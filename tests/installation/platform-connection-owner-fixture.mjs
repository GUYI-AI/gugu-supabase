import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

// The caller owns the disposable database and surrounding transaction. Fixture
// grants, users and effect receipts are rolled back together by that caller.
export async function assertOwnerConnectionRuntime(db, test) {
  const owner = randomUUID(), other = randomUUID(), device = `owner-${randomUUID()}`, foreign = `owner-${randomUUID()}`
  const runtime = randomUUID(), replacement = randomUUID(), foreignRuntime = randomUUID(), secondRuntime = randomUUID(), secondDevice = `owner-${randomUUID()}`
  const api = ['connection_snapshot(text)','connection_resource(text,text)',
    'connection_commit(uuid,text,text,bigint,text,jsonb,text,text,text,uuid)','connection_pending(text)',
    'connection_admit(text,bigint,uuid)','connection_ack(text,uuid,uuid,text,boolean)',
    'connection_recreate_begin(uuid,text,text,bigint,text,text,bigint)','connection_commit_batch(uuid,uuid,jsonb,text)']
  for (const signature of api) {
    assert.equal((await db.query('SELECT has_function_privilege(\'authenticated\',$1,\'EXECUTE\') AS allowed', [`identity.${signature}`])).rows[0].allowed, false)
    await db.query(`GRANT EXECUTE ON FUNCTION identity.${signature} TO authenticated`)
  }
  for (const id of [owner, other]) {
    await db.query(`INSERT INTO auth.users(id,instance_id,aud,role,email,raw_app_meta_data,raw_user_meta_data,
      confirmation_token,recovery_token,email_change_token_new,email_change,created_at,updated_at)
      VALUES($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,
      '{"provider":"email","providers":["email"]}','{}','','','','',now(),now())`, [id, `${id}@owner-connection.invalid`])
    await db.query("INSERT INTO identity.users(id,type,display_name) VALUES($1,'human','Owner connection fixture') ON CONFLICT DO NOTHING", [id])
  }
  for (const [id, user] of [[device, owner], [secondDevice, owner], [foreign, other]]) {
    await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'fixture','fixture','linux')", [id, user])
  }
  for (const [instance, target, user] of [[runtime, device, owner], [replacement, device, owner], [secondRuntime, secondDevice, owner], [foreignRuntime, foreign, other]]) {
    await db.query('INSERT INTO identity.runtime_instances(instance_id,device_id,owner_user_id) VALUES($1,$2,$3)', [instance, target, user])
  }
  async function as(user, action) {
    await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role: 'authenticated' })])
    await db.query('SET LOCAL ROLE authenticated')
    const result = await action()
    await db.query('RESET ROLE')
    return result
  }
  const rpc = async (name, placeholders, values, user = owner) => as(user, async () =>
    (await db.query(`SELECT identity.${name}(${placeholders}) AS result`, values)).rows[0].result)
  async function reject(action, code) {
    await db.query('SAVEPOINT connection_expected_error')
    let error
    try { await action() } catch (caught) { error = caught }
    await db.query('ROLLBACK TO connection_expected_error; RELEASE connection_expected_error')
    assert.equal(error?.code, code, error?.message ?? 'expected refusal')
  }
  const scope = `device:${device}`
  const key = account => JSON.stringify(['github', account])
  const document = account => JSON.stringify({ version: 1, providerId: 'github', accountId: account, displayName: account })
  const head = async () => (await rpc('connection_snapshot', 'NULL', [])).revision
  const commit = (account, revision = '0', operation = 'save', options = {}) => rpc('connection_commit', '$1,$2,$3,$4,$5,$6,$7,$8,$9,$10',
    [options.id ?? randomUUID(), options.scope ?? scope, options.key === undefined ? key(account) : options.key, revision, operation,
      options.data ?? { providerId: 'github', accountId: account, configured: true }, options.document === undefined ? (operation === 'save' ? document(account) : null) : options.document,
      options.scope === 'platform' ? null : device, options.runtime === undefined ? runtime : options.runtime, options.intent ?? null])
  const intent = (id, resource, revision, provider = null, startHead = null) => rpc('connection_recreate_begin', '$1,$2,$3,$4,$5,$6,$7',
    [id, scope, resource, revision, device, provider, startHead])
  const admit = (id, revision, instance = runtime) => rpc('connection_admit', '$1,$2,$3', [instance, revision, id])
  const ack = (id, admission, error = null, terminal = false, instance = runtime) => rpc('connection_ack', '$1,$2,$3,$4,$5', [instance, id, admission, error, terminal])

  await test('owner service initializes without an assistant and isolates owner metadata', async () => {
    assert.deepEqual(await rpc('connection_snapshot', 'NULL', []), { version: 1, state: 'not-ready', revision: '0', items: null, application: null })
    const saved = await commit('first')
    const marker = `__collection__:${device}`
    await commit(null, '0', 'prepared', { key: marker, data: { state: 'ready', schemaVersion: 1, itemCount: 1 }, document: null })
    const snapshot = await rpc('connection_snapshot', '$1', [device])
    assert.equal(snapshot.state, 'ready')
    assert.equal(snapshot.items.find(item => item.resourceKey === key('first')).publicMetadata.accountId, 'first')
    assert.equal((await rpc('connection_resource', '$1,$2', [scope, key('first')], other)).item, null)
    assert.equal((await db.query("SELECT count(*)::int AS n FROM identity.users WHERE owner_user_id=$1 AND type='agent'", [owner])).rows[0].n, 0)
    await reject(() => commit('wrong-runtime', '0', 'save', { runtime: foreignRuntime }), '42501')
    await reject(() => rpc('connection_snapshot', '$1', [foreign]), '42501')
    assert.equal(saved.status, 'applied')
  })

  await test('offline default selection is a restricted existing-account intent rather than account publication', async () => {
    const saved = await commit('default-choice')
    const selected = await commit('default-choice',saved.revision,'save',{runtime:null,document:null,
      data:{providerId:'github',accountId:'default-choice',isDefault:true}})
    assert.equal(selected.status,'pending')
    const item = (await rpc('connection_resource','$1,$2',[scope,key('default-choice')])).item
    assert.equal(item.data.isDefault,true); assert.equal(item.data.configured,true)
    assert.equal(item.document,document('default-choice'))
    assert.equal((await admit(selected.operationId,await head())).admitted,true)
    await reject(() => commit('new-default-owner','0','save',{runtime:null,document:null,
      data:{providerId:'github',accountId:'new-default-owner',isDefault:true}}),'42501')
    await reject(() => commit('default-choice',selected.revision,'save',{runtime:null,document:null,
      data:{providerId:'github',accountId:'default-choice',isDefault:true,configured:false}}),'42501')
  })

  await test('revocation tombstones reject observations and require a fenced explicit recreation', async () => {
    const saved = await commit('revoked')
    const removed = await commit('revoked', saved.revision, 'remove', { runtime: null })
    await reject(() => commit('revoked', removed.revision), 'PT409')
    await reject(() => commit('revoked', removed.revision, 'enable', { runtime: null }), 'PT409')
    const id = randomUUID(), ticket = await intent(id, key('revoked'), removed.revision)
    const recreated = await commit('revoked', removed.revision, 'save', { id, intent: ticket.recreationId })
    const preserved = await commit('revoked', recreated.revision, 'save', { document: null })
    assert.equal((await rpc('connection_resource', '$1,$2', [scope, key('revoked')])).item.document, document('revoked'))
    const staleId = randomUUID(), stale = await intent(staleId, key('revoked'), preserved.revision)
    await commit('revoked', preserved.revision, 'remove', { runtime: null })
    await reject(() => commit('revoked', preserved.revision, 'save', { id: staleId, intent: stale.recreationId }), 'PT409')
  })

  await test('per-operation admission persists starts, acknowledges once and preserves unknown outcomes', async () => {
    const saved = await commit('execute'), removed = await commit('execute', saved.revision, 'remove', { runtime: null })
    await reject(() => admit(removed.operationId, '0'), 'PT409')
    const started = await admit(removed.operationId, await head())
    assert.equal(started.admitted, true)
    assert.equal((await admit(removed.operationId, await head())).reason, 'already-started')
    const pending = await rpc('connection_pending', '$1', [runtime])
    assert.equal(pending.changes.find(change => change.operationId === removed.operationId).status, 'started')
    assert.match(started.requestHash, /^[0-9a-f]{64}$/)
    const failed = await ack(removed.operationId, started.admissionId, 'CONNECTION_NOT_STARTED')
    assert.deepEqual(await ack(removed.operationId, started.admissionId, 'CONNECTION_NOT_STARTED'), failed)
    const retry = await admit(removed.operationId, await head())
    assert.equal(retry.admitted, true)
    assert.notEqual(retry.admissionId, started.admissionId)
    const unknown = await ack(removed.operationId, retry.admissionId, 'CONNECTION_OUTCOME_UNKNOWN', true)
    assert.equal(unknown.terminal, true)
    assert.equal((await admit(removed.operationId, await head())).reason, 'outcome-unknown')
    const taskBarrier = await admit(null,await head())
    assert.equal(taskBarrier.admitted,false); assert.equal(taskBarrier.errorCode,'CONNECTION_OUTCOME_UNKNOWN')
    await reject(() => ack(removed.operationId, retry.admissionId), 'PT409')
  })

  await test('replacement runtimes resend durable receipts without changing newer item state', async () => {
    const saved = await commit('replace'), disabled = await commit('replace', saved.revision, 'disable', { runtime: null })
    const started = await admit(disabled.operationId, await head())
    const removed = await commit('replace', disabled.revision, 'remove', { runtime: null })
    const receipt = await ack(disabled.operationId, started.admissionId, null, false, replacement)
    assert.deepEqual(await ack(disabled.operationId, started.admissionId, null, false, replacement), receipt)
    const item = (await rpc('connection_resource', '$1,$2', [scope, key('replace')])).item
    assert.equal(item.revision, removed.revision)
    assert.ok(item.deletedAt)
    assert.equal(item.document, null)
  })

  await test('provider batches resolve unknown account keys atomically and replay their original receipts', async () => {
    const id = randomUUID(), ticket = await intent(id, null, null, 'github', await head())
    const entries = ['batch-one', 'batch-two'].map(account => ({ operationId: randomUUID(), data: { providerId: 'github', accountId: account, configured: true }, document: document(account) }))
    const apply = entries => rpc('connection_commit_batch', '$1,$2,$3,$4', [id, ticket.recreationId, JSON.stringify(entries), runtime])
    const bad = entries.map((entry, index) => index ? { ...entry, document: '{}' } : entry)
    await reject(() => apply(bad), '22023')
    assert.equal((await rpc('connection_resource', '$1,$2', [scope, key('batch-one')])).item, null)
    const receipt = await apply(entries)
    assert.equal(receipt.receipts.length, 2)
    assert.deepEqual(await apply(entries), receipt)
    assert.ok(receipt.receipts.every(item => item.scopeKey === scope && JSON.parse(item.resourceKey)[0] === 'github'))
    await reject(() => apply(entries.slice(0, 1)), 'PT409')
    const staleId = randomUUID(), stale = await intent(staleId, null, null, 'github', await head())
    await reject(() => commit('intervening'), 'PT409')
    const marker = (await rpc('connection_resource', '$1,$2', [scope, `__collection__:${device}`])).item
    await commit(null, marker.revision, 'prepared', { key: marker.resourceKey, data: { state: 'ready', schemaVersion: 1, itemCount: 7 }, document: null })
    await reject(() => commit('late-provider', null, 'save', { id: staleId, key: null, intent: stale.recreationId }), 'PT409')
    const freshId = randomUUID(), fresh = await intent(freshId, null, null, 'github', await head())
    await commit('explicit-reconciliation', null, 'save', { id: freshId, key: null, intent: fresh.recreationId })
  })

  await test('runtime execution cannot claim platform revocation or replay a foreign operation', async () => {
    const saved = await commit('platform', '0', 'save', { scope: 'platform', runtime: null })
    const removed = await commit('platform', saved.revision, 'remove', { scope: 'platform', runtime: null })
    await reject(async () => admit(removed.operationId, await head()), '42501')
    assert.ok(!(await rpc('connection_pending', '$1', [runtime])).changes.some(change => change.operationId === removed.operationId))
    await reject(async () => admit(randomUUID(), await head()), '42501')
    await reject(() => as(other, () => db.query('SELECT identity.connection_admit($1,$2,$3)', [foreignRuntime, '0', removed.operationId])), '42501')
    await reject(() => as(owner, () => db.query('DELETE FROM identity.connection_items WHERE owner_user_id=$1', [owner])), '42501')
  })

  await test('unresolved provider intent fences observations from every device, including after expiry', async () => {
    const id = randomUUID(), ticket = await rpc('connection_recreate_begin', '$1,$2,NULL,NULL,NULL,$3,$4', [id, 'platform', 'github', await head()])
    await reject(() => commit('cross-device-race', '0', 'save', { scope: 'platform', runtime: secondRuntime }), 'PT409')
    await db.query("UPDATE identity.connection_recreation_intents SET expires_at=clock_timestamp()-interval '1 second' WHERE recreation_id=$1", [ticket.recreationId])
    await reject(() => commit('expired-race', '0', 'save', { scope: 'platform', runtime: secondRuntime }), 'PT409')
    const freshId = randomUUID(), fresh = await rpc('connection_recreate_begin', '$1,$2,NULL,NULL,NULL,$3,$4', [freshId, 'platform', 'github', await head()])
    await commit('explicit-platform', null, 'save', { id: freshId, key: null, scope: 'platform', runtime: null, intent: fresh.recreationId })
    assert.equal((await commit('after-explicit', '0', 'save', { scope: 'platform', runtime: secondRuntime })).status, 'applied')
  })

  await test('unresolved imported operations remain terminal and cannot be replayed as new work', async () => {
    const saved = await commit('imported'), removed = await commit('imported', saved.revision, 'remove', { runtime: null })
    await db.query("UPDATE identity.connection_operations SET source='legacy',legacy_operation_id=operation_id WHERE operation_id=$1", [removed.operationId])
    assert.equal((await admit(removed.operationId, await head())).reason, 'outcome-unknown')
    assert.equal((await db.query('SELECT count(*)::int AS n FROM identity.connection_admissions WHERE operation_id=$1', [removed.operationId])).rows[0].n, 0)
  })

  await test('maintenance takeover requires a matching manifest, offline executor and immutable outcome evidence', async () => {
    const saved = await commit('takeover'), removed = await commit('takeover', saved.revision, 'remove', { runtime: null })
    await db.query("UPDATE identity.connection_operations SET source='legacy',legacy_operation_id=operation_id WHERE operation_id=$1", [removed.operationId])
    await db.query("UPDATE identity.connection_heads SET manifest_hash=repeat('a',64) WHERE owner_user_id=$1", [owner])
    const hash = (await db.query('SELECT request_hash FROM identity.connection_operations WHERE operation_id=$1', [removed.operationId])).rows[0].request_hash
    const record = (manifest = 'a'.repeat(64), evidence = 'b'.repeat(64)) => db.query('SELECT identity.connection_record_takeover($1,$2,$3,$4,$5,$6)',
      [owner, removed.operationId, manifest, hash, evidence, 'not-started'])
    await reject(() => record('c'.repeat(64)), 'PT409')
    await reject(() => record(), '55000')
    await db.query("UPDATE identity.runtime_instances SET last_heartbeat_at=clock_timestamp()-interval '2 minutes' WHERE owner_user_id=$1", [owner])
    await record(); await record()
    await reject(() => record('a'.repeat(64), 'c'.repeat(64)), 'PT409')
    await db.query('UPDATE identity.runtime_instances SET last_heartbeat_at=clock_timestamp() WHERE instance_id=$1', [runtime])
    assert.equal((await admit(removed.operationId, await head())).admitted, true)
  })

  await test('a single commit UUID cannot be reused as a provider batch identity', async () => {
    const id = randomUUID()
    await commit('single-identity', '0', 'save', { id })
    await reject(async () => {
      const ticket = await intent(id, null, null, 'github', await head())
      await rpc('connection_commit_batch', '$1,$2,$3,$4', [id,ticket.recreationId,
        JSON.stringify([{ operationId:randomUUID(),data:{providerId:'github',accountId:'cross-entry-batch',configured:true},document:document('cross-entry-batch') }]),runtime])
    }, 'PT409')
  })

  await test('a provider batch UUID cannot be reused by single commit or another account owner', async () => {
    const id = randomUUID(), ticket = await intent(id, null, null, 'github', await head())
    await rpc('connection_commit_batch', '$1,$2,$3,$4', [id,ticket.recreationId,
      JSON.stringify([{ operationId:randomUUID(),data:{providerId:'github',accountId:'batch-identity',configured:true},document:document('batch-identity') }]),runtime])
    await reject(() => commit('cross-entry-single', '0', 'save', { id }), 'PT409')
    await reject(() => rpc('connection_commit', '$1,$2,$3,$4,$5,$6,$7', [id,'platform',key('foreign-uuid'),'0','save',
      {providerId:'github',accountId:'foreign-uuid',configured:true},document('foreign-uuid')],other), '42501')
  })

  await test('one operation UUID cannot publish a second account even through the same entry point', async () => {
    const id = randomUUID()
    await commit('same-entry-first', '0', 'save', { id })
    await reject(() => commit('same-entry-second', '0', 'save', { id }), 'PT409')
  })

  await test('first platform authorization needs no host and prepared candidates never become ready from collection markers', async () => {
    await db.query('DELETE FROM identity.runtime_instances WHERE owner_user_id=$1', [other])
    await db.query('DELETE FROM identity.gugu_devices WHERE user_id=$1', [other])
    const id = randomUUID()
    const ticket = await rpc('connection_recreate_begin', '$1,$2,NULL,NULL,NULL,$3,$4', [id, 'platform', 'amap', '0'], other)
    assert.equal((await rpc('connection_snapshot', 'NULL', [], other)).state, 'ready')
    const data = { providerId: 'amap', accountId: 'default', configured: true }
    const receipt = await rpc('connection_commit', '$1,$2,NULL,NULL,$3,$4,$5,NULL,NULL,$6',
      [id, 'platform', 'save', data, JSON.stringify({ version: 1, ...data, configured: undefined }), ticket.recreationId], other)
    assert.equal((await rpc('connection_snapshot', 'NULL', [], other)).items.length, 1)
    await db.query('UPDATE identity.connection_heads SET native_initialized_at=NULL,prepared_at=clock_timestamp() WHERE owner_user_id=$1', [other])
    const snapshot = await rpc('connection_snapshot', 'NULL', [], other)
    assert.equal(snapshot.state, 'not-ready'); assert.equal(snapshot.items, null); assert.equal(snapshot.application, null)
    assert.equal((await rpc('connection_resource', '$1,$2', ['platform', receipt.resourceKey], other)).item, null)
    await reject(() => rpc('connection_recreate_begin', '$1,$2,$3,$4,NULL,NULL,NULL', [randomUUID(), 'platform', receipt.resourceKey, receipt.revision], other), '55000')
  })

  await test('owner deletion removes its new metadata and receipts without orphaning another account', async () => {
    await db.query('DELETE FROM auth.users WHERE id=$1', [owner])
    assert.equal((await db.query('SELECT count(*)::int AS n FROM identity.connection_heads WHERE owner_user_id=$1', [owner])).rows[0].n,0)
    assert.equal((await db.query('SELECT count(*)::int AS n FROM identity.connection_admissions WHERE owner_user_id=$1', [owner])).rows[0].n,0)
    assert.equal((await db.query('SELECT count(*)::int AS n FROM identity.connection_heads WHERE owner_user_id=$1', [other])).rows[0].n,1)
  })
}
