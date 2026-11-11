import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { auditConnectionInventory } from '../../scripts/platform-connection-audit.mjs'
import { connectionLegacyResponseFixture } from './platform-connection-legacy-fixture.mjs'

const ownerRpcs = ['identity.connection_snapshot(text)', 'identity.connection_resource(text,text)',
  'identity.connection_recreate_begin(uuid,text,text,bigint,text,text,bigint)',
  'identity.connection_commit(uuid,text,text,bigint,text,jsonb,text,text,text,uuid)',
  'identity.connection_commit_batch(uuid,uuid,jsonb,text)', 'identity.connection_pending(text)',
  'identity.connection_admit(text,bigint,uuid)', 'identity.connection_ack(text,uuid,uuid,text,boolean)']
const maintenance = ['identity.connection_authority_cutover(text,bigint,text,text)',
  'identity.connection_resolve_unknown_outcome(text,uuid,text,text,text)',
  'identity.connection_has_legacy_data(text)', 'identity.connection_owner_lock(text)']
// Written independently of the migration's anchors: each must occur exactly once.
const readerPatches = [
  ['identity.connection_snapshot(text)', 'native_initialized_at IS NOT NULL INTO', "native_initialized_at IS NOT NULL AND authority_mode = 'owner' INTO"],
  ['identity.connection_resource(text,text)', 'AND native_initialized_at IS NOT NULL;', "AND native_initialized_at IS NOT NULL AND authority_mode = 'owner';"],
  ['identity.connection_pending(text)', 'AND native_initialized_at IS NOT NULL;', "AND native_initialized_at IS NOT NULL AND authority_mode='owner';"],
]
const ownerShape = { version: 1, mode: 'owner', epoch: '1', phase: 'stable', acceptingNewOperations: true }
const bounds = "SET LOCAL statement_timeout='2s'; SET LOCAL lock_timeout='250ms'; SET LOCAL transaction_timeout='2s'"
const unbounded = 'SET LOCAL statement_timeout=0; SET LOCAL lock_timeout=0; SET LOCAL transaction_timeout=0'

