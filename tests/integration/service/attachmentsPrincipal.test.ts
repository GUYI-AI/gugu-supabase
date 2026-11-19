import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

// The attachments function names its caller with chat.attachments_principal() instead of a round trip to Auth. PostgREST
// has checked the token's signature and expiry; this must refuse what getUser refused: a session that is gone, a banned
// or deleted account, a token for another user's session.
const url=process.env.GUGU_INTEGRATION_DATABASE_URL??''
let db:pg.Client, user:string, session:string
async function principal(claims:Record<string,unknown>) {
  await db.query('SET LOCAL ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claims',$1,true)",[JSON.stringify({role:'authenticated',...claims})])
  const value=(await db.query('SELECT chat.attachments_principal() AS p')).rows[0].p
  await db.query('RESET ROLE')
  return value
}
beforeAll(async()=>{
  if(!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname)) throw Error('Principal contracts require an isolated loopback database')
  db=new pg.Client({connectionString:url});await db.connect()
})
afterAll(async()=>{await db?.end()})
beforeEach(async()=>{
  await db.query('BEGIN')
  ;[user,session]=[randomUUID(),randomUUID()]
  await db.query(`INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES($1,'authenticated','authenticated',$2,'{"provider":"email"}','{}',now(),now())`,[user,user+'@principal.invalid'])
  await db.query('INSERT INTO auth.sessions(id,user_id,created_at,updated_at) VALUES($1,$2,now(),now())',[session,user])
})
afterEach(async()=>{await db.query('ROLLBACK')})

describe('attachments_principal answers what getUser answered',()=>{
  it('names the caller of a live session, and of a token that carries no session',async()=>{
    expect(await principal({sub:user,session_id:session})).toBe(user)
    expect(await principal({sub:user})).toBe(user)
  })
  it('refuses a signed-out or revoked session at once, and a session past its end',async()=>{
    await db.query('DELETE FROM auth.sessions WHERE id=$1',[session])
    expect(await principal({sub:user,session_id:session})).toBeNull()
    const ended=randomUUID()
    await db.query("INSERT INTO auth.sessions(id,user_id,created_at,updated_at,not_after) VALUES($1,$2,now(),now(),now()-interval '1 second')",[ended,user])
    expect(await principal({sub:user,session_id:ended})).toBeNull()
  })
  it('refuses another account\'s session, a banned account and a deleted one',async()=>{
    const other=randomUUID()
    await db.query(`INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
      VALUES($1,'authenticated','authenticated',$2,'{"provider":"email"}','{}',now(),now())`,[other,other+'@principal.invalid'])
    expect(await principal({sub:other,session_id:session})).toBeNull()
    await db.query("UPDATE auth.users SET banned_until=now()+interval '1 day' WHERE id=$1",[user])
    expect(await principal({sub:user,session_id:session})).toBeNull()
    await db.query("UPDATE auth.users SET banned_until=now()-interval '1 day' WHERE id=$1",[user])
    expect(await principal({sub:user,session_id:session})).toBe(user)
    await db.query('UPDATE auth.users SET deleted_at=now() WHERE id=$1',[user])
    expect(await principal({sub:user,session_id:session})).toBeNull()
  })
  it('is not callable without a signed-in role',async()=>{
    await db.query('SAVEPOINT anon');await db.query('SET LOCAL ROLE anon')
    await expect(db.query('SELECT chat.attachments_principal()')).rejects.toThrow(/permission denied/)
    await db.query('ROLLBACK TO SAVEPOINT anon')
  })
})
