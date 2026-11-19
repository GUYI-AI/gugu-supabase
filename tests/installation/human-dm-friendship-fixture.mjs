import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'

export const humanDmFriendshipVersion = '20261119174000_human_dm_friendship_required'
const tag = 'dm_friendship_required'
const sendSql = "SELECT chat.send_message_with_overlays($1,$2,$3,NULL,$4,'text',NULL,NULL,false,false)"

async function actor(db, id, role = 'authenticated') {
  assert.ok(['authenticated', 'service_role'].includes(role))
  await db.query('SET LOCAL ROLE ' + role)
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,true),set_config('request.jwt.claims',$2,true)",
    [id ?? '', JSON.stringify({ ...(id ? { sub: id } : {}), role })])
}
async function refused(db, action, named = true) {
  await db.query('SAVEPOINT refusal')
  let error
  try { await action() } catch (caught) { error = caught }
  finally { await db.query('ROLLBACK TO SAVEPOINT refusal; RELEASE SAVEPOINT refusal') }
  assert.ok(error, 'the attempted write must be refused')
  assert.equal(error.code, '42501')
  if (named) {
    assert.equal(error.message, tag)
    assert.equal(error.hint, tag)
  }
  return error
}
async function human(db, label) {
  const id = randomUUID()
  await db.query("INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at) VALUES($1,'authenticated','authenticated',$2,'{\"provider\":\"email\",\"providers\":[\"email\"]}','{}',now(),now())",
    [id, id + '@human-dm-friendship.invalid'])
  await db.query("INSERT INTO identity.users(id,type,display_name) VALUES($1,'human',$2) ON CONFLICT(id) DO UPDATE SET display_name=EXCLUDED.display_name", [id, label])
  await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'DM friendship fixture','fixture','darwin')", ['dev-' + id, id])
  return id
}
async function room(db, kind, people) {
  const id = randomUUID()
  await db.query('INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,$2,$3,$4)', [id, kind, kind === 'group' ? 'DM friendship group control' : null, people[0]])
  for (const [i, person] of people.entries()) {
    await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role,inbox_published_at) VALUES($1,$2,$3,now())",
      [id, person, i === 0 ? 'owner' : 'member'])
  }
  return id
}
async function friends(db, a, b) {
  await db.query('INSERT INTO identity.friendships(user_a_id,user_b_id) VALUES(LEAST($1::text,$2::text),GREATEST($1::text,$2::text)) ON CONFLICT DO NOTHING', [a, b])
}
async function unfriend(db, a, b) {
  await db.query('DELETE FROM identity.friendships WHERE user_a_id=LEAST($1::text,$2::text) AND user_b_id=GREATEST($1::text,$2::text)', [a, b])
}
async function ownAgent(db, owner) {
  const id = randomUUID()
  await db.query("INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id) VALUES($1,'agent','DM friendship agent control',$2,$3)", [id, owner, 'dev-' + owner])
  return id
}
async function snapshot(db, f) {
  return {
    messages: (await db.query('SELECT id,chat_id,sender_user_id,content,created_at,seq FROM chat.messages WHERE chat_id=$1 ORDER BY seq', [f.dm])).rows,
    seats: (await db.query('SELECT user_id,role,inbox_published_at FROM chat.chat_members WHERE chat_id=$1 ORDER BY user_id', [f.dm])).rows,
  }
}
async function waitForLock(monitor, pid) {
  const until = Date.now() + 5000
  while (Date.now() < until) {
    const { rows } = await monitor.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])
    if (rows[0]?.wait_event_type === 'Lock') return
    await delay(20)
  }
  assert.fail('the competing transaction must really wait on a lock')
}
async function concurrency({ db, url, fixture: f, test }) {
  const first = new pg.Client({ connectionString: url })
  const second = new pg.Client({ connectionString: url })
  await first.connect(); await second.connect()
  const pid = (await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
  try {
    await test('a removal holding the friendship row makes a waiting send recheck and refuse', async () => {
      await friends(db, f.a, f.b)
      await first.query("BEGIN; SET LOCAL lock_timeout='8s'")
      await unfriend(first, f.a, f.b)
      await second.query("BEGIN; SET LOCAL lock_timeout='8s'"); await actor(second, f.a)
      const pending = second.query(sendSql, [randomUUID(), f.dm, f.a, 'must not pass removal'])
      void pending.catch(() => {})
      await waitForLock(db, pid)
      await first.query('COMMIT')
      await assert.rejects(pending, { code: '42501', message: tag })
      await second.query('ROLLBACK')
    })
    await test('an authorized send holds the friendship until commit; later sends refuse', async () => {
      await friends(db, f.a, f.b)
      await first.query("BEGIN; SET LOCAL lock_timeout='8s'"); await actor(first, f.a)
      const id = randomUUID()
      await first.query(sendSql, [id, f.dm, f.a, 'committed before removal'])
      await second.query("BEGIN; SET LOCAL lock_timeout='8s'")
      const pending = unfriend(second, f.a, f.b); void pending.catch(() => {})
      await waitForLock(db, pid)
      await first.query('COMMIT'); await pending; await second.query('COMMIT')
      assert.equal((await db.query('SELECT id FROM chat.messages WHERE id=$1', [id])).rowCount, 1)
      await first.query('BEGIN'); await actor(first, f.a)
      await refused(first, () => first.query(sendSql, [randomUUID(), f.dm, f.a, 'after removal']))
      await first.query('ROLLBACK')
    })
  } finally {
    await first.query('ROLLBACK').catch(() => {}); await second.query('ROLLBACK').catch(() => {})
    await first.end(); await second.end()
  }
}

export async function installHumanDmFriendshipWithEvidence({ db, query, sql, url, test }) {
  const f = { a: await human(db, 'DM A'), b: await human(db, 'DM B'), c: await human(db, 'DM C'), outsider: await human(db, 'DM outsider') }
  f.dm = await room(db, 'dm', [f.a, f.b])
  f.oldA = randomUUID(); f.oldB = randomUUID()
  await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type) VALUES($1,$3,$4,'old A','text'),($2,$3,$5,'old B','text')", [f.oldA, f.oldB, f.dm, f.a, f.b])
  await db.query("INSERT INTO chat.message_reactions(message_id,user_id,emoji) VALUES($1,$2,'👍')", [f.oldB, f.a])
  const before = await snapshot(db, f)
  const entryAcl = () => db.query("SELECT oid,proowner,proacl::text,proargtypes::text,prorettype::regtype::text FROM pg_proc WHERE oid IN ('chat.get_or_create_dm(text)'::regprocedure,'chat.open_dm(text)'::regprocedure,'chat.attachment_sender_check(text,text)'::regprocedure) ORDER BY oid")
  const aclBefore = (await entryAcl()).rows
  const definitionsBefore = (await db.query("SELECT oid,prosrc,provolatile FROM pg_proc WHERE oid IN ('chat.get_or_create_dm(text)'::regprocedure,'chat.attachment_sender_check(text,text)'::regprocedure) ORDER BY oid")).rows
  await test('the migration rolls back new guards, old entrypoints and its ledger atomically', async () => {
    await assert.rejects(query(sql.replace(/COMMIT;\s*$/, 'SELECT 1/0; COMMIT;')), { code: '22012' })
    await db.query('ROLLBACK')
    assert.equal((await db.query("SELECT to_regprocedure('chat_private.require_human_friendship(text,text)') AS helper")).rows[0].helper, null)
    assert.deepEqual((await entryAcl()).rows, aclBefore)
    assert.deepEqual((await db.query("SELECT oid,prosrc,provolatile FROM pg_proc WHERE oid IN ('chat.get_or_create_dm(text)'::regprocedure,'chat.attachment_sender_check(text,text)'::regprocedure) ORDER BY oid")).rows, definitionsBefore)
    assert.deepEqual(await snapshot(db, f), before)
  })
  const result = await query(sql)
  await test('the upgrade preserves old messages, seats, public signatures and ACLs', async () => {
    assert.deepEqual(await snapshot(db, f), before)
    assert.deepEqual((await entryAcl()).rows, aclBefore)
    assert.equal((await db.query("SELECT provolatile FROM pg_proc WHERE oid='chat.attachment_sender_check(text,text)'::regprocedure")).rows[0].provolatile, 'v')
    const actual = (await db.query("SELECT oid,prosrc,provolatile FROM pg_proc WHERE oid IN ('chat.get_or_create_dm(text)'::regprocedure,'chat.attachment_sender_check(text,text)'::regprocedure) ORDER BY oid")).rows
    for (const [index, current] of actual.entries()) {
      const source = current.prosrc
        .replace('    PERFORM chat_private.require_human_friendship(v_current_user_id, v_target_user_id);\n\n', '')
        .replace('    PERFORM chat_private.require_dm_friendship(p_chat_id);\n', '')
      assert.equal(source, definitionsBefore[index].prosrc, 'all prior liveness and ownership checks remain byte-identical')
    }
  })
  await test('operational rollback restores exact predecessor functions, ACLs and retained state without rewriting the ledger', async () => {
    const ledger = (await db.query('SELECT * FROM gugu_install.releases ORDER BY version')).rows
    await db.query('BEGIN')
    try {
      const rollback = readFileSync(new URL('../../ops/rollback-human-dm-friendship.sql', import.meta.url), 'utf8')
        .replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '')
      await db.query(rollback)
      assert.deepEqual((await entryAcl()).rows, aclBefore)
      assert.deepEqual((await db.query("SELECT oid,prosrc,provolatile FROM pg_proc WHERE oid IN ('chat.get_or_create_dm(text)'::regprocedure,'chat.attachment_sender_check(text,text)'::regprocedure) ORDER BY oid")).rows, definitionsBefore)
      assert.equal((await db.query("SELECT to_regprocedure('chat_private.require_human_friendship(text,text)') AS helper")).rows[0].helper, null)
      assert.deepEqual(await snapshot(db, f), before)
      assert.deepEqual((await db.query('SELECT * FROM gugu_install.releases ORDER BY version')).rows, ledger)
    } finally { await db.query('ROLLBACK') }
  })
  await test('the new helper and trigger functions are closed to all API roles', async () => {
    for (const role of ['anon', 'authenticated', 'service_role', 'gugu_files']) {
      for (const signature of ['chat_private.require_human_friendship(text,text)', 'chat_private.require_dm_friendship(text)', 'chat_private.guard_human_dm_message()', 'chat_private.guard_human_dm_reaction()']) {
        assert.equal((await db.query('SELECT has_function_privilege($1,$2,\'EXECUTE\') AS allowed', [role, signature])).rows[0].allowed, false)
      }
    }
  })
  await db.query('BEGIN')
  const check = async (name, who, run, setup = async () => {}) => test(name, async () => {
    await db.query('SAVEPOINT dm_case')
    try { await setup(); await actor(db, typeof who === 'string' ? who : who?.id ?? null, who?.role ?? 'authenticated'); await run() }
    finally { await db.query('ROLLBACK TO SAVEPOINT dm_case; RELEASE SAVEPOINT dm_case') }
  })
  try {
    await check('non-friends cannot create a DM or publish an existing DM through open_dm', f.a, async () => {
      await refused(db, () => db.query('SELECT chat.open_dm($1)', [f.c]))
      await refused(db, () => db.query('SELECT chat.open_dm($1)', [f.b]))
      assert.deepEqual((await db.query('SELECT id,content FROM chat.messages WHERE chat_id=$1 ORDER BY seq', [f.dm])).rows,
        before.messages.map(({ id, content }) => ({ id, content })))
    })
    await check('a cached non-friend DM rejects ordinary RPC sends, inserts and forwards', f.a, async () => {
      await refused(db, () => db.query(sendSql, [randomUUID(), f.dm, f.a, 'new RPC text']))
      await refused(db, () => db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES($1,$2,$3,'direct')", [randomUUID(), f.dm, f.a]))
      await refused(db, () => db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content,forwarded_from_message_id) VALUES($1,$2,$3,'forwarded',$4)", [randomUUID(), f.dm, f.a, f.oldB]))
    })
    await check('a trusted API role cannot bypass new-message or reaction guards', { role: 'service_role' }, async () => {
      await refused(db, () => db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES($1,$2,$3,'service path')", [randomUUID(), f.dm, f.a]))
      await refused(db, () => db.query("UPDATE chat.message_reactions SET emoji='🔥' WHERE message_id=$1 AND user_id=$2", [f.oldB, f.a]))
      await refused(db, () => db.query("UPDATE chat.messages SET encrypted_content=decode('01','hex') WHERE id=$1", [f.oldA]))
    })
    await check('a trusted role carrying a non-member subject cannot use the RLS-denial exemption', { id: f.outsider, role: 'service_role' }, async () => {
      await refused(db, () => db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES($1,$2,$3,'claimed service path')", [randomUUID(), f.dm, f.a]))
      await refused(db, () => db.query("UPDATE chat.messages SET content='claimed service edit' WHERE id=$1", [f.oldA]))
      await refused(db, () => db.query("UPDATE chat.message_reactions SET emoji='🔥' WHERE message_id=$1 AND user_id=$2", [f.oldB, f.a]))
    })
    await check('server notices and existing metadata maintenance keep their old authority', { role: 'service_role' }, async () => {
      await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type) VALUES($1,$2,NULL,'server notice','system')", [randomUUID(), f.dm])
      await db.query('UPDATE chat.messages SET to_user_ids=ARRAY[]::text[],file_blob_id=NULL WHERE id=$1', [f.oldA])
      assert.equal((await db.query('SELECT content FROM chat.messages WHERE id=$1', [f.oldA])).rows[0].content, 'old A')
    })
    await check('a member cannot forge the sender-less server-notice exemption', f.a, async () => {
      const error = await refused(db, () => db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type) VALUES($1,$2,NULL,'forged notice','system')", [randomUUID(), f.dm]), false)
      assert.notEqual(error.message, tag)
    })
    await check('attachment commit and forwarding refuse before looking up staged bytes', f.a, async () => {
      await refused(db, () => db.query("SELECT * FROM chat.attachment_commit($1,$2,$3,$4,'test.txt')", ['missing-controlled-stage', randomUUID(), f.dm, f.a]))
      await refused(db, () => db.query("SELECT * FROM chat.attachment_forward($1,$2,$3,$4)", [f.oldB, randomUUID(), f.dm, f.a]))
    })
    await check('non-friend body edits and new emoji reactions refuse', f.a, async () => {
      await refused(db, () => db.query("UPDATE chat.messages SET content='edited',edited_at=now() WHERE id=$1", [f.oldA]))
      await refused(db, () => db.query("INSERT INTO chat.message_reactions(message_id,user_id,emoji) VALUES($1,$2,'🔥')", [f.oldB, f.a]))
    })
    await check('retraction, removing a reaction and personal deletion retain existing permissions', f.a, async () => {
      await db.query('UPDATE chat.messages SET retracted_at=now() WHERE id=$1', [f.oldA])
      assert.ok((await db.query('SELECT retracted_at FROM chat.messages WHERE id=$1', [f.oldA])).rows[0].retracted_at)
      assert.equal((await db.query("DELETE FROM chat.message_reactions WHERE message_id=$1 AND user_id=$2 RETURNING message_id", [f.oldB, f.a])).rowCount, 1)
      const removed = (await db.query('SELECT * FROM chat.delete_message($1)', [f.oldB])).rows[0]
      assert.equal(removed.globally_deleted, false)
      await db.query('SELECT chat.clear_messages_for_me($1)', [f.dm])
    })
    await check('deleting your own message remains allowed without friendship', f.a, async () => {
      assert.equal((await db.query('SELECT * FROM chat.delete_message($1)', [f.oldA])).rows[0].globally_deleted, true)
    })
    await check('friends reuse the original DM and can send, edit and react', f.a, async () => {
      assert.equal((await db.query('SELECT chat.open_dm($1) AS id', [f.b])).rows[0].id, f.dm)
      await db.query(sendSql, [randomUUID(), f.dm, f.a, 'friend send'])
      await db.query("UPDATE chat.messages SET content='friend edit',edited_at=now() WHERE id=$1", [f.oldA])
      await db.query("INSERT INTO chat.message_reactions(message_id,user_id,emoji) VALUES($1,$2,'🔥')", [f.oldB, f.a])
    }, () => friends(db, f.a, f.b))
    await check('removal blocks later sends but already-committed idempotent replay stays a readback', f.a, async () => {
      const id = randomUUID(), args = [id, f.dm, f.a, 'idempotent original']
      await db.query(sendSql, args)
      await db.query('SELECT identity.remove_contact($1)', [f.b])
      await db.query(sendSql, args)
      assert.equal((await db.query('SELECT id FROM chat.messages WHERE id=$1', [id])).rowCount, 1)
      await refused(db, () => db.query(sendSql, [randomUUID(), f.dm, f.a, 'new after removal']))
    }, () => friends(db, f.a, f.b))
    for (const status of ['pending', 'rejected']) {
      await check(status + ' friend requests are not friendships', f.a,
        () => refused(db, () => db.query('SELECT chat.open_dm($1)', [f.c])),
        () => db.query('INSERT INTO identity.friend_requests(id,sender_id,receiver_id,status) VALUES($1,$2,$3,$4)', [randomUUID(), f.a, f.c, status]))
    }
    await check('acceptance establishes friendship before publishing the greeting exactly once', f.a, async () => {
      const request = (await db.query("SELECT id FROM identity.friend_requests WHERE sender_id=$1 AND receiver_id=$2", [f.c, f.a])).rows[0].id
      const first = (await db.query('SELECT * FROM identity.accept_friend_request_by_id($1)', [request])).rows[0]
      const second = (await db.query('SELECT * FROM identity.accept_friend_request_by_id($1)', [request])).rows[0]
      assert.equal(second.chat_id, first.chat_id)
      assert.equal((await db.query("SELECT id FROM chat.messages WHERE id=$1", ['friend-request:' + request])).rowCount, 1)
    }, () => db.query("INSERT INTO identity.friend_requests(id,sender_id,receiver_id,message) VALUES($1,$2,$3,'accepted greeting')", [randomUUID(), f.c, f.a]))
    await check('re-friending recovers the same history and original DM', f.a, async () => {
      assert.equal((await db.query('SELECT chat.open_dm($1) AS id', [f.b])).rows[0].id, f.dm)
      assert.equal((await db.query('SELECT id FROM chat.messages WHERE chat_id=$1', [f.dm])).rowCount, 2)
    }, () => friends(db, f.a, f.b))
    await check('unrelated callers receive ordinary RLS denial without a relationship probe', f.outsider, async () => {
      const error = await refused(db, () => db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES($1,$2,$3,'outsider')", [randomUUID(), f.dm, f.outsider]), false)
      assert.notEqual(error.message, tag)
    })
    let group, agent, foreignAgent
    await check('group whispers and owned-agent DMs keep their existing contracts', f.a, async () => {
      await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content,to_user_ids,is_whisper) VALUES($1,$2,$3,'group whisper',ARRAY[$4::text],true)", [randomUUID(), group, f.a, f.c])
      const own = (await db.query('SELECT chat.open_dm($1) AS id', [agent])).rows[0].id
      await db.query(sendSql, [randomUUID(), own, f.a, 'owned agent'])
      await db.query('SAVEPOINT foreign_agent')
      let error
      try { await db.query('SELECT chat.open_dm($1)', [foreignAgent]) } catch (caught) { error = caught }
      await db.query('ROLLBACK TO SAVEPOINT foreign_agent; RELEASE SAVEPOINT foreign_agent')
      assert.match(error?.message ?? '', /agent you do not own/)
    }, async () => { group = await room(db, 'group', [f.a, f.c]); agent = await ownAgent(db, f.a); foreignAgent = await ownAgent(db, f.c) })
    await check('a missing human peer is not a write exemption', f.a,
      () => refused(db, () => db.query(sendSql, [randomUUID(), f.dm, f.a, 'missing peer'])),
      () => db.query('DELETE FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [f.dm, f.b]))
  } finally { await db.query('ROLLBACK') }
  await concurrency({ db, url, fixture: f, test })
  return result
}
