export class ObjectStorageError extends Error {
  constructor(readonly status: number, readonly code: string | null, message: string) { super(message) }
}

export interface ReadObject { bytes: Uint8Array; etag: string | null }
export interface InspectedObject extends ReadObject { sizeBytes: number; sha256: string }
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
  inspect?(key: string, limit: number, retainBytes?: number): Promise<InspectedObject>
  read(key: string, limit: number): Promise<ReadObject>
  promote(source: string, destination: string, read: ReadObject, headers: Record<string, string>): Promise<void>
  put(key: string, bytes: Uint8Array): Promise<void>
  exists(key: string): Promise<boolean>
  remove(key: string): Promise<void>
  sign(key: string, image: boolean, now: Date, permit?: DownloadPermit): Promise<{ url: string; thumbUrl: string | null; expiresAt: string }>
  invalidate(key: string, image: boolean): Promise<void>
}
