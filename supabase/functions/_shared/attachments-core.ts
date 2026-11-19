// attachments 函数的逻辑(gugu-base notes/2026-10-15-attachments-into-folder/设计.md §3.4、§3.5;库那一半在
// gugu-supabase 20261016104500_file_blobs、20261016105500_message_file_refs)。依赖从外面传进来(OSS 配置、fetch、
// 以调用者身份和以 service_role 调库、Supabase 存储),所以单元测试在 Node 里用假的 OSS 和库跑同一份代码。
//
//   POST upload   → A quota-scoped immutable staging upload permit with provider-enforced size and lifetime bounds.
//   POST commit   → With sha256: declare the pending file and its keep, then attachment_commit sends its message before the bytes.
//                   Without sha256: hash, promote and register staged bytes before attachment_commit.
//   POST finish   → Hash and promote bytes, settle the declaration with its receipt/quota and declared keep atomically.
//                   Staging stays immutable until permit cleanup; declared settle includes registration in its transaction.
//   POST forward  → 以调用者的身份 attachment_forward。
//   POST share    → 群文件夹里的文件按引用发:文本文件先定成带字节的一版(attachment_document_snapshot),再 attachment_share。
//   POST urls     → 以调用者的身份 file_urls_as(条目的某一版,或悄悄话附件那条消息),再签:OSS 的走 CDN 鉴权 A(图片另给缩略图链接),老对象走存储的签名链接。
//   POST gc       → 只认 service_role(pg_cron + pg_net 每 10 分钟叫一次):领一批该回收的,删对象、清 CDN、报完成 / 失败。

import { ossObjectStorage } from './attachment-object-storage.ts'
import { type AttachmentObjectStorage, type MultipartStorage, ObjectStorageError, type InspectedObject } from './object-storage.ts'
import type { Inspector } from './file-inspection.ts'
import { hasThumbnail, objectHeaders, sniff } from './blob-sniff.ts'
import { fileRef, handleFileDownload } from './file-transfer-core.ts'
import {
  CDN_SIGN_TTL_SECONDS,
  type CdnConfig,
  type FetchLike,
  IMMUTABLE,
  type OssConfig,
} from './oss.ts'

export interface DbError {
  message: string
  hint?: string | null
  code?: string | null
  details?: string | null
  /** The HTTP status PostgREST answered with; 0 when the request never reached it. */
  status?: number
}
export type Rpc = (fn: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<{ data: unknown; error: DbError | null }>

export interface AttachmentsDeps {
  /** The same classifier used for local files and App data, pinned by the Edge entry point. */
  textFiles: {
    maxBytes: number
    classify(name: string, contentType: string | null, bytes: Uint8Array):
      { kind: 'document'; text: string; contentType: string } | { kind: 'file'; why: string }
  }
  objects?: AttachmentObjectStorage
  oss?: OssConfig
  cdn?: CdnConfig
  /** With oss/cdn: who reads staged bytes (the file service). */
  inspector?: Inspector
  fetch: FetchLike
  /** 以调用者自己的令牌调 chat 里的函数(群规、成员、RLS 全照调用者)。 */
  userRpc: Rpc
  /** 以 service_role 调(登记上传、领回收任务)。 */
  serviceRpc: Rpc
  /** 老对象(Supabase 存储里的 workspace / chat-media 桶):签名链接(本栈公网域上的,客户端拿得到)、删除。 */
  storageSignedUrl(bucket: string, object: string, seconds: number, trafficBits?:number): Promise<string>
  storageRemove(bucket: string, object: string): Promise<void>
  now(): Date
  uuid(): string
  log(stage: string, extra?: Record<string, unknown>): void
  /** 撞上正在回收的 blob 时,重试之间等多久(测试里给 0)。 */
  retryDelayMs?: number
  /** Drain/finish an inspected incoming replacement, using the original caller's authorization. */
  documentReplacement?(item: string, actor: string, body: { key: string; expected: number; finish: boolean }): Promise<void>
  /** A text document's text as it is now, from the file service with the caller's authorization (`asAgent`: as their agent). */
  documentText?(item: string, asAgent: string | null): Promise<string>
}

export function objectStorage(deps: AttachmentsDeps): AttachmentObjectStorage {
  if (deps.objects) return deps.objects
  if (!deps.oss || !deps.cdn || !deps.inspector) throw new Error('Attachment object storage is not configured')
  return ossObjectStorage({ oss: deps.oss, cdn: deps.cdn, fetch: deps.fetch, inspector: deps.inspector })
}

/** 说给调用者听的拒绝:HTTP 状态 + 机读的 code + 一句话。 */
export class Refusal extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: string) {
    super(message)
  }
}

const STAGING = /^staging\/([^/]+)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,127}$/

/**
 * 库的拒绝按 HINT 认:状态码和 code。群文件夹自己的拒绝(workspace_* 那一套,20261016012659 / 20261017194409)照它的 HINT
 * 原样作 code、400 —— 客户端认的正是这一套(gugu app-files-core 的 FOLDER_CODES);认不出的(包括群规、RLS)照原话、
 * 500 以外按 400 / 403 分。
 */
