import {
  type CdnConfig, type FetchLike, type OssConfig, CDN_SIGN_TTL_SECONDS, MAX_ATTACHMENT_BYTES,
  cdnSignedUrl, ossCopy, ossDelete, ossExists, ossRequest, ossSignedRequest, postObjectForm, refreshCdn,
} from './oss.ts'
import { type AttachmentObjectStorage, type MultipartStorage, ObjectStorageError } from './object-storage.ts'
import { type Inspector, inspectFileStream } from './file-inspection.ts'

/** Bytes are read by the file service (`inspector`) from a request signed here; this Edge worker only copies by ETag. */
export function ossObjectStorage(config: { oss: OssConfig; cdn: CdnConfig; fetch: FetchLike; inspector: Inspector; directSign?:AttachmentObjectStorage['sign'] }): AttachmentObjectStorage {
  const { oss, cdn, fetch } = config
  const store: AttachmentObjectStorage = {
    uploadBounds: async (requestedBytes,requestedSeconds) => {
      const signed=await import('./oss.ts').then(m=>m.ossSign(oss,{method:'GET',bucketLevel:true,query:{versioning:''}}))
      const res=await fetch('https://'+oss.bucket+'.'+oss.endpointPublic+'/?'+signed.query,{headers:signed.headers})
      const body=await res.text()
      if (!res.ok || !/<VersioningConfiguration(?:\s[^>]*)?(?:\/>|>)/.test(body)
        || /<Status>\s*(Enabled|Suspended)\s*<\/Status>/.test(body)) throw new ObjectStorageError(503,'not_configured','Immutable OSS uploads require a bucket that has never enabled versioning')
      return {maxBytes:requestedBytes,expiresSeconds:requestedSeconds}
    },
    upload: (key, date, limits) => postObjectForm(oss, { key, date, maxBytes: limits?.maxBytes ?? MAX_ATTACHMENT_BYTES,
      expiresInSeconds: limits?.expiresSeconds }),
    inspect: async (key, limit, retainBytes = 512) => {
      const source = await ossSignedRequest(oss, { method: 'GET', key, internal: true })
      const { etag, ...inspected } = await config.inspector(source, limit, retainBytes)
      return { ...inspected, revision: etag }
    },
    promote: (source, destination, revision, headers) => ossCopy(oss, fetch, source, destination, revision, headers),
    put: async (key, bytes) => {
      const response = await ossRequest(oss, fetch, { method: 'PUT', key, body: bytes as BodyInit, internal: true })
      if (response.status !== 200) throw new ObjectStorageError(response.status, null, 'Could not stage attachment bytes')
    },
    exists: (key) => ossExists(oss, fetch, key),
    remove: (key) => ossDelete(oss, fetch, key),
    sign: async (key, image, now, permit) => {
      if(permit?.direct) {
        if(!config.directSign) throw new ObjectStorageError(503,'not_configured','Origin signing is not configured')
        return config.directSign(key,image,now,permit)
      }
      const signed=cdnSignedUrl(cdn,key,{image,now,rand:permit?.requestId.replace(/-/g,''),expiresSeconds:permit?.expiresSeconds})
      // Advertise the existing direct signer; never invoke it on the primary CDN path.
      return {...signed,...(permit&&config.directSign?{originAvailable:true}:{})}
    },
    invalidate: async (key, image) => { await refreshCdn(oss, fetch, cdn, key, image) },
    parts: ossMultipart(oss, fetch),
  }
  return store
}

/**
 * OSS multipart uploads, as the runtime key was probed to allow on the bucket (initiate, upload part, complete-all,
 * abort). Every key goes through `objectKey` inside the signer, so a deployment's prefix applies like everywhere else.
 */
