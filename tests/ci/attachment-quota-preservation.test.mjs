import assert from 'node:assert/strict'
import test from 'node:test'
import { auditQuotaSnapshots, quotaWriterSignatures } from '../installation/attachment-quota-preservation.mjs'

// Synthetic catalog rows test the verifier's refusal behavior only. The real
// before/after SQL bodies and ACLs are captured separately by installation CI.
const admission = '    -- #359: quota admission before any file row lock.\n'
  + '    PERFORM pg_catalog.pg_advisory_xact_lock(\n'
  + "        pg_catalog.hashtextextended('gugu:file-transfer:quota',0));\n"
const hex = source => Buffer.from(source).toString('hex')
const source = row => Buffer.from(row.body_utf8_hex, 'hex').toString('utf8')
function snapshots() {
  const before = quotaWriterSignatures.map((signature, index) => ({
    oid: String(index + 1), signature,
    body_utf8_hex: hex("\nBEGIN\n    IF p_lock THEN\n        RAISE NOTICE '旧体 é';\n    END IF;\nEND\n"),
    acl: [{ grantor: '10', grantee: '20', privilege: 'EXECUTE', grantable: false }],
    metadata: { oid: String(index + 1), proowner: '10', prosecdef: true, proconfig: ['search_path=""'] },
  }))
  const after = structuredClone(before)
  for (const row of after) {
    let insertion = admission, anchor = 'BEGIN\n'
    if (row.signature === 'chat.messages_file_ref()') insertion = "    IF TG_OP='INSERT' AND (NEW.content_type='attachment'\n"
      + '        OR NEW.file_item_id IS NOT NULL OR NEW.file_blob_id IS NOT NULL) THEN\n' + admission + '    END IF;\n'
    else if (row.signature.startsWith('chat.send_message_idempotent(')) insertion = "    IF p_content_type='attachment' OR p_file_item_id IS NOT NULL\n"
      + '        OR p_file_blob_id IS NOT NULL THEN\n' + admission + '    END IF;\n'
    else if (row.signature.startsWith('chat.workspace_item_for(')) anchor = '    IF p_lock THEN\n'
    row.body_utf8_hex = hex(source(row).replace(anchor, anchor + insertion))
  }
  return { before, after }
}

test('audit requires all 24 real body comparisons, including conditional write entries', () => {
  const { before, after } = snapshots(), report = auditQuotaSnapshots(before, after)
  assert.equal(report.passed, true)
  assert.equal(report.functions.length, 24)
  for (const row of report.functions) {
    assert.equal(row.before_sha256, row.restored_sha256)
    assert.notEqual(row.before_sha256, row.after_sha256)
    assert.equal(row.acl_identical, true)
  }
})

test('a single extra whitespace byte or visually equivalent Unicode edit is refused', () => {
  for (const edit of [text => text + ' ', text => text.replace('é', 'e\u0301')]) {
    const { before, after } = snapshots()
    after[0].body_utf8_hex = hex(edit(source(after[0])))
    const report = auditQuotaSnapshots(before, after)
    assert.equal(report.passed, false)
    assert.ok(report.functions[0].errors.includes('body_bytes'))
  }
})

test('missing, duplicated or misplaced admission is refused even if stripping it would restore the body', () => {
  for (const edit of [
    text => text.replace(admission, ''),
    text => text.replace(admission, admission + admission),
    text => text.replace(admission, '') + admission,
  ]) {
    const { before, after } = snapshots()
    after[0].body_utf8_hex = hex(edit(source(after[0])))
    assert.equal(auditQuotaSnapshots(before, after).passed, false)
  }
})

test('changing a grantor, principal, grant option or owner fails the audit', () => {
  for (const edit of [
    row => { row.acl[0].grantor = '30' },
    row => { row.acl[0].grantee = '0' },
    row => { row.acl[0].grantable = true },
    row => { row.metadata.proowner = '30' },
    row => { row.metadata.prosecdef = false },
  ]) {
    const { before, after } = snapshots()
    edit(after[0])
    assert.equal(auditQuotaSnapshots(before, after).passed, false)
  }
})

test('missing and duplicate targets cannot silently reduce the reviewed inventory', () => {
  for (const edit of [rows => rows.slice(1), rows => [...rows, rows[0]]]) {
    const { before, after } = snapshots()
    assert.equal(auditQuotaSnapshots(before, edit(after)).passed, false)
  }
})

test('an unrelated body edit, extra function or removed function fails the scoped catalog check', () => {
  for (const change of ['edit', 'add', 'remove']) {
    const { before, after } = snapshots()
    const unrelated = { ...structuredClone(before[0]), oid: '999', signature: null }
    before.push(unrelated)
    if (change !== 'remove') after.push({ ...unrelated, body_utf8_hex: change === 'edit' ? hex('BEGIN NULL; END') : unrelated.body_utf8_hex })
    if (change === 'add') after.push({ ...unrelated, oid: '1000' })
    const report = auditQuotaSnapshots(before, after)
    assert.equal(report.passed, false)
    assert.ok(report.errors.includes('unexpected_catalog_changes'))
  }
})