export function refusalFromDb(error: DbError): Refusal {
  if (error.hint?.startsWith('file_transfer_')) {
    const code=error.hint.slice('file_transfer_'.length)
    const status=code==='invalid'?400:code.endsWith('_full')||code==='rate_limited'?429:code==='denied'?403:code==='expired'?410:
      ['not_configured','inventory_required','paused','unavailable'].includes(code)?503:code==='too_large'?413:409
    return new Refusal(status,code,error.message)
  }
  const byHint: Record<string, [number, string]> = {
    session_attachment_denied: [403, 'denied'],
    attachment_upload_not_found: [404, 'upload_not_found'],
    attachment_upload_used: [409, 'upload_used'],
    attachment_source_not_found: [404, 'source_not_found'],
    attachment_source_gone: [410, 'source_gone'],
    file_blob_deleting: [503, 'retry'],
    file_too_large: [413, 'too_large'],
    message_file_not_here: [400, 'invalid'],
    message_file_envelope: [400, 'invalid'],
    message_file_fixed: [400, 'invalid'],
    file_place_invalid: [400, 'invalid'],
    attachment_forward_needs_bytes: [400, 'needs_bytes'],
    workspace_version_conflict: [409, 'version_conflict'],
  }
  // #2383: a recipient that never sat in the chat. A permanent refusal (400, never retried); details carries
  // the offending ids from the database, comma-separated, so the caller can name them.
  if (error.hint === 'recipient_not_member') {
    return new Refusal(400, 'recipient_not_member', error.message, error.details ?? undefined)
  }
  const hit = error.hint ? byHint[error.hint] : undefined
  if (hit) return new Refusal(hit[0], hit[1], error.message)
  if (error.hint?.startsWith('workspace_')) return new Refusal(400, error.hint, error.message)
  if (/not a chat you are a member of|Not allowed to act as|row-level security|permission denied/i.test(error.message)) {
    return new Refusal(403, 'denied', error.message)
  }
  if (error.code === 'PT429') return new Refusal(429, 'rate_limited', error.message)
  if (error.code === '23505' || error.code === 'check_violation' || error.code === '23514') return new Refusal(400, 'invalid', error.message)
  return new Refusal(500, 'failed', error.message)
}

/**
 * Who is calling (chat.attachments_principal): the id, or the refusal to answer with. Only PostgREST's 401 (no, bad or expired
 * token) and a null principal (deleted, banned, session gone) mean signed out; anything else is the service failing.
 */
export async function principalOf(rpc: Rpc): Promise<string> {
  const { data, error } = await rpc('attachments_principal', {})
  if (error && error.status !== 401) throw new Refusal(503, 'unavailable', 'could not check your sign-in; try again')
  if (error || typeof data !== 'string') throw new Refusal(401, 'denied', 'sign in first')
  return data
}

export async function call(rpc: Rpc, fn: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await rpc(fn, args)
  if (error) throw refusalFromDb(error)
  return data
}

async function writeFile(deps: AttachmentsDeps, fn: string, args: Record<string, unknown>) {
  const item = args.p_item_id as string | undefined
  const actor = (args.p_sender_user_id ?? args.p_as_user_id) as string
  const entry = item ? await call(deps.userRpc, 'workspace_get_as', { p_item_id: item, p_as_user_id: actor }) as { kind: string }[] : []
  if (entry[0]?.kind !== 'document') return await call(deps.userRpc, fn, args)
  if (!deps.documentReplacement) throw new Refusal(503, 'not_configured', 'Document replacement requires the file service')
  const body = { key: args.p_staging_key as string, expected: args.p_expected_version as number, finish: false }
  await deps.documentReplacement!(item!, actor, body)
  try { return await call(deps.userRpc, fn, args) }
  finally { await deps.documentReplacement!(item!, actor, { ...body, finish: true }).catch(() => deps.log('replacement_finish_failed', { item })) }
}

const str = (body: Record<string, unknown>, key: string, required = true): string | null => {
  const v = body[key]
  if (v === undefined || v === null || v === '') {
    if (required) throw new Refusal(400, 'invalid', `${key} is required`)
    return null
  }
  if (typeof v !== 'string') throw new Refusal(400, 'invalid', `${key} must be a string`)
  return v
}
const bool = (body: Record<string, unknown>, key: string) => {
  const v = body[key]
  if (v === undefined || v === null) return false
  if (typeof v !== 'boolean') throw new Refusal(400, 'invalid', `${key} must be true or false`)
  return v
}
const int = (body: Record<string, unknown>, key: string): number | null => {
  const v = body[key]
  if (v === undefined || v === null) return null
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1) throw new Refusal(400, 'invalid', `${key} must be a whole number from 1`)
  return v
}
const strings = (body: Record<string, unknown>, key: string): string[] => {
  const v = body[key]
  if (v === undefined || v === null) return []
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw new Refusal(400, 'invalid', `${key} must be a list of user ids`)
  return v as string[]
}

