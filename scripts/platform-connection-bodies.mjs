import { createHash, createHmac } from 'node:crypto'

// Server-side reads of legacy connection body files for the cutover tool. Bytes are
// only returned to the caller, which verifies them against the recorded SHA-256;
// nothing here logs object names, bodies, keys or provider responses.
const fail = code => { throw Object.assign(new Error(code), { code }) }
export const connectionBodyOssEnv = Object.freeze(['OSS_REGION', 'OSS_BUCKET', 'OSS_ENDPOINT_PUBLIC', 'OSS_ACCESS_KEY_ID', 'OSS_ACCESS_KEY_SECRET'])

/** Locations of legacy bodies, accepted only under the rule the legacy commit enforced:
 * a file in the private DM of exactly this owner and their provisioned assistant. */
export async function connectionBodyLocations(db, ownerId, assistantId, bodyIds) {
  if (!bodyIds.length) return new Map()
  const { rows } = await db.query(`SELECT w.id::text AS id,b.bucket_id,b.object_name,b.size_bytes::text AS size_bytes,b.state
    FROM unnest($3::uuid[]) ref(id)
    JOIN chat.workspace_items w ON w.id=ref.id AND w.kind='file'
    JOIN chat.chats c ON c.id=w.chat_id AND c.kind='dm'
    JOIN chat.file_blobs b ON b.id=w.blob_id
    WHERE EXISTS (SELECT 1 FROM chat.chat_members m WHERE m.chat_id=c.id AND m.user_id=$1::text)
      AND EXISTS (SELECT 1 FROM chat.chat_members a WHERE a.chat_id=c.id AND a.user_id=$2::text)
      AND NOT EXISTS (SELECT 1 FROM chat.chat_members o WHERE o.chat_id=c.id AND o.user_id NOT IN ($1::text,$2::text))
      AND EXISTS (SELECT 1 FROM identity.agent_provisions p WHERE p.agent_user_id=$2::text AND p.dm_chat_id=c.id AND p.owner_user_id=$1::text)`,
  [ownerId, assistantId, bodyIds])
  return new Map(rows.map(row => [row.id, { bucketId: row.bucket_id, objectName: row.object_name,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes), live: row.state === 'live' }]))
}

const uriEncode = (value, keepSlash = false) => {
  const encoded = encodeURIComponent(value).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
  return keepSlash ? encoded.replace(/%2F/g, '/') : encoded
}
const hmac = (key, data) => createHmac('sha256', key).update(data, 'utf8').digest()

/** Same physical key mapping as supabase/functions/_shared/oss.ts objectKey. */
export function connectionOssObjectKey(cfg, key) {
  const prefix = cfg.objectPrefix ?? ''
  if (!prefix) return key
  if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(prefix)) fail('CONNECTION_BODY_STORAGE_INVALID_PREFIX')
  return `${prefix}/${key}`
}

/** OSS V4 header signature for an unsigned-payload GET, identical to ossSign in
 * supabase/functions/_shared/oss.ts for that request (checked by a unit test). */
export function connectionOssGet(cfg, key, date) {
  const ts = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''), day = ts.slice(0, 8)
  const objectKey = connectionOssObjectKey(cfg, key)
  const canonical = ['GET', uriEncode(`/${cfg.bucket}/${objectKey}`, true), '',
    `x-oss-content-sha256:UNSIGNED-PAYLOAD\nx-oss-date:${ts}\n`, '', 'UNSIGNED-PAYLOAD'].join('\n')
  const scope = `${day}/${cfg.region}/oss/aliyun_v4_request`
  const stringToSign = ['OSS4-HMAC-SHA256', ts, scope, createHash('sha256').update(canonical, 'utf8').digest('hex')].join('\n')
  let signingKey = hmac('aliyun_v4' + cfg.accessKeySecret, day)
  for (const part of [cfg.region, 'oss', 'aliyun_v4_request']) signingKey = hmac(signingKey, part)
  const signature = hmac(signingKey, stringToSign).toString('hex')
  return {
    url: `https://${cfg.bucket}.${cfg.endpoint}/${uriEncode(objectKey, true)}`,
    headers: { 'Accept-Encoding': 'identity', 'x-oss-content-sha256': 'UNSIGNED-PAYLOAD', 'x-oss-date': ts,
      Authorization: `OSS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope},Signature=${signature}` },
  }
}

async function boundedBytes(response, limit) {
  if (!response.ok) { await response.body?.cancel(); fail('CONNECTION_BODY_UNAVAILABLE') }
  const declared = Number(response.headers.get('content-length') ?? 'NaN')
  if (Number.isFinite(declared) && declared > limit) { await response.body?.cancel(); fail('CONNECTION_BODY_TOO_LARGE') }
  const chunks = []
  let total = 0
  const reader = response.body?.getReader()
  if (!reader) fail('CONNECTION_BODY_UNAVAILABLE')
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) { await reader.cancel(); fail('CONNECTION_BODY_TOO_LARGE') }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}

/** Reads a body location with service credentials taken from the environment, using the
 * same variables as the attachments function. 'workspace' rows live in that Supabase
 * Storage bucket; 'oss' rows live in OSS when it is configured, else in the primary bucket. */
export function connectionBodyStore(env = process.env, { fetch = globalThis.fetch, now = () => new Date(), timeoutMs = 15_000 } = {}) {
  const value = key => (env[key] ?? '').trim()
  const configured = connectionBodyOssEnv.filter(key => value(key))
  if (configured.length && configured.length !== connectionBodyOssEnv.length) fail('CONNECTION_BODY_STORAGE_PARTIAL_OSS')
  const oss = configured.length ? { region: value('OSS_REGION'), bucket: value('OSS_BUCKET'), endpoint: value('OSS_ENDPOINT_PUBLIC'),
    accessKeyId: value('OSS_ACCESS_KEY_ID'), accessKeySecret: value('OSS_ACCESS_KEY_SECRET'), objectPrefix: value('ATTACHMENTS_OBJECT_PREFIX') } : null
  const primary = value('GUGU_ATTACHMENTS_BUCKET') || 'attachments'
  return async function readBody(location, limit) {
    if (!location?.live || typeof location.objectName !== 'string' || !location.objectName) fail('CONNECTION_BODY_UNAVAILABLE')
    if (location.sizeBytes !== null && location.sizeBytes > limit) fail('CONNECTION_BODY_TOO_LARGE')
    const signal = AbortSignal.timeout(timeoutMs)
    if (location.bucketId === 'oss' && oss) {
      const request = connectionOssGet(oss, location.objectName, now())
      return boundedBytes(await fetch(request.url, { headers: request.headers, signal }), limit)
    }
    const bucket = location.bucketId === 'oss' ? primary : location.bucketId === 'workspace' ? 'workspace' : null
    if (!bucket) fail('CONNECTION_BODY_UNAVAILABLE')
    const base = value('SUPABASE_URL').replace(/\/$/, ''), key = value('SUPABASE_SERVICE_ROLE_KEY')
    if (!/^https?:\/\//.test(base) || !key) fail('CONNECTION_BODY_STORAGE_NOT_CONFIGURED')
    const url = `${base}/storage/v1/object/${encodeURIComponent(bucket)}/${location.objectName.split('/').map(encodeURIComponent).join('/')}`
    return boundedBytes(await fetch(url, { headers: { apikey: key, Authorization: 'Bearer ' + key }, signal }), limit)
  }
}
