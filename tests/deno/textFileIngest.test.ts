import { handleCommit, handlePlace, Refusal, type AttachmentsDeps } from '../../supabase/functions/_shared/attachments-core.ts'
import { inspectFileStream } from '../../supabase/functions/_shared/file-inspection.ts'
import { handleDocumentImport, WORKSPACE_TEXT_MAX_BYTES, workspaceUploadKind } from '../../supabase/functions/_shared/document-import-core.ts'

const assert = (ok: unknown, message: string) => { if (!ok) throw new Error(message) }
const user = '11111111-1111-4111-8111-111111111111'
const key = `staging/${user}/22222222-2222-4222-8222-222222222222`
const text = '# 同一份正文\n' + '非 ASCII 内容在 512 字节之后仍完整。\n'.repeat(80)
const encode = (text: string) => new TextEncoder().encode(text)

function fixture(bytes: Uint8Array) {
  const calls: { fn: string; args: Record<string, unknown> }[] = []
  const deps = {
    textFiles: { maxBytes: WORKSPACE_TEXT_MAX_BYTES, classify: workspaceUploadKind },
    objects: {
      inspect: async (_key: string, limit: number, retain: number) => ({
        ...await inspectFileStream(new ReadableStream({ start(c) {
          c.enqueue(bytes.subarray(0,511)); c.enqueue(bytes.subarray(511)); c.close()
        }}), limit, retain), etag: '"immutable"',
      }),
      promote: async () => {}, exists: async () => true,
    },
    serviceRpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args })
      return { data: fn === 'file_managed_upload_for' ? { max_bytes: bytes.length } : [{ created: false }], error: null }
    },
    userRpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args }); return { data: [{ id: 'result' }], error: null }
    },
  } as unknown as AttachmentsDeps
  return { deps, calls }
}

Deno.test('human attachment, agent attachment and folder upload register the same complete document', async () => {
  for (const entry of ['human', 'agent', 'folder']) {
    const f = fixture(encode(text))
    const body = { staging_key: key, file_name: '中文.md', content_type: 'application/octet-stream',
      chat_id: 'group', sender_user_id: entry === 'agent' ? 'agent' : user }
    if (entry === 'folder') await handlePlace(f.deps, user, body)
    else await handleCommit(f.deps, user, { ...body, message_id: 'message' })
    const registered = f.calls.find(c => c.fn === 'file_managed_upload_registered')!
    const document = registered.args.p_document as { text: string; content_type: string }
    assert(document.text === text, `${entry} retains the entire text`)
    assert(document.content_type === 'text/markdown', `${entry} uses the canonical suffix rule`)
    assert(f.calls.filter(c => c.fn === 'file_blob_register').length === 1, `${entry} uses one blob registration`)
    assert(f.calls.findIndex(c => c.fn === 'file_managed_upload_scope') === 0, `${entry} authorizes before inspection`)
  }
})

Deno.test('binary, malformed UTF-8/JSON and over-limit text keep the original binary admission', async () => {
  for (const [name, type, bytes] of [
    ['real.bin', 'application/octet-stream', new Uint8Array([0xff, 0x00, 0x80])],
    ['broken.md', 'text/markdown', new Uint8Array([0xff, 0xfe])],
    ['array.json', 'application/json', encode('[]')],
    ['large.md', 'text/markdown', new Uint8Array(WORKSPACE_TEXT_MAX_BYTES + 2).fill(65)],
  ] as const) {
    const f = fixture(bytes)
    await handlePlace(f.deps, user, { staging_key: key, chat_id: 'group', file_name: name, content_type: type })
    assert(f.calls.find(c => c.fn === 'file_managed_upload_registered')!.args.p_document === null, name)
    assert(f.calls.some(c => c.fn === 'file_place_as'), `${name} still uses ordinary file placement`)
  }
})

Deno.test('a formatted JSON object attachment becomes a shared document for human, agent and folder uploads', async () => {
  for (const entry of ['human', 'agent', 'folder']) {
    const f = fixture(encode('{\n  "text": "keep these exact bytes"\n}\n'))
    const body = { staging_key: key, file_name: 'formatted.json', content_type: 'application/json', chat_id: 'group', sender_user_id: entry === 'agent' ? 'agent' : user }
    if (entry === 'folder') await handlePlace(f.deps, user, body)
    else await handleCommit(f.deps, user, { ...body, message_id: 'message' })
    const document = f.calls.find(c => c.fn === 'file_managed_upload_registered')!.args.p_document as { text: string; content_type: string }
    assert(document.text === '{\n  "text": "keep these exact bytes"\n}\n' && document.content_type === 'application/json', `${entry} uses the shared JSON document classification`)
    assert(f.calls.filter(c => c.fn === 'file_blob_register').length === 1, 'the original inspected blob is still registered')
  }
})

