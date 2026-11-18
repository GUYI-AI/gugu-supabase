import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { supabaseObjectStorage } from '../../../supabase/functions/_shared/attachment-object-storage'
import { ObjectStorageError } from '../../../supabase/functions/_shared/object-storage'

function storage(fetcher: typeof fetch) {
  return supabaseObjectStorage({
    url: 'https://project.example', serviceKey: 'server-only-fixture', bucket: 'attachments',
    fetch: fetcher,
    signDownload: async () => 'https://project.example/signed/object',
  })
}

/** Supabase Storage as far as these calls go: every upload is a new version; copy finds its source by version id. */
function versioned(initial: Record<string, Uint8Array>) {
  const objects = new Map<string, { version: string; bytes: Uint8Array }>()
  let next = 0, hook: (() => void) | null = null
  const replace = (key: string, bytes: Uint8Array) => void objects.set(key, { version: 'v' + ++next, bytes })
  for (const [key, bytes] of Object.entries(initial)) replace(key, bytes)
  const copies: unknown[] = []
  const missing = () => new Response('{"statusCode":"404"}', { status: 400 })
  const keyAfter = (path: string, prefix: string) => path.slice(prefix.length).split('/').map(decodeURIComponent).join('/')
  const api = storage(vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname, headers = new Headers(init?.headers)
    if (path.startsWith('/storage/v1/object/info/attachments/')) {
      const object = objects.get(keyAfter(path, '/storage/v1/object/info/attachments/'))
      return object ? Response.json({ version: object.version }) : missing()
    }
    if (path === '/storage/v1/object/copy') {
      const body = JSON.parse(String(init?.body))
      copies.push({ body, upsert: headers.get('x-upsert'), authorization: headers.get('authorization') })
      const source = objects.get(body.sourceKey)
      if (!source || source.version !== body.sourceVersionId) return missing()
      replace(body.destinationKey, source.bytes)
      return Response.json({})
    }
    const object = objects.get(keyAfter(path, '/storage/v1/object/attachments/'))
    if (!object) return missing()
    const run = hook; hook = null; run?.()
    return new Response(object.bytes, { headers: { 'content-length': String(object.bytes.byteLength) } })
  }))
  return { api, copies, replace, duringGet: (run: () => void) => { hook = run },
    versionOf: (key: string) => objects.get(key)?.version, bytesOf: (key: string) => objects.get(key)?.bytes }
}

