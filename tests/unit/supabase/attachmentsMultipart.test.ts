// Resumable multipart uploads (attachments upload / upload-parts / upload-complete, and the gc that abandons them).
// The fake OSS answers the way the runtime key's probe on the shared bucket did (2026-11-15): initiate 200, part 200,
// a part whose length differs from its signature 403, complete-all 200 and again 404 NoSuchUpload, abort 204, a part
// after abort 404 NoSuchUpload. The database half is the three functions of 20261115190000, in memory.
import { describe, expect, it } from 'vitest'
import { sweepManagedUploads } from '../../../supabase/functions/_shared/upload-closure'
import { type OssConfig } from '../../../supabase/functions/_shared/oss'
import { ossObjectStorage, supabaseObjectStorage } from '../../../supabase/functions/_shared/attachment-object-storage'
import {
  type AttachmentsDeps, handleGc, handleUpload, handleUploadComplete, handleUploadParts, UPLOAD_PART_BYTES,
} from '../../../supabase/functions/_shared/attachments-core'

const OSS: OssConfig = {
  region: 'cn-wulanchabu', bucket: 'gugu-files-test', endpointInternal: 'oss-cn-wulanchabu-internal.aliyuncs.com',
  endpointPublic: 'oss-cn-wulanchabu.aliyuncs.com', accessKeyId: 'LTAI-test', accessKeySecret: 'secret-test',
}
const CDN = { domain: 'files-dev.example', authKey: 'cdn-key-test', authTtlSeconds: 1800 }
const USER = '11111111-1111-4111-8111-111111111111'
const ID = '22222222-2222-4222-8222-222222222222'
const KEY = `staging/${USER}/${ID}`
const SIZE = 2 * UPLOAD_PART_BYTES + 1000 // three parts, the last one short

