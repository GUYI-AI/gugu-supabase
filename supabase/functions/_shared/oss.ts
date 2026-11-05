// 附件的字节在阿里云 OSS 私有桶里、经 CDN 读(gugu-base notes/2026-10-15-attachments-into-folder/设计.md §12;实测
// gugu-base evidence/2026-10-16-oss-cdn-probe/)。这里是 attachments 函数要的那几样,只用 WebCrypto 与 fetch,所以在
// edge runtime(Deno)和单元测试(Node)里是同一份代码:
//   · OSS V4 签名(OSS4-HMAC-SHA256,签名不含 Host:同一个签名走内网、外网端点都能用);
//   · PostObject 表单(V4 policy):key 定死、大小由 OSS 管 —— 客户端直传,字节不经过库机;
//   · GET / HEAD / CopyObject / DeleteObject;
//   · CDN 鉴权方式 A(auth_key = 时间戳-随机数-uid-md5),只签路径,所以一次签名原图和缩略图(x-oss-process)都能用;
//   · 阿里云 OpenAPI V3(ACS3-HMAC-SHA256)调 CDN 的 RefreshObjectCaches。
// 钥匙只从调用方传进来的配置里读,这里不读环境、不打日志。

import { md5Hex } from './md5.ts'
import { ObjectStorageError } from './object-storage.ts'

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
export const IMMUTABLE = 'public, max-age=31536000, immutable'
/** 气泡里的缩略图:宽 560、webp(OSS 图片处理现做,CDN 按这个参数各缓存一份)。 */
export const THUMB_PROCESS = 'image/resize,w_560/format,webp'
/** CDN 鉴权 A 的有效期(在 CDN 上配的;签名只带签发时间,过期由 CDN 判)。 */
export const CDN_SIGN_TTL_SECONDS = 1800

export interface OssConfig {
  objectPrefix?: string
  region: string
  bucket: string
  endpointInternal: string
  endpointPublic: string
  accessKeyId: string
  accessKeySecret: string
}
export interface CdnConfig {
  objectPrefix?: string
  domain: string
  authKey: string
  /** Must equal the validity period configured at the CDN edge. */
  authTtlSeconds: number
}
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** The database keeps logical keys; each environment maps them to its own physical directory. */
export function objectKey(config: { objectPrefix?: string }, key: string): string {
  const prefix = config.objectPrefix ?? ''
  if (!prefix) return key
  if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(prefix)) throw new Error('Invalid attachment object prefix')
  return `${prefix}/${key}`
}

export class OssError extends ObjectStorageError {}

const enc = new TextEncoder()
const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')

async function hmac(key: string | Uint8Array, data: string): Promise<Uint8Array> {
  const raw = typeof key === 'string' ? enc.encode(key) : key
  const k = await crypto.subtle.importKey('raw', raw as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(data)))
}

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', (typeof data === 'string' ? enc.encode(data) : data) as BufferSource))
}

/** RFC 3986:除了 A–Z a–z 0–9 - _ . ~ 都编码;路径里的 / 可以留着。 */
export function uriEncode(s: string, keepSlash = false): string {
  const e = encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
  return keepSlash ? e.replace(/%2F/g, '/') : e
}

/** 20250411T064124Z */
export function isoBasic(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

const byName = (a: [string, string | null], b: [string, string | null]) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)

export async function v4SigningKey(secret: string, day: string, region: string): Promise<Uint8Array> {
  let k = await hmac('aliyun_v4' + secret, day)
  k = await hmac(k, region)
  k = await hmac(k, 'oss')
  return hmac(k, 'aliyun_v4_request')
}

export interface SignedRequest {
  headers: Record<string, string>
  /** 规范化以后的查询串(已编码,可以直接接在 URL 后面)。 */
  query: string
  canonical: string
  signature: string
}

