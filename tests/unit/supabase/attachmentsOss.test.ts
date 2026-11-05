// 附件进群文件夹 ③:attachments 函数的签名与逻辑(supabase/functions/_shared/{md5,oss,blob-sniff,attachments-core}.ts)。
// 签名对官方文档的样例;其余是这份代码在 OSS / CDN 实测里跑通的那些(gugu-base evidence/2026-10-16-oss-cdn-probe/),
// 用假的 OSS 与库判逻辑:先复制再登记、撞上正在回收重来、暂存没了交给库认登记、签名链接、回收。
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { md5Hex } from '../../../supabase/functions/_shared/md5'
import {
  cdnAuthKey,
  cdnSignedUrl,
  IMMUTABLE,
  MAX_ATTACHMENT_BYTES,
  type OssConfig,
  ossSign,
  postObjectForm,
  sha256Hex,
  THUMB_PROCESS,
} from '../../../supabase/functions/_shared/oss'
import { hasThumbnail, objectHeaders, sniff } from '../../../supabase/functions/_shared/blob-sniff'
import {
  type AttachmentsDeps,
  handleCommit,
  handleSessionCommit,
  handleSessionUrls,
  handleForward,
  handlePlace,
  handleShare,
  handleGc,
  handleUpload,
  handleUrls,
  Refusal,
  refusalFromDb,
} from '../../../supabase/functions/_shared/attachments-core'

const OSS: OssConfig = {
  region: 'cn-wulanchabu', bucket: 'gugu-files-test', endpointInternal: 'oss-cn-wulanchabu-internal.aliyuncs.com',
  endpointPublic: 'oss-cn-wulanchabu.aliyuncs.com', accessKeyId: 'LTAI-test', accessKeySecret: 'secret-test',
}
const CDN = { domain: 'files-dev.gugu.nextmind.space', authKey: 'cdn-key-test', authTtlSeconds:1800 }
const USER = '11111111-1111-4111-8111-111111111111'
const STAGING = `staging/${USER}/22222222-2222-4222-8222-222222222222`

describe('签名', () => {
  it('MD5 对 RFC 1321 的样例(CDN 鉴权 A 用)', () => {
    expect(md5Hex('')).toBe('d41d8cd98f00b204e9800998ecf8427e')
    expect(md5Hex('abc')).toBe('900150983cd24fb0d6963f7d28e17f72')
    expect(md5Hex('message digest')).toBe('f96b697d7cb7938d525a2f31aaf161d0')
    expect(md5Hex('12345678901234567890123456789012345678901234567890123456789012345678901234567890')).toBe('57edf4a22be3c955ac49da2e2107b67a')
    // 对照:随便一段长一点的字节,与 Node 自带的一样。
    const bytes = new Uint8Array(1000).map((_, i) => (i * 37) & 0xff)
    expect(md5Hex(bytes)).toBe(createHash('md5').update(bytes).digest('hex'))
  })

  it('CDN 鉴权 A 对阿里云文档的样例;签名链接只签路径,缩略图在同一个签名后面加 x-oss-process,有效期 1800 s', () => {
    expect(cdnAuthKey('/video/standard/test.mp4', 'aliyuncdnexp1234', { ts: 1444435200, rand: '0', uid: '0' }))
      .toBe('1444435200-0-0-23bf85053008f5c0e791667a313e28ce')
    const sha = 'ab'.repeat(32)
    const now = new Date('2026-10-16T12:00:00Z')
    const signed = cdnSignedUrl(CDN, `ab/${sha}`, { image: true, now, rand: 'r0' })
    const ts = Math.floor(now.getTime() / 1000)
    expect(signed.url).toBe(`https://${CDN.domain}/ab/${sha}?auth_key=${ts}-r0-0-${md5Hex(`/ab/${sha}-${ts}-r0-0-${CDN.authKey}`)}`)
    expect(signed.thumbUrl).toBe(`${signed.url}&x-oss-process=${THUMB_PROCESS}`)
    expect(signed.expiresAt).toBe('2026-10-16T12:30:00.000Z')
    expect(cdnSignedUrl(CDN, `ab/${sha}`, { image: false, now, rand: 'r0' }).thumbUrl).toBeNull()
  })

  it('OSS V4:规范请求对阿里云文档的样例(签名钥匙那一步文档用的是示意值,实测请求全过)', async () => {
    const signed = await ossSign({ ...OSS, bucket: 'examplebucket', region: 'cn-hangzhou', accessKeyId: 'LTAI-doc', accessKeySecret: 'yourAccessKeySecret' }, {
      method: 'PUT', key: 'exampleobject', date: new Date('2025-04-11T06:41:24Z'), additional: ['content-disposition', 'content-length'],
      headers: { 'Content-Disposition': 'attachment', 'Content-Length': '3', 'Content-MD5': 'ICy5YqxZB1uWSwcVLSNLcA==', 'Content-Type': 'text/plain' },
    })
    expect(await sha256Hex(signed.canonical)).toBe('c46d96390bdbc2d739ac9363293ae9d710b14e48081fcb22cd8ad54b63136eca')
    expect(signed.headers.Authorization).toMatch(/^OSS4-HMAC-SHA256 Credential=LTAI-doc\/20250411\/cn-hangzhou\/oss\/aliyun_v4_request,AdditionalHeaders=content-disposition;content-length,Signature=[0-9a-f]{64}$/)
    expect(signed.headers['x-oss-date']).toBe('20250411T064124Z')
  })

  it('PostObject 表单:key 定死、大小 1 字节到 25 MiB、15 分钟,签名在 policy 上', async () => {
    const date = new Date('2026-10-16T12:00:00Z')
    const form = await postObjectForm(OSS, { key: STAGING, date })
    expect(form.url).toBe('https://gugu-files-test.oss-cn-wulanchabu.aliyuncs.com/')
    expect(form.expiresAt).toBe('2026-10-16T12:15:00.000Z')
    const policy = JSON.parse(atob(form.fields.policy!)) as { expiration: string; conditions: unknown[] }
    expect(policy.conditions).toEqual([
      { bucket: 'gugu-files-test' },
      { 'x-oss-signature-version': 'OSS4-HMAC-SHA256' },
      { 'x-oss-credential': 'LTAI-test/20261016/cn-wulanchabu/oss/aliyun_v4_request' },
      { 'x-oss-date': '20261016T120000Z' },
      ['content-length-range', 1, MAX_ATTACHMENT_BYTES],
      ['eq', '$key', STAGING],
      { 'x-oss-forbid-overwrite': 'true' },
    ])
    // 暂存对象传上去以后同一张表单不能再换掉它(复核 L11 要改 1;OSS 实测重传回 409 FileAlreadyExists)。
    expect(form.fields).toMatchObject({ key: STAGING, 'x-oss-signature-version': 'OSS4-HMAC-SHA256', 'x-oss-date': '20261016T120000Z', 'x-oss-forbid-overwrite': 'true' })
    expect(form.fields['x-oss-signature']).toMatch(/^[0-9a-f]{64}$/)
    // 换一把钥匙,签名就变(签名真的依赖钥匙)。
    expect((await postObjectForm({ ...OSS, accessKeySecret: 'other' }, { key: STAGING, date })).fields['x-oss-signature']).not.toBe(form.fields['x-oss-signature'])
  })
})