// ── upload ───────────────────────────────────────────────────────────────────────
async function issueUpload(deps: AttachmentsDeps, userId: string, body: Record<string,unknown> = {}) {
  const id=str(body,'request_id',false)??deps.uuid()
  if (!UUID.test(id)) throw new Refusal(400,'invalid','request_id must be a uuid')
  const declared=int(body,'size_bytes')
  // Clients from before the budget release send an empty body; they cannot upload here, so tell their person to update.
  if (!declared) throw new Refusal(426,'client_outdated','Update Gugu to send files (this version does not declare the file size)')
  const chat=str(body,'chat_id',false),actor=str(body,'as',false)??userId
  const contentType=str(body,'content_type',false)
  const prepared=await call(deps.userRpc,'file_managed_upload_prepare',{p_chat:chat,p_as:actor,p_bytes:declared,p_content_type:contentType}) as {
    max_bytes:number;permit_seconds:number
  }
  const store=objectStorage(deps)
  let bounds:{maxBytes:number;expiresSeconds:number}
  try { bounds=await store.uploadBounds(declared,Number(prepared.permit_seconds)) }
  catch(error) {
    if (error instanceof ObjectStorageError&&error.status===503) throw new Refusal(503,'not_configured',error.message)
    throw error
  }
  if (!Number.isSafeInteger(bounds.maxBytes)||bounds.maxBytes<declared||bounds.maxBytes>Number(prepared.max_bytes)
      ||bounds.expiresSeconds!==Number(prepared.permit_seconds)) {
    throw new Refusal(503,'not_configured','The upload provider size ceiling and lifetime must match deployment policy')
  }
  const permit=await call(deps.userRpc,'file_managed_upload_as',{
    p_id:id,p_chat:chat,p_as:actor,p_bytes:bounds.maxBytes,p_content_type:contentType,
  }) as { staging_key:string; signed_at:string; expires_at:string; max_bytes:number }
  // A client that sends parts gets a multipart upload when the store signs parts and the file is more than one part:
  // a single part interrupted is sent again whole, so splitting it would change nothing.
  if (body.parts===true&&store.parts&&Number(permit.max_bytes)===declared&&declared>UPLOAD_PART_BYTES) {
    await openParts(deps,store.parts,userId,permit.staging_key)
    return { staging_key:permit.staging_key,max_bytes:declared,expires_at:permit.expires_at,
      parts:{ part_bytes:UPLOAD_PART_BYTES,count:Math.ceil(declared/UPLOAD_PART_BYTES) } }
  }
  const seconds=(Date.parse(permit.expires_at)-Date.parse(permit.signed_at))/1000
  const form=await store.upload(permit.staging_key,new Date(permit.signed_at),{maxBytes:Number(permit.max_bytes),expiresSeconds:seconds})
    .catch(error => {
      if (error instanceof ObjectStorageError && error.status === 409 && error.code === 'upload_used')
        throw new Refusal(409, 'upload_used', error.message)
      throw new Refusal(502, 'failed', 'The storage provider could not sign the upload')
    })
  return { staging_key:permit.staging_key,url:form.url,fields:form.fields,...(form.method?{method:form.method}:{}),
    ...(form.headers?{headers:form.headers}:{}),expires_at:form.expiresAt,max_bytes:Number(permit.max_bytes) }
}

export async function handleUpload(deps: AttachmentsDeps,userId:string,body:Record<string,unknown> = {}) {
  return await issueUpload(deps,userId,body)
}

// ── multipart upload ─────────────────────────────────────────────────────────────
/** Parts of a multipart upload; OSS takes 100 KB to 5 GB a part and at most 10000 parts (256 MiB is 32). */
export const UPLOAD_PART_BYTES=8*1024*1024
/** Parts signed per `upload-parts` answer: a few at a time, so a slow upload asks again with fresh signatures. */
const PARTS_PER_ANSWER=6
type PartsState={ upload_id:string|null; parts_done:number[] }

/** The staging key's multipart upload: the recorded one, or a new one. Of two concurrent openers the loser abandons its own. */
async function openParts(deps:AttachmentsDeps,parts:MultipartStorage,userId:string,key:string) {
  const known=await call(deps.serviceRpc,'file_managed_upload_parts',{p_key:key,p_user:userId,p_upload_id:null,p_done:[]}) as PartsState
  if (known.upload_id) return known.upload_id
  const opened=await parts.open(key)
  const kept=await call(deps.serviceRpc,'file_managed_upload_parts',{p_key:key,p_user:userId,p_upload_id:opened,p_done:[]}) as PartsState
  if (kept.upload_id!==opened) await parts.abandon(key,opened)
  return kept.upload_id!
}

/** The caller's own multipart upload under a live permit: its parts, and the number and size of each. */
async function partsOf(deps:AttachmentsDeps,userId:string,body:Record<string,unknown>) {
  const key=stagingOf(body,userId)
  const parts=objectStorage(deps).parts
  if (!parts) throw new Refusal(400,'invalid','This storage uploads a file in one request')
  const permit=await call(deps.serviceRpc,'file_managed_upload_for',{p_key:key,p_user:userId}) as { max_bytes:number; blob_id:string|null }
  if (permit.blob_id) throw new Refusal(410,'expired','This upload was already sent; start a new one')
  const size=Number(permit.max_bytes),count=Math.ceil(size/UPLOAD_PART_BYTES)
  const bytes=(n:number)=>n<count?UPLOAD_PART_BYTES:size-(count-1)*UPLOAD_PART_BYTES
  return { key,parts,size,count,bytes }
}

/** Records the parts the client just sent and answers the parts still to send, signed. */
export async function handleUploadParts(deps:AttachmentsDeps,userId:string,body:Record<string,unknown>) {
  const { key,parts,count,bytes }=await partsOf(deps,userId,body)
  const done=body.done===undefined||body.done===null?[]:body.done
  if (!Array.isArray(done)||done.some(n=>!Number.isSafeInteger(n)||n<1||n>count)) throw new Refusal(400,'invalid',`done must be part numbers from 1 to ${count}`)
  const state=await call(deps.serviceRpc,'file_managed_upload_parts',{p_key:key,p_user:userId,p_upload_id:null,p_done:done}) as PartsState
  if (!state.upload_id) throw new Refusal(409,'upload_incomplete','This upload has no parts yet; ask upload for it again')
  const todo=Array.from({length:count},(_,i)=>i+1).filter(n=>!state.parts_done.includes(n)).slice(0,PARTS_PER_ANSWER)
  return { done:state.parts_done,todo:await parts.sign(key,state.upload_id,todo.map(n=>({n,bytes:bytes(n)}))) }
}

/**
 * Joins the parts into the staging object once every part is reported. The object must be exactly the declared size;
 * otherwise it is removed and the upload starts again. Asked again after success, it answers success again.
 */
