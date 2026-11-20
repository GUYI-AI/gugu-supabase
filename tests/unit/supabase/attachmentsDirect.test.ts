// Direct upload (attachments upload with sha256 → the uploader's final object u/<account>/<sha256>; finish HEADs it and
// reads only its head; gc cleans abandoned objects). The fake OSS answers as the multipart probe did (see
// attachmentsMultipart.test.ts); ranged GETs answer 206 with Content-Range. The database half is
// 20261120140000_direct_upload, in memory.
import { describe, expect, it } from 'vitest'
import { type OssConfig } from '../../../supabase/functions/_shared/oss'
import { ossObjectStorage, supabaseObjectStorage } from '../../../supabase/functions/_shared/attachment-object-storage'
import {
  type AttachmentsDeps, handleCommit, handleFinish, handleGc, handleUpload, handleUploadComplete, handleUploadParts,
  refusalFromDb, UPLOAD_PART_BYTES,
} from '../../../supabase/functions/_shared/attachments-core'

const OSS: OssConfig = {
  region: 'cn-wulanchabu', bucket: 'gugu-files-test', endpointInternal: 'oss-cn-wulanchabu-internal.aliyuncs.com',
  endpointPublic: 'oss-cn-wulanchabu.aliyuncs.com', accessKeyId: 'LTAI-test', accessKeySecret: 'secret-test',
}
const CDN = { domain: 'files-dev.example', authKey: 'cdn-key-test', authTtlSeconds: 1800 }
const USER = '11111111-1111-4111-8111-111111111111'
const ID = '22222222-2222-4222-8222-222222222222'
const KEY = `direct/${USER}/${ID}`
const SHA = 'ab'.repeat(32)
const OBJECT = `u/${USER}/${SHA}`
const TEXT_MAX = 1024
const png = () => {
  const b = new Uint8Array(64)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(b.buffer).setUint32(16, 800)
  new DataView(b.buffer).setUint32(20, 600)
  return b
}