describe('字节是什么(看文件头)', () => {
  it('PNG / JPEG / GIF / WebP 给类型和宽高;别的是 octet-stream;对象上图片不带 Content-Disposition,别的当附件下载', () => {
    const png = new Uint8Array(33)
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
    new DataView(png.buffer).setUint32(16, 1600)
    new DataView(png.buffer).setUint32(20, 1200)
    expect(sniff(png)).toEqual({ contentType: 'image/png', image: true, width: 1600, height: 1200 })
    // JPEG:SOI、一个 APP0、SOF0(高 480、宽 640)
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 0x01, 0xe0, 0x02, 0x80, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(sniff(jpeg)).toEqual({ contentType: 'image/jpeg', image: true, width: 640, height: 480 })
    const gif = new Uint8Array([...new TextEncoder().encode('GIF89a'), 0x20, 0x00, 0x10, 0x00, 0, 0])
    expect(sniff(gif)).toEqual({ contentType: 'image/gif', image: true, width: 32, height: 16 })
    const webp = new Uint8Array(30)
    webp.set(new TextEncoder().encode('RIFF'), 0)
    webp.set(new TextEncoder().encode('WEBPVP8X'), 8)
    webp.set([559 & 0xff, 559 >> 8, 0, 419 & 0xff, 419 >> 8, 0], 24)
    expect(sniff(webp)).toEqual({ contentType: 'image/webp', image: true, width: 560, height: 420 })
    expect(sniff(new TextEncoder().encode('<html><script>alert(1)</script>'))).toEqual({ contentType: 'application/octet-stream', image: false, width: null, height: null })
    expect(objectHeaders(sniff(png), IMMUTABLE)).toEqual({ 'Content-Type': 'image/png', 'Cache-Control': IMMUTABLE })
    expect(objectHeaders(sniff(new Uint8Array([1, 2, 3])), IMMUTABLE)).toEqual({ 'Content-Type': 'application/octet-stream', 'Cache-Control': IMMUTABLE, 'Content-Disposition': 'attachment' })
  })

  it('SVG:去掉 BOM、空白、XML 声明、注释、DOCTYPE 之后是 <svg ⇒ image/svg+xml、没有宽高;对象上带真实类型、当附件下载;没有缩略图', () => {
    const svg = (text: string) => sniff(new TextEncoder().encode(text))
    const SVG = { contentType: 'image/svg+xml', image: true, width: null, height: null }
    expect(svg('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="2"/>')).toEqual(SVG)
    expect(svg('\uFEFF\n  <?xml version="1.0" encoding="UTF-8"?>\n<!-- made by hand -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd">\n<SVG>')).toEqual(SVG)
    // 对照:不是 SVG 元素的一律不认 —— <svgfoo>、正文里提到 <svg、HTML 里嵌一个 <svg>
    expect(svg('<svgfoo/>').image).toBe(false)
    expect(svg('see <svg> below').image).toBe(false)
    expect(svg('<html><body><svg></svg><script>alert(1)</script></body></html>').image).toBe(false)
    expect(objectHeaders(svg('<svg/>'), IMMUTABLE)).toEqual({ 'Content-Type': 'image/svg+xml', 'Cache-Control': IMMUTABLE, 'Content-Disposition': 'attachment' })
    expect([hasThumbnail('image/png'), hasThumbnail('image/webp'), hasThumbnail('image/svg+xml'), hasThumbnail('application/pdf')]).toEqual([true, true, false, false])
  })
})

