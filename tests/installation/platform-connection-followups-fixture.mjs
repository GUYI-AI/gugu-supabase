import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { auditConnectionInventory } from '../../scripts/platform-connection-audit.mjs'

const prepareImport = 'identity.connection_prepare_import(text,text,text,jsonb)'
const pending = 'identity.connection_pending(text)'
const fence = 'identity.connection_management_write_fence(text,boolean)'
// Each anchor must occur exactly once; only that span may change, and it must
// carry the new behavior (written independently of the migration's text).
const patches = [
  [prepareImport, "(entry->>'body_item_id')::uuid,assistant,entry->>'resource_key',", ["entry->>'assistant_user_id'"], ['assistant,']],
  [pending, "RAISE EXCEPTION 'Connection account is not prepared' USING ERRCODE='55000';",
    ["ERRCODE='PT409'", "'CONNECTION_AUTHORITY_NOT_OWNER'"], ['55000']],
  [fence, "RAISE EXCEPTION 'Connection authority changed or is quiescing' USING ERRCODE='PT409'; END IF;",
    ["p_legacy AND head.authority_mode='owner'", "'CONNECTION_AUTHORITY_SWITCHED'", "'CONNECTION_AUTHORITY_QUIESCING'"], []],
]
const replaced = ['identity.connection_legacy_inventory(text)', 'identity.connection_owner_lock(text)',
  'identity.connection_authority_cutover(text,bigint,text,text,text)']
const added = ['identity.connection_legacy_import_rows(text,text)', 'identity.connection_unknown_outcomes(text)']
const ownerShape = { version: 1, mode: 'owner', epoch: '1', phase: 'stable', acceptingNewOperations: true }
const operator = 'fixture-operator'
const bounds = "SET LOCAL statement_timeout='2s'; SET LOCAL lock_timeout='250ms'; SET LOCAL transaction_timeout='2s'"
const unbounded = 'SET LOCAL statement_timeout=0; SET LOCAL lock_timeout=0; SET LOCAL transaction_timeout=0'