type Call = { method: string; key: string; headers: Record<string, string>; query: URLSearchParams }
function world(opts: { stored?: boolean; busy?: boolean; object?: Uint8Array; size?: number; cleanup?: unknown[]; supabase?: boolean } = {}) {
  const objects = new Map<string, Uint8Array>()
  if (opts.object) objects.set(OBJECT, opts.object)
  const calls: Call[] = []
  const uploads = new Map<string, { key: string; parts: Map<number, number>; state: 'open' | 'completed' | 'aborted' }>()
  let opened = 0
  const ranged = (bytes: Uint8Array | undefined, range: string | null) => {
    if (!bytes) return null
    const [, from, to] = /^bytes=(\d+)-(\d+)$/.exec(range ?? '')!
    const end = Math.min(Number(to), bytes.length - 1)
    return new Response(bytes.slice(Number(from), end + 1), { status: 206, headers: { 'content-range': `bytes ${from}-${end}/${bytes.length}` } })
  }
  const ossFetch = async (input: string, init: RequestInit = {}) => {
    const url = new URL(input), method = init.method ?? 'GET', headers = Object.fromEntries(new Headers(init.headers).entries())
    if (url.searchParams.has('versioning')) return new Response('<VersioningConfiguration/>', { status: 200 })
    const key = decodeURIComponent(url.pathname.slice(1)), uploadId = url.searchParams.get('uploadId')
    calls.push({ method, key, headers, query: url.searchParams })
    if (method === 'POST' && url.searchParams.has('uploads')) {
      const id = `U${++opened}`
      uploads.set(id, { key, parts: new Map(), state: 'open' })
      return new Response(`<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`, { status: 200 })
    }
    const upload = uploadId ? uploads.get(uploadId) : undefined
    if (uploadId && (!upload || upload.state !== 'open' || upload.key !== key)) return new Response('<Error><Code>NoSuchUpload</Code></Error>', { status: 404 })
    if (method === 'POST' && upload) {
      if (objects.has(key)) return new Response('<Error><Code>FileAlreadyExists</Code></Error>', { status: 409 })
      objects.set(key, new Uint8Array([...upload.parts.values()].reduce((a, b) => a + b, 0)))
      upload.state = 'completed'
      return new Response('<CompleteMultipartUploadResult/>', { status: 200 })
    }
    if (method === 'PUT' && upload) {
      upload.parts.set(Number(url.searchParams.get('partNumber')), Number(headers['content-length']))
      return new Response(null, { status: 200 })
    }
    if (method === 'DELETE' && upload) { upload.state = 'aborted'; return new Response(null, { status: 204 }) }
    if (method === 'DELETE') { objects.delete(key); return new Response(null, { status: 204 }) }
    if (method === 'HEAD') return objects.has(key)
      ? new Response(null, { status: 200, headers: { 'content-length': String(objects.get(key)!.length) } }) : new Response(null, { status: 404 })
    if (method === 'GET') return ranged(objects.get(key), headers.range ?? null) ?? new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 })
    return new Response('unexpected', { status: 500 })
  }
  // Supabase Storage: a missing object answers HTTP 400 with a structured 404; delete takes a list of prefixes.
  const supabaseFetch = async (input: string, init: RequestInit = {}) => {
    const path = new URL(input).pathname, method = init.method ?? 'GET', headers = Object.fromEntries(new Headers(init.headers).entries())
    const key = decodeURIComponent(path.replace(/^\/storage\/v1\/object\/attachments\/?/, ''))
    calls.push({ method, key, headers, query: new URLSearchParams(String(init.body ?? '')) })
    if (method === 'DELETE') {
      for (const prefix of JSON.parse(String(init.body)).prefixes as string[]) objects.delete(prefix)
      return Response.json([])
    }
    const bytes = objects.get(key)
    if (!bytes) return new Response('{"statusCode":"404"}', { status: 400 })
    if (method === 'HEAD') return new Response(null, { status: 200 })
    return ranged(bytes, headers.range ?? null)!
  }
  const row = opts.stored ? null : {
    staging_key: KEY, account_id: USER, max_bytes: opts.size ?? 64, blob_id: null as string | null, object_key: OBJECT,
    upload_id: null as string | null, parts_done: [] as number[], staging_deleted: false,
  }
  const rpcs: Array<{ fn: string; args: Record<string, unknown> }> = []
  const logs: string[] = []
  const serviceRpc = async (fn: string, args: Record<string, unknown>) => {
    rpcs.push({ fn, args })
    if (fn === 'file_managed_upload_for') return row
      ? { data: row, error: null } : { data: null, error: { message: 'Upload has no quota reservation', hint: 'file_transfer_denied' } }
    if (fn === 'file_managed_upload_parts') {
      row!.upload_id ??= args.p_upload_id as string | null
      row!.parts_done = row!.upload_id ? [...new Set([...row!.parts_done, ...(args.p_done as number[])])].sort((a, b) => a - b) : []
      return { data: { upload_id: row!.upload_id, parts_done: row!.parts_done }, error: null }
    }
    if (fn === 'file_managed_upload_parts_clear') {
      if (row!.upload_id === args.p_upload_id) { row!.upload_id = null; row!.parts_done = [] }
      return { data: null, error: null }
    }
    if (fn === 'file_blob_register') return { data: [{ blob_id: 'b1', created: true }], error: null }
    if (fn === 'file_blob_settle') return { data: { status: 'ready', blob_id: 'b1', created: true }, error: null }
    if (fn === 'file_blob_gc_run_begin') return { data: { acquired: true, token: '11111111-1111-4111-8111-111111111111', batch_limit: 50, concurrency: 1 }, error: null }
    if (fn === 'file_blob_gc_run_renew' || fn === 'file_blob_gc_run_end') return { data: true, error: null }
    if (fn === 'file_blob_gc_run_claim' || fn === 'file_managed_upload_parts_claim') return { data: [], error: null }
    if (fn === 'file_direct_upload_cleanup_claim') return { data: opts.cleanup ?? [], error: null }
    return { data: null, error: null }
  }
  const userRpc = async (fn: string, args: Record<string, unknown>) => {
    rpcs.push({ fn, args })
    if (fn === 'file_managed_upload_prepare') return { data: { max_bytes: 256 * 1024 * 1024, permit_seconds: opts.supabase ? 7200 : 900 }, error: null }
    if (fn === 'file_managed_upload_as') return { data: { staging_key: `staging/${USER}/${args.p_id}`, max_bytes: args.p_bytes, signed_at: '2026-11-20T12:00:00Z', expires_at: '2026-11-20T12:15:00Z' }, error: null }
    if (fn === 'file_managed_upload_direct_as') {
      if (opts.busy) return { data: null, error: { message: 'These bytes are being uploaded by another request', hint: 'file_transfer_upload_in_progress', details: '2026-11-20 12:05:00.25+00' } }
      return { data: opts.stored ? { status: 'stored', staging_key: KEY }
        : { status: 'upload', staging_key: KEY, object_key: OBJECT, max_bytes: args.p_bytes, signed_at: '2026-11-20T12:00:00Z', expires_at: '2026-11-20T12:15:00Z' }, error: null }
    }
    if (fn === 'file_managed_upload_scope') return { data: null, error: null }
    if (fn === 'attachment_commit') return { data: [{ id: args.p_message_id, file_version: 1 }], error: null }
    return { data: null, error: { message: `no fake for ${fn}` } }
  }
  const objectsStore = opts.supabase
    ? supabaseObjectStorage({ url: 'https://db.example', serviceKey: 'fixture', bucket: 'attachments', fetch: async (input, init) =>
      new URL(input).pathname === '/storage/v1/bucket/attachments' ? Response.json({ file_size_limit: 256 * 1024 * 1024 }) : supabaseFetch(input, init),
      signDownload: async () => '' })
    : ossObjectStorage({ oss: OSS, cdn: CDN, fetch: ossFetch, inspector: async () => { throw new Error('direct uploads are never read whole') } })
  const deps = {
    objects: objectsStore, fetch: ossFetch, userRpc, serviceRpc,
    textFiles: { maxBytes: TEXT_MAX, classify: () => ({ kind: 'file', why: 'binary fixture' }) },
    storageSignedUrl: async () => '', storageRemove: async () => {},
    now: () => new Date('2026-11-20T12:00:00Z'), uuid: () => ID, log: (stage: string) => void logs.push(stage), retryDelayMs: 0,
  } as unknown as AttachmentsDeps
  return { deps, calls, objects, uploads, row, rpcs, logs, of: (fn: string) => rpcs.filter(r => r.fn === fn).map(r => r.args) }
}
const issue = (deps: AttachmentsDeps, extra: Record<string, unknown> = {}) =>
  handleUpload(deps, USER, { request_id: ID, size_bytes: 64, sha256: SHA, ...extra }) as Promise<Record<string, unknown>>

