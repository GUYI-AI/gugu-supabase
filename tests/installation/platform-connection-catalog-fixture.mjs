import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { auditConnectionInventory } from '../../scripts/platform-connection-audit.mjs'

const validate = 'identity.assistant_panel_validate(text,text,jsonb)'
// Each anchor must occur exactly once; only that span may change, and it must
// carry the new behavior (written independently of the migration's text).
const patches = [
  ["'checkResult','checkedAt','permission','enabled']", ["'enabled','catalog']"]],
  ["AND e.key NOT IN ('assistantSessionIds','sourceLinks','lastRun')) THEN", ["'lastRun','catalog')"]],
  ["    IF p_data ? 'enabled' AND jsonb_typeof(p_data->'enabled') <> 'boolean' THEN",
    ["starts_with(p_key,'catalog:')", "('categoryId','aliases')", "'Panel catalog must be a provider directory category with search aliases'"]],
]
/** What a 0.3.2 client publishes for a provider directory row (GUYI-AI/gugu#1936). */
export const releasedDirectoryRow = Object.freeze({ providerId: 'amap', configured: false, displayName: 'AMap',
  catalog: { categoryId: 'life', aliases: ['AMap', '高德地图', '高德'] } })
const directoryDocument = JSON.stringify({ version: 1, en: { id: 'amap' }, 'zh-CN': { id: 'amap' } })
const ownerShape = { version: 1, mode: 'owner', epoch: '1', phase: 'stable', acceptingNewOperations: true }
const refused = 'Panel catalog must be a provider directory category with search aliases'
const bounds = "SET LOCAL statement_timeout='2s'; SET LOCAL lock_timeout='250ms'; SET LOCAL transaction_timeout='2s'"
const unbounded = 'SET LOCAL statement_timeout=0; SET LOCAL lock_timeout=0; SET LOCAL transaction_timeout=0'

