import { type AttachmentsDeps, call, Refusal } from './attachments-core.ts'

/** Service-only configuration: the caller supplies control flags, never keys or URLs. */
export async function configureAttachmentGc(serviceRpc: AttachmentsDeps['serviceRpc'],
  serverUrl: string, serverKey: string, body: Record<string, unknown>) {
  if (!body || typeof body !== 'object' || typeof body.enabled !== 'boolean' || ![5, 50].includes(body.batch_limit as number)) {
    throw new Refusal(400, 'invalid', 'Explicit enabled boolean and batch_limit of 5 or 50 required')
  }
  try {
    return await call(serviceRpc, 'configure_file_blob_gc', {
      p_endpoint: serverUrl.replace(/\/$/, '') + '/functions/v1/attachments/gc',
      p_key: serverKey, p_enabled: body.enabled, p_batch_limit: body.batch_limit,
    })
  } catch { throw new Refusal(500, 'failed', 'Attachment GC configuration failed') }
}