describe('issue', () => {
  it('bytes this account already stores: stored, with no permit, signature or object request', async () => {
    const f = world({ stored: true })
    expect(await issue(f.deps)).toEqual({ status: 'stored', staging_key: KEY })
    expect(f.of('file_managed_upload_direct_as')).toEqual([{ p_id: ID, p_chat: null, p_as: USER, p_bytes: 64, p_content_type: null, p_sha256: SHA }])
    expect(f.of('file_managed_upload_as')).toEqual([])
    expect(f.calls).toEqual([])
  })
  it('signs one request straight to the final object: exactly the declared size, never overwriting', async () => {
    const f = world()
    const up = await issue(f.deps)
    expect(up).toMatchObject({ status: 'upload', staging_key: KEY, max_bytes: 64, url: `https://${OSS.bucket}.${OSS.endpointPublic}/`, expires_at: '2026-11-20T12:15:00.000Z' })
    const fields = up.fields as Record<string, string>
    expect(fields.key).toBe(OBJECT)
    expect(fields['x-oss-forbid-overwrite']).toBe('true')
    const conditions = JSON.parse(atob(fields.policy!)).conditions
    expect(conditions).toContainEqual(['content-length-range', 64, 64])
    expect(conditions).toContainEqual(['eq', '$key', OBJECT])
    expect(conditions).toContainEqual({ 'x-oss-forbid-overwrite': 'true' })
    expect(JSON.stringify(up)).not.toContain('object_key')
  })
  it('without sha256 the legacy staging permit is answered as before, with no status', async () => {
    const f = world()
    const up = await handleUpload(f.deps, USER, { request_id: ID, size_bytes: 64 }) as Record<string, unknown>
    expect(up.staging_key).toBe(`staging/${USER}/${ID}`)
    expect(up).not.toHaveProperty('status')
    expect(f.of('file_managed_upload_direct_as')).toEqual([])
  })
  it.each(['AB'.repeat(32), 'ab'.repeat(31), 7])('refuses sha256 %s before any reservation', async sha256 => {
    const f = world()
    await expect(issue(f.deps, { sha256 })).rejects.toMatchObject({ status: 400, code: 'invalid' })
    expect(f.rpcs).toEqual([])
  })
  it('another open permit writing the same object: 409 upload_in_progress with when to ask again', async () => {
    const f = world({ busy: true })
    await expect(issue(f.deps)).rejects.toMatchObject({ status: 409, code: 'upload_in_progress', extra: { retry_after: '2026-11-20T12:05:00.250Z' } })
    expect(f.calls).toEqual([])
    expect(refusalFromDb({ message: 'm', hint: 'file_transfer_upload_in_progress', details: '2026-11-20T12:05:00Z' }).extra)
      .toEqual({ retry_after: '2026-11-20T12:05:00.000Z' })
    expect(refusalFromDb({ message: 'm', hint: 'file_transfer_conflict' }).extra).toBeUndefined()
  })
})

