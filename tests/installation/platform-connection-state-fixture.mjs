import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { connectionLegacyResponseFixture } from './platform-connection-legacy-fixture.mjs'

const baseline = JSON.parse(await readFile(new URL('../../ops/platform-connections/legacy-functions.json', import.meta.url), 'utf8'))

async function legacyState(db) {
  const functions = (await db.query(`SELECT s.signature,p.oid,pg_get_functiondef(p.oid) AS definition,
    p.proacl::text AS acl,p.proowner,
    jsonb_build_object('prosecdef',p.prosecdef,'provolatile',p.provolatile,'proisstrict',p.proisstrict,
      'proparallel',p.proparallel,'proconfig',to_jsonb(p.proconfig),'prorettype',p.prorettype,
      'proargtypes',p.proargtypes::text,'prokind',p.prokind,'proleakproof',p.proleakproof) AS attributes
    FROM unnest($1::text[]) WITH ORDINALITY s(signature,n)
    JOIN pg_proc p ON p.oid=to_regprocedure(s.signature) ORDER BY s.n`, [baseline.functions.map(row => row.signature)])).rows
  const tables = (await db.query(`SELECT c.oid,c.relname,c.relacl::text AS acl,c.relrowsecurity,c.relforcerowsecurity,
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY p.policyname) FROM pg_policies p
      WHERE p.schemaname='identity' AND p.tablename=c.relname) AS policies
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='identity' AND c.relname IN ('assistant_panel_items','assistant_panel_changes') ORDER BY c.relname`)).rows
  return { functions, tables }
}

async function denied(db, action) {
  await db.query('SAVEPOINT expected_connection_denial')
  try { await assert.rejects(action(), error => error.code === '42501') }
  finally { await db.query('ROLLBACK TO SAVEPOINT expected_connection_denial') }
}

export async function installConnectionStateWithEvidence({ db, query, sql, release, test }) {
  const before = await legacyState(db)
  await test('connection migration refuses an installed function that drifted without changing any old object', async () => {
    await db.query('BEGIN')
    try {
      const source = before.functions[0].definition
      const changed = source.replace('BEGIN\n', 'BEGIN\n    -- Deliberate isolated drift fixture.\n')
      assert.notEqual(changed, source)
      await db.query(changed)
      await assert.rejects(db.query(release.sql), /predecessor differs from the reviewed source/)
    } finally { await db.query('ROLLBACK') }
    assert.deepEqual(await legacyState(db), before)
    assert.equal((await db.query("SELECT to_regclass('identity.connection_heads') AS relation")).rows[0].relation, null)
  })

  const fixture = await connectionLegacyResponseFixture(db)
  const responseBefore = await fixture.capture()
  let result
  try {
    result = await query(sql)
    await test('connection preparation preserves exact non-integration response bytes and admission revision semantics', async () => {
      const after = await fixture.capture()
      for (const name of Object.keys(responseBefore)) assert.deepEqual(Buffer.from(after[name]), Buffer.from(responseBefore[name]))
      assert.equal(JSON.parse(after.admission).admitted, false)
      assert.equal(JSON.parse(after.admission).domain, 'personality')
    })
  } finally { await fixture.cleanup() }
  await test('connection evidence keeps exact legacy definition bytes, OIDs, ACLs, owners and attributes', async () => {
    assert.deepEqual(await legacyState(db), before)
    const records = (await db.query(`SELECT signature,original_oid,definition,original_acl::text AS acl,
      original_owner,original_attributes,
      definition_sha256=encode(sha256(convert_to(definition,'UTF8')),'hex') AS hash_matches
      FROM identity.connection_legacy_functions`)).rows
    assert.equal(records.length, before.functions.length)
    for (const original of before.functions) {
      const stored = records.find(row => row.signature === original.signature)
      assert.ok(stored)
      assert.deepEqual(Buffer.from(stored.definition, 'utf8'), Buffer.from(original.definition, 'utf8'))
      assert.equal(stored.original_oid, original.oid)
      assert.equal(stored.acl, original.acl)
      assert.equal(stored.original_owner, original.proowner)
      assert.deepEqual(stored.original_attributes, original.attributes)
      assert.equal(stored.hash_matches, true)
    }
  })

  await test('connection storage isolates owners and exposes no direct writes or maintenance definitions', async () => {
    await db.query('BEGIN')
    try {
      const owner = randomUUID(), stranger = randomUUID()
      for (const id of [owner,stranger]) await db.query("INSERT INTO identity.users(id,type,display_name) VALUES($1,'human','Connection RLS fixture')", [id])
      await db.query('INSERT INTO identity.connection_heads(owner_user_id) VALUES($1)', [owner])
      await db.query(`INSERT INTO identity.connection_items(owner_user_id,scope_key,resource_key,device_id,revision,data)
        VALUES($1,'device-fixture','fixture','device-fixture',1,'{"providerId":"fixture","accountId":"fixture"}')`, [owner])
      await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: owner, role: 'authenticated' })])
      await db.query('SET LOCAL ROLE authenticated')
      assert.equal((await db.query('SELECT count(*)::int AS n FROM identity.connection_items')).rows[0].n, 1)
      await denied(db, () => db.query("UPDATE identity.connection_items SET data='{}'"))
      await denied(db, () => db.query('SELECT definition FROM identity.connection_legacy_functions'))
      await db.query('RESET ROLE')
      await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: stranger, role: 'authenticated' })])
      await db.query('SET LOCAL ROLE authenticated')
      assert.equal((await db.query('SELECT count(*)::int AS n FROM identity.connection_heads')).rows[0].n, 0)
      assert.equal((await db.query('SELECT count(*)::int AS n FROM identity.connection_items')).rows[0].n, 0)
      await db.query('RESET ROLE')
      await db.query('SET LOCAL ROLE anon')
      await denied(db, () => db.query('SELECT * FROM identity.connection_items'))
    } finally { await db.query('ROLLBACK') }
  })
  await test('connection rollback executes original text and restores exact ACLs after isolated drift', async () => {
    const original = before.functions[0]
    await db.query(original.definition.replace('BEGIN\n', 'BEGIN\n    -- Isolated restoration fixture.\n'))
    await db.query(`GRANT EXECUTE ON FUNCTION ${original.signature} TO service_role`)
    assert.notDeepEqual(await legacyState(db), before)
    await query(await readFile(new URL('../../ops/restore-platform-connection-functions.sql', import.meta.url), 'utf8'))
    assert.deepEqual(await legacyState(db), before)
  })
  return result
}