/** OSS V4 请求头签名。Host 不在规范请求里。 */
export async function ossSign(cfg: OssConfig, req: {
  method: string
  key?: string
  bucketLevel?: boolean
  query?: Record<string, string>
  headers?: Record<string, string>
  additional?: string[]
  date?: Date
}): Promise<SignedRequest> {
  const ts = isoBasic(req.date ?? new Date())
  const day = ts.slice(0, 8)
  const h: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers ?? {})) h[k.toLowerCase()] = String(v).trim()
  h['x-oss-content-sha256'] = 'UNSIGNED-PAYLOAD'
  h['x-oss-date'] = ts
  const add = (req.additional ?? []).map((x) => x.toLowerCase()).sort()
  const names = Object.keys(h).filter((k) => k === 'content-type' || k === 'content-md5' || k.startsWith('x-oss-') || add.includes(k)).sort()
  const canonHeaders = names.map((k) => `${k}:${h[k]}\n`).join('')
  const resource = req.bucketLevel ? `/${cfg.bucket}/` : `/${cfg.bucket}/${objectKey(cfg, req.key ?? '')}`
  const query = Object.entries(req.query ?? {})
    .map(([k, v]): [string, string | null] => [uriEncode(k), v === '' || v == null ? null : uriEncode(String(v))])
    .sort(byName)
    .map(([k, v]) => (v == null ? k : `${k}=${v}`))
    .join('&')
  const canonical = [req.method, uriEncode(resource, true), query, canonHeaders, add.join(';'), 'UNSIGNED-PAYLOAD'].join('\n')
  const scope = `${day}/${cfg.region}/oss/aliyun_v4_request`
  const stringToSign = ['OSS4-HMAC-SHA256', ts, scope, await sha256Hex(canonical)].join('\n')
  const signature = hex(await hmac(await v4SigningKey(cfg.accessKeySecret, day, cfg.region), stringToSign))
  const authorization = `OSS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope},${add.length ? `AdditionalHeaders=${add.join(';')},` : ''}Signature=${signature}`
  return {
    headers: { ...(req.headers ?? {}), 'x-oss-content-sha256': 'UNSIGNED-PAYLOAD', 'x-oss-date': ts, Authorization: authorization },
    query,
    canonical,
    signature,
  }
}

export interface PostForm {
  url: string
  fields: Record<string, string>
  expiresAt: string
}

/**
 * 客户端直传用的 PostObject 表单:key 定死,content-length-range 由 OSS 执行(多 1 字节回 400 EntityTooLarge)。
 * x-oss-forbid-overwrite:暂存对象写进去以后同一张表单不能再换掉它(重传回 409 FileAlreadyExists,客户端当作已经传好)——
 * 否则提交读完、复制之前能换内容(复核 L11 实测,gugu-base notes/reviews/2026-10-16-attachments-fn-sb126-982ebb88.md)。
 */
export async function postObjectForm(cfg: OssConfig, opts: { key: string; maxBytes?: number; expiresInSeconds?: number; date?: Date }): Promise<PostForm> {
  const key = objectKey(cfg, opts.key)
  const date = opts.date ?? new Date()
  const ts = isoBasic(date)
  const day = ts.slice(0, 8)
  const credential = `${cfg.accessKeyId}/${day}/${cfg.region}/oss/aliyun_v4_request`
  const expiresAt = new Date(date.getTime() + (opts.expiresInSeconds ?? 900) * 1000).toISOString()
  const policy = {
    expiration: expiresAt,
    conditions: [
      { bucket: cfg.bucket },
      { 'x-oss-signature-version': 'OSS4-HMAC-SHA256' },
      { 'x-oss-credential': credential },
      { 'x-oss-date': ts },
      ['content-length-range', 1, opts.maxBytes ?? MAX_ATTACHMENT_BYTES],
      ['eq', '$key', key],
      { 'x-oss-forbid-overwrite': 'true' },
    ],
  }
  const encoded = btoa(String.fromCharCode(...enc.encode(JSON.stringify(policy))))
  const signature = hex(await hmac(await v4SigningKey(cfg.accessKeySecret, day, cfg.region), encoded))
  return {
    url: `https://${cfg.bucket}.${cfg.endpointPublic}/`,
    fields: {
      key,
      policy: encoded,
      'x-oss-signature-version': 'OSS4-HMAC-SHA256',
      'x-oss-credential': credential,
      'x-oss-date': ts,
      'x-oss-signature': signature,
      'x-oss-forbid-overwrite': 'true',
    },
    expiresAt,
  }
}

function errorOf(status: number, body: string): OssError {
  const tag = (t: string) => new RegExp(`<${t}>([^<]*)</${t}>`).exec(body)?.[1] ?? null
  const code = tag('Code')
  return new OssError(status, code, `OSS ${status}${code ? ` ${code}` : ''}${tag('Message') ? `: ${tag('Message')!.slice(0, 160)}` : ''}`)
}

