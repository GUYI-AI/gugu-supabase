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

/** One part of a multipart upload: a PUT the client sends as given, its length bound into the signature. */
export interface SignedPart { n: number; bytes: number; url: string; headers: Record<string, string> }
/**
 * Multipart uploads of one staging key, for a store that can sign each part. No method lists the store: which upload
 * belongs to a key and which parts arrived are kept in the database.
 */
export interface MultipartStorage {
  /** A new multipart upload of `key`, which may not overwrite an existing object; returns its upload id. */
  open(key: string): Promise<string>
  /** A signed PUT for each part, its length bound into the signature. */
  sign(key: string, uploadId: string, parts: Array<{ n: number; bytes: number }>): Promise<SignedPart[]>
  /**
   * Joins the parts that arrived, without overwriting, then reads the object's size. An upload that is already joined
   * or gone is not an error: the answer is the size of the object at `key`, or null when there is none.
   */
  complete(key: string, uploadId: string): Promise<number | null>
  /** Abandons an unfinished upload and frees its parts. An upload that no longer exists counts as abandoned. */
  abandon(key: string, uploadId: string): Promise<void>
}

/** Primary blob storage. Database bucket tag "oss" is retained for existing records. */
export interface AttachmentObjectStorage {
  uploadBounds(requestedBytes: number, requestedSeconds: number): Promise<{maxBytes:number;expiresSeconds:number}>
  /** `minBytes` (default 1) is the provider's lower size bound, where it enforces one. */
  upload(key: string, now: Date, limits?: { maxBytes: number; minBytes?: number; expiresSeconds: number }): Promise<UploadPlan>
  /** Whether the provider enforces an upload's size bounds itself (signed policy); otherwise only a later read checks it. */
  sizeEnforced?: boolean
  inspect(key: string, limit: number, retainBytes?: number): Promise<InspectedObject>
  /** A ranged read of the object's first `bytes` bytes and its whole size; null when there is no object. */
  head(key: string, bytes: number): Promise<{ size: number; head: Uint8Array } | null>
  /** Server-side copy of the inspected revision; a source that is no longer that revision fails with status 412. */
  promote(source: string, destination: string, revision: string, headers: Record<string, string>): Promise<void>
  put(key: string, bytes: Uint8Array): Promise<void>
  exists(key: string, signal?: AbortSignal): Promise<boolean>
  /**
   * The object's size and the provider's content checksum, from metadata alone (no bytes read); null when there is no
   * object. Only a store whose server-side copy keeps the checksum has this: a copy and its source then compare equal.
   */
  fingerprint?(key: string): Promise<{ size: number; checksum: string } | null>
  remove(key: string, signal?: AbortSignal): Promise<void>
  sign(key: string, image: boolean, now: Date, permit?: DownloadPermit): Promise<{ url: string; thumbUrl: string | null; expiresAt: string; originAvailable?: boolean }>
  /** The store signs image thumbnails (OSS image processing); a store without this signs originals only. */
  thumbnails?: true
  invalidate(key: string, image: boolean): Promise<void>
  /** Only a store that can sign each part has this; the others are always uploaded in one request. */
  parts?: MultipartStorage
}
