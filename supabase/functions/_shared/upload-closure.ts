import { type AttachmentsDeps, call, objectStorage, Refusal } from './attachments-core.ts'
import type { AttachmentStorageConfig } from './attachment-storage-config.ts'

interface Candidate {
  reservation_id: string
  staging_key: string
  account_id: string
  upload_id: string | null
  evidence: string
  held_bytes: number
}

/** Both the periodic kick and an operator's bounded replay use the same service-only selection and cleanup. */
export async function sweepManagedUploads(deps: AttachmentsDeps, storage: AttachmentStorageConfig, project: string,
  report: boolean, ids: unknown = null, limit: unknown = 50, run: unknown = deps.uuid(), expectedEvidence?: unknown) {
  const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i
  if (typeof run !== 'string' || !uuid.test(run) || !Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 500
    || (ids !== null && (!Array.isArray(ids) || ids.length > 500 || ids.some(id => typeof id !== 'string'
      || !uuid.test(id))))) {
    throw new Refusal(400, 'invalid', 'Invalid cleanup run, batch limit or reservation IDs')
  }
  const namespace = storage.kind === 'oss'
    ? { provider: 'oss', region: storage.oss.region, bucket: storage.oss.bucket, prefix: storage.oss.objectPrefix ?? '' }
    : { provider: 'supabase', project, bucket: storage.bucket }
  const rows = await call(deps.serviceRpc, 'file_managed_upload_closable', {
    p_namespace: namespace, p_limit: limit, p_report: report, p_ids: ids,
  }) as Candidate[]
  if (report) return { candidates: rows, selected: rows.length }
  if (expectedEvidence !== undefined && rows.some(row => row.evidence !== expectedEvidence)) {
    throw new Refusal(409, 'conflict', 'Managed upload proof changed after the report')
  }
  const store = objectStorage(deps)
  const failures: string[] = []
  for (const row of rows) {
    try {
      if (row.staging_key !== `staging/${row.account_id}/${row.reservation_id}` || !store.removeStaging) {
        throw new Error('Unverified staging identity or storage adapter')
      }
      await store.removeStaging(row.staging_key, row.upload_id)
      await call(deps.serviceRpc, 'file_managed_upload_closed', { p_key: row.staging_key, p_evidence: `sweep:${run}:${row.evidence}` })
    } catch (error) {
      failures.push(row.reservation_id)
      deps.log('upload_closure_failed', { id: row.reservation_id, message: String(error) })
    }
  }
  return { run, selected: rows.length, confirmed: rows.length - failures.length, failed: failures }
}
