import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

/** A captured definition can match while its owner/grantors legitimately differ.
 * Everything, including created roles and backup edits, is rolled back. */
export async function assertConnectionDelegatedAclRestore(db, rollbackSql) {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
  const owner = `connection_owner_${suffix}`, grantor = `connection_grantor_${suffix}`, recipient = `connection_recipient_${suffix}`
  await db.query('BEGIN')
  try {
    for (const role of [owner, grantor, recipient]) await db.query(`CREATE ROLE ${role} NOLOGIN`)
    // Supabase's postgres is not a superuser. Give this disposable maintenance
    // session the explicit SET permissions a real restoration operator needs.
    await db.query(`GRANT ${owner},${grantor} TO postgres WITH SET TRUE`)
    await db.query(`GRANT USAGE,CREATE ON SCHEMA identity TO ${owner}`)
    await db.query(`GRANT USAGE ON SCHEMA identity TO ${grantor}`)
    const signature = 'identity.assistant_panel_snapshot(text)'
    await db.query(`ALTER FUNCTION ${signature} OWNER TO ${owner}`)
    await db.query(`SET LOCAL ROLE ${owner}`)
    await db.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${grantor} WITH GRANT OPTION`)
    await db.query('RESET ROLE')
    await db.query(`SET LOCAL ROLE ${grantor}`)
    await db.query(`GRANT EXECUTE ON FUNCTION ${signature} TO ${recipient}`)
    await db.query('RESET ROLE')
    await db.query(`UPDATE identity.connection_legacy_functions b SET original_owner=p.proowner,original_acl=p.proacl
      FROM pg_proc p WHERE b.signature=$1 AND p.oid=b.original_oid`, [signature])
    const original = (await db.query(`SELECT p.oid,p.proowner,p.proacl::text AS acl,pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p WHERE p.oid=$1::regprocedure`, [signature])).rows[0]
    assert.ok(original.acl.includes(`=${'X'}/${grantor}`))
    await db.query(original.definition.replace('BEGIN\n', 'BEGIN\n    -- Delegated restoration fixture.\n'))
    await db.query(`GRANT EXECUTE ON FUNCTION ${signature} TO service_role`)
    // Keep the fixture's outer transaction so roles and injected definitions
    // cannot leak into later installation tests.
    const body = rollbackSql.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '')
    await db.query(body)
    const restored = (await db.query(`SELECT p.oid,p.proowner,p.proacl::text AS acl,pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p WHERE p.oid=$1::regprocedure`, [signature])).rows[0]
    assert.deepEqual(restored, original)
    assert.equal((await db.query('SELECT current_user AS role')).rows[0].role, 'postgres')
  } finally { await db.query('ROLLBACK'); await db.query('RESET ROLE') }
}
