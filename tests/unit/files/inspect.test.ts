import { createHash } from 'node:crypto'
import http from 'node:http'
import type net from 'node:net'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { FilesConfig } from '../../../services/files/src/config.mjs'
import { createFileService, type FileService } from '../../../services/files/src/files.mjs'
import { createLogger } from '../../../services/files/src/log.mjs'
import { fileServiceInspector } from '../../../supabase/functions/_shared/file-inspection'

/**
 * 内部口 POST /inspect:attachments 函数把签好的暂存对象读请求交过来,这里流式算 sha256(edge 的 2 s CPU 装不下大文件)。
 * 服务真起在端口上(库是假的),来源是本地一个 HTTP 服务。
 */
const SECRET = 'inspect-fixture-secret'
const MiB = 1024 * 1024

let source: http.Server
let sourceBase: string
let seenHeaders: http.IncomingHttpHeaders | undefined
const services: FileService[] = []

function config(inspectSecret: string | null): FilesConfig {
  return {
    host: '127.0.0.1', port: 0, adminHost: '127.0.0.1', adminPort: 0,
    dbUrl: 'postgresql://nobody@127.0.0.1:1/none', dbPoolMax: 1,
    jwksUrl: 'http://127.0.0.1:1/jwks.json', jwtSecret: null, jwtIssuer: null, inspectSecret,
    timeoutMs: 30_000, debounceMs: 1_000, maxDebounceMs: 5_000,
    maxFileBytes: MiB, maxFrameBytes: 16 * MiB, maxBodyBytes: 4 * MiB,
    rateUpdates: { perSecond: 50, burst: 500 }, rateBytes: { perSecond: 256 * 1024, burst: 8 * MiB },
    rateAwareness: { perSecond: 20, burst: 60 },
    compactRatio: 4, compactMinBytes: 4096, hotCompactRatio: 8, hotCompactMinBytes: 256 * 1024,
    hotCompactCooldownMs: 60_000, compactDrainMs: 1000, roundIdleMs: 30_000, storeWaitsHistoryMs: 5_000,
    logLevel: 'error',
  }
}

async function start(inspectSecret: string | null) {
  const pool = { async query() { throw new Error('no database in this test') } }
  const service = createFileService(config(inspectSecret), { log: createLogger({ level: 'error', write: () => undefined }), pool: pool as never })
  services.push(service)
  const { port, adminPort } = await service.listen()
  return { base: `http://127.0.0.1:${port}`, admin: `http://127.0.0.1:${adminPort}` }
}

/** 64 KiB 一块,内容随位置变;/chunked 不报 content-length。 */
const pattern = (size: number) => {
  const bytes = new Uint8Array(size)
  for (let i = 0; i < size; i++) bytes[i] = (i * 31 + (i >> 16)) & 0xff
  return bytes
}
const BIG = pattern(24 * MiB + 17)

let ports: { base: string; admin: string }

beforeAll(async () => {
  source = http.createServer((req, res) => {
    seenHeaders = req.headers
    if (req.url === '/missing') { res.writeHead(404); return res.end('<Error/>') }
    if (req.url === '/no-etag') { res.writeHead(200); return res.end('x') }
    const chunked = req.url === '/chunked'
    res.writeHead(200, { etag: '"abc"', ...(chunked ? {} : { 'content-length': String(BIG.length) }) })
    let offset = 0
    const pump = () => {
      while (offset < BIG.length) {
        const next = BIG.subarray(offset, offset + 64 * 1024)
        offset += next.length
        if (!res.write(next)) return void res.once('drain', pump)
      }
      res.end()
    }
    pump()
  })
  await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve))
  sourceBase = `http://127.0.0.1:${(source.address() as net.AddressInfo).port}`
  ports = await start(SECRET)
})

afterAll(async () => {
  for (const service of services) await service.close()
  await new Promise<void>((resolve) => source.close(() => resolve()))
})

const inspect = (body: unknown, secret: string | null = SECRET, base = ports.admin) => fetch(`${base}/inspect`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
  body: JSON.stringify(body),
})