type Upload = { key: string; parts: Map<number, number>; state: 'open' | 'completed' | 'aborted' }
function fakes(opts: { prefix?: string; size?: number; expired?: boolean; blob?: string | null } = {}) {
  const size = opts.size ?? SIZE
  const oss = { ...OSS, ...(opts.prefix ? { objectPrefix: opts.prefix } : {}) }
  const calls: Array<{ method: string; url: string; headers: Record<string, string> }> = []
  const uploads = new Map<string, Upload>()
  const objects = new Map<string, number>() // physical key → size
  let opened = 0
  const physical = (url: string) => decodeURIComponent(new URL(url).pathname.slice(1))
  const fetch = async (input: string, init: RequestInit = {}) => {
    const url = new URL(input), method = init.method ?? 'GET', headers = Object.fromEntries(new Headers(init.headers).entries())
    calls.push({ method, url: input, headers })
    if (url.searchParams.has('versioning')) return new Response('<VersioningConfiguration/>', { status: 200 })
    const key = physical(input), uploadId = url.searchParams.get('uploadId')
    if (method === 'POST' && url.searchParams.has('uploads')) {
      const id = `U${++opened}`
      uploads.set(id, { key, parts: new Map(), state: 'open' })
      return new Response(`<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`, { status: 200 })
    }
    if (method === 'GET' && url.searchParams.has('uploads')) {
      const open = [...uploads.values()].some(u => u.state === 'open' && u.key.startsWith(url.searchParams.get('prefix')!))
      return new Response(`<ListMultipartUploadsResult><Bucket>${oss.bucket}</Bucket><Prefix>${url.searchParams.get('prefix')}</Prefix><IsTruncated>false</IsTruncated>${open ? '<Upload><Key>pending</Key></Upload>' : ''}</ListMultipartUploadsResult>`)
    }
    if (method === 'GET' && !objects.has(key)) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 })
    const upload = uploadId ? uploads.get(uploadId) : undefined
    if (uploadId && (!upload || upload.state !== 'open' || upload.key !== key)) return new Response('<Error><Code>NoSuchUpload</Code></Error>', { status: 404 })
    if (method === 'POST' && upload) {
      if (objects.has(key)) return new Response('<Error><Code>FileAlreadyExists</Code></Error>', { status: 409 })
      objects.set(key, [...upload.parts.values()].reduce((a, b) => a + b, 0))
      upload.state = 'completed'
      return new Response('<CompleteMultipartUploadResult/>', { status: 200 })
    }
    if (method === 'PUT' && upload) return new Response(null, { status: 200 })
    if (method === 'DELETE' && upload) { upload.state = 'aborted'; return new Response(null, { status: 204 }) }
    if (method === 'DELETE') { objects.delete(key); return new Response(null, { status: 204 }) }
    if (method === 'HEAD') return objects.has(key)
      ? new Response(null, { status: 200, headers: { 'content-length': String(objects.get(key)) } }) : new Response(null, { status: 404 })
    return new Response('unexpected', { status: 500 })
  }
  /** A client sending a signed part: OSS refuses a body whose length is not the signed one. */
  const send = async (part: { n: number; url: string; headers: Record<string, string>; bytes: number }, bytes = part.bytes) => {
    const response = await fetch(part.url, { method: 'PUT', headers: { ...part.headers, 'content-length': String(bytes) } })
    if (response.status !== 200) return response.status
    if (bytes !== Number(part.headers['content-length'])) return 403
    uploads.get(new URL(part.url).searchParams.get('uploadId')!)!.parts.set(Number(new URL(part.url).searchParams.get('partNumber')), bytes)
    return 200
  }
  const row = { staging_key: KEY, account_id: USER, max_bytes: size, blob_id: opts.blob ?? null, upload_id: null as string | null, parts_done: [] as number[] }
  const rpcs: string[] = []
  const serviceRpc = async (fn: string, args: Record<string, unknown>) => {
    rpcs.push(fn)
    if (fn === 'file_managed_upload_for') {
      if (opts.expired && !row.blob_id) return { data: null, error: { message: 'Upload permit expired', hint: 'file_transfer_expired' } }
      return { data: { max_bytes: row.max_bytes, blob_id: row.blob_id, state: 'issued' }, error: null }
    }
    if (fn === 'file_managed_upload_parts') {
      row.upload_id ??= args.p_upload_id as string | null
      row.parts_done = row.upload_id ? [...new Set([...row.parts_done, ...(args.p_done as number[])])].sort((a, b) => a - b) : []
      return { data: { upload_id: row.upload_id, parts_done: row.parts_done }, error: null }
    }
    if (fn === 'file_managed_upload_parts_clear') {
      if (row.upload_id === args.p_upload_id) { row.upload_id = null; row.parts_done = [] }
      return { data: null, error: null }
    }
    if (fn === 'file_managed_upload_parts_claim') return { data: opts.expired && row.upload_id ? [{ staging_key: KEY, account_id: USER, upload_id: row.upload_id }] : [], error: null }
    if (fn === 'file_blob_gc_claim') return { data: [], error: null }
    return { data: null, error: null }
  }
  const userRpc = async (fn: string, args: Record<string, unknown>) => {
    if (fn === 'file_managed_upload_prepare') return { data: { max_bytes: 256 * 1024 * 1024, permit_seconds: 900 }, error: null }
    if (fn === 'file_managed_upload_as') return { data: { staging_key: `staging/${USER}/${args.p_id}`, max_bytes: args.p_bytes, signed_at: '2026-11-15T12:00:00Z', expires_at: '2026-11-15T12:15:00Z' }, error: null }
    return { data: null, error: { message: `no fake for ${fn}` } }
  }
  const deps = {
    objects: ossObjectStorage({ oss, cdn: CDN, fetch, inspector: async () => { throw new Error('not read here') } }),
    fetch, userRpc, serviceRpc,
    textFiles: { maxBytes: 1024, classify: () => ({ kind: 'file', why: '' }) },
    storageSignedUrl: async () => '', storageRemove: async () => {},
    now: () => new Date('2026-11-15T12:00:00Z'), uuid: () => ID, log: () => {},
  } as unknown as AttachmentsDeps
  return { deps, calls, uploads, objects, row, rpcs, send, fetch }
}
const begin = (deps: AttachmentsDeps, size = SIZE) => handleUpload(deps, USER, { request_id: ID, size_bytes: size, parts: true })

