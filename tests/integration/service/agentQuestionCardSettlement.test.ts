import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

let db: pg.Client
const sql = 'SELECT chat.settle_agent_question_card($1,$2,$3::jsonb) AS settled'
const one = [{ question: 'Which?', header: 'Choice', multiSelect: false, options: [{ optionId: 'A', name: 'A', description: 'First choice' },{ optionId: 'B', name: 'B' }] }]
let owner: string, colleague: string, stranger: string, otherOwner: string, agent: string, otherAgent: string, room: string, message: string
const query = async (text: string, values: unknown[] = []) => (await db.query(text,values)).rows
const actor = async (id: string, role = 'authenticated') => {
  if (!['authenticated','postgres','anon'].includes(role)) throw new Error('Invalid fixture role')
  await db.query('SET LOCAL ROLE ' + role)
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",[id,JSON.stringify({ sub:id,role })])
}
async function refused(run: () => Promise<unknown>, code = '42501') {
  await db.query('SAVEPOINT refusal')
  let caught: unknown
  try { await run() } catch (error) { caught = error }
  await db.query('ROLLBACK TO SAVEPOINT refusal; RELEASE SAVEPOINT refusal')
  expect(caught).toMatchObject({ code })
}
const card = (id: string, extra: object = {}) => ({ v:1,type:'question',text:'Which?',options:['A','B'],questions:one,
  ownerUserId:owner,questionId:'agent-question:'+id,sessionId:'fixture-session',projectId:'fixture-project',deviceId:'fixture-device',machineLabel:'Fixture',...extra })
async function post(extra: object = {}, sender = agent, destination = room) {
  const id = randomUUID()
  await actor(owner,'postgres')
  await query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type,client_message_id) VALUES($1,$2,$3,$4,'card',$1)",[id,destination,sender,JSON.stringify(card(id,extra))])
  return id
}
async function revisions(id: string) {
  await actor(owner,'postgres')
  await query('SELECT chat.flush_pending_user_revisions()')
  await actor(id)
  return (await query('SELECT chat.sync_since(0,500) AS page'))[0].page.operations as Array<{ event:string; payload: Record<string,unknown> }>
}
beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname)) throw new Error('Disposable loopback database required')
  db = new pg.Client({ connectionString:url.href }); await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await query('BEGIN')
  ;[owner,colleague,stranger,otherOwner,agent,otherAgent,room] = Array.from({ length:7 },() => randomUUID())
  await query("INSERT INTO identity.users(id,type,display_name) SELECT id,'human','Question fixture' FROM unnest($1::text[]) id",[[owner,colleague,stranger,otherOwner]])
  for (const [human,bot] of [[owner,agent],[otherOwner,otherAgent]]) {
    await query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'Question fixture','fixture','linux')",['device-'+human,human])
    await query("INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id) VALUES($1,'agent','Question fixture',$2,$3)",[bot,human,'device-'+human])
  }
  await query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','Question fixture',$2)",[room,owner])
  for (const id of [owner,colleague,agent,otherAgent]) await query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,$3)",[room,id,id===owner?'owner':'member'])
  message = await post()
})
afterEach(async () => { await query('ROLLBACK') })