// ── 逻辑:假的 OSS 与库 ──────────────────────────────────────────────────────────
type Call = { method: string; url: string; headers: Record<string, string> }
/** 假 OSS 的桶:暂存对象(带 ETag)和已经复制过去的正式对象。 */
type Bucket = { staging: { bytes: Uint8Array; etag: string } | null; finals: Map<string, Uint8Array> }
function fakes(opts: {
  object?: Uint8Array | null
  registerErrors?: { hint: string; message: string }[]
  registerCreated?: boolean
  claimed?: unknown[]
  /** 提交 GET 完暂存之后、复制之前。 */
  afterGet?: (bucket: Bucket) => void
  /** 登记成功之后。 */
  afterRegister?: (bucket: Bucket) => void
  /** 转发的原消息是老式附件:库说的那一行,和 chat-media 里那个对象的字节(null = 对象没了)。 */
  legacy?: { row: { object_name: string; file_name: string; content_type: string | null }; bytes: Uint8Array | null }
  /** 按引用发的是文本文件:它此刻的正文,和库里最新一版已经带着字节的正文(null = 没有带字节的一版)。 */
  document?: { text: string; snapshotted: string | null }
} = {}) {
  const bucket: Bucket = { staging: opts.object ? { bytes: opts.object, etag: '"E1"' } : null, finals: new Map() }
  const keyOf = (url: string) => new URL(url).pathname.slice(1)
  const calls: Call[] = []
  const order: string[] = []
  const rpcs: { as: 'user' | 'service'; fn: string; args: Record<string, unknown> }[] = []
  const logs: string[] = []
  const removed: string[] = []
  const registerErrors = [...(opts.registerErrors ?? [])]
  const controls: {as:'user'|'service';fn:string;args:Record<string,unknown>}[]=[]
  const deps: AttachmentsDeps = {
    textFiles: { maxBytes: 1024 * 1024, classify: () => ({ kind: 'file', why: 'binary fixture' }) },
    oss: OSS,
    cdn: CDN,
    fetch: async (url, init) => {
      order.push('object:' + (init?.method ?? 'GET'))
      const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>))
      calls.push({ method: init?.method ?? 'GET', url, headers })
      if ((init?.method ?? 'GET') === 'GET' && new URL(url).searchParams.has('versioning')) return new Response('<VersioningConfiguration/>',{status:200})
      if ((init?.method ?? 'GET') === 'GET' && url.startsWith('https://db.example/storage/v1/object/sign/')) {
        const bytes = opts.legacy?.bytes
        return bytes ? new Response(bytes as unknown as BodyInit, { status: 200 }) : new Response('{"error":"not_found"}', { status: 400 })
      }
      if ((init?.method ?? 'GET') === 'GET' && url.includes('/staging/')) {
        const staged = bucket.staging
        if (!staged) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 })
        opts.afterGet?.(bucket)
        // OSS gzip transfer starts at 1 KiB and omits ETag/Content-Length; fetch decodes the bytes.
        const compressed = staged.bytes.length >= 1024 && new Headers(headers).get('Accept-Encoding') !== 'identity'
        return new Response(staged.bytes as unknown as BodyInit, { status: 200, headers: compressed
          ? { 'content-encoding': 'gzip' }
          : { 'content-length': String(staged.bytes.length), etag: staged.etag } })
      }
      if (init?.method === 'PUT' && headers['x-oss-copy-source'] === undefined) {
        // PutObject:把字节放进暂存(转发老式附件时,边缘函数自己放)。
        bucket.staging = { bytes: new Uint8Array(init.body as Uint8Array), etag: '"P1"' }
        return new Response(null, { status: 200 })
      }
      if (init?.method === 'PUT') {
        // CopyObject 照 OSS:带 if-match 而源对象的 ETag 不是它 ⇒ 412;不带就照抄当时的源对象(目标已有也覆盖)。
        if (!bucket.staging) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 })
        const ifMatch = headers['x-oss-copy-source-if-match']
        if (ifMatch !== undefined && ifMatch !== bucket.staging.etag) return new Response('<Error><Code>PreconditionFailed</Code></Error>', { status: 412 })
        bucket.finals.set(keyOf(url), bucket.staging.bytes)
        return new Response('<CopyObjectResult/>', { status: 200 })
      }
      if (init?.method === 'HEAD') return new Response(null, { status: bucket.finals.has(keyOf(url)) ? 200 : 404 })
      if (init?.method === 'DELETE') {
        if (url.includes('/staging/')) bucket.staging = null
        return new Response(null, { status: 204 })
      }
      if (url.startsWith('https://cdn.aliyuncs.com/')) return new Response(JSON.stringify({ RefreshTaskId: 't1' }), { status: 200 })
      return new Response('unexpected', { status: 500 })
    },
    userRpc: async (fn, args) => {
      order.push('user:' + fn)
      if (fn === 'workspace_get_as') return { data: [opts.document
        ? { id: args.p_item_id, chat_id: 'c1', kind: 'document', filename: '周报', content_type: 'text/markdown' }
        : { id: args.p_item_id, chat_id: 'c1', kind: 'file', filename: 'a.png', content_type: 'image/png' }], error: null }
      if (fn==='file_managed_upload_prepare') { controls.push({as:'user',fn,args});return {data:{max_bytes:MAX_ATTACHMENT_BYTES,permit_seconds:900},error:null} }
      if (fn==='file_managed_upload_scope') { controls.push({as:'user',fn,args});return {data:null,error:null} }
      if (fn==='file_managed_upload_as') {
        controls.push({as:'user',fn,args})
        if (typeof args.p_bytes!=='number'||args.p_bytes<=0) return {data:null,error:{message:'size required',hint:'file_transfer_invalid'}}
        return {data:{staging_key:'staging/'+USER+'/'+args.p_id,max_bytes:args.p_bytes,signed_at:'2026-10-16T12:00:00Z',expires_at:'2026-10-16T12:15:00Z'},error:null}
      }
      if (fn==='file_transfer_download_as') {
        controls.push({as:'user',fn,args})
        const ref=args.p_ref as {item_id?:string;message_id?:string;attachment_id?:string}
        const old=ref.item_id?.startsWith('5555')
        return {data:{
          status:'ready',source:'managed-object',item_id:ref.item_id??null,version:old?2:ref.message_id?null:1,
          message_id:ref.message_id??null,current_version:old?2:ref.message_id?null:3,chat_id:'c',
          file_name:old?'b.pptx':ref.message_id?'w.pdf':'a.png',bucket_id:old?'workspace':'oss',
          object_name:old?'c/u/x-b.pptx':ref.message_id?'cd/'+'cd'.repeat(32):'ab/'+'ab'.repeat(32),
          sha256:'ab'.repeat(32),size_bytes:old?5:ref.message_id?7:10,
          content_type:old?'application/x':ref.message_id?'application/pdf':'image/png',width:old?null:640,height:old?null:480,
          download_id:args.p_id,signed_at:'2026-10-16T12:00:00Z',expires_at:'2026-10-16T12:01:00.000Z',transfer_id:null,
          ...(opts.legacy&&ref.message_id?{bucket_id:'chat-media',object_name:opts.legacy.row.object_name,
            file_name:opts.legacy.row.file_name,content_type:opts.legacy.row.content_type,size_bytes:opts.legacy.bytes?.length??1}:{}),
        },error:null}
      }
      rpcs.push({ as: 'user', fn, args })
      if (fn === 'attachment_commit') return { data: [{ id: args.p_message_id, file_version: 1 }], error: null }
      if (fn === 'send_friend_file_as_owner') return { data: { chat_id: 'dm-1', message_id: 'm-o', sender_user_id: USER, sent_by_agent: true }, error: null }
      if (fn === 'attachment_legacy_source') return { data: opts.legacy ? [opts.legacy.row] : [], error: null }
      if (fn === 'attachment_forward') {
        // 老式的原消息、又没带上传:库说要字节(和迁移里那一句同一个 HINT)。
        if (opts.legacy && !args.p_staging_key) return { data: null, error: { message: 'message old-1 is an old attachment: forward it through attachments/forward', hint: 'attachment_forward_needs_bytes', code: 'P0001' } }
        return { data: [{ id: args.p_message_id, forwarded_from_message_id: args.p_source_message_id }], error: null }
      }
      if (fn === 'attachment_document_snapshot') {
        // 库那一半(20261030120000):最新一版已经是这段正文、带着字节 ⇒ 那一版;没有字节又没带上传 ⇒ 要字节。
        if (opts.document!.snapshotted === args.p_text) return { data: 7, error: null }
        if (!args.p_staging_key) return { data: null, error: { message: '周报 is a text document: its text is sent as bytes through attachments/share', hint: 'attachment_forward_needs_bytes', code: 'P0001' } }
        opts.document!.snapshotted = args.p_text as string
        return { data: 8, error: null }
      }
      if (fn === 'attachment_share') {
        // A document's version without bytes (20261030120000): the share refuses it, as the database does.
        if (opts.document && args.p_version !== 7 && args.p_version !== 8) return { data: null, error: { message: '周报 is a text document: send it through attachments/share', hint: 'attachment_forward_needs_bytes', code: 'P0001' } }
        return { data: [{ id: args.p_message_id, file_item_id: args.p_item_id, file_version: args.p_version }], error: null }
      }
      if (fn === 'file_storage_mark_as') return { data: 1, error: null }
      if (fn === 'file_place_as') return { data: [{ id: 'i9', version: 1, path: args.p_file_name }], error: null }
      if (fn === 'file_replace_as') return { data: [{ id: args.p_item_id, version: 4 }], error: null }
      if (fn === 'file_urls_as') {
        return { data: [
          { item_id: 'i1', version: 1, message_id: null, current_version: 3, chat_id: 'c', file_name: 'a.png', bucket_id: 'oss', object_name: 'ab/' + 'ab'.repeat(32), sha256: 'ab'.repeat(32), size_bytes: '10', content_type: 'image/png', width: 640, height: 480 },
          { item_id: 'i2', version: 2, message_id: null, current_version: 2, chat_id: 'c', file_name: 'b.pptx', bucket_id: 'workspace', object_name: 'c/u/x-b.pptx', sha256: null, size_bytes: '5', content_type: 'application/x', width: null, height: null },
          { item_id: null, version: null, message_id: 'm1', current_version: null, chat_id: 'c', file_name: 'w.pdf', bucket_id: 'oss', object_name: 'cd/' + 'cd'.repeat(32), sha256: 'cd'.repeat(32), size_bytes: '7', content_type: 'application/pdf', width: null, height: null },
        ], error: null }
      }
      return { data: null, error: { message: `no fake for ${fn}` } }
    },
    serviceRpc: async (fn, args) => {
      order.push('service:' + fn)
      if (fn==='file_managed_upload_for') {controls.push({as:'service',fn,args});return {data:{max_bytes:MAX_ATTACHMENT_BYTES},error:null}}
      if (fn==='file_managed_upload_registered'||fn==='file_transfer_expire'||fn==='file_temporary_expire') {controls.push({as:'service',fn,args});return {data:null,error:null}}
      if (fn==='file_transfer_settings') {controls.push({as:'service',fn,args});return {data:{},error:null}}
      rpcs.push({ as: 'service', fn, args })
      if (fn === 'file_blob_register') {
        const next = registerErrors.shift()
        if (next) return { data: null, error: next }
        opts.afterRegister?.(bucket)
        return { data: [{ blob_id: 'b1', created: opts.registerCreated ?? true }], error: null }
      }
      if (fn === 'file_blob_gc_claim') return { data: opts.claimed ?? [], error: null }
      if (fn === 'file_blob_gc_finish' || fn === 'file_blob_gc_fail') return { data: null, error: null }
      return { data: null, error: { message: `no fake for ${fn}` } }
    },
    storageSignedUrl: async (bucket, object, seconds) => `https://db.example/storage/v1/object/sign/${bucket}/${object}?expires=${seconds}`,
    storageRemove: async (bucket, object) => void removed.push(`${bucket}/${object}`),
    now: () => new Date('2026-10-16T12:00:00Z'),
    uuid: () => '22222222-2222-4222-8222-222222222222',
    log: (stage) => void logs.push(stage),
    retryDelayMs: 0,
    documentText: async () => opts.document!.text,
  }
  return { deps, calls, rpcs, controls, logs, removed, bucket, order }
}
/** The quota/actor guard must precede every byte read. Staging remains immutable and charged. */
function expectManagedCommit(f: ReturnType<typeof fakes>, publication: string, start = 0) {
  if (start) expect(f.order.slice(0, start)).toEqual(['user:file_managed_upload_prepare','object:GET','user:file_managed_upload_as'])
  expect(f.order.slice(start, start + 3)).toEqual(['user:file_managed_upload_scope', 'service:file_managed_upload_for', 'object:GET'])
  const registered = f.order.indexOf('service:file_managed_upload_registered')
  expect(registered).toBeGreaterThan(f.order.indexOf('service:file_blob_register'))
  expect(f.order.indexOf('user:' + publication)).toBeGreaterThan(registered)
  expect(f.controls.some(r => r.fn === 'file_managed_upload_closed')).toBe(false)
  expect(f.calls.some(c => c.method === 'DELETE' && c.url.includes('/staging/'))).toBe(false)
  expect(f.bucket.staging).not.toBeNull()
}
const pngBytes = () => {
  const b = new Uint8Array(64)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(b.buffer).setUint32(16, 800)
  new DataView(b.buffer).setUint32(20, 600)
  return b
}
const commitBody = (extra: Record<string, unknown> = {}) => ({ staging_key: STAGING, message_id: 'm1', chat_id: 'c1', sender_user_id: USER, file_name: 'shot.png', ...extra })

