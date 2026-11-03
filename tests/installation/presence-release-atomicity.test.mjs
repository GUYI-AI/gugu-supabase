import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import { installReleases, releases } from '../../scripts/foundation.mjs'

// Reuse the installed disposable fixture. No installed ledger row is removed or changed.
test('presence DDL and its ledger retain the installer transaction and lock until commit',
  { skip: process.env.GUGU_PRESENCE_INSTALL_ATOMICITY !== '1' }, async (t) => {
    const url = new URL(process.env.GUGU_INSTALL_TEST_DATABASE_URL ?? '')
    assert.ok(['postgres:', 'postgresql:'].includes(url.protocol))
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
    const release = releases.find(row => row.version === '20261103140100_presence_publication_budget')
    assert.ok(release)
    let wrapped
    // Obtain the exact request emitted by the real installer, without changing its implementation.
    await installReleases(async (_sql, readOnly) => {
      if (readOnly) return releases.filter(row => row !== release).map(({ version, digest }) => ({ version, digest }))
      assert.equal(wrapped, undefined)
      wrapped = _sql
      return []
    })
    assert.ok(wrapped.includes(release.sql))
    const writer = new pg.Client({ connectionString: url.href })
    const observer = new pg.Client({ connectionString: url.href })
    await writer.connect(); await observer.connect()
    const gate = BigInt('0x' + randomUUID().replaceAll('-', '').slice(0, 15)).toString()
    const witness = 'presence_atomic_' + randomUUID().replaceAll('-', '')
    const version = 'atomicity_probe_' + randomUUID()
    let pending
    try {
      const ledger = (await observer.query('SELECT version,digest FROM gugu_install.releases ORDER BY version')).rows
      const signatures = ['identity.broadcast_agent_presence_from_runtime()', 'identity.fan_agent_presence_to_viewers(text,jsonb)']
      const definitions = async () => (await observer.query(`SELECT p.oid::regprocedure::text AS signature,
        pg_get_functiondef(p.oid) AS definition,p.proacl::text,p.proowner,p.prosecdef,p.proconfig
        FROM pg_proc p WHERE p.oid=ANY($1::regprocedure[]) ORDER BY 1`, [signatures])).rows
      const before = await definitions()
      const pid = (await writer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      const observerPid = (await observer.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      await observer.query('SELECT pg_advisory_lock($1::bigint)', [gate])
      // Only the test release name and a session-local witness/barrier/failure are injected.
      // The production migration and the installer's BEGIN/guard/lock/ledger/COMMIT are unchanged.
      const sql = wrapped.replaceAll(release.version, version)
        .replace(release.sql, `CREATE FUNCTION pg_temp.${witness}() RETURNS integer LANGUAGE sql AS 'SELECT 1';\n${release.sql}`)
        .replace('INSERT INTO gugu_install.releases', `SELECT pg_advisory_xact_lock(${gate}::bigint);\nSELECT 1/0;\nINSERT INTO gugu_install.releases`)
      pending = writer.query(sql).then(() => null, error => error)
      const deadline = Date.now() + 10_000
      for (;;) {
        const blockers = (await observer.query('SELECT pg_blocking_pids($1) AS blockers', [pid])).rows[0].blockers
        if (blockers.includes(observerPid)) break
        if (Date.now() > deadline) throw new Error('installer did not reach the controlled pre-ledger barrier')
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      let held
      await observer.query('BEGIN')
      try {
        held = !(await observer.query("SELECT pg_try_advisory_xact_lock(hashtextextended('gugu:foundation-install:v1',0)) AS available")).rows[0].available
      } finally { await observer.query('ROLLBACK') }
      await observer.query('SELECT pg_advisory_unlock($1::bigint)', [gate])
      const failure = await pending
      assert.equal(failure?.code, '22012', 'the injected pre-ledger failure must execute')
      await writer.query('ROLLBACK')
      const rolledBack = (await writer.query('SELECT to_regprocedure($1) AS witness', [`pg_temp.${witness}()`])).rows[0].witness === null
      assert.deepEqual(await definitions(), before, 'installed function definitions and permissions remain unchanged')
      assert.deepEqual((await observer.query('SELECT version,digest FROM gugu_install.releases ORDER BY version')).rows, ledger)
      t.diagnostic(JSON.stringify({ preLedgerInstallerLockHeld: held, earlierDdlRolledBack: rolledBack, ledgerUnchanged: true }))
      assert.deepEqual({ preLedgerInstallerLockHeld: held, earlierDdlRolledBack: rolledBack },
        { preLedgerInstallerLockHeld: true, earlierDdlRolledBack: true })
    } finally {
      await observer.query('SELECT pg_advisory_unlock($1::bigint)', [gate]).catch(() => {})
      await pending
      await writer.query('ROLLBACK').catch(() => {})
      await writer.end(); await observer.end()
    }
  })
