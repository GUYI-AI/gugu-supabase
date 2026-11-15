import { randomUUID } from 'node:crypto'
import { SignJWT } from 'jose'
import { expect,it,vi } from 'vitest'
import { authorizeItem,createVerifier } from '../../../services/files/src/auth.mjs'

it('carries only the cryptographically verified Auth session into file authorization',async()=>{
  const user=randomUUID(),session=randomUUID(),item=randomUUID(),secret=new TextEncoder().encode(randomUUID()+randomUUID())
  const token=await new SignJWT({sub:user,role:'authenticated',session_id:session}).setProtectedHeader({alg:'HS256'}).setExpirationTime('1h').sign(secret)
  const identity=await createVerifier({jwksUrl:null,jwtSecret:secret,jwtIssuer:null})(token)
  expect(identity.sessionId).toBe(session)
  const query=vi.fn().mockResolvedValue({rows:[{chat_id:'fixture',epoch:1,content_type:'text/plain',kind:'document',actor_id:user,actor_name:'fixture'}]})
  await authorizeItem({query} as never,item,identity.userId,null,identity.sessionId)
  expect(query).toHaveBeenCalledExactlyOnceWith('SELECT * FROM chat.files_authorize($1::uuid, $2, $3, $4)',[item,user,null,session])
})