describe('managed authorization before bytes or signatures', () => {
  it('asks a client that declares no size to update, before reserving or signing',async()=>{
    const f=fakes()
    await expect(handleUpload(f.deps,USER,{})).rejects.toMatchObject({status:426,code:'client_outdated',message:expect.stringMatching(/^Update Gugu to send files/)})
    expect(f.controls).toEqual([])
    expect(f.calls).toEqual([])
  })
  it('refuses a provider lifetime mismatch before issuing an upload reservation or URL',async()=>{
    const f=fakes()
    const store=await import('../../../supabase/functions/_shared/attachment-object-storage')
    let signed=false
    f.deps.objects=store.supabaseObjectStorage({url:'https://db.example',serviceKey:'fixture',bucket:'attachments',
      fetch:async()=>new Response(JSON.stringify({file_size_limit:MAX_ATTACHMENT_BYTES})),
      signUpload:async()=>{signed=true;return 'https://db.example/scoped'},signDownload:async()=>'',
    })
    await expect(handleUpload(f.deps,USER,{size_bytes:5})).rejects.toMatchObject({status:503,code:'not_configured'})
    expect(signed).toBe(false)
    expect(f.controls.map(r=>r.fn)).toEqual(['file_managed_upload_prepare'])
  })
  it('refuses a finite provider ceiling above the deployment quota before reserving or signing',async()=>{
    const f=fakes(),store=await import('../../../supabase/functions/_shared/attachment-object-storage')
    const original=f.deps.userRpc
    f.deps.userRpc=async(fn,args)=>fn==='file_managed_upload_prepare'
      ?{data:{max_bytes:MAX_ATTACHMENT_BYTES,permit_seconds:7200},error:null}:original(fn,args)
    let signed=false
    f.deps.objects=store.supabaseObjectStorage({url:'https://db.example',serviceKey:'fixture',bucket:'attachments',
      fetch:async()=>new Response(JSON.stringify({file_size_limit:MAX_ATTACHMENT_BYTES+1})),
      signUpload:async()=>{signed=true;return 'https://db.example/scoped'},signDownload:async()=>'',
    })
    await expect(handleUpload(f.deps,USER,{size_bytes:5})).rejects.toMatchObject({status:503,code:'not_configured'})
    expect(signed).toBe(false)
    expect(f.controls).toEqual([])
  })
  it.each(['upload','commit','place','session','urls'])('stops %s when its control-plane authorization is denied', async route => {
    const f=fakes({object:pngBytes()})
    f.deps.userRpc=async()=>({data:null,error:{message:'denied by policy',hint:'file_transfer_denied'}})
    const run=route==='upload'?()=>handleUpload(f.deps,USER,{size_bytes:64}):
      route==='commit'?()=>handleCommit(f.deps,USER,commitBody()):
      route==='place'?()=>handlePlace(f.deps,USER,{staging_key:STAGING,chat_id:'c1',file_name:'x.png'}):
      route==='session'?()=>handleSessionCommit(f.deps,USER,{staging_key:STAGING,attachment_id:'33333333-3333-4333-8333-333333333333',sender_user_id:USER,sender_session_id:'s',recipient_user_ids:['receiver'],file_name:'x.png'}):
      ()=>handleUrls(f.deps,USER,{refs:[{message_id:'m1'}]})
    await expect(run()).rejects.toMatchObject({status:403,code:'denied'})
    expect(f.calls).toEqual([])
    expect(f.rpcs).toEqual([])
    expect(f.bucket.finals.size).toBe(0)
  })
})

describe('临时 / 保留(keep)', () => {
  const placeBody = (extra: Record<string, unknown> = {}) => ({ staging_key: STAGING, chat_id: 'c1', file_name: 'deck.pptx', ...extra })
  it('marks the copy that just joined the chat, as the uploader marks it later; not given, nothing is marked', async () => {
    const sent = fakes({ object: pngBytes() })
    await handleCommit(sent.deps, USER, commitBody({ keep: 'temporary' }))
    expect(sent.rpcs.map((r) => `${r.as} ${r.fn}`)).toEqual(['service file_blob_register', 'user attachment_commit', 'user file_storage_mark_as'])
    expect(sent.rpcs[2]!.args).toEqual({ p_refs: [{ message_id: 'm1' }], p_action: 'temporary', p_as: USER })
    const placed = fakes({ object: pngBytes() })
    await handlePlace(placed.deps, USER, placeBody({ keep: 'permanent', as_user_id: 'agent-1' }))
    expect(placed.rpcs.at(-1)).toEqual({ as: 'user', fn: 'file_storage_mark_as', args: { p_refs: [{ item_id: 'i9' }], p_action: 'permanent', p_as: 'agent-1' } })
    const plain = fakes({ object: pngBytes() })
    await handleCommit(plain.deps, USER, commitBody())
    expect(plain.rpcs.some((r) => r.fn === 'file_storage_mark_as')).toBe(false)
  })
  it('refuses an unknown class before anything is stored or sent', async () => {
    const bad = fakes({ object: pngBytes() })
    await expect(handleCommit(bad.deps, USER, commitBody({ keep: 'forever' }))).rejects.toMatchObject({ status: 400, code: 'invalid' })
    await expect(handlePlace(bad.deps, USER, placeBody({ keep: 'later' }))).rejects.toMatchObject({ status: 400, code: 'invalid' })
    expect(bad.rpcs).toEqual([])
  })
})