/** 一次签好名的 OSS 请求。internal = 走同地域内网端点(库机读暂存对象,内网流量不收费)。 */
export async function ossRequest(cfg: OssConfig, fetchFn: FetchLike, req: {
  method: string
  key: string
  headers?: Record<string, string>
  body?: BodyInit
  internal?: boolean
  query?: Record<string, string>
}): Promise<Response> {
  const signed = await ossSign(cfg, { method: req.method, key: req.key, headers: req.headers, query: req.query })
  const endpoint = req.internal ? cfg.endpointInternal : cfg.endpointPublic
  const url = `https://${cfg.bucket}.${endpoint}/${uriEncode(objectKey(cfg, req.key), true)}${signed.query ? '?' + signed.query : ''}`
  return fetchFn(url, { method: req.method, headers: signed.headers, body: req.body })
}

/** 读一个对象的全部字节(上限 limit,多一个字节就停、报错)和它的 ETag。附件最大 25 MiB,整份读进内存。 */
export async function ossGetBytes(cfg: OssConfig, fetchFn: FetchLike, key: string, opts: { internal?: boolean; limit?: number } = {}): Promise<{ bytes: Uint8Array; etag: string }> {
  const res = await ossRequest(cfg, fetchFn, { method: 'GET', key, internal: opts.internal, headers: { 'Accept-Encoding': 'identity' } })
  if (res.status !== 200) throw errorOf(res.status, await res.text())
  const limit = opts.limit ?? MAX_ATTACHMENT_BYTES
  const declared = Number(res.headers.get('content-length') ?? 'NaN')
  if (Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel()
    throw new OssError(413, 'EntityTooLarge', `object ${key} is ${declared} bytes, over ${limit}`)
  }
  const etag = res.headers.get('etag')
  if (!etag) {
    await res.body?.cancel()
    throw new OssError(502, null, `OSS GET ${key} answered without an ETag`)
  }
  const bytes = new Uint8Array(await res.arrayBuffer())
  if (bytes.length > limit) throw new OssError(413, 'EntityTooLarge', `object ${key} is ${bytes.length} bytes, over ${limit}`)
  return { bytes, etag }
}

/** 对象在不在(200 / 404);别的状态报错。 */
export async function ossExists(cfg: OssConfig, fetchFn: FetchLike, key: string): Promise<boolean> {
  const res = await ossRequest(cfg, fetchFn, { method: 'HEAD', key })
  await res.body?.cancel()
  if (res.status === 200) return true
  if (res.status === 404) return false
  throw new OssError(res.status, null, `OSS HEAD ${key}: ${res.status}`)
}

/**
 * 服务端复制(字节不出机房),元数据按 headers 换(Content-Type、Cache-Control、Content-Disposition)。
 * sourceEtag:只在源对象还是读到的那一份时才复制,换过了 OSS 回 412 PreconditionFailed —— 复制过去的一定是算过哈希的字节。
 */
export async function ossCopy(cfg: OssConfig, fetchFn: FetchLike, src: string, dst: string, sourceEtag: string, headers: Record<string, string>): Promise<void> {
  const res = await ossRequest(cfg, fetchFn, {
    method: 'PUT',
    key: dst,
    headers: {
      'x-oss-copy-source': `/${cfg.bucket}/${uriEncode(objectKey(cfg, src), true)}`,
      'x-oss-copy-source-if-match': sourceEtag,
      'x-oss-metadata-directive': 'REPLACE',
      ...headers,
    },
  })
  const body = await res.text()
  if (res.status !== 200) throw errorOf(res.status, body)
}

/** 删一个对象;本来就没有(204 / 404)也算删了。 */
export async function ossDelete(cfg: OssConfig, fetchFn: FetchLike, key: string): Promise<void> {
  const res = await ossRequest(cfg, fetchFn, { method: 'DELETE', key })
  const body = await res.text()
  if (res.status !== 204 && res.status !== 200 && res.status !== 404) throw errorOf(res.status, body)
}

/** CDN 鉴权方式 A:auth_key = ts-rand-uid-md5("/路径-ts-rand-uid-密钥");只签路径,不签查询参数。uid 用 0(UUID 里的「-」会把格式弄坏)。 */
export function cdnAuthKey(path: string, key: string, opts: { ts: number; rand: string; uid?: string }): string {
  const uid = opts.uid ?? '0'
  return `${opts.ts}-${opts.rand}-${uid}-${md5Hex(`${path}-${opts.ts}-${opts.rand}-${uid}-${key}`)}`
}

export interface CdnUrl {
  url: string
  /** 图片才有:同一个签名加上 x-oss-process。 */
  thumbUrl: string | null
  expiresAt: string
}

