import { type AttachmentsDeps,call,handleGc,objectStorage,Refusal } from './attachments-core.ts'
import { fileRef,handleFileDownload } from './file-transfer-core.ts'

function text(body:Record<string,unknown>,name:string) {
  if(typeof body[name]!=='string'||!body[name]) throw new Refusal(400,'invalid',name+' is required')
  return body[name] as string
}
function id(body:Record<string,unknown>,name:string) {
  const value=text(body,name)
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Refusal(400,'invalid',name+' must be a uuid')
  return value
}
export async function handleProjectFiles(deps:AttachmentsDeps,user:string,route:string,body:Record<string,unknown>) {
  const actor=typeof body.as==='string'?body.as:user
  if(route==='file-download') return handleFileDownload(deps,user,body)
  if(route==='file-request') {
    const state=await call(deps.userRpc,'file_temporary_request',{p_ref:fileRef(body.ref),p_as:actor,p_id:id(body,'request_id')}) as Record<string,unknown>
    if(body.download_request_id===undefined) return state
    // A reader that names its download gets the lease in this same call once the copy is ready: one round trip, not two.
    const download=id(body,'download_request_id')
    return {...state,download:state.status==='ready'&&state.transfer_status==='ready'?await handleFileDownload(deps,user,{ref:body.ref,as:body.as,request_id:download}):null}
  }
  if(route==='file-pending') return {transfers:await call(deps.userRpc,'file_temporary_pending',{p_device:text(body,'device_id')})}
  if(route==='file-read-complete') {
    const download=id(body,'download_id')
    if(body.expect===undefined) {
      await call(deps.userRpc,'file_temporary_read_complete',{p_download:download,p_as:actor})
      return {acknowledged:true}
    }
    // With `expect`, the version is re-resolved first and the read acknowledged only if it is still the one read: the
    // order a reader keeps with a separate file-resolve, and `current` lets it make its own checks without that call.
    const expect=body.expect as Record<string,unknown>
    if(!expect||typeof expect!=='object'||typeof expect.sha256!=='string'||typeof expect.size_bytes!=='number') throw new Refusal(400,'invalid','expect needs sha256 and size_bytes')
    const current=await call(deps.userRpc,'file_resolve_as',{p_ref:fileRef(body.ref),p_as:actor}) as Record<string,unknown>
    const same=current.status==='ready'&&current.sha256===expect.sha256&&current.size_bytes===expect.size_bytes
    if(same) await call(deps.userRpc,'file_temporary_read_complete',{p_download:download,p_as:actor})
    return {acknowledged:same,current}
  }
  // The holder could not send this copy: the reader is told why on its next poll instead of waiting out its bound.
  if(route==='file-decline') {
    await call(deps.userRpc,'file_temporary_decline',{p_id:id(body,'transfer_id'),p_reason:text(body,'reason')})
    return {transfer_id:body.transfer_id,status:'retired'}
  }
  const transfer=id(body,'transfer_id'),bytes=body.ciphertext_bytes
  if(typeof bytes!=='number'||!Number.isSafeInteger(bytes)||bytes<1) throw new Refusal(400,'invalid','ciphertext_bytes must be a positive integer')
  const store=objectStorage(deps)
  if(route==='file-accept') {
    const retired=await call(deps.serviceRpc,'file_temporary_expire',{p_limit:500,p_request:transfer,p_host:user,p_needed:bytes})
    if(Number(retired)>0) await handleGc(deps,'file-accept')
    const permit=await call(deps.userRpc,'file_temporary_accept',{p_id:transfer,p_size:bytes}) as {staging_key:string;signed_at:string;expires_at:string;max_bytes:number}
    const seconds=(Date.parse(permit.expires_at)-Date.parse(permit.signed_at))/1000
    const bounds=await store.uploadBounds(bytes,seconds)
    if(bounds.maxBytes!==bytes||bounds.expiresSeconds!==seconds) throw new Refusal(503,'not_configured','Temporary uploads require exact provider size and lifetime limits')
    const form=await store.upload(permit.staging_key,new Date(permit.signed_at),{maxBytes:bytes,expiresSeconds:seconds})
    return {...form,transfer_id:transfer,expires_at:permit.expires_at,max_bytes:bytes}
  }
  if(route!=='file-commit') throw new Refusal(404,'invalid','Unknown project file operation')
  const sha=text(body,'ciphertext_sha256'),key=text(body,'key')
  if(!/^[0-9a-f]{64}$/.test(sha)||!/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/.test(key)) throw new Refusal(400,'invalid','Invalid ciphertext SHA or canonical 256-bit key')
  const decision=await call(deps.serviceRpc,'file_temporary_host_for',{p_id:transfer,p_host:user}) as {object_name:string;ciphertext_bytes:number;state:string}
  if(Number(decision.ciphertext_bytes)!==bytes) throw new Refusal(409,'upload_changed','Ciphertext size differs from its reservation')
  if(decision.state!=='ready') {
    if(!store.inspect) throw new Refusal(503,'not_configured','Streamed object inspection is unavailable')
    const actual=await store.inspect(decision.object_name,bytes)
    if(actual.sizeBytes!==bytes||actual.sha256!==sha) throw new Refusal(409,'upload_changed','Ciphertext differs from its commitment')
  }
  await call(deps.serviceRpc,'file_temporary_commit',{p_id:transfer,p_host:user,p_sha:sha,p_size:bytes,p_key:key})
  return {transfer_id:transfer,status:'ready'}
}
