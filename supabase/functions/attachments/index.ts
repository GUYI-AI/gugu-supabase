// Community attachments: bytes in the project's Supabase Storage by default, or Alibaba Cloud OSS + CDN when every OSS
// variable is set (see ../_shared/attachment-storage-config.ts). User/RLS and GC authorization are enforced below.
import { createClient } from 'npm:@supabase/supabase-js@2.110.9'
import {
  type AttachmentsDeps,
  handleCommit,
  handleSessionCommit,
  handleSessionUrls,
  handleSessionRevoke,
  handlePlace,
  handleForward,
  handleShare,
  handleGc,
  handleUpload,
  handleUrls,
  Refusal,
} from '../_shared/attachments-core.ts'

import { ossObjectStorage, supabaseObjectStorage } from '../_shared/attachment-object-storage.ts'
import { type AttachmentStorageConfig, attachmentStorageConfig, StorageConfigError } from '../_shared/attachment-storage-config.ts'
import { handleUsageImport,handleStorageInventory,handleFileResolve } from '../_shared/file-transfer-core.ts'
import { handleProjectFiles } from '../_shared/project-file-transfer-core.ts'
import { ossDirectSigner } from '../_shared/oss-direct-url.ts'
import { handleDocumentImport, WORKSPACE_TEXT_MAX_BYTES, workspaceUploadKind } from '../_shared/document-import-core.ts'

const env = (key: string): string => Deno.env.get(key)?.trim() ?? ''

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' } })
}

function log(stage: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ fn: 'attachments', stage, ...extra }))
}

const REQUIRED = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']

/** 两段一样长才比内容,逐字节异或:比较的时间不随第一个不同的位置变。 */
function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a)
  const y = new TextEncoder().encode(b)
  if (x.length !== y.length || x.length === 0) return false
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!
  return diff === 0
}

function publicStorageUrl(signedUrl: string, internalBase: string): string {
  const internal = internalBase.replace(/\/$/, '')
  if (!signedUrl.startsWith(internal + '/')) throw new Error('Unexpected storage URL origin')
  const external = (env('GUGU_PUBLIC_SUPABASE_URL') || internal).replace(/\/$/, '')
  return external + signedUrl.slice(internal.length)
}

