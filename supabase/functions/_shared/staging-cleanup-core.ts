import type { Rpc } from './attachments-core.ts'
import { ObjectStorageError, type AttachmentObjectStorage } from './object-storage.ts'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const staging = /^staging\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export class StagingCleanupError extends Error {
  constructor(readonly code: string, readonly uncertain = false) { super(code) }
}
type Deps = { claim?: Record<string, unknown>; prepare?: AttachmentObjectStorage['prepareStaging']; serviceRpc: Rpc; objects: Pick<AttachmentObjectStorage, 'remove' | 'exists'>; log(stage: string, counts: Record<string, unknown>): void }
type Job = { staging_key: string; claim_token: string; attempt_count: number; upload_id: string | null }
async function call(rpc: Rpc, fn: string, args: Record<string, unknown> = {}, deadline = Infinity) {
  const remaining = Math.min(5000, deadline - Date.now())
  if (remaining <= 0) throw new StagingCleanupError('run_deadline', true)
  const response = await rpc(fn, args, AbortSignal.timeout(remaining)).catch(() => { throw new StagingCleanupError('confirmation_failed', true) })
  if (response.error) throw new StagingCleanupError('confirmation_failed', response.error.status == null || response.error.status === 0 || response.error.status >= 500)
  return response.data
}

/** Abort the real provider request; never replace a timed-out delete with a successful empty response. */
async function provider<T>(work: (signal: AbortSignal) => Promise<T>, deadline = Infinity): Promise<T> {
  const remaining = Math.min(10_000, deadline - Date.now())
  if (remaining <= 0) throw new StagingCleanupError('run_deadline', true)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), remaining)
  try { return await work(controller.signal) }
  catch (error) {
    if (controller.signal.aborted) throw new StagingCleanupError('storage_timeout', true)
    if (error instanceof ObjectStorageError && error.status === 404) throw error
    throw new StagingCleanupError('storage_failed', !(error instanceof ObjectStorageError) || error.status === 0 || error.status >= 500)
  } finally { clearTimeout(timer) }
}

/** Only the service entry calls this. The database grants one bounded run, once; jobs execute sequentially. */
export async function handleStagingCleanup(deps: Deps) {
  const deadline = Date.now() + 120_000
  const invoke = (fn: string, args: Record<string, unknown> = {}) => call(deps.serviceRpc, fn, args, deadline)
  const result = { admitted: false, claimed: 0, deleted: 0, failed: 0, unconfirmed: 0 }
  const begin = await invoke('file_staging_cleanup_run_begin') as {
    admitted?: unknown; run_token?: unknown; batch_limit?: unknown; concurrency?: unknown
  }
  if (begin?.admitted === false && begin.batch_limit === 5 && begin.concurrency === 1) return result
  if (begin?.admitted !== true || typeof begin.run_token !== 'string' || !uuid.test(begin.run_token)
      || begin.batch_limit !== 5 || begin.concurrency !== 1) throw new StagingCleanupError('invalid_run_receipt', true)
  result.admitted = true
  const run = begin.run_token
  let keepLease = false
  const renew = async () => {
    if (await invoke('file_staging_cleanup_run_renew', { p_run: run }) !== true)
      throw new StagingCleanupError('run_expired', true)
  }
  try {
    const data = deps.claim
      ? await invoke('file_managed_staging_claim', { ...deps.claim, p_run: run })
      : await invoke('file_staging_cleanup_claim', { p_run: run })
    if (!Array.isArray(data) || data.length > 5 || data.some((job: Job) => !job || !staging.test(job.staging_key)
        || (deps.claim && job.upload_id !== null && typeof job.upload_id !== 'string')
        || !uuid.test(job.claim_token) || !Number.isSafeInteger(job.attempt_count) || job.attempt_count < 1)
        || new Set(data.map((job: Job) => job.staging_key)).size !== data.length)
      throw new StagingCleanupError('invalid_claim_receipt', true)
    const jobs = data as Job[]
    result.claimed = jobs.length
    for (const job of jobs) {
      try {
        await renew()
        if (deps.prepare) {
          await provider(signal => deps.prepare!(job.staging_key, job.upload_id, signal), deadline)
          await renew()
        }
        try { await provider(signal => deps.objects.remove(job.staging_key, signal), deadline) }
        catch (error) { if (!(error instanceof ObjectStorageError && error.status === 404)) throw error }
        await renew()
        if (await provider(signal => deps.objects.exists(job.staging_key, signal), deadline)) throw new StagingCleanupError('still_present')
        await renew()
        const finished = await invoke('file_staging_cleanup_finish', {
          p_run: run, p_key: job.staging_key, p_claim: job.claim_token,
        })
        if (finished !== true && finished !== false) throw new StagingCleanupError('confirmation_failed', true)
        result.deleted++
      } catch (error) {
        result.failed++
        const known = error instanceof StagingCleanupError ? error : new StagingCleanupError('storage_failed')
        if (known.uncertain) { keepLease = true; result.unconfirmed++ }
        const code = ['storage_failed', 'storage_timeout', 'still_present'].includes(known.code) ? known.code : 'confirmation_failed'
        try {
          const recorded = await invoke('file_staging_cleanup_fail', {
            p_run: run, p_key: job.staging_key, p_claim: job.claim_token, p_error: code,
          })
          if (recorded !== true) { keepLease = true; result.unconfirmed++ }
        } catch { keepLease = true; result.unconfirmed++ }
        if (known.uncertain || known.code === 'run_expired') break
      }
    }
    return result
  } catch (error) {
    keepLease = true
    throw error
  } finally {
    if (!keepLease) {
      try {
        if (await invoke('file_staging_cleanup_run_end', { p_run: run }) !== true) {
          result.unconfirmed++; keepLease = true
        }
      }
      catch { result.unconfirmed++; keepLease = true }
    }
    // No object names, account identities, provider bodies, URLs or exception text.
    try { deps.log('staging_cleanup_result', { ...result, lease_retained: keepLease }) } catch { /* telemetry must not replace the result */ }
  }
}