/** Installs the rehearsal follow-up release, then exercises it in one transaction that rolls back every fixture row. */
export async function installConnectionFollowupsWithEvidence({ db, query, sql, test }) {
  const definitions = async () => (await db.query(`SELECT s.signature,p.oid,p.prosrc,p.proowner,p.prosecdef,p.provolatile,p.proconfig,
      (SELECT array_agg(x::text ORDER BY x::text) FROM unnest(p.proacl) x) AS acl
    FROM unnest($1::text[]) s(signature) JOIN pg_proc p ON p.oid=to_regprocedure(s.signature) ORDER BY s.signature`,
  [[prepareImport, pending, fence, ...replaced]])).rows
  const before = await definitions()
  const result = await query(sql)
  await test('follow-up release patches one span each and keeps OIDs, owners, attributes and grants', async () => {
    const after = await definitions()
    for (const [signature, anchor, present, absent] of patches) {
      const old = before.find(row => row.signature === signature).prosrc, now = after.find(row => row.signature === signature).prosrc
      const parts = old.split(anchor)
      assert.equal(parts.length, 2, `${signature}: anchor`)
      assert.ok(now.startsWith(parts[0]) && now.endsWith(parts[1]), `${signature}: only the anchored span changed`)
      const span = now.slice(parts[0].length, now.length - parts[1].length)
      for (const text of present) assert.ok(span.includes(text), `${signature}: ${text}`)
      for (const text of absent) assert.ok(!span.includes(text), `${signature}: no ${text}`)
    }
    for (const old of before) {
      const now = after.find(row => row.signature === old.signature)
      assert.deepEqual({ ...now, prosrc: null }, { ...old, prosrc: null }, old.signature)
    }
    const allowed = async (role, signature) => (await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [role, signature])).rows[0].allowed
    assert.equal(await allowed('authenticated', pending), true)
    for (const role of ['anon', 'service_role']) assert.equal(await allowed(role, pending), false, role)
    for (const signature of added) {
      for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await allowed(role, signature), false, `${role} ${signature}`)
      const row = (await db.query('SELECT prosecdef,proconfig FROM pg_proc WHERE oid=$1::regprocedure', [signature])).rows[0]
      assert.deepEqual(row, { prosecdef: false, proconfig: ['search_path=pg_catalog'] }, signature)
    }
  })

  await db.query('BEGIN')
  try {
    const human = async () => {
      const id = randomUUID()
      await db.query(`INSERT INTO auth.users(id,instance_id,aud,role,email,raw_app_meta_data,raw_user_meta_data,
        confirmation_token,recovery_token,email_change_token_new,email_change,created_at,updated_at)
        VALUES($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,
        '{"provider":"email","providers":["email"]}','{}','','','','',now(),now())`, [id, `${id}@connection-followups.invalid`])
      await db.query("INSERT INTO identity.users(id,type,display_name) VALUES($1,'human','Connection follow-up fixture') ON CONFLICT DO NOTHING", [id])
      return id
    }
    const device = async owner => {
      const id = `followup-${randomUUID()}`
      await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'fixture','fixture','linux')", [id, owner])
      return id
    }
    const runtime = async (owner, home) => {
      const id = randomUUID()
      await db.query('INSERT INTO identity.runtime_instances(instance_id,device_id,owner_user_id) VALUES($1,$2,$3)', [id, home, owner])
      return id
    }
    // An agent of the owner; removed ones have no execution device. provisioned: a completed assistant provision.
    const agent = async (owner, home, { removed = false, provisioned = true } = {}) => {
      const id = randomUUID(), operation = randomUUID()
      await db.query(`INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id,removed_at)
        VALUES($1,'agent','Follow-up fixture',$2,$3,CASE WHEN $4::boolean THEN now() END)`, [id, owner, removed ? null : home, removed])
      if (provisioned) {
        await db.query(`INSERT INTO identity.agent_provision_operations(id,owner_user_id,device_id,kind,payload_hash,blueprint,phase)
          VALUES($1,$2,$3,'single','fixture','{}','completed')`, [operation, owner, home])
        await db.query(`INSERT INTO identity.agent_provisions(id,owner_user_id,operation_id,member_key,device_id,display_name,agent_type,
          inherit_memory,history_import_required,payload_hash,agent_user_id,provisioned_agent_user_id,phase)
          VALUES($1,$2,$3,'assistant',$4,'Fixture','claude-code',false,false,'fixture',$5::text,$5::text::uuid,'completed')`,
        [randomUUID(), owner, operation, home, id])
      }
      return id
    }
    const row = (assistant, owner, key, home, revision, deleted = true) => db.query(`INSERT INTO identity.assistant_panel_items(
      assistant_user_id,owner_user_id,domain,resource_key,device_id,revision,data,deleted_at)
      VALUES($1,$2,'integrations',$3,$4,$5,$6,CASE WHEN $7::boolean THEN clock_timestamp() END)`,
    [assistant, owner, key, home, revision, deleted ? {} : { providerId: 'github', accountId: JSON.parse(key)[1], configured: true }, deleted])
    const change = (assistant, owner, key) => db.query(`INSERT INTO identity.assistant_panel_changes(operation_id,assistant_user_id,
      owner_user_id,domain,resource_key,device_id,source,operation,expected_item_revision,request_hash,payload,status)
      VALUES($1,$2,$3,'integrations',$4,NULL,'panel','remove',0,repeat('f',64),'{}','pending')`, [randomUUID(), assistant, owner, key])
    // A legacy account: provisioned assistant, control head at revision 3, ready empty collection.
    const legacyAccount = async () => {
      const owner = await human(), home = await device(owner), assistant = await agent(owner, home)
      await db.query(`INSERT INTO identity.assistant_panel_items(assistant_user_id,owner_user_id,domain,resource_key,device_id,revision,data)
        VALUES($1,$2,'control','__head__',NULL,3,'{}'),
          ($1,$2,'integrations','__collection__:' || $3,$3,3,'{"state":"ready","schemaVersion":1,"itemCount":0}')`, [assistant, owner, home])
      return { owner, home, assistant }
    }
    const as = async (user, action) => {
      await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role: 'authenticated' })])
      await db.query('SET LOCAL ROLE authenticated')
      const value = await action()
      await db.query('RESET ROLE')
      return value
    }
    const rpc = (user, name, placeholders, values = []) => as(user, async () =>
      (await db.query(`SELECT identity.${name}(${placeholders}) AS result`, values)).rows[0].result)
    const reject = async (action, code, message, errorCode) => {
      await db.query('SAVEPOINT followup_expected_error')
      let error
      try { await action() } catch (caught) { error = caught }
      await db.query('ROLLBACK TO followup_expected_error; RELEASE followup_expected_error')
      assert.equal(error?.code, code, error?.message ?? 'expected refusal')
      if (message) assert.equal(error.message, message)
      if (errorCode) assert.deepEqual(JSON.parse(error.detail), { errorCode, feature: 'connection-management' })
    }
    const bounded = async (statement, values) => {
      await db.query('SAVEPOINT followup_bounded')
      try {
        await db.query(bounds)
        const rows = (await db.query(statement, values)).rows
        await db.query(unbounded)
        await db.query('RELEASE followup_bounded')
        return rows[0]?.result
      } catch (error) { await db.query('ROLLBACK TO followup_bounded; RELEASE followup_bounded'); throw error }
    }
    const cutover = (id, digest = null, manifest = null) =>
      bounded('SELECT identity.connection_authority_cutover($1,0,$2,$3,$4) AS result', [id, operator, digest, manifest])
    const prepare = (id, digest, manifest) =>
      bounded('SELECT identity.connection_prepare_import($1,$2,$3,$4) AS result', [id, digest, manifest, '{}'])
    const inventory = async id => (await db.query('SELECT identity.connection_legacy_inventory($1) AS v', [id])).rows[0].v
    const mode = async id => (await db.query('SELECT authority_mode FROM identity.connection_heads WHERE owner_user_id=$1', [id])).rows[0]?.authority_mode ?? null
    const sorted = rows => [...rows].sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)

    await test('a reinstalled owner switches: removed tombstones are imported and still block, removed live rows are counted', async () => {
      const { owner, home, assistant } = await legacyAccount()
      // Two completed assistant provisions, the earlier agent removed: the live one is the source.
      const earlier = await agent(owner, home, { removed: true })
      await row(assistant, owner, '["github","current"]', home, 2)
      await row(earlier, owner, '["github","current"]', home, 1)
      await row(earlier, owner, '["github","before-reinstall"]', home, 7)
      await row(earlier, owner, '["github","old-live"]', home, 1, false)
      await change(earlier, owner, '["github","old-live"]')
      const source = await inventory(owner)
      assert.equal(source.identityState, 'found'); assert.equal(source.assistantId, assistant)
      assert.equal(source.headRevision, '7', 'an imported tombstone above the control revision raises the head')
      assert.deepEqual(source.removedAssistants, { assistantIds: [earlier], importedTombstones: 1, supersededTombstones: 1,
        excludedRows: 1, excludedOperations: 1 })
      assert.deepEqual(sorted(source.items.map(item => [item.resource_key, item.assistant_user_id, item.deleted_at !== null])), sorted([
        ['["github","before-reinstall"]', earlier, true], ['["github","current"]', assistant, true], [`__collection__:${home}`, assistant, false]]))
      assert.equal(source.operations.length, 0)
      const audited = await auditConnectionInventory(source)
      assert.deepEqual((await prepare(owner, source.databaseDigest, audited.hash)).itemCount, 3)
      const candidate = (await db.query('SELECT identity.connection_prepared_inventory($1) AS v', [owner])).rows[0].v
      assert.equal((await auditConnectionInventory(candidate)).hash, audited.hash, 'the candidate keeps each row and its assistant')
      for (const [label, drift, message] of [
        ['removed tombstone drift', `UPDATE identity.assistant_panel_items SET updated_at=updated_at+interval '1 second'
          WHERE owner_user_id=$1 AND resource_key='["github","before-reinstall"]' AND $2::text IS NOT NULL`, 'Connection source changed after preparation'],
        ['staged tombstone attributed to another assistant', `UPDATE identity.connection_items SET legacy_assistant_user_id=$2
          WHERE owner_user_id=$1 AND resource_key='["github","before-reinstall"]'`, 'Connection candidate differs from its legacy source'],
        ['staged tombstone missing', `DELETE FROM identity.connection_items
          WHERE owner_user_id=$1 AND resource_key='["github","before-reinstall"]' AND $2::text IS NOT NULL`, 'Connection candidate differs from its legacy source'],
      ]) {
        await db.query('SAVEPOINT drift')
        await db.query(drift, [owner, assistant])
        await reject(() => cutover(owner, source.databaseDigest, audited.hash), 'PT409', message)
        assert.equal(await mode(owner), 'legacy', label)
        await db.query('ROLLBACK TO drift; RELEASE drift')
      }
      assert.deepEqual(await cutover(owner, source.databaseDigest, audited.hash), ownerShape)
      assert.deepEqual(sorted((await db.query(`SELECT resource_key,legacy_assistant_user_id,deleted_at IS NOT NULL AS revoked
        FROM identity.connection_items WHERE owner_user_id=$1`, [owner])).rows.map(item => [item.resource_key, item.legacy_assistant_user_id, item.revoked])),
      sorted([['["github","before-reinstall"]', earlier, true], ['["github","current"]', assistant, true], [`__collection__:${home}`, assistant, false]]))
      // The imported revocation blocks a plain re-add exactly like the owner's own tombstones.
      const publisher = await runtime(owner, home)
      await reject(() => rpc(owner, 'connection_commit', '$1,$2,$3,$4,$5,$6,$7,$8,$9', [randomUUID(), `device:${home}`,
        '["github","before-reinstall"]', 7, 'save', { providerId: 'github', accountId: 'before-reinstall', configured: true },
        JSON.stringify({ version: 1, providerId: 'github', accountId: 'before-reinstall' }), home, publisher]),
      'PT409', 'Connection observation cannot clear a revocation')
      // A legacy integration write after the switch has its own errorCode.
      await reject(() => as(owner, () => db.query("SELECT identity.assistant_panel_commit($1,$2,'integrations',$3,0,'save',$4,NULL,NULL,$5,NULL)",
        [assistant, randomUUID(), '["github","late"]', { providerId: 'github', accountId: 'late', configured: true }, home])),
      'PT409', 'Connection authority was switched to owner', 'CONNECTION_AUTHORITY_SWITCHED')
    })

    await test('several live assistants, ambiguous provisions and no live assistant stay legacy', async () => {
      for (const [label, seed] of [
        ['a second live agent with an account row', async ({ owner, home }) => row(await agent(owner, home, { provisioned: false }), owner, '["github","other"]', home, 1)],
        ['a second live agent with an unfinished change', async ({ owner, home }) => change(await agent(owner, home, { provisioned: false }), owner, '["github","other"]')],
      ]) {
        const account = await legacyAccount()
        await seed(account)
        await reject(() => inventory(account.owner), '55000', 'Connection legacy rows belong to several assistants', null)
        assert.equal(await mode(account.owner), null, label)
      }
      const doubled = await legacyAccount()
      await agent(doubled.owner, doubled.home)
      await reject(() => inventory(doubled.owner), '55000', 'Connection legacy identity is ambiguous')
      // Only a removed assistant: nothing importable, and not empty either.
      const orphaned = await human(), home = await device(orphaned), removed = await agent(orphaned, home, { removed: true })
      await row(removed, orphaned, '["github","orphan"]', home, 1)
      const none = await inventory(orphaned)
      assert.deepEqual({ ...none, databaseDigest: null }, { version: 1, complete: true, ownerId: orphaned, identityState: 'none',
        assistantId: null, headRevision: '0', items: [], operations: [], databaseDigest: null,
        removedAssistants: { assistantIds: [], importedTombstones: 0, supersededTombstones: 0, excludedRows: 0, excludedOperations: 0 } })
      await reject(() => cutover(orphaned), '55000', 'Connection legacy data requires an audited preparation')
    })

    await test('expected owner-RPC refusals are PT409 with a stable errorCode', async () => {
      const fresh = await human(), home = await device(fresh), publisher = await runtime(fresh, home)
      const notOwner = ['PT409', 'Connection authority has not been switched to owner', 'CONNECTION_AUTHORITY_NOT_OWNER']
      await reject(() => rpc(fresh, 'connection_recreate_begin', "$1,'platform',NULL,NULL,NULL,'amap',0", [randomUUID()]), ...notOwner)
      await reject(() => rpc(fresh, 'connection_admit', '$1,0,NULL', [publisher]), ...notOwner)
      await reject(() => rpc(fresh, 'connection_pending', '$1', [publisher]), ...notOwner)
      assert.equal(await mode(fresh), null)
      await cutover(fresh)
      assert.deepEqual(await rpc(fresh, 'connection_pending', '$1', [publisher]), { version: 1, revision: '0', changes: [] })
      const quiescing = await human()
      await db.query("INSERT INTO identity.connection_heads(owner_user_id,authority_phase) VALUES($1,'quiescing')", [quiescing])
      await reject(() => rpc(quiescing, 'connection_recreate_begin', "$1,'platform',NULL,NULL,NULL,'amap',0", [randomUUID()]),
        'PT409', 'Connection authority changed or is quiescing', 'CONNECTION_AUTHORITY_QUIESCING')
    })

    await test('unknown outcomes are listed per owner with their repair entry point until resolved', async () => {
      const id = await human(), home = await device(id), publisher = await runtime(id, home)
      const list = async owner => (await db.query('SELECT * FROM identity.connection_unknown_outcomes($1)', [owner])).rows
      await cutover(id)
      const scope = `device:${home}`, key = '["github","unknown"]'
      const revision = async () => (await rpc(id, 'connection_snapshot', 'NULL')).revision
      const saved = await rpc(id, 'connection_commit', '$1,$2,$3,0,$4,$5,$6,$7,$8', [randomUUID(), scope, key, 'save',
        { providerId: 'github', accountId: 'unknown', configured: true }, JSON.stringify({ version: 1, providerId: 'github', accountId: 'unknown' }), home, publisher])
      const removed = await rpc(id, 'connection_commit', "$1,$2,$3,$4,'remove','{}',NULL,$5", [randomUUID(), scope, key, saved.revision, home])
      assert.deepEqual(await list(id), [])
      const started = await rpc(id, 'connection_admit', '$1,$2,$3', [publisher, await revision(), removed.operationId])
      await rpc(id, 'connection_ack', "$1,$2,$3,'CONNECTION_OUTCOME_UNKNOWN',true", [publisher, removed.operationId, started.admissionId])
      const [listed, ...more] = await list(id)
      assert.equal(more.length, 0)
      assert.ok(listed.admitted_at instanceof Date && listed.reported_at instanceof Date && listed.admitted_at <= listed.reported_at)
      assert.deepEqual({ ...listed, admitted_at: null, reported_at: null }, { owner_user_id: id, operation_id: removed.operationId,
        admission_id: started.admissionId, source: 'panel', scope_key: scope, resource_key: key, operation: 'remove',
        admitted_at: null, reported_at: null, repair: 'connection_resolve_unknown_outcome' })
      assert.ok((await list(null)).some(entry => entry.operation_id === removed.operationId))
      // An imported legacy operation found unknown on admission is repaired by the takeover path.
      const imported = await human(), operation = randomUUID()
      await db.query('INSERT INTO identity.connection_heads(owner_user_id) VALUES($1)', [imported])
      await db.query(`INSERT INTO identity.connection_operations(operation_id,owner_user_id,scope_key,resource_key,revision,expected_item_revision,
        operation,source,request_hash,payload,status,error_code,terminal_at,legacy_operation_id)
        VALUES($1,$2,'platform','["amap","legacy"]',(SELECT COALESCE(max(revision),0)+1 FROM identity.connection_operations),0,
          'remove','legacy',repeat('f',64),'{}','failed','CONNECTION_OUTCOME_UNKNOWN',clock_timestamp(),$1)`, [operation, imported])
      assert.deepEqual((await list(imported)).map(entry => [entry.operation_id, entry.admission_id, entry.admitted_at, entry.repair]),
        [[operation, null, null, 'connection_record_takeover']])
      await db.query("SELECT identity.connection_resolve_unknown_outcome($1,$2,'not-started',repeat('b',64),$3)", [id, removed.operationId, operator])
      assert.deepEqual(await list(id), [])
    })
  } finally { await db.query('ROLLBACK') }
  return result
}