/** 一个对象的 CDN 签名链接;签发时间用服务器时钟(CDN 也认将来的时间戳,所以这里的钟要准 —— 依赖 NTP)。 */
export function cdnSignedUrl(cdn: CdnConfig, objectName: string, opts: { image: boolean; now?: Date; rand?: string; expiresSeconds?: number }): CdnUrl {
  const now = opts.now ?? new Date()
  const edgeTtl=cdn.authTtlSeconds
  const lifetime=opts.expiresSeconds??edgeTtl
  if (!Number.isSafeInteger(edgeTtl)||!Number.isSafeInteger(lifetime)||lifetime<1||lifetime>edgeTtl) throw new Error('Invalid CDN signature lifetime')
  // Type A expires at timestamp + the edge-configured TTL, not at a JSON expires_at field.
  const ts = Math.floor(now.getTime() / 1000)+lifetime-edgeTtl
  const rand = opts.rand ?? crypto.randomUUID().replace(/-/g, '')
  const path = `/${objectKey(cdn, objectName)}`
  const url = `https://${cdn.domain}${uriEncode(path, true)}?auth_key=${cdnAuthKey(path, cdn.authKey, { ts, rand })}`
  return {
    url,
    thumbUrl: opts.image ? `${url}&x-oss-process=${THUMB_PROCESS}` : null,
    expiresAt: new Date((ts + edgeTtl) * 1000).toISOString(),
  }
}

/** 阿里云 OpenAPI V3(ACS3-HMAC-SHA256),RPC 风格:参数在查询串里,空 body。 */
export async function acsCall(cfg: OssConfig, fetchFn: FetchLike, req: {
  action: string
  params: Record<string, string>
  host?: string
  version?: string
  date?: Date
  nonce?: string
}): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const host = req.host ?? 'cdn.aliyuncs.com'
  const payloadHash = await sha256Hex('')
  const headers: Record<string, string> = {
    host,
    'x-acs-action': req.action,
    'x-acs-content-sha256': payloadHash,
    'x-acs-date': (req.date ?? new Date()).toISOString().replace(/\.\d{3}/, ''),
    'x-acs-signature-nonce': req.nonce ?? crypto.randomUUID().replace(/-/g, ''),
    'x-acs-version': req.version ?? '2018-05-10',
  }
  const names = Object.keys(headers).sort()
  const canonHeaders = names.map((k) => `${k}:${headers[k]}\n`).join('')
  const query = Object.entries(req.params)
    .map(([k, v]): [string, string] => [uriEncode(k), uriEncode(String(v))])
    .sort(byName)
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
  const canonical = ['POST', '/', query, canonHeaders, names.join(';'), payloadHash].join('\n')
  const signature = hex(await hmac(cfg.accessKeySecret, `ACS3-HMAC-SHA256\n${await sha256Hex(canonical)}`))
  const { host: _host, ...send } = headers
  const res = await fetchFn(`https://${host}/?${query}`, {
    method: 'POST',
    headers: { ...send, Authorization: `ACS3-HMAC-SHA256 Credential=${cfg.accessKeyId},SignedHeaders=${names.join(';')},Signature=${signature}` },
  })
  const text = await res.text()
  let json: Record<string, unknown> | null = null
  try {
    json = JSON.parse(text) as Record<string, unknown>
  } catch {
    json = null
  }
  return { status: res.status, json }
}

/**
 * 删了对象以后清 CDN 边缘缓存(只是清理:签名先于缓存验,不再签新链接以后 1800 s 谁也拿不到)。实测:按普通 URL 刷只清原图,
 * 带 x-oss-process 的缩略图清不掉;IgnoreParams 连同所有参数变体一起清(每天默认 100 次)。所以图片用 IgnoreParams,别的用 File。
 * 回 RefreshTaskId(不等它完成,也不查状态)。
 */
export async function refreshCdn(cfg: OssConfig, fetchFn: FetchLike, cdn: CdnConfig, objectName: string, image: boolean): Promise<string | null> {
  const r = await acsCall(cfg, fetchFn, {
    action: 'RefreshObjectCaches',
    params: { ObjectPath: `https://${cdn.domain}/${objectKey(cdn, objectName)}`, ObjectType: image ? 'IgnoreParams' : 'File' },
  })
  if (r.status >= 300) {
    throw new OssError(r.status, typeof r.json?.Code === 'string' ? r.json.Code : null, `CDN refresh ${r.status}: ${String(r.json?.Message ?? '').slice(0, 160)}`)
  }
  return typeof r.json?.RefreshTaskId === 'string' ? r.json.RefreshTaskId : null
}
