// Run once per minute from a protected server scheduler. Credentials belong in
// its existing environment, never in command arguments, cron text or output.
const root = process.env.SUPABASE_URL?.replace(/\/+$/, '')
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!root || !key || !/^https?:\/\//.test(root)) {
  console.error(JSON.stringify({ ok: false, configuration_missing: true }))
  process.exitCode = 1
} else {
  try {
    const response = await fetch(root + '/functions/v1/account-deletion/process-due', {
      method: 'POST', signal: AbortSignal.timeout(240_000),
      headers: { apikey: key, authorization: 'Bearer ' + key, 'content-type': 'application/json' }, body: '{}',
    })
    const data = await response.json().catch(() => null)
    if (!response.ok || !data || !['processed', 'deleted', 'deferred'].every(k => Number.isInteger(data[k]) && data[k] >= 0 && data[k] <= 5)
        || data.deleted + data.deferred !== data.processed) throw new Error('worker_unavailable')
    console.log(JSON.stringify({ ok: true, processed: data.processed, deleted: data.deleted, deferred: data.deferred }))
    if (data.deferred) process.exitCode = 2
  } catch {
    console.error(JSON.stringify({ ok: false, worker_unavailable: true }))
    process.exitCode = 1
  }
}