Deno.test('CSV and source-code suffixes use the same text-document classifier', () => {
  for (const [filename, contentType, source] of [
    ['report.csv', 'text/csv', 'name,count\nAda,1\n'],
    ['script.py', 'text/x-python', 'print("hello")\n'],
  ]) {
    const classified = workspaceUploadKind(filename, 'application/octet-stream', encode(source))
    assert(classified.kind === 'document' && classified.contentType === contentType && classified.text === source,
      `${filename} follows its suffix in the shared classifier`)
  }
})

Deno.test('a mixed import honors content_types for JSON documents without stalling its cursor', async () => {
  for (const types of [['text/markdown', 'text/plain'], ['text/plain'], ['application/json']]) {
    const f = fixture(encode(text)), imported: string[] = []
    const rows = ['md', 'txt', 'json'].map((suffix, n) => ({ id: `00000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`,
      version: 1, blob_id: 'blob', filename: `file.${suffix}`, content_type: 'application/octet-stream', bucket_id: 'oss',
      object_name: suffix, size_bytes: suffix === 'json' ? encode('{\n  "x": 1\n}\n').length : encode(text).length, sha256: null }))
    const inspect = f.deps.objects!.inspect!
    f.deps.objects!.inspect = async (object, limit, retain) => object === 'json'
      ? { ...await inspectFileStream(new Response(encode('{\n  "x": 1\n}\n')).body!, limit, retain), etag: '"immutable"' }
      : inspect(object, limit, retain)
    f.deps.serviceRpc = async (fn, args) => {
      f.calls.push({ fn, args })
      if (fn === 'workspace_document_import_candidates') return { data: rows.filter(row => row.id > String(args.p_after ?? '')), error: null }
      imported.push(String(args.p_item)); return { data: true, error: null }
    }
    const result = await handleDocumentImport(f.deps, { content_types: types })
    const expected = types.includes('text/markdown') ? [rows[0].id, rows[1].id]
      : types.includes('text/plain') ? [rows[1].id]
      : types.includes('application/json') ? [rows[2].id] : []
    assert(JSON.stringify(imported) === JSON.stringify(expected), 'only requested document MIME types reach the existing import RPC')
    assert(result.scanned === 3 && result.imported === expected.length && result.after === rows[2].id && result.done, 'the cursor advances past excluded JSON')
    const next = await handleDocumentImport(f.deps, { after: result.after, content_types: types })
    assert(next.scanned === 0 && next.imported === 0 && next.done, 'resumption does not get stuck on an excluded type')
  }
})

Deno.test('a storage adapter returning only its sniffing prefix cannot silently truncate a document', async () => {
  const f = fixture(encode(text))
  f.deps.objects!.inspect = async () => ({ bytes: encode(text).subarray(0,512), sizeBytes: encode(text).length,
    sha256: 'a'.repeat(64), etag: '"immutable"' })
  let refused = false
  try { await handlePlace(f.deps, user, { staging_key: key, chat_id: 'group', file_name: '正文.md' }) }
  catch (error) { refused = (error as { code?: string }).code === 'not_configured' }
  assert(refused, 'partial inspection fails before registration or placement')
  assert(!f.calls.some(c => c.fn === 'file_blob_register' || c.fn === 'file_place_as'), 'no truncated bytes were admitted')
})

Deno.test('old OSS and legacy storage files migrate in place through the same classifier without changing the blob or version', async () => {
  for (const bucket of ['oss', 'workspace']) {
    const f = fixture(encode(text))
    f.deps.storageSignedUrl = async (actual, object) => {
      assert(actual === bucket && object === 'old-object', 'the original storage location is used')
      return 'https://legacy.invalid/old-object'
    }
    f.deps.fetch = async () => new Response(encode(text))
    f.deps.serviceRpc = async (fn, args) => {
      f.calls.push({ fn, args })
      return { data: fn === 'workspace_document_import_candidates' ? [{ id: user, version: 7, blob_id: 'original-blob',
        filename: '旧附件.md', content_type: 'text/markdown', bucket_id: bucket, object_name: 'old-object',
        size_bytes: encode(text).length, sha256: null }] : true, error: null }
    }
    const result = await handleDocumentImport(f.deps, {})
    assert(result.imported === 1 && result.done, 'one in-place conversion')
    const imported = f.calls.find(c => c.fn === 'workspace_import_document')!
    assert(imported.args.p_item === user && imported.args.p_version === 7 && imported.args.p_blob === 'original-blob', 'identity, version and immutable bytes remain the same')
    assert((imported.args.p_document as { text: string }).text === text, 'complete text reaches the existing document model')
  }
})