describe('文件服务的内部口 POST /inspect', () => {
  it('流式读完来源:sha256、字节数、ETag 与前缀;带上调用方签好的请求头', async () => {
    for (const path of ['/object', '/chunked']) {
      const res = await inspect({ source: { url: sourceBase + path, headers: { Authorization: 'OSS4 signed' } }, limit: BIG.length, retain: 1000 })
      expect(res.status).toBe(200)
      expect(res.headers.get('x-gugu-sha256')).toBe(createHash('sha256').update(BIG).digest('hex'))
      expect(res.headers.get('x-gugu-size')).toBe(String(BIG.length))
      expect(res.headers.get('x-gugu-etag')).toBe('"abc"')
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(BIG.subarray(0, 1000))
      expect(seenHeaders?.authorization).toBe('OSS4 signed')
      expect(seenHeaders?.['accept-encoding']).toBe('identity')
    }
  })

  it('超过 limit 一个字节就拒(报了长度的、没报长度的都一样)', async () => {
    for (const path of ['/object', '/chunked']) {
      const res = await inspect({ source: { url: sourceBase + path }, limit: BIG.length - 1, retain: 512 })
      expect(res.status).toBe(413)
      expect(await res.json()).toEqual({ error: 'too-large' })
    }
  })

  it('来源不在 ⇒ 404;没有 ETag ⇒ 502', async () => {
    expect((await inspect({ source: { url: sourceBase + '/missing' }, limit: 10, retain: 512 })).status).toBe(404)
    expect((await inspect({ source: { url: sourceBase + '/no-etag' }, limit: 10, retain: 512 })).status).toBe(502)
  })

  it('只认服务间密钥:没带、带错都 401;对外口上没有这条路', async () => {
    const body = { source: { url: sourceBase + '/object' }, limit: BIG.length, retain: 512 }
    expect((await inspect(body, null)).status).toBe(401)
    expect((await inspect(body, SECRET + 'x')).status).toBe(401)
    expect((await inspect(body, SECRET, ports.base)).status).toBe(404)
  })

  it('请求不合规 ⇒ 400', async () => {
    for (const body of [{}, { source: { url: 'file:///etc/passwd' }, limit: 1, retain: 1 }, { source: { url: sourceBase }, limit: 0, retain: 1 },
      { source: { url: sourceBase, headers: { a: 1 } }, limit: 1, retain: 1 }]) {
      expect((await inspect(body)).status).toBe(400)
    }
  })

  it('没配密钥 ⇒ 503,不放行', async () => {
    const bare = await start(null)
    const res = await inspect({ source: { url: sourceBase + '/object' }, limit: BIG.length, retain: 512 }, SECRET, bare.admin)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'not-configured' })
  })
})

describe('attachments 函数这一端(fileServiceInspector)对真起的文件服务', () => {
  const client = (secret = SECRET, url = ports.admin) => fileServiceInspector({ url, secret, fetch: (input, init) => fetch(input, init) })

  it('拿回 sha256、字节数、ETag 与前缀', async () => {
    const r = await client()({ url: sourceBase + '/object', headers: {} }, BIG.length, 4096)
    expect(r).toEqual({ bytes: BIG.subarray(0, 4096), sizeBytes: BIG.length, sha256: createHash('sha256').update(BIG).digest('hex'), etag: '"abc"' })
  })

  it('文件服务的拒绝换成存储的状态:404 不在、413 超限、密钥不对 ⇒ not_configured', async () => {
    await expect(client()({ url: sourceBase + '/missing', headers: {} }, 10, 512)).rejects.toMatchObject({ status: 404 })
    await expect(client()({ url: sourceBase + '/object', headers: {} }, 10, 512)).rejects.toMatchObject({ status: 413, code: 'too_large' })
    await expect(client('wrong')({ url: sourceBase + '/object', headers: {} }, BIG.length, 512)).rejects.toMatchObject({ status: 503, code: 'not_configured' })
    await expect(client()({ url: sourceBase + '/no-etag', headers: {} }, 10, 512)).rejects.toMatchObject({ status: 502 })
  })

  it('没配地址或密钥 ⇒ not_configured,一个字节也不读', async () => {
    seenHeaders = undefined
    for (const inspector of [client('', ports.admin), client(SECRET, '')]) {
      await expect(inspector({ url: sourceBase + '/object', headers: {} }, BIG.length, 512)).rejects.toMatchObject({ status: 503, code: 'not_configured' })
    }
    expect(seenHeaders).toBeUndefined()
  })
})