describe('community attachment storage', () => {
  it('reports the real bucket ceiling and fixed signed-upload lifetime instead of promising per-object enforcement',async()=>{
    const fetcher=vi.fn(async()=>new Response(JSON.stringify({file_size_limit:26214400})))
    expect(await storage(fetcher).uploadBounds(5,120)).toEqual({maxBytes:26214400,expiresSeconds:7200})
    expect(fetcher.mock.calls[0]![0]).toBe('https://project.example/storage/v1/bucket/attachments')
    for (const size of [null,0,-1,1.5,Number.MAX_SAFE_INTEGER+1,'Infinity','invalid']) {
      await expect(storage(vi.fn(async()=>new Response(JSON.stringify({file_size_limit:size})))).uploadBounds(5,120))
        .rejects.toMatchObject({status:503,code:'not_configured'})
    }
  })
  it('accepts a finite ceiling covering 25 MiB plaintext plus authentication frames and refuses one byte beyond it',async()=>{
    const plaintext=25*1024*1024,ceiling=32+plaintext+Math.ceil(plaintext/(256*1024))*17
    expect(ceiling).toBe(26216132)
    const api=storage(vi.fn(async()=>new Response(JSON.stringify({file_size_limit:String(ceiling)}))))
    expect(await api.uploadBounds(ceiling,7200)).toEqual({maxBytes:ceiling,expiresSeconds:7200})
    await expect(api.uploadBounds(ceiling+1,7200)).rejects.toMatchObject({status:503,code:'not_configured'})
  })
  it('streams the entire authenticated representation at its exact granted ceiling, keeps only a prefix, and refuses one byte less',async()=>{
    const plaintext=25*1024*1024,ceiling=32+plaintext+Math.ceil(plaintext/(256*1024))*17
    const bytes=new Uint8Array(ceiling).fill(17),f=versioned({'temporary/encrypted':bytes})
    const inspected=await f.api.inspect('temporary/encrypted',ceiling)
    expect(inspected.sizeBytes).toBe(ceiling)
    expect(inspected.bytes.byteLength).toBe(512)
    expect(inspected.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(inspected.revision).toBe(f.versionOf('temporary/encrypted'))
    await expect(f.api.inspect('temporary/encrypted',ceiling-1)).rejects.toMatchObject({status:413,code:'too_large'})
  })

  it('copies exactly the hashed version: a staging object replaced after inspection is not promoted', async () => {
    const f = versioned({ 'staging/u/file': new Uint8Array([1, 2, 3]) })
    const read = await f.api.inspect('staging/u/file', 10)
    f.replace('staging/u/file', new Uint8Array([9, 9, 9]))
    await expect(f.api.promote('staging/u/file', 'ab/hash', read.revision, {})).rejects.toMatchObject({ status: 412 })
    expect(f.bytesOf('ab/hash')).toBeUndefined()
  })

  it('refuses an inspection whose object was replaced during the streamed read', async () => {
    const f = versioned({ 'staging/u/file': new Uint8Array([1, 2, 3]) })
    f.duringGet(() => f.replace('staging/u/file', new Uint8Array([9, 9, 9])))
    await expect(f.api.inspect('staging/u/file', 10)).rejects.toMatchObject({ status: 412 })
  })

  it('promotes by a server-side copy of the pinned version with the object headers', async () => {
    const f = versioned({ 'staging/u/file': new Uint8Array([1, 2, 3]) })
    const read = await f.api.inspect('staging/u/file', 10)
    await f.api.promote('staging/u/file', 'ab/hash', read.revision, { 'Content-Type': 'image/png', 'Cache-Control': 'immutable' })
    expect(f.bytesOf('ab/hash')).toEqual(new Uint8Array([1, 2, 3]))
    expect(f.copies).toEqual([{ body: { bucketId: 'attachments', sourceKey: 'staging/u/file', sourceVersionId: read.revision, destinationKey: 'ab/hash',
      copyMetadata: false, metadata: { mimetype: 'image/png', cacheControl: 'immutable' } }, upsert: 'true', authorization: 'Bearer server-only-fixture' }])
  })

  it('cancels a chunked response once it exceeds the attachment limit', async () => {
    let cancelled = false
    const api = storage(vi.fn(async (url: string) => url.includes('/object/info/') ? Response.json({ version: 'v1' }) : new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(4))
        controller.enqueue(new Uint8Array(4))
      },
      cancel() { cancelled = true },
    }))))
    await expect(api.inspect('staging/u/file', 5)).rejects.toMatchObject({ status: 413 })
    expect(cancelled).toBe(true)
  })

  it('recognizes structured missing-object errors and preserves authentication errors', async () => {
    await expect(versioned({}).api.inspect('staging/u/file', 10)).rejects.toMatchObject({ status: 404 })
    const denied = storage(vi.fn(async () => new Response('{}', { status: 401 })))
    await expect(denied.exists('ab/hash')).rejects.toBeInstanceOf(ObjectStorageError)
  })

  it.each([
    [400, { statusCode: '409', error: 'Duplicate' }, 409, 'upload_used'],
    [409, { code: 'KeyAlreadyExists' }, 409, 'upload_used'],
    [409, { code: 'ResourceAlreadyExists' }, 409, 'upload_used'],
    [400, { statusCode: '400', error: 'InvalidKey' }, 400, null],
    [400, { statusCode: '409', error: 'OtherConflict' }, 400, null],
    [409, { code: 'BucketAlreadyExists' }, 409, null],
  ] as const)('classifies the signing response %s %j', async (status, body, expected, code) => {
    const api = storage(async () => Response.json(body, { status }))
    await expect(api.upload('staging/u/file', new Date())).rejects.toMatchObject({ status: expected, code })
  })
  it('returns only a scoped upload URL and never the server credential', async () => {
    const sign = vi.fn(async () => Response.json({ url: '/object/upload/sign/attachments/staging/u/file?token=scoped' }))
    const plan = await storage(sign).upload('staging/u/file', new Date('2026-10-21T00:00:00Z'))
    expect(plan.method).toBe('PUT')
    expect(JSON.stringify(plan)).not.toContain('server-only-fixture')
    expect(plan.url).toContain('token=scoped')
  })
})