Deno.test('old-data conversion skips mismatched stored bytes without changing the item', async () => {
  const f = fixture(encode(text))
  f.deps.serviceRpc = async (fn, args) => {
    f.calls.push({ fn, args })
    return { data: [{ id: user, version: 7, blob_id: 'blob', filename: 'old.md', bucket_id: 'oss',
      object_name: 'old', size_bytes: 1, sha256: null }], error: null }
  }
  const result = await handleDocumentImport(f.deps, {})
  assert(result.skipped.length === 1 && result.skipped[0].code === 'source_changed' && result.skipped[0].id === user, 'the mismatch is recorded')
  assert(!f.calls.some(c => c.fn === 'workspace_import_document'), 'immutable source is checked before conversion')
})

Deno.test('a stored object over the live-document limit stays a file without stopping the dry run', async () => {
  const large = new Uint8Array(WORKSPACE_TEXT_MAX_BYTES + 1).fill(65)
  const f = fixture(large), id = '00000000-0000-4000-8000-000000000001'
  f.deps.serviceRpc = async (fn, args) => {
    f.calls.push({ fn, args })
    return { data: fn === 'workspace_document_import_candidates' ? [{ id, version: 1, blob_id: 'blob', filename: 'large.md',
      content_type: 'text/markdown', bucket_id: 'oss', object_name: 'large', size_bytes: large.length, sha256: null }] : true, error: null }
  }
  const result = await handleDocumentImport(f.deps, { dry_run: true })
  assert(result.items.length === 1 && result.items[0].decision === 'keep_file', 'over-limit bytes are not eligible for document conversion')
  assert(result.skipped.length === 0 && result.done, 'a known oversized object is a keep-file decision, not an unreadable source')
  assert(!f.calls.some(c => c.fn === 'workspace_import_document'), 'dry-run never writes')
})

Deno.test('old-data conversion resumes from its last completed cursor and repeated conversion is harmless', async () => {
  const f = fixture(encode(text))
  const rows = Array.from({ length: 21 }, (_, n) => ({ id: `00000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`,
    version: 1, blob_id: `blob-${n}`, filename: 'old.md', content_type: 'text/markdown', bucket_id: 'oss',
    object_name: 'original-object', size_bytes: encode(text).length, sha256: null }))
  const imported = new Set<string>()
  f.deps.serviceRpc = async (fn, args) => {
    f.calls.push({ fn, args })
    if (fn === 'workspace_document_import_candidates') return { data: rows.filter(row => row.id > String(args.p_after ?? '')).slice(0, 20), error: null }
    const id = String(args.p_item), changed = !imported.has(id)
    imported.add(id)
    return { data: changed, error: null }
  }
  const first = await handleDocumentImport(f.deps, {})
  assert(first.scanned === 20 && first.imported === 20 && !first.done, 'first completed batch provides a durable caller cursor')
  const resumed = await handleDocumentImport(f.deps, { after: first.after })
  assert(resumed.scanned === 1 && resumed.imported === 1 && resumed.done, 'resume processes the remaining file')
  const repeated = await handleDocumentImport(f.deps, {})
  assert(repeated.imported === 0 && imported.size === 21, 'repeating an already completed conversion changes nothing')
})

Deno.test('an unreadable item is recorded and passed over; the batch goes on to the next one', async () => {
  for (const [code, how] of [['source_changed', 'size'], ['source_unavailable', 'status'], ['source_unavailable', 'unsigned'], ['source_unavailable', 'network']]) {
    const f = fixture(encode(text)), bad = '00000000-0000-4000-8000-000000000001'
    const good = '00000000-0000-4000-8000-000000000002'
    const rows = [bad, good].map(id => ({ id, version: 1, blob_id: 'blob', filename: 'old.md',
      content_type: 'text/markdown', bucket_id: 'workspace', object_name: id,
      size_bytes: id === bad && how === 'size' ? 1 : encode(text).length, sha256: null }))
    f.deps.storageSignedUrl = async (_bucket, object) => {
      // A Storage object that is gone cannot even be signed (`signStorage` throws a plain Error).
      if (object === bad && how === 'unsigned') throw new Error('Could not sign a managed Storage download')
      return `https://legacy.invalid/${object}`
    }
    f.deps.fetch = async url => {
      if (!String(url).endsWith(bad)) return new Response(encode(text))
      if (how === 'network') throw new TypeError('error sending request')
      return how === 'status' ? new Response(null, { status: 503 }) : new Response(encode(text))
    }
    f.deps.serviceRpc = async (fn, args) => {
      f.calls.push({ fn, args })
      return { data: fn === 'workspace_document_import_candidates'
        ? rows.filter(row => row.id > String(args.p_after ?? '')) : true, error: null }
    }
    const result = await handleDocumentImport(f.deps, {})
    assert(result.skipped.length === 1 && result.skipped[0].id === bad && result.skipped[0].code === code
      && result.skipped[0].message.includes(bad), `${how}: the bad item is recorded with its id`)
    assert(result.imported === 1 && result.after === good && result.done, `${how}: the following item is still imported`)
    const writes = f.calls.filter(c => c.fn === 'workspace_import_document')
    assert(writes.length === 1 && writes[0].args.p_item === good, `${how}: the bad item was not changed`)
  }
})