function depsFor(authorization: string, storage: AttachmentStorageConfig): AttachmentsDeps {
  const url = env('SUPABASE_URL')
  const asUser = createClient(url, env('SUPABASE_ANON_KEY'), {
    db: { schema: 'chat' },
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const asService = createClient(url, env('SUPABASE_SERVICE_ROLE_KEY'), { db: { schema: 'chat' }, auth: { persistSession: false } })
  const signStorage=async(bucket:string,object:string,seconds:number)=>{
    // Storage signs the same 60-second capability; any gateway rate policy is independent.
    if(seconds!==60) {
      throw new Refusal(503,'not_configured','Managed Storage downloads require a 60-second capability')
    }
    const {data,error}=await asService.storage.from(bucket).createSignedUrl(object,seconds)
    if(error||!data?.signedUrl) throw new Error('Could not sign a managed Storage download')
    return publicStorageUrl(data.signedUrl,url)
  }
  const files = (env('GUGU_FILES_URL') || `${env('GUGU_PUBLIC_SUPABASE_URL') || url}/files`).replace(/\/$/, '')
  return {
    documentReplacement: async (item, actor, body) => {
      const response = await fetch(`${files}/${item}/replace`, { method: 'POST',
        headers: { Authorization: authorization, 'X-Gugu-As-Agent': actor, 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(35_000) })
      const answer = await response.json()
      if (!response.ok) throw new Refusal(response.status, answer.error ?? 'replacement_failed', 'The document changed or could not be replaced')
    },
    documentText: async (item, asAgent) => {
      const response = await fetch(`${files}/${item}`, { headers: { Authorization: authorization, ...(asAgent ? { 'X-Gugu-As-Agent': asAgent } : {}) },
        signal: AbortSignal.timeout(35_000) })
      const answer = await response.json()
      if (!response.ok || typeof answer.text !== 'string') throw new Refusal(response.status === 404 ? 404 : 502, answer.error ?? 'document_unreadable', 'The text document could not be read')
      return answer.text
    },
    textFiles: { maxBytes: WORKSPACE_TEXT_MAX_BYTES, classify: workspaceUploadKind },
    objects: storage.kind === 'oss'
      ? ossObjectStorage({ oss: storage.oss, cdn: storage.cdn, directSign:ossDirectSigner(storage.oss),fetch: (input, init) => fetch(input, init) })
      : supabaseObjectStorage({
        url, serviceKey: env('SUPABASE_SERVICE_ROLE_KEY'), bucket: storage.bucket,
        fetch: (input, init) => fetch(input, init),
        signUpload: async (key) => {
          const { data, error } = await asService.storage.from(storage.bucket).createSignedUploadUrl(key)
          if (error || !data?.signedUrl) throw new Error('could not sign attachment upload')
          return publicStorageUrl(data.signedUrl, url)
        },
        signDownload: (key,seconds)=>signStorage(storage.bucket,key,seconds),
      }),
    fetch: (input, init) => fetch(input, init),
    userRpc: async (fn, args) => {
      const { data, error } = await asUser.rpc(fn, args)
      return { data, error: error ? { message: error.message, hint: error.hint, code: error.code } : null }
    },
    serviceRpc: async (fn, args) => {
      const { data, error } = await asService.rpc(fn, args)
      return { data, error: error ? { message: error.message, hint: error.hint, code: error.code } : null }
    },
    storageSignedUrl:signStorage,
    storageRemove: async (bucket, object) => {
      const { error } = await asService.storage.from(bucket).remove([object])
      if (error) throw new Error(`could not remove ${bucket}/${object}: ${error.message}`)
    },
    now: () => new Date(),
    uuid: () => crypto.randomUUID(),
    log,
  }
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (request.method !== 'POST') return json({ error: 'invalid', message: 'POST only' }, 405)
  const missing = REQUIRED.filter((key) => !env(key))
  if (missing.length) {
    log('not_configured', { missing })
    return json({ error: 'not_configured', message: `attachments storage is not configured: ${missing.join(', ')}` }, 503)
  }
  let storage: AttachmentStorageConfig
  try {
    storage = attachmentStorageConfig(env)
  } catch (error) {
    if (!(error instanceof StorageConfigError)) throw error
    log('not_configured', { missing: error.missing })
    return json({ error: 'not_configured', message: error.message }, 503)
  }
  const route = new URL(request.url).pathname.split('/').filter(Boolean).at(-1) ?? ''
  const authorization = request.headers.get('Authorization') ?? ''
  try {
    const deps = depsFor(authorization, storage)
    if (route === 'usage-import'||route==='storage-inventory'||route==='document-import') {
      if (!sameSecret(authorization.replace(/^Bearer\s+/i,''),env('SUPABASE_SERVICE_ROLE_KEY'))) {
        return json({error:'denied',message:'Usage ingestion is restricted to the service'},401)
      }
      const body=await request.json()
      if (route==='document-import') return json(await handleDocumentImport(deps,body))
      return json(await (route==='usage-import'?handleUsageImport(deps.serviceRpc,body):handleStorageInventory(deps.serviceRpc,body)))
    }
    if (route === 'gc') {
      if (!sameSecret(authorization.replace(/^Bearer\s+/i, ''), env('SUPABASE_SERVICE_ROLE_KEY'))) {
        return json({ error: 'denied', message: 'gc is the server\'s own job' }, 401)
      }
      const result = await handleGc(deps)
      // OSS expires abandoned staging uploads with its own lifecycle rule; only the Supabase bucket needs this sweep.
      if (storage.kind === 'oss') return json({ ...result, staging_deleted: 0 })
      const service = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), { db: { schema: 'chat' }, auth: { persistSession: false } })
      const bucket = storage.bucket
      const { data: expired, error: expiredError } = await service.rpc('attachment_expired_staging', { p_bucket: bucket })
      if (expiredError) throw new Error('Could not list expired staging uploads')
      const names = ((expired ?? []) as Array<{ name: string }>).map((row) => row.name)
      if (names.length) {
        const { error } = await service.storage.from(bucket).remove(names)
        if (error) throw new Error('Could not remove expired staging uploads')
      }
      return json({ ...result, staging_deleted: names.length })
    }
    const asUser = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data: who, error: whoError } = await asUser.auth.getUser()
    if (whoError || !who?.user?.id) return json({ error: 'denied', message: 'sign in first' }, 401)
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    if(route.startsWith('file-')&&route!=='file-resolve') return json(await handleProjectFiles(deps,who.user.id,route,body))
    switch (route) {
      case 'file-resolve':
        return json(await handleFileResolve(deps,who.user.id,body))
      case 'upload':
        return json(await handleUpload(deps, who.user.id,body))
      case 'session-commit':
        return json({ attachment: await handleSessionCommit(deps, who.user.id, body) })
      case 'session-revoke':
        return json(await handleSessionRevoke(deps, who.user.id, body))
      case 'session-urls':
        return json(await handleSessionUrls(deps, who.user.id, body))
      case 'commit':
        return json({ message: await handleCommit(deps, who.user.id, body) })
      case 'place':
        return json({ item: await handlePlace(deps, who.user.id, body) })
      case 'forward':
        return json({ message: await handleForward(deps, who.user.id, body) })
      case 'share':
        return json({ message: await handleShare(deps, who.user.id, body) })
      case 'urls':
        return json(await handleUrls(deps, who.user.id, body))
      default:
        return json({ error: 'invalid', message: `no route ${route}` }, 404)
    }
  } catch (error) {
    if (error instanceof Refusal) return json({ error: error.code, message: error.message }, error.status)
    log('failed', { route, error_type:error instanceof Error?error.name:'unknown' })
    return json({ error: 'failed', message: 'attachments failed; try again' }, 500)
  }
})
