import { createHash } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const staging = /^staging\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const digest = /^[0-9a-f]{64}$/
const utc = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(value) && Number.isFinite(Date.parse(value))
const hash = value => createHash('sha256').update(value).digest('hex')
const canonical = x => JSON.stringify(sort(x))
const sort = x => Array.isArray(x) ? x.map(sort) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sort(v)])) : x
const require = (ok, code) => { if (!ok) throw Error(code) }
export function planSha(plan) { const { plan_sha256: _, ...content } = plan; return hash(canonical(content)) }

/** Operates on protected exports only. There is no storage client, URL signer or deletion in this planner. */
export function buildStagingCleanupPlan(snapshot, evidence, { now = new Date().toISOString(), limit = 5 } = {}) {
  require(snapshot?.schema === 1 && snapshot.kind === 'staging-cleanup-snapshot' && utc(snapshot.at)
    && Array.isArray(snapshot.uploads) && snapshot.uploads.length <= 500_000, 'invalid_snapshot')
  require(evidence?.schema === 1 && evidence.kind === 'staging-cleanup-trusted-evidence' && Array.isArray(evidence.entries)
    && evidence.entries.length <= 500_000 && utc(now) && Number.isSafeInteger(limit) && limit > 0 && limit <= 500, 'invalid_evidence_packet')
  require(Date.parse(snapshot.at) <= Date.parse(now), 'snapshot_is_in_the_future')
  const proofs = new Map(), seen = new Set()
  for (const e of evidence.entries) {
    require(e && typeof e.staging_key === 'string' && staging.test(e.staging_key) && !proofs.has(e.staging_key), 'duplicate_or_invalid_evidence')
    proofs.set(e.staging_key, e)
  }
  const counts = { scanned: snapshot.uploads.length, already_closed: 0, unregistered: 0, missing_publication: 0,
    missing_terminal: 0, mismatched_evidence: 0, capability_open: 0, eligible: 0, selected: 0, deferred: 0 }
  const entries = []
  for (const row of snapshot.uploads) {
    require(row && typeof row.staging_key === 'string' && staging.test(row.staging_key) && !seen.has(row.staging_key)
      && uuid.test(row.reservation_id) && utc(row.permit_expires_at) && typeof row.staging_deleted === 'boolean'
      && typeof row.publication_committed === 'boolean', 'invalid_or_duplicate_snapshot_row')
    seen.add(row.staging_key)
    if (row.staging_deleted || row.reservation_state === 'settled') { counts.already_closed++; continue }
    if (!row.blob_id || !uuid.test(row.blob_id)) { counts.unregistered++; continue }
    if (!['reserved', 'issued'].includes(row.reservation_state) || Date.parse(row.permit_expires_at) > Date.parse(now)) { counts.capability_open++; continue }
    const proof = proofs.get(row.staging_key)
    if (!row.publication_committed && (!proof || !digest.test(proof.publication_sha256 ?? '') || !utc(proof.publication_at))) {
      counts.missing_publication++; continue
    }
    if (!proof || !digest.test(proof.terminal_sha256 ?? '') || !utc(proof.terminal_at)) { counts.missing_terminal++; continue }
    if (proof.reservation_id !== row.reservation_id || proof.blob_id !== row.blob_id
        || proof.permit_expires_at !== row.permit_expires_at || Date.parse(proof.terminal_at) < Date.parse(row.permit_expires_at)
        || Date.parse(proof.terminal_at) > Date.parse(now)
        || proof.publication_at != null && (!utc(proof.publication_at) || Date.parse(proof.publication_at) > Date.parse(now))) {
      counts.mismatched_evidence++; continue
    }
    counts.eligible++
    entries.push({ staging_key: row.staging_key, reservation_id: row.reservation_id, blob_id: row.blob_id,
      permit_expires_at: row.permit_expires_at, terminal_at: proof.terminal_at, terminal_sha256: proof.terminal_sha256,
      publication_sha256: proof.publication_sha256 ?? null, publication_at: proof.publication_at ?? null })
  }
  entries.sort((a, b) => a.staging_key.localeCompare(b.staging_key))
  const plan = { schema: 1, kind: 'committed-staging-cleanup-plan', generated_at: now,
    snapshot_sha256: hash(canonical(snapshot)), evidence_sha256: hash(canonical(evidence)), counts,
    entries: entries.slice(0, limit) }
  counts.selected = plan.entries.length; counts.deferred = counts.eligible - counts.selected
  return { ...plan, plan_sha256: planSha(plan) }
}

function validatePlan(plan, confirmation) {
  require(plan?.schema === 1 && plan.kind === 'committed-staging-cleanup-plan' && utc(plan.generated_at)
    && digest.test(plan.snapshot_sha256 ?? '') && digest.test(plan.evidence_sha256 ?? '')
    && digest.test(confirmation ?? '') && confirmation === plan.plan_sha256 && confirmation === planSha(plan)
    && Array.isArray(plan.entries) && plan.entries.length <= 500 && plan.counts?.selected === plan.entries.length, 'plan_confirmation_mismatch')
  const seen = new Set()
  for (const row of plan.entries) {
    require(row && staging.test(row.staging_key) && !seen.has(row.staging_key) && uuid.test(row.reservation_id) && uuid.test(row.blob_id)
      && utc(row.permit_expires_at) && utc(row.terminal_at) && digest.test(row.terminal_sha256)
      && (row.publication_sha256 === null || digest.test(row.publication_sha256))
      && (row.publication_at === null || utc(row.publication_at)), 'invalid_plan_entry')
    seen.add(row.staging_key)
  }
}