Deno.test('a configuration refusal still stops the batch, naming the item it stopped at', async () => {
  const f = fixture(encode(text)), id = '00000000-0000-4000-8000-000000000001'
  f.deps.objects!.inspect = undefined
  f.deps.serviceRpc = async (fn, args) => {
    f.calls.push({ fn, args })
    return { data: fn === 'workspace_document_import_candidates' ? [{ id, version: 1, blob_id: 'blob', filename: 'old.md',
      content_type: 'text/markdown', bucket_id: 'oss', object_name: 'o', size_bytes: encode(text).length, sha256: null }] : true, error: null }
  }
  let caught: unknown
  try { await handleDocumentImport(f.deps, {}) } catch (error) { caught = error }
  assert(caught instanceof Refusal && caught.code === 'not_configured' && caught.message.includes(id), 'not passed over')
  assert(!f.calls.some(c => c.fn === 'workspace_import_document'), 'nothing written')
})

Deno.test('a dry run reads and classifies every row like a run, lists each decision and writes nothing', async () => {
  const f = fixture(encode(text))
  const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000004']
  const rows = [['笔记.md', text], ['data.json', '{"a":1}'], ['gone.txt', text], ['bin.dat', '\u0000\u00ff']].map(([filename, body], n) =>
    ({ id: ids[n], version: 1, blob_id: 'blob', filename, content_type: 'application/octet-stream', bucket_id: 'workspace',
      object_name: ids[n], size_bytes: encode(body).length, sha256: null, body }))
  f.deps.storageSignedUrl = async (_bucket, object) => `https://legacy.invalid/${object}`
  f.deps.fetch = async url => {
    const row = rows.find(r => String(url).endsWith(r.id))!
    return row.filename === 'gone.txt' ? new Response(null, { status: 404 }) : new Response(encode(row.body))
  }
  f.deps.serviceRpc = async (fn, args) => {
    f.calls.push({ fn, args })
    return { data: fn === 'workspace_document_import_candidates' ? rows : true, error: null }
  }
  const result = await handleDocumentImport(f.deps, { dry_run: true })
  assert(result.dry_run && result.imported === 0 && !f.calls.some(c => c.fn === 'workspace_import_document'), 'nothing written')
  const decisions = Object.fromEntries(result.items.map(item => [item.filename, item.decision]))
  assert(JSON.stringify(decisions) === JSON.stringify({ '笔记.md': 'import', 'data.json': 'import', 'gone.txt': 'skip', 'bin.dat': 'keep_file' }),
    `each row's decision: ${JSON.stringify(decisions)}`)
  assert(result.skipped.length === 1 && result.skipped[0].code === 'source_unavailable', 'the unreadable row is the skipped one')
})

Deno.test('incoming copies drain before the original caller transaction and always finish after success or message failure', async () => {
  for (const rejected of [false, true]) {
    const f = fixture(encode(text)), order: string[] = []
    const original = f.deps.userRpc
    f.deps.userRpc = async (fn, args) => {
      if (fn === 'workspace_get_as') return { data: [{ kind: 'document' }], error: null }
      if (fn === 'attachment_commit') {
        order.push('caller transaction')
        if (rejected) return { data: null, error: { message: 'recipient is not a member', hint: 'file_transfer_denied' } }
      }
      return await original(fn, args)
    }
    f.deps.documentReplacement = async (_item, _actor, body) => { order.push(body.finish ? 'finish' : 'drain') }
    let failed = false
    try { await handleCommit(f.deps, user, { staging_key: key, file_name: 'document.md', chat_id: 'group', sender_user_id: user,
      message_id: 'message', item_id: user, expected_version: 1 }) } catch { failed = true }
    assert(failed === rejected, 'original transaction outcome is preserved')
    assert(order.join(',') === 'drain,caller transaction,finish', 'success and failure both release the one existing drain')
  }
})