function ossMultipart(oss: OssConfig, fetch: FetchLike): MultipartStorage {
  const answer = async (response: Response, ok: number[], what: string) => {
    const body = await response.text()
    if (!ok.includes(response.status)) {
      throw new ObjectStorageError(response.status, /<Code>([^<]+)<\/Code>/.exec(body)?.[1] ?? null, `OSS ${what}: ${response.status}`)
    }
    return body
  }
  return {
    open: async (key) => {
      const response = await ossRequest(oss, fetch, { method: 'POST', key, query: { uploads: '' }, headers: { 'x-oss-forbid-overwrite': 'true' }, internal: true })
      const id = /<UploadId>([^<]+)<\/UploadId>/.exec(await answer(response, [200], 'initiate multipart upload'))?.[1]
      if (!id) throw new ObjectStorageError(502, null, 'OSS answered a multipart upload without its id')
      return id
    },
    // The part number and upload id are in the signed query, so only these parts of this upload can be sent; the
    // length is a signed header, so a longer or shorter body is refused by OSS before it is stored.
    sign: (key, uploadId, parts) => Promise.all(parts.map(async ({ n, bytes }) => ({
      n, bytes,
      ...await ossSignedRequest(oss, { method: 'PUT', key, query: { partNumber: String(n), uploadId }, headers: { 'content-length': String(bytes) }, additional: ['content-length'] }),
    }))),
    complete: async (key, uploadId) => {
      // complete-all joins what arrived without a part list; joining again answers NoSuchUpload, an existing object
      // FileAlreadyExists. Either way the object's size decides.
      const joined = await ossRequest(oss, fetch, { method: 'POST', key, query: { uploadId }, internal: true,
        headers: { 'x-oss-complete-all': 'yes', 'x-oss-forbid-overwrite': 'true' } })
      await answer(joined, [200, 404, 409], 'complete multipart upload')
      const head = await ossRequest(oss, fetch, { method: 'HEAD', key, internal: true })
      await head.body?.cancel()
      if (head.status === 404) return null
      const size = Number(head.headers.get('content-length'))
      if (head.status !== 200 || !Number.isSafeInteger(size)) throw new ObjectStorageError(head.status === 200 ? 502 : head.status, null, `OSS HEAD ${key}: ${head.status}`)
      return size
    },
    abandon: async (key, uploadId) => {
      await answer(await ossRequest(oss, fetch, { method: 'DELETE', key, query: { uploadId }, internal: true }), [204, 404], 'abort multipart upload')
    },
  }
}

export interface SupabaseObjectConfig {
  url: string
  serviceKey: string
  bucket: string
  fetch: FetchLike
  signUpload(key: string): Promise<string>
  signDownload(key: string, seconds: number, trafficBits?:number): Promise<string>
}

/**
 * Supabase Storage has no conditional copy, so the copy pins the object version that was hashed: inspection reads the
 * version before and after one streamed GET, and promotion copies that version by id. Hashing stays in this Edge worker
 * (a hosted project has no other process), so the platform's CPU limit bounds the largest file; see docs/self-hosting.md.
 */