describe('multipart upload plan', () => {
  it('a client that sends parts gets a part plan for a file over one part, and the same upload when it asks again', async () => {
    const f = fakes()
    expect(await begin(f.deps)).toEqual({ staging_key: KEY, max_bytes: SIZE, expires_at: '2026-11-15T12:15:00Z', parts: { part_bytes: UPLOAD_PART_BYTES, count: 3 } })
    await begin(f.deps)
    expect([...f.uploads.keys()]).toEqual(['U1'])
    expect(f.row.upload_id).toBe('U1')
    expect(f.calls.filter(c => c.method === 'POST')[0]!.headers['x-oss-forbid-overwrite']).toBe('true')
  })
  it('a client without parts, a file of one part, and a store without parts get the one-request plan as before', async () => {
    for (const [body, size] of [[{}, SIZE], [{ parts: true }, UPLOAD_PART_BYTES]] as const) {
      const f = fakes({ size })
      const plan = await handleUpload(f.deps, USER, { request_id: ID, size_bytes: size, ...body }) as Record<string, unknown>
      expect(plan.parts).toBeUndefined()
      expect(plan.url).toBe(`https://${OSS.bucket}.${OSS.endpointPublic}/`)
      expect(f.uploads.size).toBe(0)
    }
    const community = supabaseObjectStorage({ url: 'https://db.example', serviceKey: 'k', bucket: 'attachments', fetch: async () => new Response('{}'),
      signUpload: async () => 'https://db.example/upload', signDownload: async () => '' })
    expect(community.parts).toBeUndefined()
  })
  it('of two concurrent openers the second abandons its own upload and both use the recorded one', async () => {
    const f = fakes()
    f.row.upload_id = 'U0' // recorded by the other opener between this one's read and its write
    const read = f.deps.serviceRpc
    let first = true
    f.deps.serviceRpc = async (fn, args) => {
      if (fn === 'file_managed_upload_parts' && first) { first = false; return { data: { upload_id: null, parts_done: [] }, error: null } }
      return read(fn, args)
    }
    await begin(f.deps)
    expect(f.uploads.get('U1')!.state).toBe('aborted')
    expect(f.row.upload_id).toBe('U0')
  })
})