/** Called only by --apply with an exact reviewed digest. Mutations are never retried after an uncertain response. */
export async function applyStagingCleanupPlan(plan, confirmation, call) {
  validatePlan(plan, confirmation)
  if (!plan.entries.length) return { plan_sha256: confirmation, selected: 0, recorded: 0, deleted: 0, dry_run: false, no_eligible_entries: true }
  const state = await call('staging-cleanup-status', {})
  require(state?.batch_limit === 5 && state.concurrency === 1 && state.inflight === 0 && typeof state.enabled === 'boolean', 'cleanup_not_quiescent')
  // An approved execution explicitly closes admission first. This is a single
  // mutation, not a retry or an attempt to erase another active run.
  if (state.enabled) {
    const disabled = await call('staging-cleanup-configure', { enabled: false, single_batch: true })
    require(disabled?.enabled === false && disabled.inflight === 0, 'cleanup_disable_unconfirmed')
  }
  let recorded = 0
  for (const row of plan.entries) {
    const receipt = await call('staging-cleanup-evidence', row)
    require(typeof receipt?.recorded === 'boolean', 'evidence_acknowledgement_unknown')
    recorded += Number(receipt.recorded)
  }
  const keys = plan.entries.map(row => row.staging_key)
  const before = await call('staging-cleanup-status', { keys })
  require(Number.isSafeInteger(before?.completed) && before.known === keys.length, 'scope_readback_unknown')
  const enabled = await call('staging-cleanup-configure', { enabled: true, single_batch: true, keys })
  require(enabled?.enabled === true && enabled.single_batch === true && enabled.batch_limit === 5
    && enabled.concurrency === 1 && enabled.inflight === 0 && enabled.scope_count === keys.length, 'cleanup_activation_unknown')
  const run = await call('staging-cleanup', {})
  require(typeof run?.admitted === 'boolean' && ['claimed', 'deleted', 'failed', 'unconfirmed'].every(k => Number.isSafeInteger(run[k]) && run[k] >= 0)
    && run.claimed <= 5 && run.deleted <= run.claimed, 'cleanup_result_unknown')
  const after = await call('staging-cleanup-status', { keys })
  require(after?.known === keys.length && Number.isSafeInteger(after.completed) && after.completed >= before.completed, 'completion_readback_unknown')
  return { plan_sha256: confirmation, selected: keys.length, recorded, ...run,
    newly_confirmed: after.completed - before.completed, completed: after.completed, dry_run: false }
}

function protectedJson(file) {
  const stat = statSync(file)
  require(stat.isFile() && (stat.mode & 0o077) === 0 && stat.size <= 128 * 1024 * 1024, 'private_bounded_input_required')
  return JSON.parse(readFileSync(file, 'utf8'))
}
async function main(args) {
  const values = new Map()
  for (let i = 0; i < args.length; i++) {
    const name = args[i]
    require(['--snapshot', '--evidence', '--out', '--plan', '--confirm', '--apply'].includes(name) && !values.has(name), 'invalid_arguments')
    if (name === '--apply') values.set(name, true)
    else { require(args[i + 1] && !args[i + 1].startsWith('--'), 'invalid_arguments'); values.set(name, args[++i]) }
  }
  if (!values.has('--apply')) {
    require(values.has('--snapshot') && values.has('--evidence') && values.has('--out') && !values.has('--plan') && !values.has('--confirm'), 'planning_inputs_required')
    const plan = buildStagingCleanupPlan(protectedJson(values.get('--snapshot')), protectedJson(values.get('--evidence')))
    writeFileSync(values.get('--out'), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    console.log(JSON.stringify({ dry_run: true, requests: 0, mutations: 0, counts: plan.counts, plan_sha256: plan.plan_sha256 }))
    return
  }
  require(values.has('--plan') && values.has('--confirm') && !values.has('--snapshot') && !values.has('--evidence') && !values.has('--out'), 'approved_plan_required')
  const endpoint = new URL(process.env.GUGU_STAGING_CLEANUP_URL ?? '')
  require((endpoint.protocol === 'https:' || endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))
    && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash
    && endpoint.pathname.replace(/\/$/, '').endsWith('/functions/v1/attachments'), 'invalid_cleanup_endpoint')
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  require(typeof key === 'string' && key.length >= 40 && key.length <= 8192 && !/[\r\n]/.test(key), 'service_capability_required')
  const deadline = Date.now() + 600_000
  const call = async (route, body) => {
    const remaining = Math.min(route === 'staging-cleanup' ? 125_000 : 10_000, deadline - Date.now())
    require(remaining > 0, 'cleanup_total_deadline_outcome_may_be_unknown')
    const response = await fetch(endpoint.href.replace(/\/$/, '') + '/' + route, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key, apikey: key },
      body: JSON.stringify(body), signal: AbortSignal.timeout(remaining) })
    require(response.ok, 'cleanup_request_failed_outcome_may_be_unknown')
    const bytes = await response.text()
    require(bytes.length <= 16384, 'cleanup_receipt_too_large')
    const value = JSON.parse(bytes)
    return value.cleanup ?? value
  }
  console.log(JSON.stringify(await applyStagingCleanupPlan(protectedJson(values.get('--plan')), values.get('--confirm'), call)))
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    const code = /^[a-z_]{1,100}$/.test(error.message ?? '') ? error.message : 'staging_cleanup_failed_outcome_may_be_unknown'
    console.error(JSON.stringify({ error: code, automatic_retries: 0 })); process.exitCode = 1
  })
}
