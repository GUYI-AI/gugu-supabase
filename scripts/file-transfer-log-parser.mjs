// Provider JSON records only. Never retain or print a bearer URL, signature, IP or user agent.
// Fields: https://help.aliyun.com/zh/cdn/user-guide/fields-in-real-time-logs
//         https://help.aliyun.com/zh/sls/log-fields-13
const eventId=/^[A-Za-z0-9_-]{1,128}$/
export function parseInventoryEntry(row) {
  if(!row||typeof row!=='object'||typeof row.bucket_id!=='string'||!/^[A-Za-z0-9._-]{1,100}$/.test(row.bucket_id)||
      typeof row.object_name!=='string'||!row.object_name||row.object_name.length>1024||
      typeof row.size_bytes!=='number'||!Number.isSafeInteger(row.size_bytes)||row.size_bytes<0) throw new Error('Invalid physical inventory record')
  return {bucket_id:row.bucket_id,object_name:row.object_name,size_bytes:row.size_bytes}
}
export function parseTransferLog(source,row,options) {
  if (!['cdn','oss'].includes(source)||!row||typeof row!=='object') throw new Error('Invalid provider record')
  if ((source==='cdn'?row.method:row.http_method)!=='GET') return null
  if (source==='oss'&&row.sync_request==='cdn') return null // origin cost is reconciled separately, not charged as a second download
  const domain=source==='cdn'?row.domain:row.host
  if (domain!==options.domain) throw new Error('Provider domain differs from the configured source')
  const raw=source==='cdn'?String(row.uri)+'?'+String(row.uri_param??'').replace(/^\?/,''):String(row.request_uri) // real-time logs keep the '?'
  let url
  try { url=new URL(raw,'https://'+domain) } catch { throw new Error('Invalid provider URI') }
  if(url.hostname!==domain) throw new Error('Provider URI differs from its source domain')
  const token=source==='cdn'?url.searchParams.get('auth_key')?.split('-')[1]:url.searchParams.get('gugu-download-id')?.replace(/-/g,'')
  if (!token||!/^[0-9a-f]{32}$/i.test(token)) throw new Error('Provider download has no managed attribution identifier')
  const id=source==='cdn'?row.uuid:row.request_id
  const rawSize=source==='cdn'?row.body_bytes_sent:row.response_body_length
  const rawTime=source==='cdn'?row.unixtime:row.__time__
  if(!/^[0-9]+$/.test(String(rawSize))||!/^[0-9]+(?:\.[0-9]+)?$/.test(String(rawTime))) throw new Error('Missing provider bytes or completion timestamp')
  const size=Number(rawSize),seconds=Number(rawTime)
  if (typeof id!=='string'||!eventId.test(id)||!Number.isSafeInteger(size)||size<0||!Number.isFinite(seconds)||seconds<0) {
    throw new Error('Missing provider request ID, byte count or completion timestamp')
  }
  let object
  try { object=decodeURIComponent(url.pathname).replace(/^\//,'') } catch { throw new Error('Invalid provider object encoding') }
  const prefix=options.objectPrefix?options.objectPrefix.replace(/\/$/,'')+'/':''
  if (!object.startsWith(prefix)||!object.slice(prefix.length)) throw new Error('Object is outside the configured managed prefix')
  const download_id=token.slice(0,8)+'-'+token.slice(8,12)+'-'+token.slice(12,16)+'-'+token.slice(16,20)+'-'+token.slice(20)
  return {event_id:source+':'+id,download_id,bytes:size,observed_at:new Date(seconds*1000).toISOString(),object_name:object.slice(prefix.length)}
}
