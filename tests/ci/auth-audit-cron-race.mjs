import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

// A real pg_cron worker, against the unchanged PR-base dev database. The
// explicit barrier selects a legal interleaving of the original row-lock test.
const root = realpathSync(process.argv[2]) + sep
const source = process.argv[3]
assert.match(source, /^[a-f0-9]{40}$/)
assert.equal(execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), source)
const owner = JSON.parse(readFileSync(resolve(root, '.local/test-db/owner.json'), 'utf8'))
const project = 'gugucommunitytest' + createHash('sha256').update(root).digest('hex').slice(0, 10)
assert.equal(owner.root, root); assert.equal(owner.project, project)
const url = new URL(process.env.GUGU_INSTALL_TEST_DATABASE_URL)
assert.equal(url.hostname, '127.0.0.1'); assert.equal(Number(url.port), owner.port)
assert.equal(execFileSync('docker', ['port', 'supabase_db_' + project, '5432/tcp'], { encoding: 'utf8' }).trim(), '127.0.0.1:' + owner.port)
const { Client } = createRequire(resolve(root, 'package.json'))('pg')
const db = new Client({ connectionString: url.href, application_name: 'gugu-audit-cron-control', connectionTimeoutMillis: 5000, query_timeout: 5000 })
const locker = new Client({ connectionString: url.href, application_name: 'gugu-audit-cron-locker', connectionTimeoutMillis: 5000, query_timeout: 5000 })
const rows = [randomUUID(), randomUUID()]
let original
const prune = async () => Number((await db.query('SELECT identity.prune_auth_audit_log(100) AS n')).rows[0].n)
const pause = async () => {
  await db.query('SELECT cron.alter_job($1::bigint,active:=false)', [original.jobid])
  // Inactivation prevents future starts; this lock also drains an existing
  // worker before we seed anything. Its production statement timeout is 2s.
  await db.query("BEGIN; SET LOCAL lock_timeout='5s'; LOCK TABLE auth.audit_log_entries IN ACCESS EXCLUSIVE MODE; COMMIT")
}
try {
  await db.connect(); await locker.connect()
  await db.query("SET statement_timeout='5s'")
  const jobs = (await db.query("SELECT jobid,schedule,command,active FROM cron.job WHERE jobname='auth-audit-retention' AND username=current_user AND database=current_database()")).rows
  assert.equal(jobs.length, 1); original = jobs[0]
  assert.equal(original.schedule, '*/10 * * * *')
  assert.equal(original.command, "SET statement_timeout='2s'; SELECT identity.prune_auth_audit_log(100);")
  await pause()
  assert.equal(Number((await db.query("SELECT count(*) AS n FROM auth.audit_log_entries WHERE created_at < now()-interval '180 days'")).rows[0].n), 0)
  await locker.query("INSERT INTO auth.audit_log_entries(id,payload,created_at) SELECT unnest($1::uuid[]),'{}',now()-interval '181 days'", [rows])
  await locker.query('BEGIN')
  await locker.query('SELECT id FROM auth.audit_log_entries WHERE id=$1 FOR UPDATE', [rows[0]])
  await db.query('BEGIN'); await db.query("SET LOCAL statement_timeout='2s'")
  assert.equal(await prune(), 1)
  await db.query('COMMIT'); await locker.query('COMMIT')
  const before = (await db.query('SELECT coalesce(max(runid),0) AS id FROM cron.job_run_details WHERE jobid=$1', [original.jobid])).rows[0].id
  // Only the test scheduler period changes. The exact installed command,
  // owner, database and real pg_cron execution path stay unchanged.
  await db.query("SELECT cron.alter_job($1::bigint,schedule:='1 second',active:=true)", [original.jobid])
  let worker
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    worker = (await db.query("SELECT runid,status FROM cron.job_run_details WHERE jobid=$1 AND runid>$2 AND status='succeeded' ORDER BY runid LIMIT 1", [original.jobid, before])).rows[0]
    if (worker) break
    await delay(100)
  }
  assert.ok(worker, 'The actual scheduled worker did not finish')
  await pause()
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM auth.audit_log_entries WHERE id=ANY($1::uuid[])', [rows])).rows[0].n), 0)
  await db.query("SET statement_timeout='2s'")
  const afterWorker = await prune()
  assert.equal(afterWorker, 0, 'The original fixture expects 1 here, after the competing worker already consumed the row')
  console.log(JSON.stringify({ event: 'dev_auth_audit_cron_race_reproduced', source,
    fixtureSha256: createHash('sha256').update(readFileSync(resolve(root, 'tests/integration/service/authAuditRetention.test.ts'))).digest('hex'),
    workerRunId: worker.runid, originalFixtureExpected: 1, observedFinalPrune: afterWorker }))
} finally {
  await db.query('ROLLBACK').catch(() => {})
  await locker.query('ROLLBACK').catch(() => {})
  if (original) {
    await pause()
    await db.query('DELETE FROM auth.audit_log_entries WHERE id=ANY($1::uuid[])', [rows])
    await db.query('SELECT cron.alter_job($1::bigint,schedule:=$2::text,active:=$3::boolean)', [original.jobid, original.schedule, original.active])
  }
  await locker.end(); await db.end()
}