export async function handleUploadComplete(deps:AttachmentsDeps,userId:string,body:Record<string,unknown>) {
  const { key,parts,size,count }=await partsOf(deps,userId,body)
  const state=await call(deps.serviceRpc,'file_managed_upload_parts',{p_key:key,p_user:userId,p_upload_id:null,p_done:[]}) as PartsState
  if (!state.upload_id) throw new Refusal(409,'upload_incomplete','This upload has no parts yet; ask upload for it again')
  const missing=Array.from({length:count},(_,i)=>i+1).filter(n=>!state.parts_done.includes(n))
  if (missing.length) throw new Refusal(409,'upload_incomplete',`Parts not sent yet: ${missing.join(', ')}`,missing.join(','))
  const joined=await parts.complete(key,state.upload_id)
  if (joined===size) return { staging_key:key,size_bytes:size }
  // A part reported but not sent, or bytes that are not this file (or the store gave up the upload after a day).
  if (joined!==null) await objectStorage(deps).remove(key)
  await call(deps.serviceRpc,'file_managed_upload_parts_clear',{p_key:key,p_user:userId,p_upload_id:state.upload_id})
  throw new Refusal(409,'upload_changed',`The parts make ${joined ?? 0} bytes, not ${size}; upload the file again`)
}

// ── commit ───────────────────────────────────────────────────────────────────────
/** 存进 OSS 的那一行 blob:图片按文件头;不是图片的,客户端报的类型看着像 MIME 就记它(对象上一律当附件下载)。 */
function blobType(declared: string | null, bytes: Uint8Array) {
  const s = sniff(bytes)
  if (s.image) return s
  const d = (declared ?? '').toLowerCase().trim()
  return { ...s, contentType: MIME.test(d) && !d.startsWith('image/') ? d : 'application/octet-stream' }
}

export async function handleCommit(deps: AttachmentsDeps, userId: string, body: Record<string, unknown>) {
  const stagingKey = stagingOf(body, userId)
  const keep = keepOf(body)
  await call(deps.userRpc,'file_managed_upload_scope',{p_key:stagingKey,p_as:str(body,body.friend_user_id?'agent_user_id':'sender_user_id'),
    p_chat:str(body,'chat_id',false),p_item:null})
  // agent 代主人把文件发给主人的好友(message_send_file_as_owner):库里那一半照 send_friend_message_as_owner 的规矩。
  if (str(body, 'friend_user_id', false)) {
    const ownerArgs = {
      p_agent_user_id: str(body, 'agent_user_id'),
      p_friend_user_id: str(body, 'friend_user_id'),
      p_staging_key: stagingKey,
      p_file_name: str(body, 'file_name'),
      p_request_id: str(body, 'request_id'),
      p_caption: str(body, 'caption', false),
    }
    await registerStaged(deps, userId, stagingKey, str(body, 'content_type', false), str(body, 'file_name')!)
    return await call(deps.userRpc, 'send_friend_file_as_owner', ownerArgs)
  }
  const caption = str(body, 'caption', false)
  const itemId = str(body, 'item_id', false)
  const sendGroupId = str(body, 'send_group_id', false)
  const commitArgs = {
    p_staging_key: stagingKey,
    p_message_id: str(body, 'message_id'),
    p_chat_id: str(body, 'chat_id'),
    p_sender_user_id: str(body, 'sender_user_id'),
    p_file_name: str(body, 'file_name'),
    p_to_user_ids: strings(body, 'to_user_ids'),
    p_reply_to_message_id: str(body, 'reply_to_message_id', false),
    p_thread_root_id: str(body, 'thread_root_id', false),
    p_is_thread_root: bool(body, 'is_thread_root'),
    p_is_whisper: bool(body, 'is_whisper'),
    p_via_app: str(body, 'via_app', false),
    // 图配文字:库把它接在信封后面(首尾空白去掉,空的就没有)。没有说明就不带这个键:函数先于迁移落地时,
    // 老库的 attachment_commit 没有 p_caption,带上键(哪怕是 null)PostgREST 就找不到函数。
    ...(caption != null ? { p_caption: caption } : {}),
    // 这份字节是群文件夹里一个文件的下一版(item_id + 它基于的 expected_version);同上,不给就不带这两个键。
    ...(itemId != null ? { p_item_id: itemId, p_expected_version: int(body, 'expected_version') } : {}),
    // 一次发出的几个文件(gugu#2581):同一个 send_group_id + 这次一共几个;同上,不给就不带这两个键。
    ...(sendGroupId != null ? { p_send_group_id: sendGroupId, p_send_group_size: int(body, 'send_group_size') } : {}),
  }
  // Declared (sha256 + size): the message goes now and its bytes follow (finish); otherwise the bytes are up already.
  const declared = str(body, 'sha256', false)
  if (declared) {
    // An image's width and height ride along, so the place its readers draw while the bytes come is already its size.
    const width = int(body, 'width'), height = int(body, 'height')
    await call(deps.userRpc, 'attachment_declare', { p_staging_key: stagingKey, p_sha256: declared, p_size_bytes: int(body, 'size_bytes'), p_content_type: str(body, 'content_type', false),
      ...(width != null && height != null ? { p_width: width, p_height: height } : {}), ...(keep ? { p_keep: keep } : {}) })
  }
  else await registerStaged(deps, userId, stagingKey, str(body, 'content_type', false), str(body, 'file_name')!)
  const rows = (await writeFile(deps, 'attachment_commit', commitArgs)) as unknown[]
  const message = rows[0] as { id?: string } | undefined
  if (!declared && message?.id) await keepAs(deps, keep, { message_id: message.id }, commitArgs.p_sender_user_id)
  return message ?? null
}

/**
 * A declared attachment's bytes are up (under its own staging key, or `upload_key` when the sender resumed with a new
 * upload): hashed, checked against the declaration, and every reference moves to them. Answers {status: 'ready'}; bytes
 * that are not the declared file are refused (upload_mismatch) and the attachment reads failed.
 */