describe('upload-parts and upload-complete', () => {
  it('sends every part, resumes from what the database recorded, joins once and answers success again', async () => {
    const f = fakes()
    await begin(f.deps)
    const first = await handleUploadParts(f.deps, USER, { staging_key: KEY })
    expect(first.done).toEqual([])
    expect(first.todo.map(p => [p.n, p.bytes])).toEqual([[1, UPLOAD_PART_BYTES], [2, UPLOAD_PART_BYTES], [3, 1000]])
    expect(await f.send(first.todo[0]!)).toBe(200)
    // The call ends here; the next one reports part 1 and is asked only for the rest.
    const again = await handleUploadParts(f.deps, USER, { staging_key: KEY, done: [1] })
    expect(again.done).toEqual([1])
    expect(again.todo.map(p => p.n)).toEqual([2, 3])
    for (const part of again.todo) expect(await f.send(part)).toBe(200)
    expect((await handleUploadParts(f.deps, USER, { staging_key: KEY, done: [2, 3] })).todo).toEqual([])
    expect(await handleUploadComplete(f.deps, USER, { staging_key: KEY })).toEqual({ staging_key: KEY, size_bytes: SIZE })
    expect(f.objects.get(KEY)).toBe(SIZE)
    // The answer was lost: asked again, the store says NoSuchUpload, the object is there with its size.
    expect(await handleUploadComplete(f.deps, USER, { staging_key: KEY })).toEqual({ staging_key: KEY, size_bytes: SIZE })
    const joins = f.calls.filter(c => c.method === 'POST' && new URL(c.url).searchParams.has('uploadId'))
    expect(joins).toHaveLength(2)
    for (const join of joins) expect(join.headers).toMatchObject({ 'x-oss-complete-all': 'yes', 'x-oss-forbid-overwrite': 'true' })
  })
  it('binds each part to its number and length: a longer body is refused, and only parts 1 to count are signed', async () => {
    const f = fakes()
    await begin(f.deps)
    const { todo } = await handleUploadParts(f.deps, USER, { staging_key: KEY })
    expect(todo.map(p => p.n)).toEqual([1, 2, 3])
    for (const part of todo) {
      expect(part.headers.authorization ?? part.headers.Authorization).toContain('AdditionalHeaders=content-length')
      expect(new URL(part.url).searchParams.get('uploadId')).toBe('U1')
    }
    expect(await f.send(todo[2]!, 2000)).toBe(403)
    for (const done of [[0], [4], [1.5], ['1'], 'all']) {
      await expect(handleUploadParts(f.deps, USER, { staging_key: KEY, done })).rejects.toMatchObject({ status: 400, code: 'invalid' })
    }
  })
  it('signs a few parts per answer so a long upload asks again with fresh signatures', async () => {
    const f = fakes({ size: 32 * UPLOAD_PART_BYTES })
    await begin(f.deps, 32 * UPLOAD_PART_BYTES)
    const { todo } = await handleUploadParts(f.deps, USER, { staging_key: KEY })
    expect(todo.map(p => p.n)).toEqual([1, 2, 3, 4, 5, 6])
  })
  it('refuses to join while parts are missing, and names them', async () => {
    const f = fakes()
    await begin(f.deps)
    await handleUploadParts(f.deps, USER, { staging_key: KEY, done: [2] })
    await expect(handleUploadComplete(f.deps, USER, { staging_key: KEY })).rejects.toMatchObject({ status: 409, code: 'upload_incomplete', message: 'Parts not sent yet: 1, 3' })
    expect(f.objects.size).toBe(0)
  })
  it('a part reported but never sent: the joined object is short, so it is removed, the state cleared and the upload starts again', async () => {
    const f = fakes()
    await begin(f.deps)
    const { todo } = await handleUploadParts(f.deps, USER, { staging_key: KEY })
    await f.send(todo[0]!); await f.send(todo[2]!)
    await handleUploadParts(f.deps, USER, { staging_key: KEY, done: [1, 2, 3] })
    await expect(handleUploadComplete(f.deps, USER, { staging_key: KEY })).rejects.toMatchObject({ status: 409, code: 'upload_changed' })
    expect(f.objects.has(KEY)).toBe(false)
    expect([f.row.upload_id, f.row.parts_done]).toEqual([null, []])
    // Starting again opens a new upload; sent whole, it joins.
    await begin(f.deps)
    const fresh = await handleUploadParts(f.deps, USER, { staging_key: KEY })
    expect(fresh.done).toEqual([])
    for (const part of fresh.todo) await f.send(part)
    await handleUploadParts(f.deps, USER, { staging_key: KEY, done: [1, 2, 3] })
    expect(await handleUploadComplete(f.deps, USER, { staging_key: KEY })).toEqual({ staging_key: KEY, size_bytes: SIZE })
  })
  it('the store gave the upload up (a day passed): nothing to join, so the state is cleared and the client starts again', async () => {
    const f = fakes()
    await begin(f.deps)
    await handleUploadParts(f.deps, USER, { staging_key: KEY, done: [1, 2, 3] })
    f.uploads.get('U1')!.state = 'aborted'
    await expect(handleUploadComplete(f.deps, USER, { staging_key: KEY })).rejects.toMatchObject({ status: 409, code: 'upload_changed', message: `The parts make 0 bytes, not ${SIZE}; upload the file again` })
    expect(f.row.upload_id).toBeNull()
  })
  it('does not answer success when the size cannot be read after joining; asking again takes the idempotent branch', async () => {
    const f = fakes()
    await begin(f.deps)
    const { todo } = await handleUploadParts(f.deps, USER, { staging_key: KEY })
    for (const part of todo) await f.send(part)
    await handleUploadParts(f.deps, USER, { staging_key: KEY, done: [1, 2, 3] })
    let failHead = true
    const store = ossObjectStorage({ oss: OSS, cdn: CDN, inspector: async () => { throw new Error('x') }, fetch: async (url, init) => {
      if (init?.method === 'HEAD' && failHead) { failHead = false; return new Response(null, { status: 503 }) }
      return f.fetch(url, init)
    } })
    f.deps.objects = store
    await expect(handleUploadComplete(f.deps, USER, { staging_key: KEY })).rejects.toMatchObject({ status: 503 })
    expect(await handleUploadComplete(f.deps, USER, { staging_key: KEY })).toEqual({ staging_key: KEY, size_bytes: SIZE })
  })
  it('only the caller\'s own live upload: another user\'s key, a sent upload and an expired permit are refused', async () => {
    const f = fakes()
    await expect(handleUploadParts(f.deps, USER, { staging_key: `staging/33333333-3333-4333-8333-333333333333/${ID}` })).rejects.toMatchObject({ status: 400 })
    await expect(handleUploadParts(fakes({ blob: 'b1' }).deps, USER, { staging_key: KEY })).rejects.toMatchObject({ status: 410, code: 'expired' })
    await expect(handleUploadComplete(fakes({ expired: true }).deps, USER, { staging_key: KEY })).rejects.toMatchObject({ status: 410 })
  })
})

