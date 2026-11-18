import http from 'node:http'
import type net from 'node:net'

import * as jose from 'jose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { SUBPROTOCOL } from '../../../services/files/src/auth.mjs'
import type { FilesConfig } from '../../../services/files/src/config.mjs'
import { createFileService, type FileService } from '../../../services/files/src/files.mjs'
import { createLogger } from '../../../services/files/src/log.mjs'

/**
 * 浏览器里直接 fetch 文件服务(手机壳没有主进程,WebView 里的 downloadSource、手机版 App 读文件):
 * 预检 OPTIONS 要回 2xx,预检与正式响应都要带 Access-Control-*;否则浏览器在发出 GET 之前就拦了。
 * 服务真起在一个端口上(库换成假的连接池,令牌用本地 JWKS 签),只量 HTTP 层;WebSocket 那条路照旧。
 * 对照:把 handleHttp 里的跨域头与 OPTIONS 分支拿掉,前三格变红(OPTIONS 回 405、没有 Access-Control-Allow-Origin)。
 */
const USER = '11111111-1111-4111-8111-111111111111'
const ITEM = '22222222-2222-4222-8222-222222222222'
const ORIGIN = 'https://localhost'

let jwks: http.Server
let mint: () => Promise<string>
let service: FileService
let base: string
let adminBase: string

beforeAll(async () => {
  const { privateKey, publicKey } = await jose.generateKeyPair('ES256', { extractable: true })
  const jwk = { ...(await jose.exportJWK(publicKey)), kid: 'cors-test', alg: 'ES256', use: 'sig' }
  jwks = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ keys: [jwk] }))
  })
  await new Promise<void>((resolve) => jwks.listen(0, '127.0.0.1', resolve))
  mint = () =>
    new jose.SignJWT({ sub: USER, role: 'authenticated', aud: 'authenticated' })
      .setProtectedHeader({ alg: 'ES256', kid: 'cors-test' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey)

  // 只认这两句:判权与读库里的文本。别的查询这里不该出现。
  const pool = {
    async query(sql: string) {
      if (sql.includes('chat.files_authorize'))
        return { rows: [{ chat_id: 'c', epoch: 0, content_type: 'application/json', kind: 'document', actor_id: USER, actor_name: '' }] }
      if (sql.includes('SELECT inline_text')) return { rows: [{ inline_text: '{"a":1}' }] }
      throw new Error(`unexpected query: ${sql}`)
    },
  }
  const config = {
    host: '127.0.0.1',
    port: 0,
    adminHost: '127.0.0.1',
    adminPort: 0,
    // LISTEN 连不上就在后台退避重连,与 HTTP 层无关。
    dbUrl: 'postgresql://nobody@127.0.0.1:1/none',
    dbPoolMax: 1,
    jwksUrl: `http://127.0.0.1:${(jwks.address() as net.AddressInfo).port}/auth/v1/.well-known/jwks.json`,
    jwtSecret: null,
    jwtIssuer: null,
    inspectSecret: null,
    timeoutMs: 30_000,
    debounceMs: 1_000,
    maxDebounceMs: 5_000,
    maxFileBytes: 1024 * 1024,
    maxFrameBytes: 16 * 1024 * 1024,
    maxBodyBytes: 4 * 1024 * 1024,
    rateUpdates: { perSecond: 50, burst: 500 },
    rateBytes: { perSecond: 256 * 1024, burst: 8 * 1024 * 1024 },
    rateAwareness: { perSecond: 20, burst: 60 },
    compactRatio: 4,
    compactMinBytes: 4096,
    hotCompactRatio: 8,
    hotCompactMinBytes: 256 * 1024,
    hotCompactCooldownMs: 60_000,
    compactDrainMs: 1000,
    roundIdleMs: 30_000,
    storeWaitsHistoryMs: 5_000,
    logLevel: 'error',
  } satisfies FilesConfig
  service = createFileService(config, { log: createLogger({ level: 'error', write: () => undefined }), pool: pool as never })
  const { port, adminPort } = await service.listen()
  base = `http://127.0.0.1:${port}`
  adminBase = `http://127.0.0.1:${adminPort}`
})

afterAll(async () => {
  await service?.close()
  await new Promise<void>((resolve) => jwks.close(() => resolve()))
})

function expectCors(res: Response) {
  expect(res.headers.get('access-control-allow-origin')).toBe('*')
  expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS')
  const allowed = (res.headers.get('access-control-allow-headers') ?? '').split(',').map((h) => h.trim().toLowerCase())
  // Authorization 不被 Allow-Headers 的 * 覆盖(Fetch 规范),必须逐个列出。
  expect(allowed).toEqual(expect.arrayContaining(['authorization', 'content-type', 'x-gugu-as-agent']))
}

describe('文件服务的跨域:浏览器里直接 fetch', () => {
  it('预检 OPTIONS /:id 与 /:id/edit ⇒ 204、没有正文、带全套 Access-Control-*', async () => {
    for (const [path, method] of [
      [`/${ITEM}`, 'GET'],
      [`/${ITEM}/edit`, 'POST'],
    ]) {
      const res = await fetch(`${base}${path}`, {
        method: 'OPTIONS',
        headers: {
          Origin: ORIGIN,
          'Access-Control-Request-Method': method,
          'Access-Control-Request-Headers': 'authorization, content-type, x-gugu-as-agent',
        },
      })
      expect(res.status).toBe(204)
      expect(await res.text()).toBe('')
      expectCors(res)
      expect(res.headers.get('access-control-max-age')).toBe('600')
    }
  })

  it('正式的 GET ⇒ 200 照旧,也带 Access-Control-*', async () => {
    const res = await fetch(`${base}/${ITEM}`, { headers: { Origin: ORIGIN, Authorization: `Bearer ${await mint()}` } })
    expect(res.status).toBe(200)
    expectCors(res)
    expect(await res.json()).toMatchObject({ epoch: 0, contentType: 'application/json', text: '{\n  "a": 1\n}', live: false })
  })

  it('错误响应也带(浏览器才读得到 401 / 404 / 405 的原因,而不是一句 CORS 失败)', async () => {
    const unauth = await fetch(`${base}/${ITEM}`, { headers: { Origin: ORIGIN } })
    expect(unauth.status).toBe(401)
    expectCors(unauth)
    const notFound = await fetch(`${base}/not-an-id`, { headers: { Origin: ORIGIN } })
    expect(notFound.status).toBe(404)
    expectCors(notFound)
    const wrongMethod = await fetch(`${base}/${ITEM}`, { method: 'POST', headers: { Origin: ORIGIN } })
    expect(wrongMethod.status).toBe(405)
    expectCors(wrongMethod)
  })

  it('内部口(/healthz、/stats)不对浏览器开放:不带 Access-Control-*', async () => {
    const res = await fetch(`${adminBase}/stats`, { headers: { Origin: ORIGIN } })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('WebSocket 那条路不受影响:带令牌的子协议照样升级,不带的照样 401', async () => {
    const open = (protocols: string[]) =>
      new Promise<{ opened: boolean; protocol: string }>((resolve) => {
        const ws = new WebSocket(base.replace('http', 'ws'), protocols)
        ws.onopen = () => {
          resolve({ opened: true, protocol: ws.protocol })
          ws.close()
        }
        ws.onerror = () => resolve({ opened: false, protocol: '' })
      })
    expect(await open([SUBPROTOCOL, `bearer.${await mint()}`])).toEqual({ opened: true, protocol: SUBPROTOCOL })
    expect(await open([SUBPROTOCOL])).toEqual({ opened: false, protocol: '' })
  })
})