export async function handleFinish(deps: AttachmentsDeps, userId: string, body: Record<string, unknown>) {
  const pendingKey = stagingOf(body, userId)
  const uploadKey = body.upload_key == null ? pendingKey : stagingOf({ staging_key: body.upload_key }, userId)
  // Released clients still send keep here; the declaration already owns it.
  await registerStaged(deps, userId, uploadKey, str(body, 'content_type', false), str(body, 'file_name', false) ?? '', { pendingKey })
  return { status: 'ready' }
}

/** The caller's declared attachments still waiting for their bytes: a restarted sender resumes each it still holds. */
export async function handlePending(deps: AttachmentsDeps) {
  return { uploads: await call(deps.userRpc, 'attachment_pending_mine', {}) }
}

/**
 * How long the copy that just joined a chat stays (the uploader's 「临时 / 保留」): the same mark the person makes later, applied
 * after a legacy upload-first commit or folder placement. Declared sends apply it during registration instead.
 */
async function keepAs(deps: AttachmentsDeps, keep: Keep, ref: { message_id: string } | { item_id: string }, as: string | null) {
  if (keep) await call(deps.userRpc, 'file_storage_mark_as', { p_refs: [ref], p_action: keep, p_as: as })
}

type Keep = 'temporary' | 'permanent' | null
/** Read before anything is stored: a wrong value refuses the request, never a file sent without its class. */
function keepOf(body: Record<string, unknown>): Keep {
  const keep = str(body, 'keep', false)
  if (keep != null && keep !== 'temporary' && keep !== 'permanent') throw new Refusal(400, 'invalid', 'keep is temporary or permanent')
  return keep as Keep
}

// ── place ────────────────────────────────────────────────────────────────────────
// 只放进群文件夹、不发消息(App 写文件:gugu.files.upload / replace)。给 item_id ⇒ 那个文件换成这份字节(升一版,
// expected_version 对不上就拒);不给 ⇒ 在 folder(不给 = 根)里建一个文件。字节的登记和提交是同一步。
export async function handlePlace(deps: AttachmentsDeps, userId: string, body: Record<string, unknown>) {
  const stagingKey = stagingOf(body, userId)
  const keep = keepOf(body)
  const itemId = str(body, 'item_id', false)
  // 以谁的身份写:调用者自己,或它自己的 agent(as_user_id;库照 *_as 的规矩核)。
  const as = str(body, 'as_user_id', false) ?? userId
  await call(deps.userRpc,'file_managed_upload_scope',{p_key:stagingKey,p_as:as,p_chat:str(body,'chat_id',false),p_item:itemId})
  const args = itemId
    ? { fn: 'file_replace_as', args: { p_staging_key: stagingKey, p_item_id: itemId, p_as_user_id: as, p_expected_version: int(body, 'expected_version') } }
    : {
        fn: 'file_place_as',
        args: {
          p_staging_key: stagingKey,
          p_chat_id: str(body, 'chat_id'),
          p_as_user_id: as,
          p_file_name: str(body, 'file_name'),
          p_folder: str(body, 'folder', false),
          p_source_message_ids: strings(body, 'source_message_ids'),
        },
      }
  await registerStaged(deps, userId, stagingKey, str(body, 'content_type', false), str(body, 'file_name', false) ?? '')
  const rows = (await writeFile(deps, args.fn, args.args)) as unknown[]
  const item = rows[0] as { id?: string } | undefined
  if (item?.id) await keepAs(deps, keep, { item_id: item.id }, as)
  return item ?? null
}

function stagingOf(body: Record<string, unknown>, userId: string): string {
  const stagingKey = str(body, 'staging_key')!
  if (STAGING.exec(stagingKey)?.[1] !== userId) throw new Refusal(400, 'invalid', 'staging_key is not an upload of yours')
  return stagingKey
}