export function supabaseObjectStorage(config: SupabaseObjectConfig): AttachmentObjectStorage {
  const base = config.url.replace(/\/$/, '')
  const objectUrl = (key: string) => base + '/storage/v1/object/' + encodeURIComponent(config.bucket) + '/' + key.split('/').map(encodeURIComponent).join('/')
  // Header names are case-insensitive: merge through Headers so a caller's Content-Type replaces the default
  // instead of being joined into "a, b", which Storage rejects as an invalid MIME type.
  const withHeaders = (base: HeadersInit, extra?: HeadersInit) => {
    const merged = new Headers(base)
    new Headers(extra).forEach((value, name) => merged.set(name, value))
    return merged
  }
  const request = (url: string, init: RequestInit = {}) => config.fetch(url, {
    ...init, headers: withHeaders({ apikey: config.serviceKey, Authorization: 'Bearer ' + config.serviceKey }, init.headers),
  })
  const check = async (response: Response) => {
    if (!response.ok) {
      let status = response.status
      if (status === 400) {
        // Storage may return HTTP 400 with a structured 404 for a missing object.
        const detail = await response.json().catch(() => null) as { statusCode?: string | number } | null
        if (Number(detail?.statusCode) === 404) status = 404
      } else await response.body?.cancel()
      throw new ObjectStorageError(status, null, 'Supabase attachment storage request failed')
    }
  }
  const write = async (key: string, bytes: Uint8Array, headers: Record<string, string> = {}) => {
    const response = await request(objectUrl(key), {
      method: 'POST', body: bytes as BodyInit,
      headers: withHeaders({ 'content-type': 'application/octet-stream', 'x-upsert': 'true' }, headers),
    })
    await check(response)
    await response.body?.cancel()
  }
  const store: AttachmentObjectStorage = {
    uploadBounds: async (requestedBytes,_requestedSeconds) => {
      const response=await request(base+'/storage/v1/bucket/'+encodeURIComponent(config.bucket))
      await check(response)
      const metadata=await response.json() as {file_size_limit?:number|string|null}
      const maxBytes=Number(metadata.file_size_limit)
      if (!Number.isSafeInteger(maxBytes)||maxBytes<1||requestedBytes>maxBytes) {
        throw new ObjectStorageError(503,'not_configured','A finite supported provider bucket limit must cover this upload')
      }
      // Supabase signed uploads do not bind a per-object size or custom TTL. Reserve the real bucket ceiling.
      return {maxBytes,expiresSeconds:7200}
    },
    upload: async (key, now) => ({
      url: await config.signUpload(key), method: 'PUT', fields: {},
      expiresAt: new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(),
    }),
    inspect: async (key, limit, retainBytes) => {
      const version = async () => {
        const response = await request(base + '/storage/v1/object/info/' + encodeURIComponent(config.bucket) + '/' + key.split('/').map(encodeURIComponent).join('/'))
        await check(response)
        const info = await response.json() as { version?: unknown }
        if (typeof info.version !== 'string' || !info.version) throw new ObjectStorageError(503, 'not_configured', 'Supabase Storage did not report an object version')
        return info.version
      }
      const before = await version()
      const response = await request(objectUrl(key))
      await check(response)
      if (Number(response.headers.get('content-length')) > limit) {
        await response.body?.cancel()
        throw new ObjectStorageError(413, 'too_large', 'Attachment exceeds storage limit')
      }
      if (!response.body) throw new ObjectStorageError(502, null, 'Supabase Storage answered without a body')
      const inspected = await inspectFileStream(response.body, limit, retainBytes)
      if (await version() !== before) throw new ObjectStorageError(412, null, 'The object changed while it was being inspected')
      return { ...inspected, revision: before }
    },
    promote: async (source, destination, revision, headers) => {
      const named = new Headers(headers)
      const response = await request(base + '/storage/v1/object/copy', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-upsert': 'true' },
        body: JSON.stringify({ bucketId: config.bucket, sourceKey: source, sourceVersionId: revision, destinationKey: destination,
          copyMetadata: false, metadata: { mimetype: named.get('content-type') ?? 'application/octet-stream', cacheControl: named.get('cache-control') ?? undefined } }),
      })
      try { await check(response) }
      catch (error) {
        // The hashed version is gone: the staging object was replaced after inspection.
        if (error instanceof ObjectStorageError && error.status === 404) throw new ObjectStorageError(412, null, 'The inspected object version no longer exists')
        throw error
      }
      await response.body?.cancel()
    },
    put: (key, bytes) => write(key, bytes),
    exists: async (key) => {
      const response = await request(objectUrl(key), { method: 'HEAD' })
      try { await check(response) }
      catch (error) {
        if (error instanceof ObjectStorageError && error.status === 404) return false
        throw error
      }
      await response.body?.cancel()
      return true
    },
    remove: async (key) => {
      const response = await request(base + '/storage/v1/object/' + encodeURIComponent(config.bucket), {
        method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prefixes: [key] }),
      })
      await check(response)
      await response.body?.cancel()
    },
    sign: async (key, _image, now, permit) => ({
      url: await config.signDownload(key, permit?.expiresSeconds ?? CDN_SIGN_TTL_SECONDS,permit?.trafficBits), thumbUrl: null,
      expiresAt: new Date(now.getTime() + (permit?.expiresSeconds ?? CDN_SIGN_TTL_SECONDS) * 1000).toISOString(),
    }),
    invalidate: async () => { /* Supabase signed reads expire; no external CDN purge is configured. */ },
  }
  return store
}
