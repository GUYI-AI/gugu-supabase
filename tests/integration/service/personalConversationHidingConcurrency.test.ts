import {randomUUID} from 'node:crypto'
import pg from 'pg'
import {afterAll,afterEach,beforeAll,beforeEach,expect,it} from 'vitest'

const url=process.env.GUGU_INTEGRATION_DATABASE_URL??''
let a:pg.Client,b:pg.Client,owner:string,reader:string,room:string,otherPid:number
beforeAll(async()=>{
  if(!['127.0.0.1','localhost','[::1]'].includes(new URL(url).hostname))throw Error('Requires disposable loopback database')
  a=new pg.Client({connectionString:url});b=new pg.Client({connectionString:url})
  await a.connect();await b.connect()
  await a.query("SET statement_timeout='8s'");await b.query("SET statement_timeout='8s'")
  otherPid=(await b.query('SELECT pg_backend_pid() pid')).rows[0].pid
})
afterAll(async()=>{await a?.end();await b?.end()})
beforeEach(async()=>{
  ;[owner,reader,room]=Array.from({length:3},randomUUID)
  for(const id of [owner,reader])await a.query('INSERT INTO auth.users(id,email) VALUES($1,$2)',[id,id+'@hide-race.invalid'])
  await a.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','race',$2)",[room,owner])
  await a.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')",[room,owner,reader])
})
afterEach(async()=>{
  await a.query('ROLLBACK');await b.query('ROLLBACK')
  await a.query('DELETE FROM chat.chats WHERE id=$1',[room])
  await a.query('DELETE FROM auth.users WHERE id=ANY($1::uuid[])',[[owner,reader]])
})
async function auth(c:pg.Client){
  await c.query("SELECT set_config('request.jwt.claim.sub',$1,true)",[owner])
}
const hide=(c:pg.Client)=>c.query('SELECT chat.hide_my_conversation($1,$2)',[room,randomUUID()])
const message=(c:pg.Client)=>c.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES($1,$2,$3,'race')",[randomUUID(),room,reader])
const hidden=async()=>!!(await a.query('SELECT conversation_hidden_at FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2',[room,owner])).rows[0].conversation_hidden_at
async function waiting(){
  const until=Date.now()+4000
  while(Date.now()<until){
    if((await a.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[otherPid])).rows[0]?.wait_event_type==='Lock')return
    await new Promise(resolve=>setTimeout(resolve,10))
  }
  throw Error('The second transaction never reached the intended lock barrier')
}

it('hide commits first: an overlapping new message waits, then restores',async()=>{
  await a.query('BEGIN');await auth(a);await hide(a)
  await b.query('BEGIN')
  const sent=message(b)
  await waiting();await a.query('COMMIT');await sent;await b.query('COMMIT')
  expect(await hidden()).toBe(false)
})
it('message commits first: an overlapping hide waits and remains hidden',async()=>{
  await a.query('BEGIN');await message(a)
  await b.query('BEGIN');await auth(b)
  const removal=hide(b)
  await waiting();await a.query('COMMIT');await removal;await b.query('COMMIT')
  expect(await hidden()).toBe(true)
})
it('prepares hidden member rows before message revisions, without a read-mark lock inversion',async()=>{
  await a.query('BEGIN');await auth(a);await hide(a);await a.query('COMMIT')
  await a.query('BEGIN');await a.query('UPDATE chat.chat_members SET last_read_seq=0 WHERE chat_id=$1 AND user_id=$2',[room,owner])
  await b.query('BEGIN')
  const sent=message(b)
  await waiting();await a.query('COMMIT');await sent;await b.query('COMMIT')
  expect(await hidden()).toBe(false)
})
