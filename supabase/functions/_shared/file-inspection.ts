import { createHash } from 'node:crypto'
import { ObjectStorageError } from './object-storage.ts'

/** Hash the full bounded stream, retaining only the bytes the caller needs to inspect. */
export async function inspectFileStream(body: ReadableStream<Uint8Array>, limit: number, retainBytes = 512) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid inspection limit')
  if (!Number.isSafeInteger(retainBytes) || retainBytes < 512) throw new Error('Invalid inspection prefix size')
  const reader = body.getReader()
  const hash = createHash('sha256')
  const prefix = new Uint8Array(Math.min(limit, retainBytes))
  let sizeBytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (sizeBytes + value.byteLength > limit) {
        await reader.cancel()
        throw new ObjectStorageError(413, 'too_large', 'File exceeds its upload reservation')
      }
      if (sizeBytes < prefix.length) prefix.set(value.subarray(0, prefix.length - sizeBytes), sizeBytes)
      sizeBytes += value.byteLength
      hash.update(value)
    }
    return { sizeBytes, sha256: hash.digest('hex'),
      bytes: prefix.subarray(0, Math.min(sizeBytes, prefix.length)) }
  } finally { reader.releaseLock() }
}

/** A signed request that reads one object; whoever holds it can read that object and nothing else. */
export interface InspectSource { url: string; headers: Record<string, string> }
export type Inspector = (source: InspectSource, limit: number, retainBytes: number) =>
  Promise<{ bytes: Uint8Array; sizeBytes: number; sha256: string; etag: string }>

/**
 * Inspection in the file service (services/files POST /inspect): an Edge worker has a 2-second CPU budget, and the
 * SHA-256 of a large attachment alone exceeds it. Missing configuration refuses as not_configured; there is no local path.
 */
export function fileServiceInspector(config: { url: string; secret: string; fetch: (input: string, init?: RequestInit) => Promise<Response> }): Inspector {
  return async (source, limit, retainBytes) => {
    if (!config.url || !config.secret) {
      throw new ObjectStorageError(503, 'not_configured', 'Attachment inspection requires GUGU_FILES_INSPECT_URL and GUGU_FILES_INSPECT_SECRET')
    }
    const res = await config.fetch(config.url.replace(/\/$/, '') + '/inspect', {
      method: 'POST', headers: { Authorization: 'Bearer ' + config.secret, 'content-type': 'application/json' },
      body: JSON.stringify({ source, limit, retain: retainBytes }), signal: AbortSignal.timeout(330_000),
    })
    if (res.status !== 200) {
      const answer = await res.json().catch(() => null) as { error?: string } | null
      if (res.status === 404) throw new ObjectStorageError(404, null, 'The object to inspect is missing')
      if (res.status === 413) throw new ObjectStorageError(413, 'too_large', 'File exceeds its upload reservation')
      if (res.status === 401 || res.status === 503) {
        throw new ObjectStorageError(503, 'not_configured', `The file service refused inspection (${answer?.error ?? res.status})`)
      }
      throw new ObjectStorageError(502, null, `The file service could not inspect the object (${answer?.error ?? res.status})`)
    }
    const sha256 = res.headers.get('x-gugu-sha256') ?? '', sizeBytes = Number(res.headers.get('x-gugu-size')), etag = res.headers.get('x-gugu-etag')
    const bytes = new Uint8Array(await res.arrayBuffer())
    if (!/^[0-9a-f]{64}$/.test(sha256) || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > limit || !etag
      || bytes.byteLength !== Math.min(sizeBytes, limit, retainBytes)) throw new Error('The file service answered an inconsistent inspection')
    return { bytes, sizeBytes, sha256, etag }
  }
}
