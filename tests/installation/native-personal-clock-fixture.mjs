import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'

// Runs at the real v1 -> C installation boundary. It never resets a schema or ledger.
export async function installNativePersonalClock({ db, url, release, wrappedSQL, query, check, report = () => {} }) {
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol))
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'clock installation requires a disposable loopback fixture')
  const b = new pg.Client({ connectionString: url.href })
  const observer = new pg.Client({ connectionString: url.href })
  await b.connect(); await observer.connect()
  const owner = randomUUID(), device = randomUUID()
  const conversations = Array.from({ length: 4 }, randomUUID)
  const agents = Array.from({ length: 4 }, randomUUID)
  const normal = '2026-01-01T00:00:00.000Z', future = '2099-01-01T00:00:00.000Z'
  const session = 'clock-install-' + randomUUID()
  const unknown = randomUUID(), late = randomUUID(), stale = randomUUID()
  const gateStart = 'clock-start-' + randomUUID(), gateSwitch = 'clock-switch-' + randomUUID()
  const ids = [owner]
  const chats = [...conversations]
  let pending, stalePending, result
  const stage = async (name, action) => {
    let failure
    await check(name, async () => {
      try { await action() } catch (error) { failure = error; throw error }
    })
    // node:test reports a failed subtest without rejecting its parent promise.
    if (failure) throw failure
  }
  const auth = async (client, actor = owner) => {
    await client.query('BEGIN; SET LOCAL ROLE authenticated')
    await client.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [actor])
  }
  const native = (client, id, chat = conversations[0], at = normal) => client.query(
    'SELECT chat.publish_native_conversation_message($1,$2,$3,$4,$5,$6) AS value',
    [device, agents[conversations.indexOf(chat)], session, id, chat, at],
  )
  const committed = async (client, action, actor = owner) => {
    await auth(client, actor)
    try { const value = await action(); await client.query('COMMIT'); return value } catch (error) { await client.query('ROLLBACK'); throw error }
  }
  const pid = (await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
  const bPid = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
  const observerPid = (await observer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
  async function blocked(waiter, blocker) {
    const deadline = Date.now() + 4_000
    for (;;) {
      if ((await observer.query('SELECT pg_blocking_pids($1) AS blockers', [waiter])).rows[0].blockers.includes(blocker)) return
      if (Date.now() > deadline) throw Error('Clock installation did not reach its exact expected blocker')
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }
  const state = async () => ({
    functions: (await db.query(`SELECT oid::regprocedure::text AS signature,pg_get_functiondef(oid),proacl::text
      FROM pg_proc WHERE oid=ANY($1::regprocedure[]) ORDER BY 1`, [[
      'chat.publish_native_conversation_message(text,text,text,text,text,timestamptz)',
      'chat.list_conversation_memberships(text[])', 'chat.sync_snapshot()',
    ]])).rows,
    activity: (await db.query('SELECT to_jsonb(a) AS value FROM chat.native_personal_conversation_activity a WHERE user_id=ANY($1::text[]) ORDER BY chat_id', [ids])).rows,
    receipts: (await db.query('SELECT to_jsonb(p) AS value FROM chat.native_conversation_publications p WHERE owner_user_id=ANY($1::text[]) ORDER BY device_id,session_id,message_id', [ids])).rows,
    heads: (await db.query('SELECT user_id,revision::text FROM chat.account_revision_heads WHERE user_id=ANY($1::text[]) ORDER BY user_id', [ids])).rows,
  })
  const normalInputs = async (withSort = false) => (await db.query(`SELECT a.chat_id,a.native_personal_activity_at::text,
    ${withSort ? 'a.native_personal_sort_at' : 'a.native_personal_activity_at'}::text AS effective_sort_at,
    m.is_pinned,m.version,m.inbox_published_at::text,s.conversation_hidden_at::text,c.created_at::text
    FROM chat.native_personal_conversation_activity a JOIN chat.chat_members m
      ON m.chat_id=a.chat_id AND m.user_id=a.user_id JOIN chat.chats c ON c.id=a.chat_id
    LEFT JOIN chat.conversation_list_state s ON s.user_id=a.user_id AND s.chat_id=a.chat_id
    WHERE a.user_id=$1 AND a.chat_id=ANY($2::text[])
    ORDER BY m.is_pinned DESC,${withSort ? 'a.native_personal_sort_at' : 'a.native_personal_activity_at'} DESC,a.chat_id`, [owner, conversations.slice(0, 2)])).rows
  const legacy = async () => (await db.query(`SELECT chat_id,native_personal_activity_at::text,
    native_personal_sort_at::text,legacy_personal_sort_at::text,legacy_sort_migrated_at::text,
    native_personal_activity_revision::text FROM chat.native_personal_conversation_activity
    WHERE user_id=$1 ORDER BY chat_id`, [owner])).rows
  const beforeColumns = async () => (await db.query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema='chat' AND table_name='native_personal_conversation_activity'
    AND column_name IN ('native_personal_sort_at','legacy_personal_sort_at','legacy_sort_migrated_at')`)).rows
  try {
    await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [owner, owner + '@clock-install.invalid'])
    await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'Clock install','fixture','linux')", [device, owner])
    for (let i = 0; i < conversations.length; i++) {
      await db.query("INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id) VALUES($1,'agent','Clock install',$2,$3)", [agents[i], owner, device])
      await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'dm','Clock install',$2)", [conversations[i], owner])
      await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'member'),($1,$3,'member')", [conversations[i], owner, agents[i]])
      await db.query('UPDATE chat.chat_members SET inbox_published_at=clock_timestamp() WHERE chat_id=$1', [conversations[i]])
    }
    for (const chat of conversations.slice(0, 3)) await committed(db, () => native(db, randomUUID(), chat, chat === conversations[2] ? future : normal))
    await db.query('UPDATE chat.chat_members SET is_pinned=true WHERE chat_id=$1 AND user_id=$2', [conversations[0], owner])
    await committed(db, () => db.query('SELECT chat.hide_my_conversation($1,$2)', [conversations[2], randomUUID()]))
    await db.query('INSERT INTO chat.native_conversation_publications(owner_user_id,device_id,session_id,message_id,agent_user_id,chat_id,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [owner, device, session, unknown, agents[3], conversations[3], normal])
    await stage('a newly admitted owner makes the cutover retry before acquiring a late owner guard or head', async () => {
      const secondOwner = randomUUID(), secondDevice = randomUUID(), secondAgent = randomUUID(), secondChat = randomUUID()
      ids.push(secondOwner); chats.push(secondChat)
      await db.query('INSERT INTO auth.users(id,email) VALUES($1,$2)', [secondOwner, secondOwner + '@clock-admission.invalid'])
      await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'Clock admission','fixture','linux')", [secondDevice, secondOwner])
      await db.query("INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id) VALUES($1,'agent','Clock admission',$2,$3)", [secondAgent, secondOwner, secondDevice])
      await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'dm','Clock admission',$2)", [secondChat, secondOwner])
      await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'member'),($1,$3,'member')", [secondChat, secondOwner, secondAgent])
      const gate = 'clock-owner-admission-' + randomUUID()
      const marker = '  LOCK TABLE chat.native_conversation_publications IN ACCESS EXCLUSIVE MODE;'
      assert.equal(release.sql.split(marker).length, 2)
      await observer.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [gate])
      const instrumented = release.sql.replace(marker, () => "  PERFORM pg_advisory_xact_lock(hashtextextended('" + gate + "',0));\n" + marker)
      pending = query(wrappedSQL.replace(release.sql, () => instrumented)).then(() => null, error => error)
      await blocked(pid, observerPid)
      await committed(b, () => b.query('SELECT chat.publish_native_conversation_message($1,$2,$3,$4,$5,$6)',
        [secondDevice, secondAgent, session, randomUUID(), secondChat, normal]), secondOwner)
      await observer.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [gate])
      assert.equal((await pending)?.code, '40001')
      await db.query('ROLLBACK')
      assert.deepEqual(await beforeColumns(), [])
      assert.equal((await db.query('SELECT count(*)::int AS n FROM chat.native_personal_conversation_activity WHERE user_id=$1', [secondOwner])).rows[0].n, 1)
    })
    const before = await state(), beforeNormal = await normalInputs()
    const receipts = before.receipts.filter(row => row.value.owner_user_id === owner)
    const hiddenBefore = (await db.query('SELECT conversation_hidden_at::text AS value FROM chat.conversation_list_state WHERE user_id=$1 AND chat_id=$2', [owner, conversations[2]])).rows[0].value

    await stage('clock release failure restores the original tuple, receipt, head, functions and new columns', async () => {
      const failure = wrappedSQL.replace(/COMMIT;\s*$/, 'SELECT 1/0;\nCOMMIT;')
      assert.notEqual(failure, wrappedSQL)
      await assert.rejects(query(failure), { code: '22012' })
      await db.query('ROLLBACK')
      assert.deepEqual(await state(), before)
      assert.deepEqual(await beforeColumns(), [])
    })

    await stage('clock cutover refuses an old reader without waiting after acquiring heads', async () => {
      await b.query('BEGIN; SELECT 1 FROM chat.native_personal_conversation_activity LIMIT 1')
      try { await assert.rejects(query(wrappedSQL), { code: '55P03' }) } finally { await db.query('ROLLBACK'); await b.query('ROLLBACK') }
      assert.deepEqual(await state(), before)
      assert.deepEqual(await beforeColumns(), [])
    })

    await stage('clock migration anchors after a late committed old publication and rejects a queued old compiled body', async () => {
      await observer.query('SELECT pg_advisory_lock(hashtextextended($1,0)),pg_advisory_lock(hashtextextended($2,0))', [gateStart, gateSwitch])
      const pauseAfterAdmission = 'END;\n$clock_admission$;'
      assert.equal(release.sql.split(pauseAfterAdmission).length, 2)
      const instrumented = release.sql.replace(pauseAfterAdmission,
        pauseAfterAdmission + "\nSELECT pg_advisory_xact_lock(hashtextextended('" + gateSwitch + "',0));")
      const request = wrappedSQL.replace(release.sql, () =>
        "SELECT pg_advisory_xact_lock(hashtextextended('" + gateStart + "',0));\n" + instrumented)
      pending = query(request).then(value => ({ value }), error => ({ error }))
      await blocked(pid, observerPid)
      const transactionStart = (await observer.query('SELECT xact_start::text FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0].xact_start
      await auth(b)
      await native(b, late)
      await b.query('RESET ROLE')
      const lateReceipt = (await b.query('SELECT published_at::text FROM chat.native_conversation_publications WHERE device_id=$1 AND message_id=$2', [device, late])).rows[0].published_at
      assert.equal((await observer.query('SELECT $1::timestamptz>$2::timestamptz AS after_start', [lateReceipt, transactionStart])).rows[0].after_start, true)
      await observer.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [gateStart])
      await blocked(pid, bPid)
      await b.query('COMMIT')
      await blocked(pid, observerPid)
      await auth(b)
      stalePending = native(b, stale, conversations[0], future).then(() => null, error => error)
      await blocked(bPid, pid)
      await observer.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [gateSwitch])
      const migration = await pending
      assert.equal(migration.error, undefined)
      result = migration.value
      assert.equal((await stalePending)?.code, '40001')
      await b.query('ROLLBACK')
      stalePending = undefined
      const anchors = (await db.query(`SELECT bool_and(legacy_sort_migrated_at>=$2::timestamptz) AS after_receipt,
        count(DISTINCT legacy_sort_migrated_at)::int AS distinct_anchors FROM chat.native_personal_conversation_activity
        WHERE user_id=$1`, [owner, lateReceipt])).rows[0]
      assert.deepEqual(anchors, { after_receipt: true, distinct_anchors: 1 })
      assert.equal((await db.query('SELECT count(*)::int AS n FROM chat.native_conversation_publications WHERE device_id=$1 AND message_id=$2', [device, stale])).rows[0].n, 0)
    })

    await stage('normal legacy sort inputs and hidden state remain unchanged while future legacy values use the fixed baseline', async () => {
      const afterNormal = await normalInputs(true)
      await report({ kind: 'legacy_clock_comparison', scope: 'backend time and membership inputs; client row/date acceptance remains separate',
        before: beforeNormal, after: afterNormal,
        legacy_before: before.activity.filter(row => row.value.user_id === owner), legacy_after: await legacy(),
        differences: beforeNormal.filter((row, i) => JSON.stringify(row) !== JSON.stringify(afterNormal[i])) })
      assert.deepEqual(afterNormal, beforeNormal)
      const bounds = (await db.query(`SELECT chat_id,native_personal_sort_at=native_personal_activity_at AS normal_unchanged,
        native_personal_sort_at=legacy_personal_sort_at AS matches_baseline,
        legacy_personal_sort_at=least(native_personal_activity_at,legacy_sort_migrated_at) AS bounded,
        legacy_personal_sort_at=legacy_sort_migrated_at AS future_capped
        FROM chat.native_personal_conversation_activity WHERE user_id=$1`, [owner])).rows
      for (const row of bounds) {
        assert.equal(row.matches_baseline, true); assert.equal(row.bounded, true)
        assert.equal(row.normal_unchanged, row.chat_id !== conversations[2])
        assert.equal(row.future_capped, row.chat_id === conversations[2])
      }
      assert.equal((await db.query('SELECT conversation_hidden_at::text AS value FROM chat.conversation_list_state WHERE user_id=$1 AND chat_id=$2', [owner, conversations[2]])).rows[0].value, hiddenBefore)
      for (const row of receipts) {
        const key = row.value
        const retained = (await db.query('SELECT to_jsonb(p)-\'sort_at\'-\'personal_activity_applied_revision\' AS value FROM chat.native_conversation_publications p WHERE device_id=$1 AND session_id=$2 AND message_id=$3', [key.device_id, key.session_id, key.message_id])).rows[0]
        assert.deepEqual(retained, row)
      }
      assert.equal((await db.query('SELECT count(*)::int AS n FROM chat.native_conversation_publications WHERE owner_user_id=$1 AND (sort_at IS NOT NULL OR personal_activity_applied_revision IS NOT NULL)', [owner])).rows[0].n, 0)
      const oldVersion = new Map(before.activity.map(row => [row.value.chat_id, row.value.native_personal_activity_revision]))
      for (const row of await legacy()) assert.ok(BigInt(row.native_personal_activity_revision) > BigInt(oldVersion.get(row.chat_id)))
    })

    await stage('clock legacy phase replay leaves stored baselines, anchors and activity versions unchanged', async () => {
      const prior = await legacy()
      const start = release.sql.indexOf('DO $clock_legacy$')
      const end = release.sql.indexOf('$clock_legacy$;', start) + '$clock_legacy$;'.length
      assert.ok(start >= 0 && end > start)
      await query('BEGIN;\n' + release.sql.slice(start, end) + '\nCOMMIT;')
      assert.deepEqual(await legacy(), prior)
    })

    await stage('old unknown receipts still do not manufacture activity or fill publication evidence', async () => {
      const duplicate = (await committed(b, () => native(b, unknown, conversations[3]))).rows[0].value
      assert.equal(duplicate.already, true)
      assert.equal((await db.query('SELECT count(*)::int AS n FROM chat.native_personal_conversation_activity WHERE user_id=$1 AND chat_id=$2', [owner, conversations[3]])).rows[0].n, 0)
      assert.deepEqual((await db.query('SELECT sort_at,personal_activity_applied_revision FROM chat.native_conversation_publications WHERE device_id=$1 AND message_id=$2', [device, unknown])).rows[0], { sort_at: null, personal_activity_applied_revision: null })
    })

    await stage('a retried new C call is first once and rebuild retains the immutable legacy baseline', async () => {
      const baseline = await legacy()
      const first = (await committed(b, () => native(b, stale, conversations[0], future))).rows[0].value
      assert.equal(first.already, false)
      assert.equal((await committed(b, () => native(b, stale, conversations[0], future))).rows[0].value.already, true)
      const rebuilt = (await db.query(`SELECT a.chat_id,a.native_personal_sort_at=greatest(a.legacy_personal_sort_at,
        (SELECT max(p.sort_at) FROM chat.native_conversation_publications p WHERE p.owner_user_id=a.user_id
          AND p.chat_id=a.chat_id AND p.personal_activity_applied_revision IS NOT NULL)) AS matches
        FROM chat.native_personal_conversation_activity a WHERE a.user_id=$1`, [owner])).rows
      assert.ok(rebuilt.every(row => row.matches))
      const after = await legacy()
      for (const row of after) {
        const old = baseline.find(item => item.chat_id === row.chat_id)
        assert.equal(row.legacy_personal_sort_at, old.legacy_personal_sort_at)
        assert.equal(row.legacy_sort_migrated_at, old.legacy_sort_migrated_at)
      }
      assert.equal((await db.query('SELECT personal_activity_applied_revision::text AS revision FROM chat.native_conversation_publications WHERE device_id=$1 AND message_id=$2', [device, stale])).rows[0].revision, first.account_revision)
    })
    return result
  } finally {
    await observer.query('SELECT pg_advisory_unlock_all()').catch(() => {})
    if (!stalePending) await b.query('ROLLBACK').catch(() => {})
    await pending
    await db.query('ROLLBACK').catch(() => {})
    await stalePending
    await b.query('ROLLBACK').catch(() => {})
    for (const chat of chats) await db.query('DELETE FROM chat.chats WHERE id=$1', [chat])
    for (const id of ids) await db.query('DELETE FROM auth.users WHERE id=$1', [id])
    await b.end(); await observer.end()
  }
}