/** Installs the directory catalog release, then exercises it in one transaction that rolls back every fixture row. */
export async function installConnectionCatalogWithEvidence({ db, query, sql, url, test }) {
  const definition = async () => (await db.query(`SELECT p.oid,p.prosrc,p.proowner,p.prosecdef,p.provolatile,p.proconfig,
      (SELECT array_agg(x::text ORDER BY x::text) FROM unnest(p.proacl) x) AS acl FROM pg_proc p WHERE p.oid=$1::regprocedure`, [validate])).rows[0]
  const before = await definition()
  // Evidence of the defect on a separate connection, so no installer state is touched.
  const probe = new pg.Client({ connectionString: url })
  await probe.connect()
  try {
    await assert.rejects(probe.query('SELECT identity.assistant_panel_validate($1,$2,$3)', ['integrations', 'catalog:amap', releasedDirectoryRow]),
      error => error.code === '22023' && error.message === 'Panel data has unsupported fields', 'before this release a 0.3.2 directory row is refused')
  } finally { await probe.end() }
  const result = await query(sql)

  await test('directory catalog release patches one span each and keeps the OID, owner, attributes and grants', async () => {
    const after = await definition(), now = after.prosrc
    // The old body is segment, anchor, segment, ... ; the new one must keep every segment and differ only in the spans.
    const segments = []
    let rest = before.prosrc
    for (const [anchor] of patches) {
      const parts = rest.split(anchor)
      assert.equal(parts.length, 2, `anchor occurs once: ${anchor}`)
      segments.push(parts[0]); rest = parts[1]
    }
    segments.push(rest)
    assert.ok(now.startsWith(segments[0]), 'text before the first anchor is unchanged')
    let at = segments[0].length
    for (const [index, [anchor, present]] of patches.entries()) {
      const following = segments[index + 1]
      const next = index === patches.length - 1 ? now.length - following.length : now.indexOf(following, at)
      assert.ok(next >= at && now.slice(next, next + following.length) === following, `text after the span is unchanged: ${anchor}`)
      const span = now.slice(at, next)
      for (const text of present) assert.ok(span.includes(text), `${anchor}: ${text}`)
      at = next + following.length
    }
    assert.equal(at, now.length, 'nothing else changed')
    assert.deepEqual({ ...after, prosrc: null }, { ...before, prosrc: null })
  })

  await db.query('BEGIN')
  try {
    const check = async (domain, key, data) => {
      await db.query('SAVEPOINT catalog_check')
      try { await db.query('SELECT identity.assistant_panel_validate($1,$2,$3)', [domain, key, data]); return 'accepted' }
      catch (error) { return `${error.code} ${error.message}` }
      finally { await db.query('ROLLBACK TO catalog_check; RELEASE catalog_check') }
    }
    await test('a provider directory row may carry its category and search aliases; nothing else may', async () => {
      const row = data => ({ providerId: 'x', configured: false, ...data })
      for (const [label, domain, key, data] of [
        ['0.3.2 directory row', 'integrations', 'catalog:amap', releasedDirectoryRow],
        ['without aliases', 'integrations', 'catalog:github', row({ catalog: { categoryId: 'dev' } })],
        ['null', 'integrations', 'catalog:x', row({ catalog: null })],
        ['older directory row', 'integrations', 'catalog:x', row({ displayName: 'X' })],
        ['32 aliases of 128 characters', 'integrations', 'catalog:x', row({ catalog: { categoryId: 'x', aliases: Array(32).fill('界'.repeat(128)) } })],
      ]) assert.equal(await check(domain, key, data), 'accepted', label)
      for (const [label, domain, key, data, message] of [
        ['account row', 'integrations', '["amap","default"]', { providerId: 'amap', accountId: 'default', configured: true, catalog: { categoryId: 'life' } }, refused],
        ['account row null', 'integrations', '["amap","default"]', { providerId: 'amap', accountId: 'default', configured: true, catalog: null }, refused],
        ['another domain', 'memory', 'note.md', { title: 'x', catalog: { categoryId: 'life' } }, 'Panel data has unsupported fields'],
        ['collection marker', 'integrations', '__collection__:d', { state: 'ready', schemaVersion: 1, itemCount: 0, catalog: { categoryId: 'life' } }, 'Panel data has unsupported fields'],
        ['extra field', 'integrations', 'catalog:x', row({ catalog: { categoryId: 'life', icon: 'x' } }), refused],
        ['category missing', 'integrations', 'catalog:x', row({ catalog: { aliases: ['a'] } }), refused],
        ['category not text', 'integrations', 'catalog:x', row({ catalog: { categoryId: 3 } }), refused],
        ['category grammar', 'integrations', 'catalog:x', row({ catalog: { categoryId: '../x' } }), refused],
        ['text', 'integrations', 'catalog:x', row({ catalog: 'life' }), refused],
        ['array', 'integrations', 'catalog:x', row({ catalog: ['life'] }), refused],
        ['aliases not an array', 'integrations', 'catalog:x', row({ catalog: { categoryId: 'life', aliases: 'a' } }), refused],
        ['nested alias', 'integrations', 'catalog:x', row({ catalog: { categoryId: 'life', aliases: [{ a: 1 }] } }), refused],
        ['empty alias', 'integrations', 'catalog:x', row({ catalog: { categoryId: 'life', aliases: [''] } }), refused],
        ['control character', 'integrations', 'catalog:x', row({ catalog: { categoryId: 'life', aliases: ['a\u0007b'] } }), refused],
        ['alias of 129 characters', 'integrations', 'catalog:x', row({ catalog: { categoryId: 'life', aliases: ['a'.repeat(129)] } }), refused],
        ['33 aliases', 'integrations', 'catalog:x', row({ catalog: { categoryId: 'life', aliases: Array.from({ length: 33 }, (_, i) => `a${i}`) } }), refused],
        ['other nested metadata', 'integrations', 'catalog:x', row({ permission: { scope: 'all' } }), 'Panel metadata must not contain nested configuration'],
      ]) assert.equal(await check(domain, key, data), `22023 ${message}`, label)
    })

    const human = async () => {
      const id = randomUUID()
      await db.query(`INSERT INTO auth.users(id,instance_id,aud,role,email,raw_app_meta_data,raw_user_meta_data,
        confirmation_token,recovery_token,email_change_token_new,email_change,created_at,updated_at)
        VALUES($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,
        '{"provider":"email","providers":["email"]}','{}','','','','',now(),now())`, [id, `${id}@connection-catalog.invalid`])
      await db.query("INSERT INTO identity.users(id,type,display_name) VALUES($1,'human','Connection catalog fixture') ON CONFLICT DO NOTHING", [id])
      return id
    }
    // A legacy account: owner, home device, provisioned assistant, control head, ready empty collection.
    const legacyAccount = async () => {
      const owner = await human(), home = `catalog-${randomUUID()}`, assistant = randomUUID(), operation = randomUUID()
      await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'fixture','fixture','linux')", [home, owner])
      await db.query(`INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id) VALUES($1,'agent','Catalog fixture',$2,$3)`, [assistant, owner, home])
      await db.query(`INSERT INTO identity.agent_provision_operations(id,owner_user_id,device_id,kind,payload_hash,blueprint,phase)
        VALUES($1,$2,$3,'single','fixture','{}','completed')`, [operation, owner, home])
      await db.query(`INSERT INTO identity.agent_provisions(id,owner_user_id,operation_id,member_key,device_id,display_name,agent_type,
        inherit_memory,history_import_required,payload_hash,agent_user_id,provisioned_agent_user_id,phase)
        VALUES($1,$2,$3,'assistant',$4,'Fixture','claude-code',false,false,'fixture',$5::text,$5::text::uuid,'completed')`,
      [randomUUID(), owner, operation, home, assistant])
      await db.query(`INSERT INTO identity.assistant_panel_items(assistant_user_id,owner_user_id,domain,resource_key,device_id,revision,data)
        VALUES($1,$2,'control','__head__',NULL,3,'{}'),
          ($1,$2,'integrations','__collection__:' || $3,$3,3,'{"state":"ready","schemaVersion":1,"itemCount":0}')`, [assistant, owner, home])
      return { owner, home, assistant }
    }
    // A refusal aborts the subtransaction; reject() rolls it back, which also undoes SET LOCAL ROLE.
    const as = async (user, action) => {
      await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role: 'authenticated' })])
      await db.query('SET LOCAL ROLE authenticated')
      const value = await action()
      await db.query('RESET ROLE')
      return value
    }
    const reject = async (action, code, message) => {
      await db.query('SAVEPOINT catalog_expected_error')
      let error
      try { await action() } catch (caught) { error = caught }
      await db.query('ROLLBACK TO catalog_expected_error; RELEASE catalog_expected_error')
      assert.equal(error?.code, code, error?.message ?? 'expected refusal')
      assert.equal(error.message, message)
    }
    const bounded = async (statement, values) => {
      await db.query('SAVEPOINT catalog_bounded')
      try {
        await db.query(bounds)
        const rows = (await db.query(statement, values)).rows
        await db.query(unbounded)
        await db.query('RELEASE catalog_bounded')
        return rows[0]?.result
      } catch (error) { await db.query('ROLLBACK TO catalog_bounded; RELEASE catalog_bounded'); throw error }
    }

    await test('legacy panel and owner connection writes store a 0.3.2 directory row as sent', async () => {
      // Legacy authority: the assistant panel commit a 0.3.2 client uses.
      const legacy = await legacyAccount()
      const commit = (key, data) => as(legacy.owner, () => db.query(`SELECT identity.assistant_panel_commit($1,$2,'integrations',$3,0,'save',$4,NULL,NULL,$5,NULL) AS r`,
        [legacy.assistant, randomUUID(), key, data, legacy.home]))
      await commit('catalog:amap', releasedDirectoryRow)
      assert.deepEqual((await db.query(`SELECT data FROM identity.assistant_panel_items WHERE assistant_user_id=$1
        AND domain='integrations' AND resource_key='catalog:amap'`, [legacy.assistant])).rows[0].data, releasedDirectoryRow)
      await reject(() => commit('["amap","default"]', { providerId: 'amap', accountId: 'default', configured: true, catalog: { categoryId: 'life' } }),
        '22023', refused)

      // Owner authority after the cutover: the connection commit of the clients that ship with it.
      const { owner, home } = await legacyAccount()
      const source = (await db.query('SELECT identity.connection_legacy_inventory($1) AS v', [owner])).rows[0].v
      const audited = await auditConnectionInventory(source)
      await bounded('SELECT identity.connection_prepare_import($1,$2,$3,$4) AS result', [owner, source.databaseDigest, audited.hash, '{}'])
      assert.deepEqual(await bounded('SELECT identity.connection_authority_cutover($1,0,$2,$3,$4) AS result',
        [owner, 'fixture-operator', source.databaseDigest, audited.hash]), ownerShape)
      const publisher = randomUUID()
      await db.query('INSERT INTO identity.runtime_instances(instance_id,device_id,owner_user_id) VALUES($1,$2,$3)', [publisher, home, owner])
      const connect = (key, data) => as(owner, () => db.query('SELECT identity.connection_commit($1,$2,$3,$4,$5,$6,$7,$8,$9) AS r',
        [randomUUID(), `device:${home}`, key, 0, 'save', data, directoryDocument, home, publisher]))
      await connect('catalog:amap', releasedDirectoryRow)
      assert.deepEqual((await db.query(`SELECT data FROM identity.connection_items WHERE owner_user_id=$1 AND resource_key='catalog:amap'`,
        [owner])).rows[0].data, releasedDirectoryRow)
      await reject(() => connect('["amap","default"]', { providerId: 'amap', accountId: 'default', configured: true, catalog: { categoryId: 'life' } }),
        '22023', refused)
    })
  } finally { await db.query('ROLLBACK') }
  return result
}
