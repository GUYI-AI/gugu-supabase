export class ObjectStorageError extends Error {
  constructor(readonly status: number, readonly code: string | null, message: string) { super(message) }
}

/**
 * One complete streamed read of an object: its size and SHA-256, at most `retainBytes` of its prefix, and the provider's
 * revision of exactly the bytes read (OSS ETag, Supabase object version). Promotion copies that revision or nothing.
 */
export interface InspectedObject { bytes: Uint8Array; sizeBytes: number; sha256: string; revision: string }
export interface DownloadPermit { requestId: string; expiresSeconds: number; trafficBits?: number; direct?: boolean; }
export interface UploadPlan {
  url: string
  fields: Record<string, string>
  expiresAt: string
  method?: 'POST' | 'PUT'
  headers?: Record<string, string>
}

/** Primary blob storage. Database bucket tag "oss" is retained for existing records. */
export interface AttachmentObjectStorage {
  uploadBounds(requestedBytes: number, requestedSeconds: number): Promise<{maxBytes:number;expiresSeconds:number}>
  upload(key: string, now: Date, limits?: { maxBytes: number; expiresSeconds: number }): Promise<UploadPlan>
  inspect(key: string, limit: number, retainBytes?: number): Promise<InspectedObject>
  /** Server-side copy of the inspected revision; a source that is no longer that revision fails with status 412. */
  promote(source: string, destination: string, revision: string, headers: Record<string, string>): Promise<void>
  put(key: string, bytes: Uint8Array): Promise<void>
  exists(key: string): Promise<boolean>
  remove(key: string): Promise<void>
  sign(key: string, image: boolean, now: Date, permit?: DownloadPermit): Promise<{ url: string; thumbUrl: string | null; expiresAt: string; originAvailable?: boolean }>
  invalidate(key: string, image: boolean): Promise<void>
}
