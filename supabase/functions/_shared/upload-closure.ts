import { call, type Rpc } from './attachments-core.ts'
import type { AttachmentStorageConfig } from './attachment-storage-config.ts'
import { StagingCleanupError } from './staging-cleanup-core.ts'

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i

export function managedStagingRequest(storage: AttachmentStorageConfig, project: string, body: Record<string, unknown>) {
  const namespace = storage.kind === 'oss'
    ? { provider: 'oss', region: storage.oss.region, bucket: storage.oss.bucket, prefix: storage.oss.objectPrefix ?? '' }
    : { provider: 'supabase', project, bucket: storage.bucket }
  const { mode, limit = 5, ids = null, run = null, evidence = null } = body
  if (Object.keys(body).length && (mode !== 'report' && mode !== 'apply'
      || Object.keys(body).some(key => !['mode', 'limit', 'ids', 'run', 'evidence'].includes(key)))
      || !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 500
      || ids !== null && (!Array.isArray(ids) || !ids.length || ids.length > 500 || new Set(ids).size !== ids.length
        || ids.some(id => typeof id !== 'string' || !uuid.test(id)))
      || mode === 'apply' && (ids === null || typeof run !== 'string' || !uuid.test(run)
        || typeof evidence !== 'string' || !/^[A-Za-z0-9_.:-]{1,80}$/.test(evidence))) {
    throw new StagingCleanupError('invalid_controls')
  }
  return { p_namespace: namespace, p_limit: Number(limit), p_ids: ids, p_batch: run, p_evidence: evidence }
}

export async function reportManagedStaging(rpc: Rpc, request: ReturnType<typeof managedStagingRequest>) {
  const { p_namespace, p_limit, p_ids } = request
  const rows = await call(rpc, 'file_managed_upload_closable', { p_namespace, p_limit, p_ids, p_report: true })
  if (!Array.isArray(rows) || rows.length > p_limit) throw new StagingCleanupError('invalid_report_receipt', true)
  return { selected: rows.length, candidates: rows }
}
