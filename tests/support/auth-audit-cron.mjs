import { setTimeout as delay } from 'node:timers/promises'

/** Called outside a transaction, only on the runner's already-owned loopback fixture. */
export async function pauseAuthAuditRetentionCron(db) {
  const jobs = (await db.query("SELECT jobid,schedule,command,active FROM cron.job WHERE jobname='auth-audit-retention' AND username=current_user AND database=current_database()")).rows
  if (jobs.length !== 1 || jobs[0].command !== "SET statement_timeout='2s'; SELECT identity.prune_auth_audit_log(100);") {
    throw new Error('The owned Auth retention scheduler differs')
  }
  const original = jobs[0]
  let restored = false
  const restore = async () => {
    if (restored) return
    const current = (await db.query('SELECT schedule,command FROM cron.job WHERE jobid=$1 AND username=current_user AND database=current_database()', [original.jobid])).rows
    if (current.length !== 1 || current[0].schedule !== original.schedule || current[0].command !== original.command) {
      throw new Error('The paused Auth retention scheduler changed; refusing to replace it')
    }
    await db.query('SELECT cron.alter_job($1::bigint,active:=$2::boolean)', [original.jobid, original.active])
    const after = (await db.query('SELECT active FROM cron.job WHERE jobid=$1', [original.jobid])).rows
    if (after.length !== 1 || after[0].active !== original.active) throw new Error('Auth retention scheduler restoration was not verified')
    restored = true
  }
  try {
    // Commit the pause before any fixture transaction can publish expired rows.
    await db.query('SELECT cron.alter_job($1::bigint,active:=false)', [original.jobid])
    const deadline = Date.now() + 10_000
    while ((await db.query("SELECT 1 FROM cron.job_run_details WHERE jobid=$1 AND status IN ('starting','running') LIMIT 1", [original.jobid])).rowCount) {
      if (Date.now() >= deadline) throw new Error('The existing Auth retention worker did not drain')
      await delay(50)
    }
    // Also fence a worker that had entered its SQL before scheduler bookkeeping.
    try {
      await db.query("BEGIN; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='6s'; LOCK TABLE auth.audit_log_entries IN ACCESS EXCLUSIVE MODE; COMMIT")
    } catch (error) { await db.query('ROLLBACK'); throw error }
    const paused = (await db.query('SELECT active FROM cron.job WHERE jobid=$1', [original.jobid])).rows
    if (paused.length !== 1 || paused[0].active !== false) throw new Error('Auth retention scheduler pause was not verified')
    return { jobId: original.jobid, restore }
  } catch (error) {
    await restore()
    throw error
  }
}
