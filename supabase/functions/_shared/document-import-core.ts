import { type AttachmentsDeps, call, objectStorage, Refusal } from './attachments-core.ts'
import { inspectFileStream } from './file-inspection.ts'
import { ObjectStorageError } from './object-storage.ts'
// Byte-identical copies of the client's packages/core/src/shared/{workspaceUpload,imageMime}.mjs at the commit pinned in
// client-shared/source.json (tests/unit/client-shared checks the bytes). Vendored for Edge runtime reliability.
import { WORKSPACE_TEXT_MAX_BYTES, workspaceUploadKind } from './client-shared/workspaceUpload.mjs'

export { WORKSPACE_TEXT_MAX_BYTES }
export { workspaceUploadKind }

/** Unreadable source bytes: the row is recorded and passed over, the rest of the batch goes on. */
const SKIPPED_READS = new Set(['source_unavailable', 'source_changed'])

/**
 * Service-only, resumable migration. Existing items and their immutable byte versions keep their identities. A row whose
 * stored bytes cannot be read is returned in `skipped` and passed over; anything else still stops the batch. Each row's
 * decision comes back in `items`; `dry_run` reads and classifies exactly as a run does and writes nothing.
 */
export async function handleDocumentImport(deps: AttachmentsDeps, body: Record<string, unknown>) {
  const after = body.after ?? null
  const types = body.content_types
  const dryRun = body.dry_run === true
  if (types !== undefined && (!Array.isArray(types) || !types.length || types.some(type => typeof type !== 'string'))) {
    throw new Refusal(400, 'invalid', 'content_types must be a nonempty array of MIME types')
  }
  if (after !== null && (typeof after !== 'string' || !/^[0-9a-f-]{36}$/i.test(after))) {
    throw new Refusal(400, 'invalid', 'after must be an item UUID')
  }
  const rows = await call(deps.serviceRpc, 'workspace_document_import_candidates', { p_after: after, p_limit: 20 }) as {
    id: string; version: number; blob_id: string; filename: string; content_type: string
    bucket_id: string; object_name: string; size_bytes: number | string; sha256: string | null
  }[]
  let imported = 0
  const skipped: { id: string; code: string; message: string }[] = []
  const items: { id: string; filename: string; content_type: string; size_bytes: number; decision: 'import' | 'keep_file' | 'skip'; reason: string }[] = []
  for (const row of rows) try {
    const decided = (decision: typeof items[number]['decision'], reason: string) =>
      items.push({ id: row.id, filename: row.filename, content_type: row.content_type, size_bytes: Number(row.size_bytes), decision, reason })
    let read
    try {
      if (row.bucket_id === 'oss') {
        const store = objectStorage(deps)
        if (!store.inspect) throw new Refusal(503, 'not_configured', 'Object inspection is not configured')
        read = await store.inspect(row.object_name, deps.textFiles.maxBytes, deps.textFiles.maxBytes + 1)
      } else {
        const signed = await deps.storageSignedUrl(row.bucket_id, row.object_name, 60)
        const response = await deps.fetch(signed, { signal: AbortSignal.timeout(30_000) })
        if (!response.ok || !response.body) throw new Refusal(response.status || 502, 'source_unavailable', 'Stored bytes could not be read')
        read = await inspectFileStream(response.body, deps.textFiles.maxBytes, deps.textFiles.maxBytes + 1)
      }
      if (row.sha256 !== null && read.sha256 !== row.sha256 || read.sizeBytes !== Number(row.size_bytes) || read.bytes.length !== read.sizeBytes) {
        throw new Refusal(409, 'source_changed', 'Stored bytes do not match the version being imported')
      }
    } catch (error) {
      if (error instanceof ObjectStorageError && error.status === 413 && error.code === 'too_large') {
        decided('keep_file', `over the ${deps.textFiles.maxBytes / 1024 / 1024} MiB of a live text file`)
        continue
      }
      // Signing an object that is gone, or the network failing on its bytes, is a read failure too; a configuration
      // refusal is not, and stops the batch.
      const refusal = error instanceof Refusal ? error
        : new Refusal(502, 'source_unavailable', `Stored bytes could not be read: ${error instanceof Error ? error.message : String(error)}`)
      if (!SKIPPED_READS.has(refusal.code)) throw refusal
      skipped.push({ id: row.id, code: refusal.code, message: `item ${row.id}: ${refusal.message}` })
      decided('skip', refusal.code)
      continue
    }
    const document = deps.textFiles.classify(row.filename, row.content_type, read.bytes)
    if (document.kind !== 'document' || types && !types.includes(document.contentType)) {
      decided('keep_file', document.kind === 'document' ? `type ${document.contentType} not requested` : document.why ?? 'not text')
      continue
    }
    decided('import', document.contentType)
    if (dryRun) continue
    if (await call(deps.serviceRpc, 'workspace_import_document', {
      p_item: row.id, p_version: row.version, p_blob: row.blob_id,
      p_document: { text: document.text, content_type: document.contentType },
    })) imported++
  } catch (error) {
    if (error instanceof Refusal) error.message = `item ${row.id}: ${error.message}`
    throw error
  }
  return { scanned: rows.length, imported, skipped, items, dry_run: dryRun, after: rows.at(-1)?.id ?? after, done: rows.length < 20 }
}
