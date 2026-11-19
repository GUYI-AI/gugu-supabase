import { ossDirectSigner } from '../../supabase/functions/_shared/oss-direct-url.ts'
import { ObjectStorageError } from '../../supabase/functions/_shared/object-storage.ts'
import { THUMB_PROCESS } from '../../supabase/functions/_shared/oss.ts'

const NativeDate=Date,instant=NativeDate.parse('2026-10-24T01:02:03Z')
const config={region:'cn-wulanchabu',bucket:'sdk-fixture',endpointPublic:'oss-cn-wulanchabu.aliyuncs.com',
  endpointInternal:'oss-cn-wulanchabu-internal.aliyuncs.com',accessKeyId:'fixture-id',accessKeySecret:'fixture-secret',objectPrefix:'fixture-153'}
const permit={requestId:'11111111-1111-4111-8111-111111111111',trafficBits:819200,expiresSeconds:60,direct:true}
const assert=(ok:unknown,message:string)=>{if(!ok)throw Error(message)}
Deno.test('official origin signer binds limits and cannot refresh an existing reservation on retry',async()=>{
  class FixedDate extends NativeDate {
    constructor(value:string|number|Date=instant){super(value instanceof NativeDate?value.getTime():value)}
    static override now(){return instant}
  }
  globalThis.Date=FixedDate as DateConstructor
  try {
    const sign=ossDirectSigner(config),signedAt=new Date(instant-30000)
    const first=await sign('temporary/资料/file name.bin',null,signedAt,permit)
    const url=new URL(first.url),q=url.searchParams
    assert(url.protocol==='https:','origin uses TLS')
    assert(decodeURIComponent(url.pathname)==='/fixture-153/temporary/资料/file name.bin','the same validated object prefix is applied')
    assert(q.get('x-oss-expires')==='30','a retry has only the original remaining lifetime')
    assert(first.expiresAt===new Date(instant+30000).toISOString(),'the actual signature deadline matches the reservation')
    assert(q.get('x-oss-traffic-limit')==='819200'&&q.get('gugu-download-id')===permit.requestId,'throttle and attribution are signed')
    assert(first.thumbUrl===null&&/^[0-9a-f]{64}$/.test(q.get('x-oss-signature')??''),'ciphertext is never transformed')
    const unlimited=await sign('temporary/资料/file name.bin',null,signedAt,{...permit,trafficBits:undefined})
    const withoutRate=new URL(unlimited.url).searchParams
    assert(!withoutRate.has('x-oss-traffic-limit'),'an absent declaration does not invent a provider limit')
    assert(withoutRate.get('gugu-download-id')===permit.requestId,'unthrottled reads retain signed attribution')
    assert(withoutRate.get('x-oss-expires')==='30'&&unlimited.expiresAt===first.expiresAt,'optional throttling cannot extend the reservation')
    for(const invalid of [{...permit,trafficBits:819199},{...permit,expiresSeconds:61}]) {
      let refused=false
      try{await sign('temporary/file',null,signedAt,invalid)}catch(error){refused=error instanceof ObjectStorageError&&error.status===503}
      assert(refused,'unsupported bounds fail closed')
    }
    let expired=false
    try{await sign('temporary/file',null,new Date(instant-60000),permit)}catch(error){expired=error instanceof ObjectStorageError&&error.status===410}
    assert(expired,'an expired reservation cannot receive a fresh SDK signature')
  }finally{globalThis.Date=NativeDate}
})

Deno.test('origin image previews sign only the same object and fixed thumbnail transformation',async()=>{
  class FixedDate extends NativeDate {
    constructor(value:string|number|Date=instant){super(value instanceof NativeDate?value.getTime():value)}
    static override now(){return instant}
  }
  globalThis.Date=FixedDate as DateConstructor
  try {
    const signedAt=new Date(instant-30000),signed=await ossDirectSigner(config)('images/资料/photo.png',THUMB_PROCESS,signedAt,permit)
    assert(signed.thumbUrl!==null,'an eligible image receives an origin thumbnail')
    const original=new URL(signed.url),thumbnail=new URL(signed.thumbUrl!),q=thumbnail.searchParams
    assert(original.protocol==='https:'&&thumbnail.protocol==='https:','both reads use TLS')
    assert(original.host===thumbnail.host&&thumbnail.host==='sdk-fixture.oss-cn-wulanchabu.aliyuncs.com','the thumbnail stays in the configured bucket and region')
    assert(original.pathname===thumbnail.pathname&&decodeURIComponent(thumbnail.pathname)==='/fixture-153/images/资料/photo.png','no other object can be signed')
    assert(!original.searchParams.has('x-oss-process')&&q.get('x-oss-process')===THUMB_PROCESS,'only the thumbnail has the existing fixed transformation')
    assert(q.get('x-oss-traffic-limit')==='819200'&&q.get('gugu-download-id')===permit.requestId,'thumbnail limits and attribution match the reservation')
    assert(q.get('x-oss-expires')==='30','thumbnail signing cannot refresh the reservation')
    assert(/^[0-9a-f]{64}$/.test(q.get('x-oss-signature')??'')&&q.get('x-oss-signature')!==original.searchParams.get('x-oss-signature'),'the SDK signs the thumbnail transformation separately')
    const expiry=(url:URL)=>Date.parse(url.searchParams.get('x-oss-date')!.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,'$1-$2-$3T$4:$5:$6Z'))+Number(url.searchParams.get('x-oss-expires'))*1000
    assert(Date.parse(signed.expiresAt)===Math.min(expiry(original),expiry(thumbnail)),'the response uses the earliest capability deadline')
    assert(Date.parse(signed.expiresAt)<=signedAt.getTime()+60000,'neither capability extends its original reservation')
    let expired=false
    try{await ossDirectSigner(config)('images/photo.png',THUMB_PROCESS,new Date(instant-60000),permit)}catch(error){expired=error instanceof ObjectStorageError&&error.status===410}
    assert(expired,'an expired image reservation does not receive a thumbnail capability')
  }finally{globalThis.Date=NativeDate}
})
