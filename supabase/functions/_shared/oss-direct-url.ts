import OSS from 'npm:ali-oss@6.23.0'
import { objectKey, type OssConfig } from './oss.ts'
import { type AttachmentObjectStorage, ObjectStorageError } from './object-storage.ts'

/** Origin reads use the official SDK. Its current-clock signature must fit the original reservation. */
export function ossDirectSigner(config:OssConfig):AttachmentObjectStorage['sign'] {
  const sdk=new OSS({accessKeyId:config.accessKeyId,accessKeySecret:config.accessKeySecret,bucket:config.bucket,
    region:'oss-'+config.region,endpoint:config.endpointPublic,secure:true,authorizationV4:true})
  return async(key,signedAt,permit)=>{
    if(!permit||permit.expiresSeconds!==60||permit.trafficBits!==undefined&&(!Number.isSafeInteger(permit.trafficBits)||permit.trafficBits<819200||permit.trafficBits>838860800)) {
      throw new ObjectStorageError(503,'not_configured','Invalid origin download limits')
    }
    const deadline=signedAt.getTime()+permit.expiresSeconds*1000
    const sign=async()=>{
      const remaining=Math.floor((deadline-Date.now())/1000)
      if(remaining<1) throw new ObjectStorageError(410,'expired','The download reservation has expired')
      const url=new URL(await sdk.signatureUrlV4('GET',Math.min(60,remaining),{queries:{
        ...(permit.trafficBits===undefined?{}:{'x-oss-traffic-limit':String(permit.trafficBits)}),'gugu-download-id':permit.requestId,
      }},objectKey(config,key)))
      const date=url.searchParams.get('x-oss-date')??''
      const expires=Date.parse(date.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,'$1-$2-$3T$4:$5:$6Z'))+Number(url.searchParams.get('x-oss-expires'))*1000
      if(!Number.isFinite(expires)||expires>deadline||expires<=Date.now()) throw new ObjectStorageError(503,'not_configured','Origin signature exceeds its reservation')
      return {url:url.href,expires}
    }
    const {url,expires}=await sign()
    return {url,expiresAt:new Date(expires).toISOString()}
  }
}