describe('finish, commit and place on a direct key', () => {
  it('finish HEADs the final object, reads only its head and settles with the claimed sha: no copy, no delete', async () => {
    const f = world({ object: png() })
    await expect(handleFinish(f.deps, USER, { staging_key: KEY, file_name: 'shot.png', message_id: 'm1' })).resolves.toEqual({ status: 'ready' })
    expect(f.calls.map(c => `${c.method} ${c.key} ${c.headers.range}`)).toEqual([`GET ${OBJECT} bytes=0-${TEXT_MAX}`])
    expect(f.of('file_blob_settle')).toEqual([{ p_uploader: USER, p_pending_key: KEY, p_upload_key: KEY, p_sha256: SHA, p_size_bytes: 64,
      p_content_type: 'image/png', p_width: 800, p_height: 600, p_document: null }])
    expect(f.objects.has(OBJECT)).toBe(true)
  })
  it('commit registers the owned object and settles the permit, and never touches a staging copy', async () => {
    const f = world({ object: png() })
    await handleCommit(f.deps, USER, { staging_key: KEY, message_id: 'm1', chat_id: 'c1', sender_user_id: USER, file_name: 'shot.png' })
    expect(f.of('file_blob_register')).toEqual([{ p_uploader: USER, p_staging_key: KEY, p_sha256: SHA, p_size_bytes: 64,
      p_content_type: 'image/png', p_width: 800, p_height: 600 }])
    expect(f.of('file_managed_upload_registered')).toEqual([{ p_key: KEY, p_user: USER, p_document: null }])
    expect(f.of('file_managed_upload_closed')).toEqual([])
    expect(f.calls.map(c => c.method)).toEqual(['GET'])
  })
  it('no object there: 409 upload_missing, nothing settled', async () => {
    const f = world()
    await expect(handleFinish(f.deps, USER, { staging_key: KEY, file_name: 'shot.png' })).rejects.toMatchObject({ status: 409, code: 'upload_missing' })
    expect(f.of('file_blob_settle')).toEqual([])
  })
  it('a size other than declared: Supabase Storage (no size policy) removes the object; OSS (signed size) keeps it', async () => {
    const sb = world({ object: new Uint8Array(10), supabase: true })
    await expect(handleFinish(sb.deps, USER, { staging_key: KEY, file_name: 'x.bin' })).rejects.toMatchObject({ status: 409, code: 'upload_changed' })
    expect(sb.calls.map(c => c.method)).toEqual(['GET', 'DELETE'])
    expect(sb.objects.has(OBJECT)).toBe(false)
    expect(sb.of('file_blob_settle')).toEqual([])
    const oss = world({ object: new Uint8Array(10) })
    await expect(handleFinish(oss.deps, USER, { staging_key: KEY, file_name: 'x.bin' })).rejects.toMatchObject({ status: 409, code: 'upload_changed' })
    expect(oss.objects.has(OBJECT)).toBe(true)
  })
  it('a stored key: finish settles by its receipt and commit sends, neither reading a byte', async () => {
    const f = world({ stored: true })
    await handleFinish(f.deps, USER, { staging_key: KEY, file_name: 'shot.png' })
    expect(f.of('file_blob_settle')).toEqual([{ p_uploader: USER, p_pending_key: KEY, p_upload_key: KEY, p_sha256: null, p_size_bytes: null, p_content_type: null }])
    await handleCommit(f.deps, USER, { staging_key: KEY, message_id: 'm1', chat_id: 'c1', sender_user_id: USER, file_name: 'shot.png' })
    expect(f.of('file_blob_register')).toEqual([])
    expect(f.of('attachment_commit')).toHaveLength(1)
    expect(f.calls).toEqual([])
  })
  it('a replayed finish of a registered direct permit settles by its receipt without reading', async () => {
    const f = world({ object: png() })
    f.row!.blob_id = 'b1'
    await handleFinish(f.deps, USER, { staging_key: KEY, file_name: 'shot.png' })
    expect(f.of('file_blob_settle')[0]).toMatchObject({ p_sha256: null, p_size_bytes: null })
    expect(f.calls).toEqual([])
  })
  it('another account\'s direct key is refused before anything', async () => {
    const f = world({ object: png() })
    await expect(handleFinish(f.deps, USER, { staging_key: `direct/33333333-3333-4333-8333-333333333333/${ID}`, file_name: 'x' })).rejects.toMatchObject({ status: 400 })
    expect(f.rpcs).toEqual([])
  })
})