/** 暂存的字节:算哈希、存进 OSS 的最终位置、登记成 blob(提交和放进文件夹共用)。暂存已经没了 ⇒ 交给库认上一次的登记。 */
async function registerStaged(deps: AttachmentsDeps, userId: string, stagingKey: string, declaredType: string | null, fileName: string, settle?: { pendingKey: string }) {
  const permit=await call(deps.serviceRpc,'file_managed_upload_for',{p_key:stagingKey,p_user:userId}) as { max_bytes:number; blob_id?:string | null; staging_deleted?:boolean }
  if (settle && permit.blob_id && permit.staging_deleted) {
    await call(deps.serviceRpc, 'file_blob_settle', {
      p_uploader: userId, p_pending_key: settle.pendingKey, p_upload_key: stagingKey,
      p_sha256: null, p_size_bytes: null, p_content_type: null,
    })
    return
  }
  const store=objectStorage(deps)
  let read: InspectedObject | null = null
  try {
    read=await store.inspect(stagingKey,Number(permit.max_bytes),deps.textFiles.maxBytes + 1)
  } catch (error) {
    if (error instanceof ObjectStorageError && error.status === 413) throw new Refusal(413, 'too_large', 'file exceeds its upload reservation')
    if (error instanceof ObjectStorageError && error.status === 503) throw new Refusal(503, 'not_configured', error.message)
    if (error instanceof ObjectStorageError && error.status === 412) throw new Refusal(409, 'upload_changed', 'the upload changed while it was being committed; upload it again')
    // 暂存对象没了:要么没传上来,要么上一次已经登记过、删了暂存(重试)—— 交给库认那次登记。
    if (!(error instanceof ObjectStorageError && error.status === 404)) throw error
  }
  // A declared attachment settles only on bytes hashed here: no staged object, nothing to settle it with.
  if (!read && settle) throw new Refusal(409, 'upload_missing', 'the upload is not there; upload the file again')
  if (read) {
    const { bytes, revision, sizeBytes } = read
    if (sizeBytes === 0) throw new Refusal(400, 'invalid', 'an attachment has at least one byte')
    if (bytes.length < Math.min(sizeBytes, deps.textFiles.maxBytes + 1)) {
      throw new Refusal(503, 'not_configured', 'Object inspection did not retain the complete bounded text')
    }
    const document = deps.textFiles.classify(fileName, declaredType, bytes.subarray(0, deps.textFiles.maxBytes + 1))
    const sha = read.sha256
    const type = blobType(declaredType, bytes)
    const finalKey = `${sha.slice(0, 2)}/${sha}`
    const headers = objectHeaders(type, IMMUTABLE)
    const copy = async () => {
      try {
        await objectStorage(deps).promote(stagingKey, finalKey, revision, headers)
      } catch (error) {
        // 暂存对象在读完之后换了内容:算的哈希不是它的了,不能拿这个名字存。
        if (error instanceof ObjectStorageError && error.status === 412) throw new Refusal(409, 'upload_changed', 'the upload changed while it was being committed; upload it again')
        throw error
      }
    }
    // 先复制、再登记:登记的 blob 一定已经有字节。撞上正在回收的同一份内容(HINT file_blob_deleting)就等一下、
    // 重新复制再登记 —— 回收那一边删完对象才删行,不复制的话字节可能已经没了。
    let created = false
    for (let attempt = 1; ; attempt++) {
      await copy()
      const { data, error } = settle
        ? await deps.serviceRpc('file_blob_settle', {
          p_uploader: userId, p_pending_key: settle.pendingKey, p_upload_key: stagingKey, p_sha256: sha, p_size_bytes: sizeBytes,
          p_content_type: type.contentType, p_width: type.width, p_height: type.height,
          p_document: document.kind === 'document' ? { text: document.text, content_type: document.contentType } : null,
        })
        : await deps.serviceRpc('file_blob_register', {
          p_uploader: userId,
          p_staging_key: stagingKey,
          p_sha256: sha,
          p_size_bytes: sizeBytes,
          p_content_type: type.contentType,
          p_width: type.width,
          p_height: type.height,
        })
      if (!error && settle && (data as { status?: string } | null)?.status === 'failed') {
        throw new Refusal(409, 'upload_mismatch', 'the uploaded bytes are not the file this message declared')
      }
      if (!error) {
        created = settle ? (data as { created?: boolean }).created === true : ((data as { created?: boolean }[] | null)?.[0]?.created) === true
        break
      }
      if (error.hint !== 'file_blob_deleting' || attempt >= 5) throw refusalFromDb(error)
      await new Promise((r) => setTimeout(r, deps.retryDelayMs ?? 1000))
    }
    // 新建的一行:复制和登记之间,回收可能把同一个 sha 的旧 blob 整个收完(连对象一起删了)。这时上传登记已经引用着
    // 新的一行,回收领不走它 —— 返回之前看一眼,对象不在就再复制一次。
    // Settle already made the storage ready: a repair copy can briefly answer 404, which retryFileDownload retries.
    if (created && !(await objectStorage(deps).exists(finalKey))) await copy()
    if (!settle) await call(deps.serviceRpc,'file_managed_upload_registered',{p_key:stagingKey,p_user:userId,
      p_document:document.kind === 'document' ? {text:document.text,content_type:document.contentType} : null})
    // Registration settled the reservation, so the staging copy is redundant. A replay of the still-valid signature can
    // recreate it uncounted until the staging lifecycle removes it. A failed delete leaves it to that lifecycle.
    await dropStaging(deps, stagingKey)
  }
}

async function dropStaging(deps: AttachmentsDeps, stagingKey: string) {
  try {
    const store = objectStorage(deps)
    await store.remove(stagingKey)
    if (await store.exists(stagingKey)) throw new Error('staging object still present after delete')
    await call(deps.serviceRpc, 'file_managed_upload_closed', { p_key: stagingKey, p_evidence: 'staging-absent' })
  } catch (error) {
    deps.log('staging_delete_failed', { key: stagingKey, error: String(error) })
  }
}

// ── forward ──────────────────────────────────────────────────────────────────────
export async function handleForward(deps: AttachmentsDeps, _userId: string, body: Record<string, unknown>) {
  const forwardGroup = str(body, 'send_group_id', false)
  const rows = await call(deps.userRpc, 'attachment_forward', {
    p_source_message_id: str(body, 'source_message_id'),
    p_message_id: str(body, 'message_id'),
    p_chat_id: str(body, 'chat_id'),
    p_sender_user_id: str(body, 'sender_user_id'),
    p_to_user_ids: strings(body, 'to_user_ids'),
    p_thread_root_id: str(body, 'thread_root_id', false),
    p_is_thread_root: bool(body, 'is_thread_root'),
    p_is_whisper: bool(body, 'is_whisper'),
    // Files forwarded together stay one send where they land (gugu#2581); not given, the key is not sent (older database).
    ...(forwardGroup != null ? { p_send_group_id: forwardGroup, p_send_group_size: int(body, 'send_group_size') } : {}),
  }) as unknown[]
  return rows[0] ?? null
}

