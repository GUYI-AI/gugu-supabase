import { describe,expect,it,vi } from 'vitest'
import { type AttachmentsDeps } from '../../../supabase/functions/_shared/attachments-core'
import { handleProjectFiles } from '../../../supabase/functions/_shared/project-file-transfer-core'
import { ObjectStorageError } from '../../../supabase/functions/_shared/object-storage'

const host='11111111-1111-4111-8111-111111111111',transfer='22222222-2222-4222-8222-222222222222',download='33333333-3333-4333-8333-333333333333'
const key=Buffer.alloc(32,7).toString('base64'),sha='ab'.repeat(32),object='temporary/fixture/'+transfer
function fixture() {
  const userRpc=vi.fn<AttachmentsDeps['userRpc']>(async(fn)=>({data:fn==='file_temporary_accept'
    ?{staging_key:object,signed_at:'2026-10-24T00:00:00Z',expires_at:'2026-10-24T00:02:00Z',max_bytes:128}
    :{status:'gone'},error:null}))
  const serviceRpc=vi.fn<AttachmentsDeps['serviceRpc']>(async(fn)=>({data:fn==='file_temporary_host_for'
    ?{object_name:object,ciphertext_bytes:128,state:'uploading'}:fn==='file_temporary_key_for'?key:{},error:null}))
  const objects={uploadBounds:vi.fn(async()=>({maxBytes:128,expiresSeconds:120})),upload:vi.fn(async()=>({url:'https://origin.test',fields:{key:object},expiresAt:'2026-10-24T00:02:00Z'})),
    inspect:vi.fn(async()=>({bytes:new Uint8Array(128),sizeBytes:128,sha256:sha,etag:'immutable'})),read:vi.fn(),promote:vi.fn(),put:vi.fn(),exists:vi.fn(),remove:vi.fn(),
    sign:vi.fn(async()=>({url:'https://origin.test/cipher',thumbUrl:null,expiresAt:'2026-10-24T00:01:00Z'})),invalidate:vi.fn()}
  const deps:AttachmentsDeps={objects,userRpc,serviceRpc,fetch:vi.fn(),storageSignedUrl:vi.fn(),storageRemove:vi.fn(),now:()=>new Date('2026-10-24T00:00:00Z'),uuid:()=>download,log:vi.fn()}
  return {deps,objects,userRpc,serviceRpc}
}
describe('temporary file HTTP protocol',()=>{
  it('rejects unauthorized acceptance before touching the provider and refuses mismatched provider bounds',async()=>{
    const f=fixture()
    f.userRpc.mockResolvedValueOnce({data:null,error:{message:'denied',hint:'file_transfer_denied'}})
    await expect(handleProjectFiles(f.deps,host,'file-accept',{transfer_id:transfer,ciphertext_bytes:128})).rejects.toMatchObject({status:403})
    expect(f.objects.uploadBounds).not.toHaveBeenCalled()
    f.objects.uploadBounds.mockResolvedValueOnce({maxBytes:129,expiresSeconds:120})
    await expect(handleProjectFiles(f.deps,host,'file-accept',{transfer_id:transfer,ciphertext_bytes:128})).rejects.toMatchObject({status:503})
    expect(f.objects.upload).not.toHaveBeenCalled()
    expect(await handleProjectFiles(f.deps,host,'file-accept',{transfer_id:transfer,ciphertext_bytes:128})).toMatchObject({transfer_id:transfer,max_bytes:128})
  })
  it('verifies streamed ciphertext before committing the key exclusively through the service RPC',async()=>{
    const f=fixture(),body={transfer_id:transfer,ciphertext_bytes:128,ciphertext_sha256:sha,key}
    expect(await handleProjectFiles(f.deps,host,'file-commit',body)).toEqual({transfer_id:transfer,status:'ready'})
    expect(f.objects.inspect).toHaveBeenCalledWith(object,128)
    expect(f.serviceRpc).toHaveBeenLastCalledWith('file_temporary_commit',{p_id:transfer,p_host:host,p_sha:sha,p_size:128,p_key:key})
    expect(f.userRpc).not.toHaveBeenCalled();expect(f.deps.log).not.toHaveBeenCalled()
  })
  it('confirms temporary eviction through the existing collector before asking the original quota core for a new upload',async()=>{
    const f=fixture(),order:string[]=[]
    f.serviceRpc.mockImplementation(async(fn)=>{
      order.push(fn)
      return {data:fn==='file_temporary_expire'?(order.length===1?1:0):fn==='file_blob_gc_claim'
        ?[{blob_id:'old',claim_token:'claim',bucket_id:'temporary',object_name:'temporary/old',content_type:'application/octet-stream'}]:null,error:null}
    })
    const accept=f.userRpc.getMockImplementation()!
    f.userRpc.mockImplementation(async(fn,args)=>{order.push(fn);return accept(fn,args)})
    expect(await handleProjectFiles(f.deps,host,'file-accept',{transfer_id:transfer,ciphertext_bytes:128})).toMatchObject({max_bytes:128})
    expect(f.serviceRpc).toHaveBeenCalledWith('file_temporary_expire',{p_limit:500,p_request:transfer,p_host:host,p_needed:128})
    expect(f.objects.remove).toHaveBeenCalledWith('temporary/old')
    expect(f.objects.invalidate).not.toHaveBeenCalled()
    expect(order.indexOf('file_blob_gc_finish')).toBeLessThan(order.indexOf('file_temporary_accept'))
  })
  it('refuses modified ciphertext and malformed key material before publication',async()=>{
    const f=fixture(),body={transfer_id:transfer,ciphertext_bytes:128,ciphertext_sha256:sha,key}
    f.objects.inspect.mockResolvedValueOnce({bytes:new Uint8Array(),sizeBytes:127,sha256:sha,etag:'etag'})
    await expect(handleProjectFiles(f.deps,host,'file-commit',body)).rejects.toMatchObject({status:409})
    f.objects.inspect.mockResolvedValueOnce({bytes:new Uint8Array(),sizeBytes:128,sha256:'cd'.repeat(32),etag:'etag'})
    await expect(handleProjectFiles(f.deps,host,'file-commit',body)).rejects.toMatchObject({status:409})
    await expect(handleProjectFiles(f.deps,host,'file-commit',{...body,key:'bad'})).rejects.toMatchObject({status:400})
    expect(f.serviceRpc.mock.calls.every(([fn])=>fn!=='file_temporary_commit')).toBe(true)
  })
  it('signs encrypted objects at the origin and binds key retrieval to the same authenticated download',async()=>{
    const f=fixture()
    f.userRpc.mockResolvedValueOnce({data:{status:'ready',bucket_id:'temporary',object_name:object,transfer_id:transfer,download_id:download,
      signed_at:'2026-10-24T00:00:00Z',expires_at:'2026-10-24T00:01:00Z',content_type:'application/octet-stream'},error:null})
    const row=await handleProjectFiles(f.deps,host,'file-download',{ref:{message_id:'message'},request_id:download})
    expect(row).toMatchObject({codec:'secretstream-v1',key,url:'https://origin.test/cipher'})
    expect(f.objects.sign).toHaveBeenCalledWith(object,false,new Date('2026-10-24T00:00:00Z'),{requestId:download,expiresSeconds:60,direct:true})
    expect(f.serviceRpc).toHaveBeenLastCalledWith('file_temporary_key_for',{p_download:download,p_account:host})
  })
  it('never returns a key when signing fails closed, and never signs a pending or gone file',async()=>{
    const f=fixture(),body={ref:{message_id:'message'},request_id:download}
    f.userRpc.mockResolvedValueOnce({data:{status:'ready',bucket_id:'temporary',object_name:object,transfer_id:transfer,download_id:download,
      signed_at:'2026-10-24T00:00:00Z',expires_at:'2026-10-24T00:01:00Z',content_type:'application/octet-stream'},error:null})
    f.objects.sign.mockRejectedValueOnce(new ObjectStorageError(503,'not_configured','no origin limits'))
    await expect(handleProjectFiles(f.deps,host,'file-download',body)).rejects.toMatchObject({status:503})
    expect(f.serviceRpc.mock.calls.every(([fn])=>fn!=='file_temporary_key_for')).toBe(true)
    f.objects.sign.mockClear()
    for(const status of ['pending','gone']) {
      f.userRpc.mockResolvedValueOnce({data:{status},error:null})
      expect(await handleProjectFiles(f.deps,host,'file-download',body)).toEqual({status})
    }
    expect(f.objects.sign).not.toHaveBeenCalled()
  })
})