describe('owner settlement of an agent question card', () => {
  it('updates the same message once, preserves preview order and publishes only additive chat_changed facts', async () => {
    await actor(owner,'postgres')
    await query('SELECT chat.flush_pending_user_revisions()')
    const before = (await query('SELECT id,seq,created_at,sender_user_id,content FROM chat.messages WHERE id=$1',[message]))[0]
    const head = (await query('SELECT revision FROM chat.account_revision_heads WHERE user_id=$1',[colleague]))[0].revision
    await actor(owner)
    const answers = [{ selected:['A'] }]
    const first = (await query(sql,[message,'answered',JSON.stringify(answers)]))[0].settled
    expect(first).toMatchObject({ state:'answered',answers })
    expect((await query(sql,[message,'discuss',null]))[0].settled).toEqual(first)
    await actor(owner,'postgres')
    const after = (await query('SELECT id,seq,created_at,sender_user_id,content FROM chat.messages WHERE id=$1',[message]))[0]
    expect({ ...after,content:before.content }).toEqual(before)
    expect(after.content).toMatch(/^\{"v":1,"type":"question","text":/)
    expect(JSON.parse(after.content)).toEqual({ ...JSON.parse(before.content),settled:first })
    expect((await query('SELECT count(*)::int AS n FROM chat.messages WHERE chat_id=$1',[room]))[0].n).toBe(1)
    await query('SELECT chat.flush_pending_user_revisions()')
    await actor(colleague)
    const page = (await query('SELECT chat.sync_since($1,500) AS page',[head]))[0].page
    expect(page.operations).toHaveLength(1)
    expect(page.operations[0]).toMatchObject({ event:'chat_changed',payload:{ chat_id:room,message_id:message,message:{ id:message,seq:Number(before.seq),content:after.content } } })
  })

  it.each(['withdrawn','discuss'])('settles %s without inventing answers', async state => {
    await actor(owner)
    expect((await query(sql,[message,state,null]))[0].settled).toMatchObject({ state })
    const event = (await revisions(colleague)).find(row => row.event==='chat_changed' && row.payload.message_id===message)
    expect(event).toBeDefined()
    expect(JSON.parse((event!.payload.message as { content:string }).content).settled.answers).toBeUndefined()
  })

  it('retains explicit skips, and works with older v1 cards without a questions extension', async () => {
    await actor(owner)
    expect((await query(sql,[message,'answered','[{"selected":[],"skipped":true}]']))[0].settled.answers).toEqual([{ selected:[],skipped:true }])
    const legacy = await post({ questions:undefined })
    await actor(owner)
    expect((await query(sql,[legacy,'answered','[{"selected":["B"]}]']))[0].settled.state).toBe('answered')
  })

  it('publishes all three answers, preserving single choice, multiple choices and the owner’s own words', async () => {
    const questions = [one[0],{ ...one[0],question:'Where?',multiSelect:true },{ question:'Anything else?',multiSelect:false,options:[] }]
    const complete = await post({ questions,options:[] })
    const answers = [{ selected:['A'] },{ selected:['A','B'] },{ selected:[],other:'Keep the original card' }]
    await actor(owner)
    expect((await query(sql,[complete,'answered',JSON.stringify(answers)]))[0].settled).toMatchObject({ state:'answered',answers })
    const event = (await revisions(colleague)).find(row => row.payload.message_id===complete)
    expect(JSON.parse((event!.payload.message as { content:string }).content)).toMatchObject({ questions,settled:{ state:'answered',answers } })
  })

  it('refuses another person, an agent of another owner, non-question cards and deleted cards', async () => {
    await actor(colleague); await refused(() => query(sql,[message,'answered','[{"selected":["A"]}]']))
    await actor(stranger); await refused(() => query(sql,[message,'withdrawn',null]))
    const foreign = await post({},otherAgent)
    const wrongOwner = await post({ ownerUserId:colleague })
    const task = await post({ type:'task' })
    const deleted = await post()
    await query('UPDATE chat.messages SET deleted_at=now() WHERE id=$1',[deleted])
    for (const id of [foreign,wrongOwner,task,deleted,randomUUID()]) {
      await actor(owner); await refused(() => query(sql,[id,'withdrawn',null]))
    }
    await actor(owner,'anon'); await refused(() => query(sql,[message,'withdrawn',null]))
  })

  it('does not grant the owner a general update of agent-authored messages', async () => {
    await actor(owner)
    expect(await query("UPDATE chat.messages SET content='arbitrary edit' WHERE id=$1 RETURNING id",[message])).toEqual([])
  })

  it.each([
    ['pending',null],['answered',null],['answered','[]'],['answered','[{"selected":["A"]},{"selected":["B"]}]'],
    ['answered','[{"selected":[],"skipped":false}]'],['answered','[{"selected":["A"],"skipped":true}]'],
    ['answered','[{"selected":[],"other":"yes","skipped":true}]'],['answered','[{"selected":[1]}]'],['answered','[{"selected":["missing"]}]'],
    ['answered','[{"selected":["A","B"]}]'],['answered','[{"selected":["A","A"]}]'],['answered','[{"selected":[]}]'],
    ['answered','[{"selected":[],"extra":"not an answer"}]'],['withdrawn','[{"selected":["A"]}]'],
  ])('rejects malformed settlement %s %s', async (state,answers) => {
    await actor(owner); await refused(() => query(sql,[message,state,answers]),'22023')
  })

  it('does not publish an old card to a member whose visible history begins after it', async () => {
    await actor(owner,'postgres')
    await query('SELECT chat.flush_pending_user_revisions()')
    await query("UPDATE chat.chat_members SET hide_history_before=clock_timestamp()+interval '1 second' WHERE chat_id=$1 AND user_id=$2",[room,colleague])
    await actor(owner); await query(sql,[message,'answered','[{"selected":["A"]}]'])
    const operations = await revisions(colleague)
    expect(operations.filter(row => row.payload.message_id===message)).toEqual([])
  })

  it('does not publish to a member who deleted the card, and cannot settle an owner-hidden card', async () => {
    await actor(owner,'postgres')
    await query('UPDATE chat.messages SET deleted_for_user_ids=$2::jsonb WHERE id=$1',[message,JSON.stringify([colleague])])
    await actor(owner); await query(sql,[message,'answered','[{"selected":["A"]}]'])
    expect((await revisions(colleague)).filter(row => row.payload.message_id===message)).toEqual([])
    const hidden = await post()
    await query('UPDATE chat.messages SET deleted_for_user_ids=$2::jsonb WHERE id=$1',[hidden,JSON.stringify([owner])])
    await actor(owner); await refused(() => query(sql,[hidden,'withdrawn',null]))
  })

  it('replay does not disclose a settled body after the recipient loses history access', async () => {
    await actor(owner); await query(sql,[message,'answered','[{"selected":["A"]}]'])
    await actor(owner,'postgres')
    await query("UPDATE chat.chat_members SET hide_history_before=clock_timestamp()+interval '1 second' WHERE chat_id=$1 AND user_id=$2",[room,colleague])
    const event = (await revisions(colleague)).find(row => row.payload.message_id===message)
    expect(event).toBeDefined()
    expect(event!.payload.message).toBeUndefined()
  })

  it('supports a topic without creating a receipt or changing its message sequence', async () => {
    await actor(owner)
    const topic = (await query("SELECT chat_id FROM chat.create_topic($1,$2,'Question topic',NULL,NULL)",[room,message]))[0].chat_id
    await actor(owner,'postgres')
    await query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'member'),($1,$3,'member')",[topic,colleague,agent])
    const question = await post({},agent,topic)
    await actor(owner); await query(sql,[question,'answered','[{"selected":["A"]}]'])
    expect((await revisions(colleague)).find(row => row.payload.message_id===question)).toMatchObject({ event:'chat_changed',payload:{ chat_id:topic } })
  })
})