export async function handleStagingCleanupControl(rpc: Rpc, route: string, body: Record<string, unknown>) {
  if (route === 'staging-cleanup-status') {
    if (Object.keys(body).some(key => key !== 'keys')) throw new StagingCleanupError('invalid_controls')
    if (body.keys == null) return await call(rpc, 'file_staging_cleanup_status')
    if (!Array.isArray(body.keys) || body.keys.length < 1 || body.keys.length > 500
        || body.keys.some(key => typeof key !== 'string' || !staging.test(key)) || new Set(body.keys).size !== body.keys.length)
      throw new StagingCleanupError('invalid_controls')
    return await call(rpc, 'file_staging_cleanup_scope_status', { p_keys: body.keys })
  }
  if (route === 'staging-cleanup-configure') {
    if (typeof body.enabled !== 'boolean' || typeof body.single_batch !== 'boolean'
        || Object.keys(body).some(key => !['enabled', 'single_batch', 'keys'].includes(key))) throw new StagingCleanupError('invalid_controls')
    if (body.keys != null && (!Array.isArray(body.keys) || body.keys.length < 1 || body.keys.length > 500
        || body.keys.some(key => typeof key !== 'string' || !staging.test(key)) || new Set(body.keys).size !== body.keys.length))
      throw new StagingCleanupError('invalid_controls')
    return await call(rpc, 'configure_file_staging_cleanup', { p_enabled: body.enabled, p_single_batch: body.single_batch, p_keys: body.keys ?? null })
  }
  if (route !== 'staging-cleanup-evidence') throw new StagingCleanupError('invalid_route')
  const fields = ['staging_key', 'reservation_id', 'blob_id', 'permit_expires_at', 'terminal_at', 'terminal_sha256', 'publication_sha256', 'publication_at']
  if (Object.keys(body).some(key => !fields.includes(key)) || typeof body.staging_key !== 'string' || !staging.test(body.staging_key)
      || typeof body.reservation_id !== 'string' || !uuid.test(body.reservation_id) || typeof body.blob_id !== 'string' || !uuid.test(body.blob_id)
      || typeof body.terminal_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(body.terminal_sha256)) throw new StagingCleanupError('invalid_evidence')
  for (const key of ['permit_expires_at', 'terminal_at']) {
    if (typeof body[key] !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(body[key] as string)
        || !Number.isFinite(Date.parse(body[key] as string))) throw new StagingCleanupError('invalid_evidence')
  }
  if (body.publication_sha256 != null && (typeof body.publication_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(body.publication_sha256)))
    throw new StagingCleanupError('invalid_evidence')
  if (body.publication_at != null && (typeof body.publication_at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(body.publication_at)
      || !Number.isFinite(Date.parse(body.publication_at)))) throw new StagingCleanupError('invalid_evidence')
  const recorded = await call(rpc, 'file_staging_cleanup_evidence', {
    p_key: body.staging_key, p_reservation: body.reservation_id, p_blob: body.blob_id,
    p_permit_expires_at: body.permit_expires_at, p_terminal_at: body.terminal_at, p_terminal_sha256: body.terminal_sha256,
    p_publication_sha256: body.publication_sha256 ?? null, p_publication_at: body.publication_at ?? null,
  })
  if (typeof recorded !== 'boolean') throw new StagingCleanupError('invalid_evidence_receipt', true)
  return { recorded }
}