describe('gc abandons expired multipart uploads', () => {
  it('abandons each in the store and forgets it; an upload already gone counts as abandoned', async () => {
    for (const gone of [false, true]) {
      const f = fakes({ expired: true })
      await begin(f.deps)
      if (gone) f.uploads.get('U1')!.state = 'aborted'
      await handleGc(f.deps)
      expect(f.uploads.get('U1')!.state).toBe('aborted')
      expect(f.row.upload_id).toBeNull()
      expect(f.rpcs.indexOf('file_managed_upload_parts_claim')).toBeGreaterThan(f.rpcs.indexOf('file_transfer_expire'))
      // A part sent with an old signature after that is refused by the store.
      const signed = await f.deps.objects!.parts!.sign(KEY, 'U1', [{ n: 1, bytes: 10 }])
      expect(await f.send(signed[0]!)).toBe(404)
    }
  })
  it('a failed abandon is kept for the next gc, not forgotten', async () => {
    const f = fakes({ expired: true })
    await begin(f.deps)
    f.deps.objects = ossObjectStorage({ oss: OSS, cdn: CDN, inspector: async () => { throw new Error('x') }, fetch: async (url, init) =>
      init?.method === 'DELETE' ? new Response('<Error><Code>InternalError</Code></Error>', { status: 500 }) : f.fetch(url, init) })
    await handleGc(f.deps)
    expect(f.row.upload_id).toBe('U1')
  })
})

describe('object prefix', () => {
  it('open, sign, complete and abandon all address the prefixed key', async () => {
    const f = fakes({ prefix: 'production' })
    const parts = f.deps.objects!.parts!
    const id = await parts.open(KEY)
    const [part] = await parts.sign(KEY, id, [{ n: 1, bytes: 10 }])
    await parts.complete(KEY, id)
    await parts.abandon(KEY, id)
    for (const url of [...f.calls.map(c => c.url), part!.url]) expect(new URL(url).pathname).toBe(`/production/${KEY}`)
  })
})

describe('verified staging cleanup', () => {
  it.each(['open', 'completed', 'untracked', 'bucket missing'] as const)('checks the physical state for %s', async (state) => {
    const f = fakes({ prefix: 'isolated' })
    await begin(f.deps)
    const key = 'isolated/' + KEY
    const final = 'isolated/ab/' + 'ab'.repeat(32)
    f.objects.set(final, SIZE)
    if (state === 'completed') {
      f.objects.set(key, SIZE)
      f.uploads.get('U1')!.state = 'completed'
    }
    if (state === 'untracked') await f.deps.objects!.parts!.open(KEY)
    const oss = { ...OSS, objectPrefix: 'isolated' }
    if (state === 'bucket missing') {
      f.deps.objects = ossObjectStorage({ oss, cdn: CDN, inspector: async () => { throw new Error('unused') },
        fetch: (url, init) => init?.method === 'GET' && !new URL(url).search
          ? Promise.resolve(new Response('<Error><Code>NoSuchBucket</Code></Error>', { status: 404 })) : f.fetch(url, init) })
    }
    const receipts: unknown[] = []
    f.deps.serviceRpc = async (fn, args) => {
      if (fn === 'file_managed_upload_closable') return { data: [{ reservation_id: ID, account_id: USER,
        staging_key: KEY, upload_id: 'U1', evidence: 'test-window', held_bytes: SIZE * 2 }], error: null }
      if (fn !== 'file_managed_upload_closed') throw new Error(fn)
      receipts.push(args)
      return { data: null, error: null }
    }
    const result = await sweepManagedUploads(f.deps, { kind: 'oss', oss, cdn: CDN }, '', false, [ID])
    const held = state === 'untracked' || state === 'bucket missing'
    expect(result.failed).toEqual(held ? [ID] : [])
    expect(receipts).toEqual(held ? [] : [{p_key:KEY,p_evidence:'sweep:'+ID+':test-window'}])
    expect(f.objects.get(final)).toBe(SIZE)
    expect(f.objects.has(key)).toBe(false)
    if (state === 'untracked') expect(f.uploads.get('U2')!.state).toBe('open')
    expect(f.calls.filter(c => c.method === 'DELETE').map(c => new URL(c.url).pathname)).toEqual(['/'+key,'/'+key])
  })
})