describe('multipart on a direct permit', () => {
  const SIZE = 2 * UPLOAD_PART_BYTES + 1000
  const send = async (f: ReturnType<typeof world>, todo: Array<{ url: string; headers: Record<string, string> }>) => {
    for (const part of todo) await f.deps.fetch(part.url, { method: 'PUT', headers: part.headers })
  }
  it('opens, signs and joins on the final object while the database keeps the permit key', async () => {
    const f = world({ size: SIZE })
    expect(await issue(f.deps, { size_bytes: SIZE, parts: true })).toEqual({ status: 'upload', staging_key: KEY, max_bytes: SIZE,
      expires_at: '2026-11-20T12:15:00Z', parts: { part_bytes: UPLOAD_PART_BYTES, count: 3 } })
    expect(f.uploads.get('U1')!.key).toBe(OBJECT)
    expect(f.of('file_managed_upload_parts').every(a => a.p_key === KEY)).toBe(true)
    const { todo } = await handleUploadParts(f.deps, USER, { staging_key: KEY })
    for (const part of todo) expect(decodeURIComponent(new URL(part.url).pathname)).toBe(`/${OBJECT}`)
    await send(f, todo)
    await handleUploadParts(f.deps, USER, { staging_key: KEY, done: [1, 2, 3] })
    expect(await handleUploadComplete(f.deps, USER, { staging_key: KEY })).toEqual({ staging_key: KEY, size_bytes: SIZE })
    expect(f.objects.get(OBJECT)!.length).toBe(SIZE)
    expect(f.calls.some(c => c.key.startsWith('staging/') || c.key.startsWith('direct/'))).toBe(false)
  })
  it('the object already there: the declared size answers success; another size is upload_changed and the object stays', async () => {
    for (const [existing, ok] of [[SIZE, true], [SIZE - 1, false]] as const) {
      const f = world({ size: SIZE })
      await issue(f.deps, { size_bytes: SIZE, parts: true })
      await send(f, (await handleUploadParts(f.deps, USER, { staging_key: KEY })).todo)
      await handleUploadParts(f.deps, USER, { staging_key: KEY, done: [1, 2, 3] })
      f.objects.set(OBJECT, new Uint8Array(existing))
      const done = handleUploadComplete(f.deps, USER, { staging_key: KEY })
      if (ok) await expect(done).resolves.toEqual({ staging_key: KEY, size_bytes: SIZE })
      else await expect(done).rejects.toMatchObject({ status: 409, code: 'upload_changed' })
      expect(f.objects.get(OBJECT)!.length).toBe(existing)
    }
  })
})

