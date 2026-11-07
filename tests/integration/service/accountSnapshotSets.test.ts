import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

type Row = Record<string, unknown>
interface Db {
  connect(): Promise<void>
  end(): Promise<void>
  query<T = Row>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>
}
const { Client } = createRequire(import.meta.url)('pg') as { Client: new (options: { connectionString: string }) => Db }
let db: Db
beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['127.0.0.1','localhost','[::1]'].includes(url.hostname)) throw new Error('snapshot set tests require disposable loopback PostgreSQL')
  db = new Client({ connectionString: url.href })
  await db.connect()
})
afterAll(async () => { await db?.end() })

async function as<T = Row>(viewer: string, sql: string, values: unknown[] = []) {
  await db.query('SAVEPOINT set_reader')
  try {
    await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: viewer, role: 'authenticated' })])
    await db.query('SET LOCAL ROLE authenticated')
    return (await db.query<T>(sql, values)).rows
  } finally {
    await db.query('ROLLBACK TO SAVEPOINT set_reader')
    await db.query('RELEASE SAVEPOINT set_reader')
  }
}

function previous(file: string, name: string, alias: string) {
  const source = readFileSync(new URL(`../../../supabase/migrations/${file}`, import.meta.url), 'utf8')
  const start = source.indexOf(`CREATE FUNCTION ${name}(`)
  if (start < 0) throw new Error('Missing predecessor ' + name)
  const tail = source.slice(start)
  const delimiter = /\bAS (\$[A-Za-z_]*\$)/i.exec(tail)
  if (!delimiter) throw new Error('Missing predecessor body')
  const end = tail.indexOf(delimiter[1]!, delimiter.index + delimiter[0].length)
  return tail.slice(0, end + delimiter[1]!.length) .replace(`CREATE FUNCTION ${name}(`, `CREATE FUNCTION ${alias}(`) + ';'
}

async function fixture(body: (f: { owner: string; peer: string; stranger: string; group: string; own: string; shared: string; hidden: string }) => Promise<void>) {
  const [owner,peer,stranger,group,own,shared,hidden] = Array.from({length:7}, () => randomUUID())
  await db.query('BEGIN')
  try {
    await db.query(previous('20261021000000_foundation.sql','identity.get_agent_presence_batch','identity.before_batch_224'))
    await db.query(previous('20261107030000_unread_first_addressed.sql','chat.list_unread_locators_for_chats','chat.before_unread_224'))
    await db.query('REVOKE ALL ON FUNCTION identity.before_batch_224(text[]),chat.before_unread_224(text[]) FROM PUBLIC')
    await db.query('GRANT EXECUTE ON FUNCTION identity.before_batch_224(text[]),chat.before_unread_224(text[]) TO authenticated')
    await db.query("INSERT INTO auth.users(id,created_at) SELECT x::uuid,now() FROM unnest($1::text[]) x", [[owner,peer,stranger]])
    await db.query("INSERT INTO identity.users(id,type,display_name) SELECT x,'human','synthetic' FROM unnest($1::text[]) x ON CONFLICT(id) DO NOTHING", [[owner,peer,stranger]])
    await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES ($1,$2,'test','test','linux'),($3,$4,'test','test','linux')", ['d-'+owner,owner,'d-'+peer,peer])
    await db.query("INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id) VALUES ($1,'agent','owned',$2,$3),($4,'agent','shared',$5,$6),($7,'agent','hidden',$5,$6)", [own,owner,'d-'+owner,shared,peer,'d-'+peer,hidden])
    await db.query("INSERT INTO identity.agent_profiles(id,owner_id,display_name) VALUES ($1,$2,'owned'),($3,$4,'shared')", [own,owner,shared,peer])
    await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES ($1,'group','set fixture',$2)", [group,owner])
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role,inbox_published_at) VALUES ($1,$2,'owner',now()),($1,$3,'member',now()),($1,$4,'member',now()),($1,$5,'member',now())", [group,owner,peer,own,shared])
    await body({owner,peer,stranger,group,own,shared,hidden})
  } finally { await db.query('ROLLBACK') }
}