/** Installs the cutover release, then exercises it in one transaction that rolls back every fixture row. */
export async function installConnectionCutoverWithEvidence({ db, query, sql, url, test }) {
  const definitions = async () => (await db.query(`SELECT s.signature,p.oid,p.prosrc,p.proowner,p.prosecdef,p.provolatile,p.proconfig
    FROM unnest($1::text[]) s(signature) JOIN pg_proc p ON p.oid=to_regprocedure(s.signature) ORDER BY s.signature`,
  [[...ownerRpcs, 'identity.connection_owner_lock(text)']])).rows
  const legacy = await connectionLegacyResponseFixture(db)
  const { owner: legacyOwner, assistant, device: legacyDevice, instance: legacyRuntime } = legacy.identities
  const controlRevision = (await db.query(`SELECT revision FROM identity.assistant_panel_items
    WHERE assistant_user_id=$1 AND domain='control' AND resource_key='__head__'`, [assistant])).rows[0].revision
  // One tombstone and a ready empty collection: legacy connection data that must be imported, not initialized.
  await db.query(`INSERT INTO identity.assistant_panel_items(assistant_user_id,owner_user_id,domain,resource_key,device_id,revision,data,deleted_at)
    VALUES($1,$2,'integrations','["github","revoked"]',$3,$4,'{}',clock_timestamp()),
      ($1,$2,'integrations','__collection__:' || $3,$3,$4,'{"state":"ready","schemaVersion":1,"itemCount":0}',NULL)`,
  [assistant, legacyOwner, legacyDevice, controlRevision])
  const legacyRows = async () => (await db.query(`SELECT to_jsonb(i) AS row FROM identity.assistant_panel_items i
    WHERE owner_user_id=$1 ORDER BY domain,resource_key`, [legacyOwner])).rows
  const before = await definitions(), responsesBefore = await legacy.capture(), rowsBefore = await legacyRows()
  let result
  try {
    result = await query(sql)
    await test('cutover release patches only owner-authority conditions and keeps OIDs, owners and attributes', async () => {
      const after = await definitions()
      for (const [signature, anchor, replacement] of readerPatches) {
        const old = before.find(row => row.signature === signature), now = after.find(row => row.signature === signature)
        assert.equal(old.prosrc.split(anchor).length, 2, signature)
        assert.equal(now.prosrc, old.prosrc.replace(anchor, replacement), signature)
      }
      for (const old of before) {
        const now = after.find(row => row.signature === old.signature)
        assert.deepEqual({ ...now, prosrc: null }, { ...old, prosrc: null }, old.signature)
      }
    })
    await test('owner RPCs are granted to authenticated only; maintenance helpers stay closed to every API role', async () => {
      const allowed = async (role, signature) => (await db.query("SELECT has_function_privilege($1,$2,'EXECUTE') AS allowed", [role, signature])).rows[0].allowed
      const publicGrant = async signature => (await db.query(`SELECT COALESCE(bool_or(a.grantee=0),false) AS granted
        FROM pg_proc p,aclexplode(p.proacl) a WHERE p.oid=$1::regprocedure`, [signature])).rows[0].granted
      for (const signature of ownerRpcs) {
        assert.equal(await allowed('authenticated', signature), true, signature)
        for (const role of ['anon', 'service_role']) assert.equal(await allowed(role, signature), false, `${role} ${signature}`)
        assert.equal(await publicGrant(signature), false, signature)
      }
      for (const signature of maintenance) {
        for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(await allowed(role, signature), false, `${role} ${signature}`)
        const row = (await db.query('SELECT prosecdef,proconfig FROM pg_proc WHERE oid=$1::regprocedure', [signature])).rows[0]
        assert.deepEqual(row, { prosecdef: false, proconfig: ['search_path=pg_catalog'] }, signature)
      }
      const table = 'identity.connection_unknown_outcome_resolutions'
      assert.equal((await db.query('SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass', [table])).rows[0].relrowsecurity, true)
      for (const role of ['anon', 'authenticated', 'service_role']) {
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
          assert.equal((await db.query('SELECT has_table_privilege($1,$2,$3) AS allowed', [role, table, privilege])).rows[0].allowed, false)
        }
      }
    })

    await db.query('BEGIN')
    try {
      const human = async () => {
        const id = randomUUID()
        await db.query(`INSERT INTO auth.users(id,instance_id,aud,role,email,raw_app_meta_data,raw_user_meta_data,
          confirmation_token,recovery_token,email_change_token_new,email_change,created_at,updated_at)
          VALUES($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,
          '{"provider":"email","providers":["email"]}','{}','','','','',now(),now())`, [id, `${id}@connection-cutover.invalid`])
        await db.query("INSERT INTO identity.users(id,type,display_name) VALUES($1,'human','Connection cutover fixture') ON CONFLICT DO NOTHING", [id])
        return id
      }
      const as = async (user, action, role = 'authenticated') => {
        await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role: 'authenticated' })])
        await db.query(`SET LOCAL ROLE ${role}`)
        const value = await action()
        await db.query('RESET ROLE')
        return value
      }
      const rpc = (user, name, placeholders, values = []) => as(user, async () =>
        (await db.query(`SELECT identity.${name}(${placeholders}) AS result`, values)).rows[0].result)
      const reject = async (action, code) => {
        await db.query('SAVEPOINT cutover_expected_error')
        let error
        try { await action() } catch (caught) { error = caught }
        await db.query('ROLLBACK TO cutover_expected_error; RELEASE cutover_expected_error')
        assert.equal(error?.code, code, error?.message ?? 'expected refusal')
      }
      // The maintenance writer refuses an unbounded caller; bound only this call.
      const bounded = async (statement, values) => {
        await db.query('SAVEPOINT cutover_bounded')
        try {
          await db.query(bounds)
          const rows = (await db.query(statement, values)).rows
          await db.query(unbounded)
          await db.query('RELEASE cutover_bounded')
          return rows[0]?.result
        } catch (error) { await db.query('ROLLBACK TO cutover_bounded; RELEASE cutover_bounded'); throw error }
      }
      const cutover = (id, epoch, digest = null, manifest = null) =>
        bounded('SELECT identity.connection_authority_cutover($1,$2,$3,$4) AS result', [id, epoch, digest, manifest])
      const head = async id => (await db.query(`SELECT authority_mode,authority_epoch::text AS epoch,authority_phase,
        native_initialized_at IS NOT NULL AS initialized,prepared_at IS NOT NULL AS prepared,revision::text AS revision
        FROM identity.connection_heads WHERE owner_user_id=$1`, [id])).rows[0] ?? null
      const events = async id => (await db.query("SELECT payload FROM realtime.messages WHERE topic=$1 AND event='connection_changed'",
        [`gugu:user:${id}:events`])).rows.map(row => row.payload)
      const reader = id => rpc(id, 'connection_authority', '')
      const ownerHead = { authority_mode: 'owner', epoch: '1', authority_phase: 'stable', initialized: true }

      await test('a new account cutover writes owner/1/stable, matches the reader and emits connection_changed', async () => {
        const id = await human()
        assert.equal(await head(id), null)
        await reject(() => db.query('SELECT identity.connection_authority_cutover($1,0)', [id]), '22023')
        assert.deepEqual(await cutover(id, 0), ownerShape)
        assert.deepEqual(await head(id), { ...ownerHead, prepared: false, revision: '0' })
        assert.deepEqual(await reader(id), ownerShape)
        // Realtime delivery adds its own message id to the hint payload.
        const [event, ...more] = await events(id)
        assert.equal(more.length, 0)
        assert.match(event.id, /^[0-9a-f-]{36}$/)
        assert.deepEqual({ ...event, id: undefined }, { id: undefined, revision: '0', scopeKey: null, resourceKey: null, authorityEpoch: '1' })
        const snapshot = await rpc(id, 'connection_snapshot', 'NULL')
        assert.deepEqual(snapshot, { version: 1, state: 'ready', revision: '0', items: [], application: [] })
      })

      await test('a repeated, stale or quiescing cutover is refused without changing the head', async () => {
        const id = await human()
        await reject(() => cutover(id, 1), 'PT409')
        assert.equal(await head(id), null)
        await cutover(id, 0)
        const switched = await head(id)
        await reject(() => cutover(id, 1), 'PT409')
        await reject(() => cutover(id, 0), 'PT409')
        assert.deepEqual(await head(id), switched)
        const quiescing = await human()
        await db.query("INSERT INTO identity.connection_heads(owner_user_id,authority_phase) VALUES($1,'quiescing')", [quiescing])
        await reject(() => cutover(quiescing, 0), 'PT409')
        assert.deepEqual(await reader(quiescing), { version: 1, mode: 'legacy', epoch: '0', phase: 'quiescing', acceptingNewOperations: false })
      })

      await test('the cutover writer waits on the same authority advisory lock as the fence', async () => {
        const id = await human()
        const blocker = new pg.Client({ connectionString: url })
        await blocker.connect()
        try {
          await blocker.query('BEGIN')
          await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended('gugu:connection-authority:' || $1,0))", [id])
          await reject(() => cutover(id, 0), '55P03')
          assert.equal(await head(id), null)
        } finally { await blocker.query('ROLLBACK'); await blocker.end() }
        assert.deepEqual(await cutover(id, 0), ownerShape)
      })

      await test('owner RPCs refuse legacy accounts, and natively initialize only accounts without legacy data', async () => {
        await reject(() => as(legacyOwner, () => db.query('SELECT identity.connection_snapshot(NULL)'), 'anon'), '42501')
        // Legacy data and no head: never initialized empty.
        await reject(() => rpc(legacyOwner, 'connection_recreate_begin', "$1,'platform',NULL,NULL,NULL,'amap',0", [randomUUID()]), '55000')
        assert.equal(await head(legacyOwner), null)
        // A legacy head that was natively initialized before this release.
        const stale = await human()
        await db.query('INSERT INTO identity.connection_heads(owner_user_id,native_initialized_at,revision) VALUES($1,clock_timestamp(),3)', [stale])
        await db.query(`INSERT INTO identity.connection_items(owner_user_id,scope_key,resource_key,revision,data,public_metadata)
          VALUES($1,'platform','["amap","stale"]',3,'{"providerId":"amap","accountId":"stale"}','{"providerId":"amap","accountId":"stale"}')`, [stale])
        assert.deepEqual(await rpc(stale, 'connection_snapshot', 'NULL'), { version: 1, state: 'not-ready', revision: '3', items: null, application: null })
        assert.deepEqual(await rpc(stale, 'connection_resource', '$1,$2', ['platform', '["amap","stale"]']), { version: 1, state: 'not-ready', revision: '0', item: null })
        await reject(() => rpc(stale, 'connection_commit', "$1,'platform','[\"amap\",\"stale\"]',3,'remove','{}'", [randomUUID()]), '55000')
        await reject(() => rpc(stale, 'connection_recreate_begin', "$1,'platform',NULL,NULL,NULL,'amap',3", [randomUUID()]), '55000')
        await reject(() => rpc(stale, 'connection_admit', "'absent-runtime',3,NULL"), '55000')
        // A new account's first owner write initializes it in the cutover shape.
        const fresh = await human()
        const ticket = await rpc(fresh, 'connection_recreate_begin', "$1,'platform',NULL,NULL,NULL,'amap',0", [randomUUID()])
        assert.equal(ticket.revision, '0')
        assert.deepEqual(await head(fresh), { ...ownerHead, prepared: false, revision: '0' })
        assert.deepEqual(await reader(fresh), ownerShape)
        assert.equal((await events(fresh)).length, 1)
        // The cutover writer then refuses: the account is already owner.
        await reject(() => cutover(fresh, 0), 'PT409')
      })

      await test('a legacy account hands over its audited candidate atomically; drift and unfinished effects roll back', async () => {
        const inventory = async () => (await db.query('SELECT identity.connection_legacy_inventory($1) AS v', [legacyOwner])).rows[0].v
        const prepare = (digest, manifest) => bounded('SELECT identity.connection_prepare_import($1,$2,$3,$4) AS result',
          [legacyOwner, digest, manifest, '{}'])
        // Unfinished legacy effects keep the account legacy even after preparation.
        await db.query('SAVEPOINT unfinished')
        await db.query(`INSERT INTO identity.assistant_panel_changes(operation_id,assistant_user_id,owner_user_id,domain,resource_key,
          device_id,source,operation,expected_item_revision,request_hash,payload,status)
          VALUES($1,$2,$3,'integrations','["github","revoked"]',$4,'panel','remove',0,repeat('f',64),'{}','pending')`,
        [randomUUID(), assistant, legacyOwner, legacyDevice])
        const pendingSource = await inventory()
        await prepare(pendingSource.databaseDigest, 'e'.repeat(64))
        await reject(() => cutover(legacyOwner, 0, pendingSource.databaseDigest, 'e'.repeat(64)), '55000')
        await db.query('ROLLBACK TO unfinished; RELEASE unfinished')

        const source = await inventory(), audited = await auditConnectionInventory(source)
        assert.equal(source.identityState, 'found'); assert.equal(source.operations.length, 0)
        await reject(() => cutover(legacyOwner, 0), '55000')
        await reject(() => cutover(legacyOwner, 0, source.databaseDigest, audited.hash), 'PT409')
        const staged = await prepare(source.databaseDigest, audited.hash)
        assert.deepEqual({ ...staged, lockAcquiredAt: null }, { prepared: true, activated: false, itemCount: 2,
          operationCount: 0, sourceDigest: source.databaseDigest, lockAcquiredAt: null })
        const prepared = await head(legacyOwner)
        assert.deepEqual({ ...prepared, revision: null }, { authority_mode: 'legacy', epoch: '0', authority_phase: 'stable',
          initialized: false, prepared: true, revision: null })
        // A prepared candidate is still legacy to every owner RPC.
        assert.equal((await rpc(legacyOwner, 'connection_snapshot', 'NULL')).state, 'not-ready')
        await reject(() => rpc(legacyOwner, 'connection_pending', '$1', [legacyRuntime]), '55000')
        await reject(() => rpc(legacyOwner, 'connection_commit', "$1,$2,'[\"github\",\"revoked\"]',$3,'remove','{}',NULL,$4",
          [randomUUID(), `device:${legacyDevice}`, controlRevision, legacyDevice]), '55000')
        for (const [label, drift] of [
          ['legacy source drift', `UPDATE identity.assistant_panel_items SET updated_at=updated_at+interval '1 second'
            WHERE owner_user_id=$1 AND domain='integrations' AND resource_key='["github","revoked"]'`],
          ['staged candidate drift', `UPDATE identity.connection_items SET data='{"providerId":"github"}'
            WHERE owner_user_id=$1 AND resource_key='["github","revoked"]'`],
        ]) {
          await db.query('SAVEPOINT drift')
          await db.query(drift, [legacyOwner])
          await reject(() => cutover(legacyOwner, 0, source.databaseDigest, audited.hash), 'PT409')
          assert.deepEqual(await head(legacyOwner), prepared, label)
          await db.query('ROLLBACK TO drift; RELEASE drift')
        }
        await reject(() => cutover(legacyOwner, 1, source.databaseDigest, audited.hash), 'PT409')
        await reject(() => cutover(legacyOwner, 0, source.databaseDigest, 'd'.repeat(64)), 'PT409')
        assert.deepEqual(await events(legacyOwner), [])

        assert.deepEqual(await cutover(legacyOwner, 0, source.databaseDigest, audited.hash), ownerShape)
        assert.deepEqual(await head(legacyOwner), { ...ownerHead, prepared: true, revision: prepared.revision })
        assert.deepEqual(await reader(legacyOwner), ownerShape)
        assert.equal((await events(legacyOwner)).length, 1)
        await reject(() => cutover(legacyOwner, 1, source.databaseDigest, audited.hash), 'PT409')
        const snapshot = await rpc(legacyOwner, 'connection_snapshot', 'NULL')
        assert.equal(snapshot.state, 'ready')
        assert.deepEqual(snapshot.items.map(item => [item.resourceKey, item.deletedAt !== null]).sort(),
          [['["github","revoked"]', true], [`__collection__:${legacyDevice}`, false]])
        // Nothing legacy is rewritten; other panel domains keep exact bytes.
        assert.deepEqual(await legacyRows(), rowsBefore)
        const responses = await legacy.capture()
        for (const name of Object.keys(responsesBefore)) assert.deepEqual(Buffer.from(responses[name]), Buffer.from(responsesBefore[name]), name)
        const legacyCommit = (domain, key, data) => as(legacyOwner, () => db.query(
          "SELECT identity.assistant_panel_commit($1,$2,$3,$4,0,'save',$5,NULL,NULL,$6,NULL)", [assistant, randomUUID(), domain, key, data, legacyDevice]))
        await reject(() => legacyCommit('integrations', '["github","fresh"]', { providerId: 'github', accountId: 'fresh', configured: true }), 'PT409')
        await db.query('SAVEPOINT other_domain')
        await legacyCommit('personality', 'profile-2', { text: 'unchanged' })
        await db.query('ROLLBACK TO other_domain; RELEASE other_domain')
        assert.deepEqual(await legacyRows(), rowsBefore)
      })

      await test('an operator resolves a post-cutover unknown outcome by its original UUID, once, with recorded evidence', async () => {
        const id = await human(), device = `cutover-${randomUUID()}`, runtime = randomUUID()
        await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'fixture','fixture','linux')", [device, id])
        await db.query('INSERT INTO identity.runtime_instances(instance_id,device_id,owner_user_id) VALUES($1,$2,$3)', [runtime, device, id])
        const resolve = (operation, outcome, evidence = 'b'.repeat(64), code = null) => db.query(
          'SELECT identity.connection_resolve_unknown_outcome($1,$2,$3,$4,$5) AS result', [id, operation, outcome, evidence, code]).then(r => r.rows[0].result)
        await reject(() => resolve(randomUUID(), 'applied'), '55000')
        await cutover(id, 0)
        const scope = `device:${device}`
        const revision = async () => (await rpc(id, 'connection_snapshot', 'NULL')).revision
        const unknown = async account => {
          const key = JSON.stringify(['github', account])
          const saved = await rpc(id, 'connection_commit', '$1,$2,$3,0,$4,$5,$6,$7,$8', [randomUUID(), scope, key, 'save',
            { providerId: 'github', accountId: account, configured: true }, JSON.stringify({ version: 1, providerId: 'github', accountId: account }), device, runtime])
          const removed = await rpc(id, 'connection_commit', "$1,$2,$3,$4,'remove','{}',NULL,$5", [randomUUID(), scope, key, saved.revision, device])
          const started = await rpc(id, 'connection_admit', '$1,$2,$3', [runtime, await revision(), removed.operationId])
          assert.equal(started.admitted, true)
          await rpc(id, 'connection_ack', "$1,$2,$3,'CONNECTION_OUTCOME_UNKNOWN',true", [runtime, removed.operationId, started.admissionId])
          return { operation: removed.operationId, admission: started.admissionId }
        }
        const barrier = async () => rpc(id, 'connection_admit', '$1,$2,NULL', [runtime, await revision()])
        const receipt = async admission => (await db.query('SELECT receipt FROM identity.connection_admissions WHERE admission_id=$1', [admission])).rows[0].receipt
        const operation = async operationId => (await db.query(`SELECT status,error_code,terminal_at IS NOT NULL AS terminal
          FROM identity.connection_operations WHERE operation_id=$1`, [operationId])).rows[0]

        const retried = await unknown('retried'), original = await receipt(retried.admission)
        assert.equal((await barrier()).errorCode, 'CONNECTION_OUTCOME_UNKNOWN')
        for (const [outcome, evidence, code] of [['unknown', 'b'.repeat(64), null], ['failed', 'b'.repeat(64), null],
          ['applied', 'short', null], ['applied', 'b'.repeat(64), 'CONNECTION_X'], ['failed', 'b'.repeat(64), 'CONNECTION_OUTCOME_UNKNOWN']]) {
          await reject(() => resolve(retried.operation, outcome, evidence, code), '22023')
        }
        await reject(() => resolve(randomUUID(), 'applied'), '42501')
        const resolved = await resolve(retried.operation, 'not-started')
        assert.deepEqual({ ...resolved, recordedAt: null }, { operationId: retried.operation, admissionId: retried.admission,
          outcome: 'not-started', errorCode: null, recordedAt: null })
        assert.deepEqual(await resolve(retried.operation, 'not-started'), resolved)
        await reject(() => resolve(retried.operation, 'applied'), 'PT409')
        assert.deepEqual(await operation(retried.operation), { status: 'pending', error_code: null, terminal: false })
        assert.deepEqual(await receipt(retried.admission), original)
        const again = await rpc(id, 'connection_admit', '$1,$2,$3', [runtime, await revision(), retried.operation])
        assert.equal(again.admitted, true); assert.notEqual(again.admissionId, retried.admission)
        assert.equal((await rpc(id, 'connection_ack', '$1,$2,$3', [runtime, retried.operation, again.admissionId])).status, 'applied')

        const applied = await unknown('applied')
        await resolve(applied.operation, 'applied', 'c'.repeat(64))
        assert.deepEqual(await operation(applied.operation), { status: 'applied', error_code: null, terminal: false })
        const failed = await unknown('failed')
        await resolve(failed.operation, 'failed', 'd'.repeat(64), 'CONNECTION_PROVIDER_REFUSED')
        assert.deepEqual(await operation(failed.operation), { status: 'failed', error_code: 'CONNECTION_PROVIDER_REFUSED', terminal: true })
        assert.equal((await barrier()).admitted, true)
        assert.deepEqual((await db.query(`SELECT outcome,recorded_by FROM identity.connection_unknown_outcome_resolutions
          WHERE owner_user_id=$1 ORDER BY outcome`, [id])).rows.map(row => [row.outcome, row.recorded_by]),
        [['applied', 'postgres'], ['failed', 'postgres'], ['not-started', 'postgres']])
        await reject(() => as(id, () => db.query("SELECT identity.connection_resolve_unknown_outcome($1,$2,'applied',repeat('b',64))", [id, applied.operation])), '42501')
      })
    } finally { await db.query('ROLLBACK') }
  } catch (error) { await db.query('ROLLBACK'); throw error } finally { await legacy.cleanup() }
  return result
}
