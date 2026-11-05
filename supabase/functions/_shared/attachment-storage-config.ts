// Which object store the attachments function uses, decided by environment variables only.
//
// - No OSS variable set     → the project's own Supabase Storage bucket (the community default).
// - Every OSS variable set  → Alibaba Cloud OSS for bytes, CDN-signed links for reads.
// - Some but not all set    → refuse. A half-configured store would accept uploads in one place and sign reads for
//                             another; failing loudly is the only safe answer.
//
// Rows already recorded with bucket_id 'oss' can only be read through the OSS configuration, so a deployment that has
// ever stored attachments on OSS must keep these variables set.
import type { CdnConfig, OssConfig } from './oss.ts'

export const OSS_ENV = [
  'OSS_REGION',
  'OSS_BUCKET',
  'OSS_ENDPOINT_INTERNAL',
  'OSS_ENDPOINT_PUBLIC',
  'OSS_ACCESS_KEY_ID',
  'OSS_ACCESS_KEY_SECRET',
  'CDN_DOMAIN',
  'CDN_AUTH_KEY_PRIMARY',
  // The edge's Type A authentication lifetime: links are signed so they expire 60 s after issue, which needs this value.
  'CDN_AUTH_TTL_SECONDS',
] as const

export type AttachmentStorageConfig =
  | { kind: 'supabase'; bucket: string }
  | { kind: 'oss'; oss: OssConfig; cdn: CdnConfig }

export class StorageConfigError extends Error {
  constructor(readonly missing: string[]) {
    super(`attachments OSS storage is partially configured; missing ${missing.join(', ')}`)
  }
}

export function attachmentStorageConfig(env: (key: string) => string | undefined): AttachmentStorageConfig {
  const get = (key: string) => (env(key) ?? '').trim()
  if (!OSS_ENV.some((key) => get(key))) {
    return { kind: 'supabase', bucket: get('GUGU_ATTACHMENTS_BUCKET') || 'attachments' }
  }
  const missing = OSS_ENV.filter((key) => !get(key))
  if (missing.length) throw new StorageConfigError([...missing])
  // Optional physical prefix that keeps environments sharing one bucket apart; logical keys in the database never change.
  const objectPrefix = get('ATTACHMENTS_OBJECT_PREFIX')
  const authTtlSeconds=Number(get('CDN_AUTH_TTL_SECONDS'))
  if (!Number.isSafeInteger(authTtlSeconds)||authTtlSeconds<1) throw new StorageConfigError(['CDN_AUTH_TTL_SECONDS'])
  return {
    kind: 'oss',
    oss: {
      objectPrefix,
      region: get('OSS_REGION'),
      bucket: get('OSS_BUCKET'),
      endpointInternal: get('OSS_ENDPOINT_INTERNAL'),
      endpointPublic: get('OSS_ENDPOINT_PUBLIC'),
      accessKeyId: get('OSS_ACCESS_KEY_ID'),
      accessKeySecret: get('OSS_ACCESS_KEY_SECRET'),
    },
    cdn: { domain: get('CDN_DOMAIN'), authKey: get('CDN_AUTH_KEY_PRIMARY'), objectPrefix, authTtlSeconds },
  }
}