describe('提交', () => {
  it.each([17, 1023, 1024, 30 * 1024, 150 * 1024, 5 * 1024 * 1024])('原始表示的 %i 字节保留 ETag，按原字节哈希并锁定复制源', async (size) => {
    const bytes = new Uint8Array(size).fill(97)
    const f = fakes({ object: bytes })
    const { deps, calls, rpcs } = f
    await expect(handleCommit(deps, USER, commitBody({ file_name: 'probe.txt', content_type: 'text/plain' }))).resolves.toEqual({ id: 'm1', file_version: 1 })
    expectManagedCommit(f, 'attachment_commit')
    expect(calls[1]!.headers['x-oss-copy-source-if-match']).toBe('"E1"')
    expect(rpcs[0]!.args).toMatchObject({ p_sha256: createHash('sha256').update(bytes).digest('hex'), p_size_bytes: size })
  })

  it('读暂存(内网)→ 自己算 sha256 → 复制到 <aa>/<sha256>(图片类型、一年 immutable)→ 登记 → 保留暂存及额度 → 以调用者身份发消息', async () => {
    const bytes = pngBytes()
    const f = fakes({ object: bytes })
    const { deps, calls, rpcs } = f
    const message = await handleCommit(deps, USER, commitBody({ content_type: 'text/html' }))
    expectManagedCommit(f, 'attachment_commit')
    expect(f.bucket.staging?.bytes).toEqual(bytes)
    expect(message).toEqual({ id: 'm1', file_version: 1 })
    const sha = createHash('sha256').update(bytes).digest('hex')
    expect(calls.map((c) => `${c.method} ${c.url.replace(/\?.*$/, '')}`)).toEqual([
      `GET https://gugu-files-test.oss-cn-wulanchabu-internal.aliyuncs.com/${STAGING}`,
      `PUT https://gugu-files-test.oss-cn-wulanchabu.aliyuncs.com/${sha.slice(0, 2)}/${sha}`,
      `HEAD https://gugu-files-test.oss-cn-wulanchabu.aliyuncs.com/${sha.slice(0, 2)}/${sha}`,
    ])
    expect(calls[1]!.headers).toMatchObject({
      'x-oss-copy-source': `/gugu-files-test/${STAGING}`, 'x-oss-copy-source-if-match': '"E1"', 'x-oss-metadata-directive': 'REPLACE', 'Content-Type': 'image/png', 'Cache-Control': IMMUTABLE,
    })
    expect(calls[1]!.headers['Content-Disposition']).toBeUndefined()
    expect(rpcs.map((r) => `${r.as} ${r.fn}`)).toEqual(['service file_blob_register', 'user attachment_commit'])
    expect(rpcs[0]!.args).toEqual({ p_uploader: USER, p_staging_key: STAGING, p_sha256: sha, p_size_bytes: 64, p_content_type: 'image/png', p_width: 800, p_height: 600 })
    expect(rpcs[1]!.args).toMatchObject({ p_staging_key: STAGING, p_message_id: 'm1', p_chat_id: 'c1', p_sender_user_id: USER, p_file_name: 'shot.png', p_to_user_ids: [], p_is_whisper: false })
    // 没有说明就不带 p_caption 这个键:函数先于迁移落地时,老库的 attachment_commit 没有这个参数。
    expect(rpcs[1]!.args).not.toHaveProperty('p_caption')
    const captioned = fakes({ object: bytes })
    await handleCommit(captioned.deps, USER, commitBody({ caption: '看这张' }))
    expectManagedCommit(captioned, 'attachment_commit')
    expect(captioned.rpcs[1]!.args).toMatchObject({ p_caption: '看这张' })
  })

  it('不是图片:客户端报的类型像 MIME 就记它,对象上当附件下载;报的是 image/* 却不是图片 ⇒ octet-stream', async () => {
    const pdf = new TextEncoder().encode('%PDF-1.7 not really')
    const one = fakes({ object: pdf })
    await handleCommit(one.deps, USER, commitBody({ file_name: 'a.pdf', content_type: 'application/pdf' }))
    expectManagedCommit(one, 'attachment_commit')
    expect(one.rpcs[0]!.args.p_content_type).toBe('application/pdf')
    expect(one.calls[1]!.headers).toMatchObject({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment' })
    const two = fakes({ object: pdf })
    await handleCommit(two.deps, USER, commitBody({ content_type: 'image/png' }))
    expectManagedCommit(two, 'attachment_commit')
    expect(two.rpcs[0]!.args.p_content_type).toBe('application/octet-stream')
  })

  it('撞上正在回收的同一份内容:等一下、重新复制、再登记;五次还不行就说「稍后再试」', async () => {
    const deleting = { hint: 'file_blob_deleting', message: 'file blob x is being collected; try again shortly' }
    const ok = fakes({ object: pngBytes(), registerErrors: [deleting, deleting] })
    await handleCommit(ok.deps, USER, commitBody())
    expectManagedCommit(ok, 'attachment_commit')
    expect(ok.calls.filter((c) => c.method === 'PUT')).toHaveLength(3)
    expect(ok.rpcs.filter((r) => r.fn === 'file_blob_register')).toHaveLength(3)
    const stuck = fakes({ object: pngBytes(), registerErrors: Array(5).fill(deleting) })
    await expect(handleCommit(stuck.deps, USER, commitBody())).rejects.toMatchObject({ status: 503, code: 'retry' })
    expect(stuck.rpcs.some((r) => r.fn === 'attachment_commit')).toBe(false)
  })

  it('读完暂存、复制之前暂存被换了内容:复制带 if-match 被拒 ⇒ 409 upload_changed,以那个 sha 命名的对象不写、不登记、不发消息', async () => {
    const original = pngBytes()
    const swapped = new TextEncoder().encode('M: other content')
    const { deps, rpcs, bucket } = fakes({ object: original, afterGet: (b) => void (b.staging = { bytes: swapped, etag: '"E2"' }) })
    await expect(handleCommit(deps, USER, commitBody())).rejects.toMatchObject({ status: 409, code: 'upload_changed' })
    expect(bucket.finals.size).toBe(0)
    expect(rpcs).toEqual([])
  })

  it('复制和登记之间回收把同一个 sha 的旧 blob 收完、删了对象(登记新建一行):发布前看一眼,不在就再复制一次;复用已有的行不看', async () => {
    const bytes = pngBytes()
    const sha = createHash('sha256').update(bytes).digest('hex')
    const final = `${sha.slice(0, 2)}/${sha}`
    const raced = fakes({ object: bytes, afterRegister: (b) => void b.finals.clear() })
    await handleCommit(raced.deps, USER, commitBody())
    expectManagedCommit(raced, 'attachment_commit')
    expect(raced.calls.map((c) => c.method)).toEqual(['GET', 'PUT', 'HEAD', 'PUT'])
    expect(raced.bucket.finals.get(final)).toEqual(bytes)
    expect(raced.bucket.staging?.bytes).toEqual(bytes)
    const reused = fakes({ object: bytes, registerCreated: false })
    await handleCommit(reused.deps, USER, commitBody())
    expectManagedCommit(reused, 'attachment_commit')
    expect(reused.calls.map((c) => c.method)).toEqual(['GET', 'PUT'])
  })

  it('暂存没了(上一次已经登记、删了暂存):不复制不登记,交给库认那次登记;超过许可的 25 MiB:413,什么都不登记;暂存不是自己的:400', async () => {
    const retry = fakes({ object: null })
    expect(await handleCommit(retry.deps, USER, commitBody())).toEqual({ id: 'm1', file_version: 1 })
    expect(retry.rpcs.map((r) => r.fn)).toEqual(['attachment_commit'])
    const big = fakes({ object: new Uint8Array(MAX_ATTACHMENT_BYTES + 1) })
    await expect(handleCommit(big.deps, USER, commitBody())).rejects.toMatchObject({ status: 413, code: 'too_large' })
    expect(big.rpcs).toEqual([])
    const other = fakes({ object: pngBytes() })
    await expect(handleCommit(other.deps, '33333333-3333-4333-8333-333333333333', commitBody())).rejects.toMatchObject({ status: 400 })
    expect(other.calls).toEqual([])
  })

  it('库的拒绝按 HINT 认成状态码;群规、RLS 是 403', () => {
    expect(refusalFromDb({ message: 'x', hint: 'attachment_upload_not_found' })).toMatchObject({ status: 404, code: 'upload_not_found' })
    expect(refusalFromDb({ message: 'x', hint: 'attachment_source_gone' })).toMatchObject({ status: 410, code: 'source_gone' })
    expect(refusalFromDb({ message: 'workspace: c is not a chat you are a member of' })).toMatchObject({ status: 403, code: 'denied' })
    expect(refusalFromDb({ message: 'new row violates row-level security policy for table "messages"' })).toMatchObject({ status: 403 })
    expect(refusalFromDb({ message: 'rate-limited', code: 'PT429' })).toMatchObject({ status: 429 })
    expect(refusalFromDb({ message: 'something else' })).toMatchObject({ status: 500, code: 'failed' })
    expect(new Refusal(400, 'invalid', 'x')).toBeInstanceOf(Error)
  })
})

describe('代主人发给好友', () => {
  it('带 friend_user_id 的提交:登记字节,再以主人身份 send_friend_file_as_owner(agent、请求号、说明原样带上);缺请求号在读字节之前拒', async () => {
    const f = fakes({ object: pngBytes() })
    const { deps, rpcs } = f
    const answer = await handleCommit(deps, USER, { staging_key: STAGING, friend_user_id: 'f1', agent_user_id: 'a1', file_name: 'x.png', request_id: 'r1', caption: '给你' })
    expectManagedCommit(f, 'send_friend_file_as_owner')
    expect(answer).toMatchObject({ chat_id: 'dm-1', message_id: 'm-o', sent_by_agent: true })
    expect(rpcs.map((r) => `${r.as} ${r.fn}`)).toEqual(['service file_blob_register', 'user send_friend_file_as_owner'])
    expect(rpcs[1]!.args).toEqual({ p_agent_user_id: 'a1', p_friend_user_id: 'f1', p_staging_key: STAGING, p_file_name: 'x.png', p_request_id: 'r1', p_caption: '给你' })
    const bad = fakes({ object: pngBytes() })
    await expect(handleCommit(bad.deps, USER, { staging_key: STAGING, friend_user_id: 'f1', agent_user_id: 'a1', file_name: 'x.png' })).rejects.toMatchObject({ status: 400 })
    expect(bad.calls).toEqual([])
  })
})

describe('只放进群文件夹(App 写文件)', () => {
  const placeBody = (extra: Record<string, unknown> = {}) => ({ staging_key: STAGING, chat_id: 'c1', file_name: 'deck.pptx', ...extra })

  it('建文件:读暂存 → 登记 → 以调用者身份 file_place_as(文件夹、代谁、来源消息原样带上);不发消息', async () => {
    const f = fakes({ object: pngBytes() })
    const { deps, rpcs } = f
    expect(await handlePlace(deps, USER, placeBody({ folder: 'specs', as_user_id: 'agent-1', source_message_ids: ['m7'] }))).toEqual({ id: 'i9', version: 1, path: 'deck.pptx' })
    expectManagedCommit(f, 'file_place_as')
    expect(rpcs.map((r) => `${r.as} ${r.fn}`)).toEqual(['service file_blob_register', 'user file_place_as'])
    expect(rpcs[1]!.args).toEqual({ p_staging_key: STAGING, p_chat_id: 'c1', p_as_user_id: 'agent-1', p_file_name: 'deck.pptx', p_folder: 'specs', p_source_message_ids: ['m7'] })
  })

  it('给 item_id ⇒ 换那个文件(expected_version 带上);不给 as_user_id ⇒ 调用者自己,不给 folder ⇒ NULL(根)', async () => {
    const f = fakes({ object: pngBytes() })
    const { deps, rpcs } = f
    expect(await handlePlace(deps, USER, { staging_key: STAGING, item_id: 'i3', expected_version: 3 })).toEqual({ id: 'i3', version: 4 })
    expectManagedCommit(f, 'file_replace_as')
    expect(rpcs.map((r) => `${r.as} ${r.fn}`)).toEqual(['service file_blob_register', 'user file_replace_as'])
    expect(rpcs[1]!.args).toEqual({ p_staging_key: STAGING, p_item_id: 'i3', p_as_user_id: USER, p_expected_version: 3 })
    const root = fakes({ object: pngBytes() })
    await handlePlace(root.deps, USER, placeBody())
    expectManagedCommit(root, 'file_place_as')
    expect(root.rpcs[1]!.args).toMatchObject({ p_folder: null, p_as_user_id: USER, p_source_message_ids: [] })
  })

  it('拒:暂存不是自己的(什么都不读)、expected_version 不是正整数、建文件缺名字 —— 都在读字节之前', async () => {
    const other = fakes({ object: pngBytes() })
    await expect(handlePlace(other.deps, '33333333-3333-4333-8333-333333333333', placeBody())).rejects.toMatchObject({ status: 400 })
    expect(other.calls).toEqual([])
    const bad = fakes({ object: pngBytes() })
    await expect(handlePlace(bad.deps, USER, { staging_key: STAGING, item_id: 'i3', expected_version: '3' })).rejects.toMatchObject({ status: 400, code: 'invalid' })
    await expect(handlePlace(bad.deps, USER, { staging_key: STAGING, chat_id: 'c1' })).rejects.toMatchObject({ status: 400 })
    expect(bad.calls).toEqual([])
  })

  it('库的拒绝:版本对不上 409 version_conflict;名字空、同样的内容、活文档 400;其余 workspace_* 原样带出', () => {
    expect(refusalFromDb({ message: 'x', hint: 'workspace_version_conflict' })).toMatchObject({ status: 409, code: 'version_conflict' })
    expect(refusalFromDb({ message: 'x', hint: 'file_place_invalid' })).toMatchObject({ status: 400, code: 'invalid' })
    // 群文件夹自己的拒绝:HINT 原样作 code(客户端按 FOLDER_CODES 认),版本对不上照旧 version_conflict。
    expect(refusalFromDb({ message: 'workspace: c is not a chat you are a member of', hint: 'workspace_not_member' }))
      .toMatchObject({ status: 400, code: 'workspace_not_member' })
    expect(refusalFromDb({ message: 'x', hint: 'workspace_name_taken' })).toMatchObject({ status: 400, code: 'workspace_name_taken' })
  })
})

describe('直传表单、签名链接、回收', () => {
  it('isolates upload, commit, signatures and GC in the configured directory while keeping database keys logical', async () => {
    const bytes = pngBytes()
    const sha = await sha256Hex(bytes)
    const logical = `${sha.slice(0, 2)}/${sha}`
    const f = fakes({ object: bytes, claimed: [{ blob_id: 'b1', claim_token: 't1', bucket_id: 'oss', object_name: logical, content_type: 'image/png' }] })
    f.deps.oss = { ...OSS, objectPrefix: 'production' }
    f.deps.cdn = { ...CDN, objectPrefix: 'production' }
    const up = await handleUpload(f.deps, USER,{size_bytes:MAX_ATTACHMENT_BYTES})
    expect(up.staging_key).toBe(STAGING)
    expect(up.fields.key).toBe(`production/${STAGING}`)
    expect(JSON.parse(atob(up.fields.policy!)).conditions).toContainEqual(['eq', '$key', `production/${STAGING}`])
    await handleCommit(f.deps, USER, commitBody())
    expectManagedCommit(f, 'attachment_commit', 3)
    expect(f.calls.find(c => c.method === 'GET' && c.url.includes('/staging/'))!.url).toContain(`/production/${STAGING}`)
    const copy = f.calls.find(c => c.method === 'PUT')!
    expect(copy.url).toContain(`/production/${logical}`)
    expect(copy.headers['x-oss-copy-source']).toBe(`/${OSS.bucket}/production/${STAGING}`)
    expect(f.rpcs.find(r => r.fn === 'file_blob_register')!.args.p_staging_key).toBe(STAGING)
    const signed = await ossSign(f.deps.oss, { method: 'GET', key: logical })
    expect(signed.canonical).toContain(`/${OSS.bucket}/production/${logical}`)
    const url = cdnSignedUrl(f.deps.cdn, logical, { image: true, now: f.deps.now(), rand: 'r0' })
    expect(url.url).toContain(`/production/${logical}?auth_key=`)
    expect(url.url).not.toBe(cdnSignedUrl(CDN, logical, { image: true, now: f.deps.now(), rand: 'r0' }).url)
    f.calls.length = 0
    expect(await handleGc(f.deps)).toEqual({ claimed: 1, deleted: 1, failed: 0 })
    expect(f.calls[0]!.url).toBe(`https://${OSS.bucket}.${OSS.endpointPublic}/production/${logical}`)
    expect(new URL(f.calls[1]!.url).searchParams.get('ObjectPath')).toBe(`https://${CDN.domain}/production/${logical}`)
    expect(f.calls.some(c => new URL(c.url).pathname === `/${logical}`)).toBe(false)
  })

  it.each(['../production', '/production', 'production/', 'production//other'])('rejects invalid object prefix %s', async (objectPrefix) => {
    await expect(postObjectForm({ ...OSS, objectPrefix }, { key: STAGING })).rejects.toThrow('Invalid attachment object prefix')
  })

  it('upload:key 是 staging/<调用者>/<uuid>', async () => {
    const { deps } = fakes()
    const up = await handleUpload(deps, USER,{size_bytes:MAX_ATTACHMENT_BYTES})
    expect(up).toMatchObject({ staging_key: STAGING, url: 'https://gugu-files-test.oss-cn-wulanchabu.aliyuncs.com/', max_bytes: MAX_ATTACHMENT_BYTES })
    expect(up.fields.key).toBe(STAGING)
  })

  it('urls:OSS 的走 CDN 鉴权 A(图片另给缩略图),老对象走存储的签名链接;悄悄话附件按消息要;refs 不对就 400', async () => {
    const { deps, controls } = fakes()
    const refs = [{ item_id: '44444444-4444-4444-8444-444444444444' }, { item_id: '55555555-5555-4555-8555-555555555555', version: 2 }, { message_id: 'm1' }]
    const { urls } = await handleUrls(deps, USER, { refs })
    expect(controls.filter(r=>r.fn==='file_transfer_download_as').map(r=>r.args.p_ref)).toEqual(refs)
    expect(urls[0]).toMatchObject({ item_id: refs[0]!.item_id, version: 1, message_id: null, current_version: 3, size_bytes: 10, content_type: 'image/png', width: 640, expires_at: '2026-10-16T12:01:00.000Z' })
    expect(urls[0]!.url).toMatch(new RegExp(`^https://${CDN.domain}/ab/(ab){32}\\?auth_key=\\d+-[0-9a-f]+-0-[0-9a-f]{32}$`))
    expect(urls[0]!.thumb_url).toBe(`${urls[0]!.url}&x-oss-process=${THUMB_PROCESS}`)
    expect(urls[1]).toMatchObject({ item_id: refs[1]!.item_id, thumb_url: null, url: 'https://db.example/storage/v1/object/sign/workspace/c/u/x-b.pptx?expires=60' })
    expect(urls[2]).toMatchObject({ item_id: null, version: null, message_id: 'm1', current_version: null, file_name: 'w.pdf', thumb_url: null })
    expect(urls[2]!.url).toMatch(new RegExp(`^https://${CDN.domain}/cd/(cd){32}\\?auth_key=`))
    const both = { item_id: '44444444-4444-4444-8444-444444444444', message_id: 'm1' }
    for (const refs of [[], [{ item_id: 'not-a-uuid' }], [{ message_id: '' }], [{ message_id: 7 }], [both], Array(201).fill({ item_id: '44444444-4444-4444-8444-444444444444' }), 'x']) {
      await expect(handleUrls(deps, USER, { refs })).rejects.toMatchObject({ status: 400 })
    }
  })

  it('gc:OSS 的删对象、图片用 IgnoreParams 清 CDN、报完成;老对象从存储里删;删失败报失败,不挡下一个', async () => {
    const claimed = [
      { blob_id: 'b1', claim_token: 't1', bucket_id: 'oss', object_name: 'ab/x', content_type: 'image/png' },
      { blob_id: 'b2', claim_token: 't2', bucket_id: 'workspace', object_name: 'c/u/old', content_type: 'application/x' },
    ]
    const { deps, calls, rpcs, removed, controls, order } = fakes({ claimed })
    expect(await handleGc(deps)).toEqual({ claimed: 2, deleted: 2, failed: 0 })
    expect(controls.filter(r => r.fn === 'file_temporary_expire')).toEqual([{as:'service',fn:'file_temporary_expire',args:{p_limit:500}}])
    expect(order.indexOf('service:file_temporary_expire')).toBeLessThan(order.indexOf('service:file_transfer_expire'))
    expect(controls.filter(r => r.fn === 'file_transfer_expire')).toEqual([{as:'service',fn:'file_transfer_expire',args:{p_limit:500}}])
    expect(order.indexOf('service:file_transfer_expire')).toBeLessThan(order.indexOf('service:file_blob_gc_claim'))
    expect(order).not.toContain('service:file_transfer_object_gone')
    expect(calls.map((c) => `${c.method} ${c.url.replace(/\?.*$/, '')}`)).toEqual([
      'DELETE https://gugu-files-test.oss-cn-wulanchabu.aliyuncs.com/ab/x',
      'POST https://cdn.aliyuncs.com/',
    ])
    expect(decodeURIComponent(calls[1]!.url)).toContain('ObjectType=IgnoreParams')
    expect(removed).toEqual(['workspace/c/u/old'])
    expect(rpcs.filter((r) => r.fn === 'file_blob_gc_finish').map((r) => r.args.p_blob_id)).toEqual(['b1', 'b2'])


    const broken = fakes({ claimed })
    broken.deps.storageRemove = async () => { throw new Error('storage 500') }
    expect(await handleGc(broken.deps)).toEqual({ claimed: 2, deleted: 1, failed: 1 })
    expect(broken.rpcs.filter((r) => r.fn === 'file_blob_gc_fail').map((r) => r.args)).toEqual([{ p_blob_id: 'b2', p_claim_token: 't2', p_error: 'Error: storage 500' }])
  })
  it('gc removes temporary ciphertext at the same private provider without invoking CDN or weakening claim confirmation',async()=>{
    const {deps,calls,rpcs,removed}=fakes({claimed:[{blob_id:'temporary',claim_token:'token',bucket_id:'temporary',object_name:'temporary/group/file/generation',content_type:'application/octet-stream'}]})
    expect(await handleGc(deps)).toEqual({claimed:1,deleted:1,failed:0})
    expect(calls.map(c=>`${c.method} ${c.url.replace(/\?.*$/,'')}`)).toEqual(['DELETE https://gugu-files-test.oss-cn-wulanchabu.aliyuncs.com/temporary/group/file/generation'])
    expect(removed).toEqual([])
    expect(rpcs.filter(r=>r.fn==='file_blob_gc_finish').map(r=>r.args)).toEqual([{p_blob_id:'temporary',p_claim_token:'token'}])
  })
})

describe('按引用发(share)', () => {
  const SHARE = '44444444-4444-4444-8444-444444444444'
  const shareBody = { item_id: 'item-1', message_id: SHARE, chat_id: 'c2', sender_user_id: USER }
  it('存的文件:一次 attachment_share,钉住给的那一版;不读正文、不放暂存', async () => {
    const { deps, calls, rpcs } = fakes()
    await expect(handleShare(deps, USER, { ...shareBody, version: 3 })).resolves.toMatchObject({ id: SHARE, file_version: 3 })
    expect(calls).toEqual([])
    expect(rpcs.map((r) => `${r.as} ${r.fn}`)).toEqual(['user attachment_share'])
    expect(rpcs[0]!.args).toMatchObject({ p_item_id: 'item-1', p_version: 3, p_message_id: SHARE, p_chat_id: 'c2', p_sender_user_id: USER })
  })

  it('编辑器里改过的文本文件(没有带字节的一版):正文放进暂存(按这条新消息起名)→ 和提交同一步登记 → 定成一版 → 钉住那一版', async () => {
    const text = '# 周报\n\n第二版'
    const { deps, calls, rpcs, controls } = fakes({ document: { text, snapshotted: null } })
    await expect(handleShare(deps, USER, shareBody)).resolves.toMatchObject({ id: SHARE, file_version: 8 })
    const key = `staging/${USER}/${SHARE}`
    expect(calls.filter((c) => c.method === 'PUT').map((c) => c.url)).toContainEqual(`https://gugu-files-test.oss-cn-wulanchabu-internal.aliyuncs.com/${key}`)
    expect(rpcs.map((r) => `${r.as} ${r.fn}`)).toEqual([
      'user attachment_document_snapshot', 'service file_blob_register', 'user attachment_document_snapshot', 'user attachment_share'])
    expect(rpcs[0]!.args).toEqual({ p_item_id: 'item-1', p_as_user_id: USER, p_text: text, p_staging_key: null })
    expect(rpcs[1]!.args).toMatchObject({ p_staging_key: key, p_size_bytes: new TextEncoder().encode(text).length, p_sha256: createHash('sha256').update(text).digest('hex') })
    expect(rpcs[2]!.args).toMatchObject({ p_text: text, p_staging_key: key })
    // No version asked: the text as it is now, the snapshot's version is pinned.
    expect(rpcs[3]!.args).toMatchObject({ p_item_id: 'item-1', p_version: 8 })
    expect(controls.find((c) => c.fn === 'file_managed_upload_as')!.args).toMatchObject({ p_id: SHARE, p_chat: 'c1', p_as: USER })
  })

  it('文本文件给了版本:钉住那一版(发过、带字节的),不读正文、不定新版;没有字节的那一版说清楚,从不换成现在的正文', async () => {
    const { deps, calls, rpcs } = fakes({ document: { text: '# 周报 现在', snapshotted: null } })
    await expect(handleShare(deps, USER, { ...shareBody, version: 7 })).resolves.toMatchObject({ file_version: 7 })
    expect(rpcs.map((r) => `${r.as} ${r.fn}`)).toEqual(['user attachment_share'])
    await expect(handleShare(deps, USER, { ...shareBody, version: 2 })).rejects.toMatchObject({ status: 409, code: 'version_unavailable' })
    expect(rpcs.map((r) => r.fn)).not.toContain('attachment_document_snapshot')
    expect(calls).toEqual([])
  })

  it('同一段正文再发一次:就是上次那一版,不再上传、不再登记', async () => {
    const text = '# 周报'
    const { deps, calls, rpcs } = fakes({ document: { text, snapshotted: text } })
    await expect(handleShare(deps, USER, shareBody)).resolves.toMatchObject({ file_version: 7 })
    expect(calls).toEqual([])
    expect(rpcs.map((r) => `${r.as} ${r.fn}`)).toEqual(['user attachment_document_snapshot', 'user attachment_share'])
  })
})

describe('转发', () => {
  const FWD = '33333333-3333-4333-8333-333333333333'
  const forwardBody = { source_message_id: 'old-1', message_id: FWD, chat_id: 'c2', sender_user_id: USER }
  it('老式附件:先照旧转、库说要字节 → 库说出它在 chat-media 的对象 → 读出字节放进暂存(按这条新消息起名)→ 和提交同一步登记 → 带上这次上传再转', async () => {
    const bytes = pngBytes()
    const { deps, calls, rpcs } = fakes({ legacy: { row: { object_name: `${USER}/abc-old.png`, file_name: 'old.png', content_type: 'image/png' }, bytes } })
    const message = await handleForward(deps, USER, forwardBody)
    expect(message).toMatchObject({ id: FWD, forwarded_from_message_id: 'old-1' })
    const key = `staging/${USER}/${FWD}`
    expect(calls.map((c) => `${c.method} ${c.url.replace(/\?.*$/, '')}`)).toEqual([
      `GET https://db.example/storage/v1/object/sign/chat-media/${USER}/abc-old.png`,
      `PUT https://gugu-files-test.oss-cn-wulanchabu-internal.aliyuncs.com/${key}`,
      `GET https://gugu-files-test.oss-cn-wulanchabu-internal.aliyuncs.com/${key}`,
      expect.stringMatching(/^PUT https:\/\/gugu-files-test\.oss-cn-wulanchabu\.aliyuncs\.com\/[0-9a-f]{2}\/[0-9a-f]{64}$/),
      expect.stringMatching(/^HEAD https:\/\/gugu-files-test\.oss-cn-wulanchabu\.aliyuncs\.com\/[0-9a-f]{2}\/[0-9a-f]{64}$/),
    ])
    expect(rpcs.map((r) => `${r.as} ${r.fn}`)).toEqual(['user attachment_forward', 'user attachment_legacy_source', 'service file_blob_register', 'user attachment_forward'])
    expect(rpcs[0]!.args).not.toHaveProperty('p_staging_key')
    expect(rpcs[1]!.args).toEqual({ p_source_message_id: 'old-1' })
    expect(rpcs[2]!.args).toMatchObject({ p_uploader: USER, p_staging_key: key, p_size_bytes: bytes.length, p_content_type: 'image/png' })
    expect(rpcs[3]!.args).toMatchObject({ p_source_message_id: 'old-1', p_message_id: FWD, p_chat_id: 'c2', p_staging_key: key })
  })

  it('新式附件:一次就转完 —— 不问老式来源(函数先于迁移上线时旧库里还没有它)、不碰 chat-media、不放暂存', async () => {
    const { deps, calls, rpcs } = fakes()
    await handleForward(deps, USER, forwardBody)
    expect(calls).toEqual([])
    expect(rpcs.map((r) => `${r.as} ${r.fn}`)).toEqual(['user attachment_forward'])
    expect(rpcs[0]!.args).not.toHaveProperty('p_staging_key')
  })

  it('老式附件的字节在 chat-media 里已经没了:说清楚(410 source_gone),不转', async () => {
    const { deps, rpcs } = fakes({ legacy: { row: { object_name: `${USER}/gone.png`, file_name: 'gone.png', content_type: 'image/png' }, bytes: null } })
    await expect(handleForward(deps, USER, forwardBody)).rejects.toMatchObject({ status: 410, code: 'source_gone' })
    expect(rpcs.map((r) => r.fn)).toEqual(['attachment_forward', 'attachment_legacy_source'])
  })
})


describe('private session attachment routes', () => {
  const id='33333333-3333-4333-8333-333333333333'
  it('promotes the original bytes using the existing blob pipeline, without making a chat message',async()=>{
    const bytes=new Uint8Array([0,255,12,0,128])
    const f=fakes({object:bytes})
    const {deps,bucket,rpcs}=f
    const base=deps.userRpc
    deps.userRpc=async(fn,args)=>fn==='session_attachment_commit'
      ? (f.order.push('user:session_attachment_commit'), {data:[{attachment_id:id,file_name:args.p_file_name,sha256:await sha256Hex(bytes),size_bytes:bytes.length,content_type:'application/octet-stream'}],error:null})
      : base(fn,args)
    const answer=await handleSessionCommit(deps,USER,{staging_key:STAGING,attachment_id:id,sender_user_id:'sender',sender_session_id:'s',recipient_user_ids:['receiver'],file_name:'original.bin'})
    expectManagedCommit(f, 'session_attachment_commit')
    expect(answer).toMatchObject({attachment_id:id,size_bytes:5,sha256:await sha256Hex(bytes)})
    expect([...bucket.finals.values()]).toEqual([bytes])
    expect(rpcs.some(row=>row.fn==='file_blob_register')).toBe(true)
    expect(rpcs.some(row=>row.fn==='attachment_commit')).toBe(false)
  })
  it('signs only database-authorized session references, with the current Agent actor',async()=>{
    const {deps}=fakes()
    let actor:unknown
    deps.userRpc=async(fn,args)=>{
      expect(fn).toBe('file_transfer_download_as');actor=args.p_as
      return {data:args.p_as==='receiver' ? {status:'ready',source:'managed-object',attachment_id:id,file_name:'x.bin',
        bucket_id:'oss',object_name:'ab/'+ 'ab'.repeat(32),sha256:'ab'.repeat(32),size_bytes:4,
        content_type:'application/octet-stream',download_id:args.p_id,transfer_id:null,
        signed_at:'2026-10-16T12:00:00Z',expires_at:'2026-10-16T12:01:00Z'} : {status:'gone'},error:null}
    }
    const answer=await handleSessionUrls(deps,USER,{attachment_ids:[id],as:'receiver'})
    expect(actor).toBe('receiver')
    expect(answer.attachments).toMatchObject([{attachment_id:id,sha256:'ab'.repeat(32),size_bytes:4,url:expect.any(String)}])
    expect(await handleSessionUrls(deps,USER,{attachment_ids:[id],as:'other-agent'})).toEqual({attachments:[]})
  })
})
