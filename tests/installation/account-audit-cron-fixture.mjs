import assert from 'node:assert/strict'

export const accountAuditCronNamesVersion = '20261119234000_account_audit_cron_names'
const names = [
  ['account-audit-redaction-nightly','account-audit-redaction-hourly'],
  ['account-audit-redaction-retry','account-audit-redaction-retry-10min'],
  ['account-audit-redaction-daily','account-audit-redaction-check-hourly'],
  ['account-audit-redaction-daily-guard','account-audit-redaction-guard-hourly'],
]
export async function installAccountAuditCronNames({ query, sql, release, test }) {
  const jobs = () => query("SELECT jobid,jobname,schedule,command,nodename,nodeport,database,username,active FROM cron.job WHERE jobname LIKE 'account-audit-redaction-%' ORDER BY jobname")
  const grants = () => query("SELECT oid,relacl::text,relowner FROM pg_class WHERE oid IN ('cron.job'::regclass,'cron.job_run_details'::regclass) ORDER BY oid")
  const ledger = () => query('SELECT version,digest,installed_at FROM gugu_install.releases ORDER BY version')
  const before = await jobs(), beforeGrants = await grants(), beforeLedger = await ledger()
  assert.equal(before.length,4)
  assert.equal((await query("SELECT current_user,has_table_privilege(current_user,'cron.job','UPDATE') allowed"))[0].allowed,false,
    'the real migration role cannot update the extension table directly')
  const original = before.find(x => x.jobname === names[1][0])
  const history = () => query(`SELECT * FROM cron.job_run_details WHERE jobid IN (${before.map(x => x.jobid).join(',')}) ORDER BY runid`)
  const historyBefore = await history()
  await test('cron name replacement rolls back on a changed command, missing job or colliding name', async () => {
    for (const [setup, code] of [
      [`SELECT cron.alter_job(${original.jobid},command:='SELECT 1;');`, 'P0001'],
      [`SELECT cron.unschedule(${original.jobid});`, 'P0002'],
      ["SELECT cron.schedule('account-audit-redaction-guard-hourly','20 * * * *','SELECT 1;');", 'P0001'],
    ]) {
      await assert.rejects(query(sql.replace(release.sql, () => setup + '\n' + release.sql)), { code })
      await query('ROLLBACK')
      assert.deepEqual(await jobs(),before)
      assert.deepEqual(await ledger(),beforeLedger)
      assert.deepEqual(await grants(),beforeGrants)
    }
  })
  await test('cron name replacement preserves a paused job and restores everything on rollback', async () => {
    const trial=sql.replace(release.sql, () => `SELECT cron.alter_job(${original.jobid},active:=false);\n` + release.sql).replace(/COMMIT;\s*$/, '')
    await query(trial)
    try {
      const after=await jobs()
      assert.equal(after.find(x=>x.jobname===names[1][1]).active,false)
      for (const old of before) {
        const name=names.find(([a])=>a===old.jobname)[1], fresh=after.find(x=>x.jobname===name)
        assert.ok(fresh)
        assert.notEqual(fresh.jobid,old.jobid)
        assert.deepEqual({...fresh,jobid:old.jobid,jobname:old.jobname},
          {...old,active:old.jobid===original.jobid ? false : old.active})
      }
      assert.deepEqual(await history(),historyBefore)
      assert.deepEqual(await grants(),beforeGrants)
    } finally { await query('ROLLBACK') }
    assert.deepEqual(await jobs(),before)
    assert.deepEqual(await ledger(),beforeLedger)
  })
  const result=await query(sql)
  await test('installed cron names preserve commands, frequency, bindings, history and grants', async () => {
    const after=await jobs()
    assert.equal(after.length,4)
    for (const old of before) {
      const name=names.find(([a])=>a===old.jobname)[1], fresh=after.find(x=>x.jobname===name)
      assert.ok(fresh)
      assert.notEqual(fresh.jobid,old.jobid)
      assert.deepEqual({...fresh,jobid:old.jobid,jobname:old.jobname},old)
    }
    assert.deepEqual(await grants(),beforeGrants)
    assert.deepEqual(await history(),historyBefore)
  })
  return result
}
