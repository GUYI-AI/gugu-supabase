import { describe,it,expect } from 'vitest'
import { parseTransferLog,parseInventoryEntry } from '../../../scripts/file-transfer-log-parser.mjs'
import { handleUsageImport } from '../../../supabase/functions/_shared/file-transfer-core'
const id='12345678-1234-4234-8234-123456789abc',rand=id.replace(/-/g,'')
const options={domain:'files.example.test',objectPrefix:'fixture'}
const cdn={method:'GET',domain:options.domain,uri:'/fixture/ab/hash',uri_param:'?auth_key=1792846800-'+rand+'-0-secret',uuid:'cdn-request-1',body_bytes_sent:'120',response_size:'150',unixtime:'1792846800'}
describe('trusted provider log ingestion',()=>{
  it('uses the provider request ID, canonical download ID and actual body bytes, omitting bearer data',()=>{
    const parsed=parseTransferLog('cdn',cdn,options)
    expect(parsed).toEqual({event_id:'cdn:cdn-request-1',download_id:id,bytes:120,observed_at:'2026-10-24T13:00:00.000Z',object_name:'ab/hash'})
    expect(JSON.stringify(parsed)).not.toContain('secret')
    expect(JSON.stringify(parsed)).not.toContain('auth_key')
  })
  it('does not double-charge CDN origin fetches; direct OSS bytes keep their own request identity',()=>{
    const oss={http_method:'GET',sync_request:'-',host:options.domain,request_uri:'/fixture/ab/hash?gugu-download-id='+id+'&x-oss-signature=secret HTTP/1.1',request_id:'oss-1',response_body_length:'80',__time__:'1792846800'}
    expect(parseTransferLog('oss',oss,options)).toMatchObject({event_id:'oss:oss-1',download_id:id,bytes:80,object_name:'ab/hash'})
    expect(parseTransferLog('oss',{...oss,sync_request:'cdn'},options)).toBeNull()
    expect(parseTransferLog('cdn',{...cdn,method:'HEAD'},options)).toBeNull()
  })
  it('fails loudly for missing attribution, wrong domains/prefixes, missing byte fields or malformed timestamps',()=>{
    for (const row of [{...cdn,uri_param:'?auth_key=bad'},{...cdn,domain:'foreign.example.test'},{...cdn,uri:'/other/hash'},{...cdn,body_bytes_sent:undefined},{...cdn,body_bytes_sent:null},{...cdn,body_bytes_sent:''},{...cdn,unixtime:'bad'}]) {
      expect(()=>parseTransferLog('cdn',row,options)).toThrow()
    }
  })
  it('inventory retains zero-byte objects but never turns an unknown size into zero',()=>{
    expect(parseInventoryEntry({bucket_id:'oss',object_name:'empty',size_bytes:0,private_source:'omitted'})).toEqual({bucket_id:'oss',object_name:'empty',size_bytes:0})
    for(const size_bytes of [undefined,null,'0',-1,Infinity]) expect(()=>parseInventoryEntry({bucket_id:'oss',object_name:'x',size_bytes})).toThrow()
  })
  it('passes only validated event data to one atomic import and never accepts account/group claims',async()=>{
    const event=parseTransferLog('cdn',cdn,options)
    const calls:unknown[]=[]
    const rpc=async(fn:string,args:unknown)=>{calls.push({fn,args});return {data:{imported:1,duplicates:0},error:null}}
    expect(await handleUsageImport(rpc,{events:[event]})).toEqual({imported:1,duplicates:0})
    expect(calls).toEqual([{fn:'file_transfer_import',args:{p_events:[event]}}])
    await expect(handleUsageImport(rpc,{events:[{...event,account_id:'foreign'}]})).rejects.toMatchObject({status:400})
    await expect(handleUsageImport(rpc,{events:[]})).rejects.toMatchObject({status:400})
    expect(calls).toHaveLength(1)
  })
})