// ── share ────────────────────────────────────────────────────────────────────────
// 群文件夹里的一个文件按引用发出去(以调用者的身份 attachment_share):不传字节,消息钉住那个文件的一版。存的文件钉住
// 给的那一版(不给 = 现在的)。文本文件(document)不给版本:先把它此刻的正文定成带字节的一版
// (attachment_document_snapshot;正文没变就是上次那一版,字节按 sha256 存、不另存一份),再钉住那一版;给了版本:
// 钉住那一版,只有发过、带着字节的那几版钉得住 —— 其余的说清楚,从不悄悄换成现在的正文。
export async function handleShare(deps: AttachmentsDeps, userId: string, body: Record<string, unknown>) {
  const itemId = str(body, 'item_id')!
  const sender = str(body, 'sender_user_id')!
  const messageId = str(body, 'message_id')!
  const caption = str(body, 'caption', false)
  const entry = ((await call(deps.userRpc, 'workspace_get_as', { p_item_id: itemId, p_as_user_id: sender })) as SharedEntry[])[0]
  const asked = int(body, 'version')
  const version = entry?.kind === 'document' && asked === null ? await documentSnapshot(deps, userId, sender, messageId, entry) : asked
  const rows = (await call(deps.userRpc, 'attachment_share', {
    p_item_id: itemId,
    p_version: version,
    p_message_id: messageId,
    p_chat_id: str(body, 'chat_id'),
    p_sender_user_id: sender,
    p_to_user_ids: strings(body, 'to_user_ids'),
    p_reply_to_message_id: str(body, 'reply_to_message_id', false),
    p_thread_root_id: str(body, 'thread_root_id', false),
    p_is_thread_root: bool(body, 'is_thread_root'),
    p_via_app: str(body, 'via_app', false),
    ...(caption != null ? { p_caption: caption } : {}),
  }).catch((error) => {
    // A document's version as text only (never sent, so never given bytes): what was asked for cannot be pinned.
    if (!(entry?.kind === 'document' && error instanceof Refusal && error.code === 'needs_bytes')) throw error
    throw new Refusal(409, 'version_unavailable',
      `${entry.filename} is a text document: version ${version} has no saved copy to send. Leave out the version to send its text as it is now.`)
  })) as unknown[]
  return rows[0] ?? null
}

interface SharedEntry { id: string; chat_id: string; kind: string; filename: string; content_type: string }

/** The version of a text document that says its text as it is now, with bytes: asked once, then once more with the text staged. */
async function documentSnapshot(deps: AttachmentsDeps, userId: string, sender: string, messageId: string, entry: SharedEntry) {
  if (!deps.documentText) throw new Refusal(503, 'not_configured', 'Sharing a text document requires the file service')
  const text = await deps.documentText(entry.id, sender === userId ? null : sender)
  const snapshot = async (stagingKey: string | null) => (await call(deps.userRpc, 'attachment_document_snapshot', {
    p_item_id: entry.id, p_as_user_id: sender, p_text: text, p_staging_key: stagingKey,
  })) as number
  try {
    return await snapshot(null)
  } catch (error) {
    if (!(error instanceof Refusal && error.code === 'needs_bytes')) throw error
  }
  // The bytes go into staging named by the new message, registered as any upload.
  const stagingKey = `staging/${userId}/${messageId}`
  if (!STAGING.test(stagingKey)) throw new Refusal(400, 'invalid', 'message_id is a uuid')
  const bytes = new TextEncoder().encode(text)
  await call(deps.userRpc, 'file_managed_upload_as', { p_id: messageId, p_chat: entry.chat_id, p_as: sender, p_bytes: bytes.length })
  await objectStorage(deps).put(stagingKey, bytes)
  await registerStaged(deps, userId, stagingKey, entry.content_type, entry.filename)
  return await snapshot(stagingKey)
}

// ── urls ─────────────────────────────────────────────────────────────────────────
export async function handleUrls(deps: AttachmentsDeps, userId: string, body: Record<string, unknown>) {
  if (!Array.isArray(body.refs)||!body.refs.length||body.refs.length>200) throw new Refusal(400,'invalid','refs is a list of 1 to 200 file references')
  const refs=body.refs.map(fileRef)
  const urls=await Promise.all(refs.map(ref=>handleFileDownload(deps,userId,{ref,as:body.as??userId,request_id:deps.uuid()})))
  return {urls:urls.filter(row=>row.status!=='gone')}
}

// ── gc ───────────────────────────────────────────────────────────────────────────
interface Claimed {
  blob_id: string
  claim_token: string
  bucket_id: string
  object_name: string
  content_type: string
}

/** Multipart uploads whose permit expired are abandoned in the store, then forgotten; a failure is tried again in a later round. */
async function abandonExpiredParts(deps: AttachmentsDeps, remaining: number, guard: () => Promise<void>) {
  if (remaining === 0) return 0
  const parts = objectStorage(deps).parts
  if (!parts) return 0
  await guard()
  const stale = ((await call(deps.serviceRpc, 'file_managed_upload_parts_claim', { p_limit: remaining })) ?? []) as Array<{ staging_key: string; account_id: string; upload_id: string }>
  if (!Array.isArray(stale) || stale.length > remaining) throw new Refusal(503, 'not_configured', 'Multipart GC claim exceeds its bound')
  for (const row of stale) {
    await guard()
    try {
      await parts.abandon(row.staging_key, row.upload_id)
      await call(deps.serviceRpc, 'file_managed_upload_parts_clear', { p_key: row.staging_key, p_user: row.account_id, p_upload_id: row.upload_id })
    } catch (error) {
      deps.log('gc_abandon_failed', { key: row.staging_key, error: String(error) })
    }
  }
  return stale.length
}

