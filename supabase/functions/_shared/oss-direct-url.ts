import OSS from 'npm:ali-oss@6.23.0'
import { objectKey, type ImageProcess, type OssConfig } from './oss.ts'
import { type AttachmentObjectStorage, ObjectStorageError } from './object-storage.ts'

/** Origin reads use the official SDK. Its current-clock signature must fit the original reservation. */
export function ossDirectSigner(config:OssConfig):AttachmentObjectStorage['sign'] {
  const sdk=new OSS({accessKeyId:config.accessKeyId,accessKeySecret:config.accessKeySecret,bucket:config.bucket,
    region:'oss-'+config.region,endpoint:config.endpointPublic,secure:true,authorizationV4:true})
  return async(key,process,signedAt,permit)=>{
    if(!permit||permit.expiresSeconds!==60||permit.trafficBits!==undefined&&(!Number.isSafeInteger(permit.trafficBits)||permit.trafficBits<819200||permit.trafficBits>838860800)) {
      throw new ObjectStorageError(503,'not_configured','Invalid origin download limits')
    }
    const deadline=signedAt.getTime()+permit.expiresSeconds*1000
    const sign=async(thumbnail:ImageProcess|null)=>{
      const remaining=Math.floor((deadline-Date.now())/1000)
      if(remaining<1) throw new ObjectStorageError(410,'expired','The download reservation has expired')
      const url=new URL(await sdk.signatureUrlV4('GET',Math.min(60,remaining),{queries:{
        ...(permit.trafficBits===undefined?{}:{'x-oss-traffic-limit':String(permit.trafficBits)}),'gugu-download-id':permit.requestId,
        ...(thumbnail?{'x-oss-process':thumbnail}:{}),
      }},objectKey(config,key)))
      const date=url.searchParams.get('x-oss-date')??''
      const expires=Date.parse(date.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,'$1-$2-$3T$4:$5:$6Z'))+Number(url.searchParams.get('x-oss-expires'))*1000
      if(!Number.isFinite(expires)||expires>deadline||expires<=Date.now()) throw new ObjectStorageError(503,'not_configured','Origin signature exceeds its reservation')
      return {url:url.href,expires}
    }
    const original=await sign(null),thumbnail=process?await sign(process):null
    const expires=Math.min(original.expires,thumbnail?.expires??original.expires)
    if(expires<=Date.now()) throw new ObjectStorageError(410,'expired','The download reservation has expired')
    return {url:original.url,thumbUrl:thumbnail?.url??null,expiresAt:new Date(expires).toISOString()}
  }
}
