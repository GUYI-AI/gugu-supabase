import { type AttachmentsDeps, type Rpc, call, objectStorage, Refusal } from './attachments-core.ts'
import { canSignThumbnail } from './blob-sniff.ts'
import { ObjectStorageError } from './object-storage.ts'

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function fileRef(value:unknown):Record<string,unknown> {
  const r=value as Record<string,unknown>
  if (!r||typeof r!=='object'||Array.isArray(r)) throw new Refusal(400,'invalid','A file reference is required')
  if (typeof r.message_id==='string'&&r.message_id&&Object.keys(r).length===1) return r
  if (typeof r.attachment_id==='string'&&UUID.test(r.attachment_id)&&Object.keys(r).length===1) return r
  if (typeof r.item_id==='string'&&UUID.test(r.item_id)&&
      (!('version'in r)||typeof r.version==='number'&&Number.isSafeInteger(r.version)&&r.version>0)&&
      Object.keys(r).every(k=>['item_id','version'].includes(k))) return r
  throw new Refusal(400,'invalid','Expected an exact item/version, attachment or message reference')
}

export async function handleFileResolve(deps:AttachmentsDeps,user:string,body:Record<string,unknown>) {
  const refs='refs'in body?body.refs:[body.ref]
  if (!Array.isArray(refs)||refs.length<1||refs.length>200||'refs'in body&&'ref'in body) throw new Refusal(400,'invalid','Expected 1 to 200 file references')
  const exact=refs.map(fileRef),actor=typeof body.as==='string'?body.as:user
  const rows=await Promise.all(exact.map(ref=>call(deps.userRpc,'file_resolve_as',{p_ref:ref,p_as:actor})))
  return 'refs'in body?{files:rows.map((row,i)=>({...row as Record<string,unknown>,ref:exact[i]}))}:rows[0]
}

export async function handleFileDownload(deps:AttachmentsDeps,user:string,body:Record<string,unknown>) {
  if (typeof body.request_id!=='string'||!UUID.test(body.request_id)) throw new Refusal(400,'invalid','request_id must be a uuid')
  const row=await call(deps.userRpc,'file_transfer_download_as',{
    p_ref:fileRef(body.ref),p_as:typeof body.as==='string'?body.as:user,p_id:body.request_id,
  }) as {status:string;bucket_id:string;object_name:string;download_id:string;signed_at:string;expires_at:string;content_type:string;size_bytes:unknown;transfer_id?:string}
  if (row.status!=='ready') return row
  const cfg=await call(deps.serviceRpc,'file_transfer_settings',{}) as Record<string,unknown>
  const traffic=cfg.download_link_bits_per_second===undefined?undefined:Number(cfg.download_link_bits_per_second)
  if (traffic!==undefined&&(!Number.isSafeInteger(traffic)||traffic<819200||traffic>838860800)) throw new Refusal(503,'not_configured','Download rate is not configured')
  try {
    const signed=row.bucket_id==='oss'||row.bucket_id==='temporary'
      ?await objectStorage(deps).sign(row.object_name,canSignThumbnail(row.content_type,row.size_bytes),new Date(row.signed_at),{
        requestId:row.download_id,expiresSeconds:60,...(traffic===undefined?{}:{trafficBits:traffic}),...(row.bucket_id==='temporary'?{direct:true}:{}),
      })
      :{url:await deps.storageSignedUrl(row.bucket_id,row.object_name,60,traffic),thumbUrl:null}
    const key=row.transfer_id?await call(deps.serviceRpc,'file_temporary_key_for',{p_download:row.download_id,p_account:user}):undefined
    return {...row,url:signed.url,thumb_url:signed.thumbUrl,expires_at:row.expires_at,...(key?{key,codec:'secretstream-v1'}:{})}
  } catch(error) {
    if(error instanceof ObjectStorageError&&error.status===503) throw new Refusal(503,'not_configured',error.message)
    if(error instanceof ObjectStorageError&&error.status===410) throw new Refusal(410,'expired',error.message)
    throw error
  }
}

/** Only the service-role HTTP route may call this; account/group attribution comes from the reservation. */
export async function handleUsageImport(serviceRpc:Rpc,body:Record<string,unknown>) {
  if (!Array.isArray(body.events)||body.events.length<1||body.events.length>512) throw new Refusal(400,'invalid','Expected 1 to 512 provider events')
  const events=body.events.map(value=>{
    const e=value as Record<string,unknown>
    if (!e||typeof e!=='object'||Object.keys(e).some(k=>!['event_id','download_id','bytes','observed_at','object_name'].includes(k))||
      typeof e.event_id!=='string'||!/^(cdn|oss):[A-Za-z0-9_-]{1,128}$/.test(e.event_id)||
      typeof e.download_id!=='string'||!UUID.test(e.download_id)||typeof e.bytes!=='number'||!Number.isSafeInteger(e.bytes)||e.bytes<0||
      typeof e.observed_at!=='string'||!Number.isFinite(Date.parse(e.observed_at))||
      typeof e.object_name!=='string'||!e.object_name||e.object_name.length>500) {
      throw new Refusal(400,'invalid','Invalid provider event')
    }
    return e
  })
  return await call(serviceRpc,'file_transfer_import',{p_events:events})
}

export async function handleStorageInventory(serviceRpc:Rpc,body:Record<string,unknown>) {
  if (!Array.isArray(body.objects)||body.objects.length<1||body.objects.length>512||body.objects.some(value=>{
    const o=value as Record<string,unknown>
    return !o||typeof o!=='object'||Object.keys(o).some(k=>!['bucket_id','object_name','size_bytes'].includes(k))||
      typeof o.bucket_id!=='string'||!/^[A-Za-z0-9._-]{1,100}$/.test(o.bucket_id)||
      typeof o.object_name!=='string'||!o.object_name||o.object_name.length>1024||
      typeof o.size_bytes!=='number'||!Number.isSafeInteger(o.size_bytes)||o.size_bytes<0
  })) throw new Refusal(400,'invalid','Invalid physical inventory')
  return {objects:await call(serviceRpc,'file_transfer_inventory',{p_objects:body.objects})}
}