export async function handleGc(deps: AttachmentsDeps, entry: 'kick' | 'file-accept' = 'kick',
  sweepStaging?: (remaining: number, guard: () => Promise<void>) => Promise<void>) {
  const result = { claimed: 0, deleted: 0, failed: 0 }
  let claimedCount: number | null = null
  let removed = 0
  let completed = false
  let token: string | null = null
  try {
    const run = await call(deps.serviceRpc, 'file_blob_gc_run_begin', {}) as
      { acquired: boolean; token?: string; batch_limit: number; concurrency: number }
    if (!run || typeof run.acquired !== 'boolean' || ![5, 50].includes(run.batch_limit) || run.concurrency !== 1) {
      throw new Refusal(503, 'not_configured', 'Attachment GC control is unavailable')
    }
    if (!run.acquired) { claimedCount = 0; completed = true; return result }
    if (typeof run.token !== 'string' || !UUID.test(run.token)) throw new Refusal(503, 'not_configured', 'Invalid GC consumer receipt')
    token = run.token
    const guard = async () => {
      if (await call(deps.serviceRpc, 'file_blob_gc_run_renew', { p_token: token }) !== true) {
        throw new Refusal(503, 'not_configured', 'Attachment GC consumer is no longer permitted')
      }
    }
    await call(deps.serviceRpc, 'file_temporary_expire', { p_limit: 500 })
    await call(deps.serviceRpc, 'file_transfer_expire', { p_limit: 500 })
    const claimed = ((await call(deps.serviceRpc, 'file_blob_gc_run_claim', { p_token: token })) ?? []) as Claimed[]
    if (!Array.isArray(claimed) || claimed.length > run.batch_limit) throw new Refusal(503, 'not_configured', 'Attachment GC claim exceeds its bound')
    result.claimed = claimed.length
    claimedCount = claimed.length
    for (const job of claimed) {
      await guard()
      try {
        // A declaration whose bytes never came (pending): its staging object, if any, is the provider's to expire.
        if (job.bucket_id === 'pending') {
          // nothing stored under its name
        } else if (job.bucket_id === 'oss' || job.bucket_id === 'temporary') {
          await objectStorage(deps).remove(job.object_name)
          removed++
          // 清边缘缓存只是清理(见 refreshCdn):失败了记一行,不挡回收。
          if (job.bucket_id === 'oss') await objectStorage(deps).invalidate(job.object_name, hasThumbnail(job.content_type))
            .catch((error) => deps.log('cdn_refresh_failed', { blob: job.blob_id, error: String(error) }))
        } else {
          await deps.storageRemove(job.bucket_id, job.object_name)
          removed++
        }
        await call(deps.serviceRpc, 'file_blob_gc_finish', { p_blob_id: job.blob_id, p_claim_token: job.claim_token })
        result.deleted++
      } catch (error) {
        result.failed++
        deps.log('gc_failed', { blob: job.blob_id, error: String(error) })
        await call(deps.serviceRpc, 'file_blob_gc_fail', { p_blob_id: job.blob_id, p_claim_token: job.claim_token, p_error: String(error).slice(0, 500) })
          .catch((e) => deps.log('gc_fail_report_failed', { blob: job.blob_id, error: String(e) }))
      }
    }
    // Staging cleanup shares the same lease and remaining server-side budget.
    // A disabled or busy collector cannot delete via this second path either.
    const remaining = run.batch_limit - claimed.length
    const abandoned = await abandonExpiredParts(deps, remaining, guard)
    if (sweepStaging && remaining > abandoned) await sweepStaging(remaining - abandoned, guard)
    completed = true
    return result
  } finally {
    if (token) {
      try { await call(deps.serviceRpc, 'file_blob_gc_run_end', { p_token: token }) }
      catch { try { deps.log('gc_release_failed', { entry }) } catch { /* Keep the original outcome. */ } }
    }
    try {
      const at = deps.now().toISOString()
      // Removal may succeed even when its database confirmation fails. Keep both counts without changing the API result.
      deps.log('gc_result', { entry, at, day: at.slice(0, 10), claimed: claimedCount, deleted: removed,
        finished: result.deleted, failed: result.failed, outcome: completed ? 'completed' : 'error' })
    } catch (error) {
      try {
        console.error(JSON.stringify({ fn: 'attachments', stage: 'gc_result_log_failed', entry,
          error_type: typeof error, message: 'GC summary logging failed' }))
      } catch { /* Even unavailable stderr must not replace the GC result or original exception. */ }
    }
  }
}


/** A session handoff grants the named Agents access; it never creates a chat. */
export async function handleSessionCommit(deps: AttachmentsDeps, userId: string, body: Record<string, unknown>) {
  const stagingKey = stagingOf(body, userId)
  await call(deps.userRpc,'file_managed_upload_scope',{p_key:stagingKey,p_as:str(body,'sender_user_id'),p_chat:null,p_item:null})
  const id = str(body, 'attachment_id')!
  if (!UUID.test(id)) throw new Refusal(400, 'invalid', 'attachment_id must be a uuid')
  const args = {
    p_staging_key: stagingKey, p_attachment_id: id,
    p_sender_user_id: str(body, 'sender_user_id'), p_sender_session_id: str(body, 'sender_session_id'),
    p_recipient_user_ids: strings(body, 'recipient_user_ids'), p_file_name: str(body, 'file_name'),
  }
  await registerStaged(deps, userId, stagingKey, str(body, 'content_type', false), str(body, 'file_name')!)
  const rows = await call(deps.userRpc, 'session_attachment_commit', args) as unknown[]
  if (!rows?.[0]) throw new Refusal(500, 'failed', 'session attachment commit returned no receipt')
  return rows[0]
}

export async function handleSessionUrls(deps: AttachmentsDeps, userId: string, body: Record<string, unknown>) {
  const ids=strings(body,'attachment_ids')
  if (!ids.length||ids.length>32||ids.some(id=>!UUID.test(id))) throw new Refusal(400,'invalid','expected 1 to 32 attachment ids')
  const rows=await Promise.all(ids.map(attachment_id=>handleFileDownload(deps,userId,{
    ref:{attachment_id},as:body.as??userId,request_id:deps.uuid(),
  })))
  return {attachments:rows.filter(row=>row.status!=='gone')}
}


export async function handleSessionRevoke(deps: AttachmentsDeps, _userId: string, body: Record<string, unknown>) {
  const id = str(body, 'attachment_id')!
  if (!UUID.test(id)) throw new Refusal(400, 'invalid', 'attachment_id must be a uuid')
  await call(deps.userRpc, 'session_attachment_revoke', { p_id: id, p_as_user_id: str(body, 'as') })
  return { revoked: true }
}