describe('gc cleans abandoned direct uploads', () => {
  const OTHER = `direct/${USER}/44444444-4444-4444-8444-444444444444`, OWNED = `u/${USER}/${'cd'.repeat(32)}`
  const rows = [
    { staging_key: KEY, object_key: OBJECT, upload_id: 'U9', object_owned: false },
    { staging_key: OTHER, object_key: OWNED, upload_id: null, object_owned: true },
  ]
  it('aborts the upload, deletes only an object no blob owns, confirms it gone, then records each outcome', async () => {
    const f = world({ object: png(), cleanup: rows })
    f.objects.set(OWNED, png())
    await handleGc(f.deps)
    expect(f.of('file_direct_upload_cleanup_claim')).toEqual([{ p_limit: 50 }])
    expect(f.calls.map(c => `${c.method} ${c.key}${c.query.get('uploadId') ? ' ' + c.query.get('uploadId') : ''}`))
      .toEqual([`DELETE ${OBJECT} U9`, `DELETE ${OBJECT}`, `HEAD ${OBJECT}`])
    expect(f.objects.has(OBJECT)).toBe(false)
    expect(f.objects.has(OWNED)).toBe(true)
    expect(f.of('file_direct_upload_cleanup_done')).toEqual([{ p_key: KEY, p_object_deleted: true }, { p_key: OTHER, p_object_deleted: false }])
  })
  it('a delete the store does not confirm is not recorded, and the next row still runs', async () => {
    const f = world({ object: png(), cleanup: rows })
    const fetch = f.deps.fetch
    f.deps.objects = ossObjectStorage({ oss: OSS, cdn: CDN, inspector: async () => { throw new Error('x') }, fetch: async (url, init) =>
      init?.method === 'DELETE' && !new URL(url).searchParams.has('uploadId') ? new Response('<Error><Code>InternalError</Code></Error>', { status: 500 }) : fetch(url, init) })
    await handleGc(f.deps)
    expect(f.logs).toContain('gc_direct_cleanup_failed')
    expect(f.of('file_direct_upload_cleanup_done')).toEqual([{ p_key: OTHER, p_object_deleted: false }])
  })
})

describe('head', () => {
  it('OSS: a ranged read of the head with the whole size; an object shorter than the range; none', async () => {
    const f = world({ object: png() })
    expect(await f.deps.objects!.head(OBJECT, 16)).toEqual({ size: 64, head: png().subarray(0, 16) })
    expect(await f.deps.objects!.head(OBJECT, 1000)).toEqual({ size: 64, head: png() })
    expect(f.calls.every(c => c.headers['accept-encoding'] === 'identity')).toBe(true)
    expect(await f.deps.objects!.head(`u/${USER}/${'ef'.repeat(32)}`, 16)).toBeNull()
  })
  it('Supabase Storage: the same, with its structured missing-object answer as none', async () => {
    const f = world({ object: png(), supabase: true })
    expect(await f.deps.objects!.head(OBJECT, 16)).toEqual({ size: 64, head: png().subarray(0, 16) })
    expect(await f.deps.objects!.head(`u/${USER}/${'ef'.repeat(32)}`, 16)).toBeNull()
  })
})
