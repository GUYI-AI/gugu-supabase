import {
  type CdnConfig, type FetchLike, type OssConfig, CDN_SIGN_TTL_SECONDS, MAX_ATTACHMENT_BYTES,
  cdnSignedUrl, ossCopy, ossDelete, ossExists, ossGetBytes, ossRequest, postObjectForm, refreshCdn, sha256Hex,
} from './oss.ts'
import { type AttachmentObjectStorage, ObjectStorageError } from './object-storage.ts'
import { inspectFileStream } from './file-inspection.ts'

export function ossObjectStorage(config: { oss: OssConfig; cdn: CdnConfig; fetch: FetchLike; directSign?:AttachmentObjectStorage['sign'] }): AttachmentObjectStorage {
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
    inspect: async (key, limit, retainBytes) => {
      const res=await ossRequest(oss,fetch,{method:'GET',key,internal:true,headers:{'Accept-Encoding':'identity'}})
      if (!res.ok || !res.body || !res.headers.get('etag')) {
        await res.body?.cancel()
        throw new ObjectStorageError(res.status,null,'Could not inspect the reserved object')
      }
      return { ...await inspectFileStream(res.body,limit,retainBytes),etag:res.headers.get('etag') }
    },
    read: (key, limit) => ossGetBytes(oss, fetch, key, { internal: true, limit }),
    promote: async (source, destination, read, headers) => {
      if (!read.etag) throw new Error('OSS promotion requires the source ETag')
      await ossCopy(oss, fetch, source, destination, read.etag, headers)
    },
    put: async (key, bytes) => {
      const response = await ossRequest(oss, fetch, { method: 'PUT', key, body: bytes as BodyInit, internal: true })
      if (response.status !== 200) throw new ObjectStorageError(response.status, null, 'Could not stage attachment bytes')
    },
    exists: (key) => ossExists(oss, fetch, key),
    remove: (key) => ossDelete(oss, fetch, key),
    sign: async (key, image, now, permit) => {
      if(permit?.direct) {
        if(!config.directSign) throw new ObjectStorageError(503,'not_configured','Origin signing is not configured')
        return config.directSign(key,false,now,permit)
      }
      return cdnSignedUrl(cdn,key,{image,now,rand:permit?.requestId.replace(/-/g,''),expiresSeconds:permit?.expiresSeconds})
    },
    invalidate: async (key, image) => { await refreshCdn(oss, fetch, cdn, key, image) },
  }
  return store
}

export interface SupabaseObjectConfig {
  url: string
  serviceKey: string
  bucket: string
  fetch: FetchLike
  signUpload(key: string): Promise<string>
  signDownload(key: string, seconds: number, trafficBits?:number): Promise<string>
}

/** Stores the exact bytes read and hashed by the server; never re-copies mutable staging bytes. */
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
    read: async (key, limit) => {
      const response = await request(objectUrl(key))
      await check(response)
      const declared = Number(response.headers.get('content-length'))
      if (declared > limit) {
        await response.body?.cancel()
        throw new ObjectStorageError(413, 'too_large', 'Attachment exceeds storage limit')
      }
      const reader = response.body?.getReader()
      const parts: Uint8Array[] = []
      let length = 0
      if (reader) {
        try {
          for (;;) {
            const next = await reader.read()
            if (next.done) break
            length += next.value.byteLength
            if (length > limit) {
              await reader.cancel()
              throw new ObjectStorageError(413, 'too_large', 'Attachment exceeds storage limit')
            }
            parts.push(next.value)
          }
        } finally { reader.releaseLock() }
      }
      const bytes = new Uint8Array(length)
      let offset = 0
      for (const part of parts) { bytes.set(part, offset); offset += part.byteLength }
      return { bytes, etag: response.headers.get('etag') }
    },
    inspect: async (key, limit) => {
      const read=await store.read(key,limit)
      return { ...read,sizeBytes:read.bytes.byteLength,sha256:await sha256Hex(read.bytes) }
    },
    promote: async (_source, destination, read, headers) => write(destination, read.bytes, headers),
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