describe('account snapshot set projections', () => {
  it('matches the previous batch for authorized, hidden, duplicate, missing and removed identities', () => fixture(async f => {
    const tombstone = randomUUID()
    await db.query(`INSERT INTO identity.agent_lifecycle_tombstones(agent_user_id,owner_user_id,display_name,agent_created_at,presence_viewer_user_ids,contact_viewer_user_ids)
      VALUES ($1,$2,'removed fixture',now(),$3,$3)`, [tombstone,f.owner,[f.owner]])
    await db.query('UPDATE identity.users SET removed_at=now() WHERE id=$1', [f.own])
    const ids = [f.own,f.shared,f.hidden,f.owner,tombstone,null,'','invalid-agent-id',f.own]
    for (const viewer of [f.owner,f.peer,f.stranger]) {
      const rows = await as<{old: unknown; current: unknown}>(viewer,
        'SELECT identity.before_batch_224($1) AS old,identity.get_agent_presence_batch($1) AS current', [ids])
      expect(rows[0]!.current).toEqual(rows[0]!.old)
    }
    expect((await as<{value: unknown}>(f.owner,'SELECT identity.get_agent_presence_batch(ARRAY[]::text[]) AS value'))[0]!.value).toEqual({results:{}})
    await expect(as(f.owner,'SELECT identity.get_agent_presence_batch(NULL)')).rejects.toThrow(/must not be NULL/)
    await expect(as(f.owner,'SELECT identity.get_agent_presence_batch($1)', [Array.from({length:201},() => randomUUID())])).rejects.toThrow(/exceeds the cap/)
  }))

  it('matches every previous unread column through own replies, mentions, threads and manual marks', () => fixture(async f => {
    const anchor=randomUUID(),root=randomUUID()
    await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES($1,$2,$3,'own message')", [anchor,f.group,f.owner])
    await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content,is_thread_root) VALUES($1,$2,$3,'thread',true)", [root,f.group,f.peer])
    for (const [sender,to,reply,thread] of [
      [f.own,null,anchor,null],[f.own,[f.owner],anchor,null],[f.own,['*'],anchor,null],
      [f.peer,null,anchor,null],[f.shared,null,anchor,root],[f.owner,null,null,null],
    ]) await db.query('INSERT INTO chat.messages(id,chat_id,sender_user_id,content,to_user_ids,reply_to_message_id,thread_root_id) VALUES($1,$2,$3,\'fixture\',$4,$5,$6)', [randomUUID(),f.group,sender,to,reply,thread])
    const statement = `SELECT (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY chat_id,stream_id),'[]') FROM chat.before_unread_224($1) r) AS old,
      (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY chat_id,stream_id),'[]') FROM chat.list_unread_locators_for_chats($1) r) AS current`
    for (const ids of [null,[],[f.group,f.group],['missing']]) {
      const rows=await as<{old: unknown; current: unknown}>(f.owner,statement,[ids])
      expect(rows[0]!.current).toEqual(rows[0]!.old)
    }
    await db.query('UPDATE chat.chat_members SET last_read_seq=1000000,is_marked_unread=true WHERE chat_id=$1 AND user_id=$2',[f.group,f.owner])
    const manual=await as<{old: unknown; current: unknown}>(f.owner,statement,[null])
    expect(manual[0]!.current).toEqual(manual[0]!.old)
    await db.query('UPDATE chat.chat_members SET conversation_deleted_at=now() WHERE chat_id=$1 AND user_id=$2',[f.group,f.owner])
    expect((await as<{current: unknown}>(f.owner,statement,[[f.group]]))[0]!.current).toEqual([])
  }))

  it('retains archival fields and rejects an unrecognized scalar predecessor', () => fixture(async f => {
    const migration=readFileSync(new URL('../../../supabase/migrations/20261107134000_account_snapshot_presence_unread_sets.sql',import.meta.url),'utf8')
    const guard=/DO \$presence_predecessor\$[\s\S]*?END \$presence_predecessor\$;/.exec(migration)?.[0]
    if (!guard) throw new Error('Missing presence predecessor guard')
    await db.query(guard)
    const values=await as<{old:unknown;current:{results:Record<string,{presence:Row}>}}>(f.owner,
      'SELECT identity.before_batch_224($1) AS old,identity.get_agent_presence_batch($1) AS current',[[f.own,f.shared,f.hidden]])
    expect(values[0]!.current).toEqual(values[0]!.old)
    expect(values[0]!.current.results[f.own]!.presence).toHaveProperty('session_archived_at')
    expect(values[0]!.current.results[f.own]!.presence).toHaveProperty('session_lifecycle_revision')
    const scalar=(await db.query<{definition:string}>("SELECT pg_get_functiondef('identity.build_agent_presence_payload(text)'::regprocedure) AS definition")).rows[0]!.definition
    await db.query('SAVEPOINT unknown_presence')
    await db.query(scalar.replace('DECLARE','-- unknown predecessor\nDECLARE'))
    await expect(db.query(guard)).rejects.toThrow(/Unexpected scalar presence predecessor/)
    await db.query('ROLLBACK TO SAVEPOINT unknown_presence')
  }))

  it('keeps the snapshot wrapper and invoker boundary while batching more than 200 owned agents', () => fixture(async f => {
    const ids=Array.from({length:201},() => randomUUID())
    await db.query("INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id) SELECT x,'agent','batch fixture',$2,$3 FROM unnest($1::text[]) x", [ids,f.owner,'d-'+f.owner])
    const rows=await as<{snapshot: {identities: {id:string;type:string}[];presence: unknown}}>(f.owner,'SELECT chat.sync_snapshot() AS snapshot')
    const snapshot=rows[0]!.snapshot
    const expected=await as<{value: unknown}>(f.owner,`SELECT coalesce(jsonb_object_agg(x,identity.get_agent_presence(x)),'{}') AS value
      FROM unnest($1::text[]) x WHERE identity.can_view_agent_runtime_state(x)`, [snapshot.identities.filter(x=>x.type==='agent').map(x=>x.id)])
    expect(snapshot.presence).toEqual(expected[0]!.value)
    expect(Object.keys(snapshot.presence as object).length).toBeGreaterThan(200)
    expect((await as<{snapshot:{presence:unknown}}>(f.stranger,'SELECT chat.sync_snapshot() AS snapshot'))[0]!.snapshot.presence).toEqual({})
    expect((await db.query("SELECT provolatile,prosecdef FROM pg_proc WHERE oid='chat.sync_snapshot()'::regprocedure")).rows).toEqual([{provolatile:'s',prosecdef:false}])
    for (const signature of ['identity.get_agent_presence_batch(text[])','chat.list_unread_locators_for_chats(text[])','chat.sync_snapshot()']) {
      expect((await db.query("SELECT has_function_privilege('authenticated',$1,'EXECUTE') AS api,has_function_privilege('anon',$1,'EXECUTE') AS anonymous",[signature])).rows).toEqual([{api:true,anonymous:false}])
    }
  }), 30000)
})
