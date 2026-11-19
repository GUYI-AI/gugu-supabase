import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

export const quotaLockOrderVersion = '20261120060000_attachment_quota_lock_order'
// Reviewed independently of the migration's dynamic CREATE OR REPLACE loop.
// A missing entry or any other changed function must fail, not shrink the audit.
export const quotaWriterSignatures = Object.freeze([
  'chat.attachment_place(text,text,text,text,text,boolean)',
  'chat.attachment_place_version(text,uuid,integer,text,text,text)',
  'chat.attachment_place_forward(text,text,text,text,boolean)',
  'chat.attachment_place_share(uuid,integer,text,text,text)',
  'chat.attachment_item_for(text,uuid,text,text,text)',
  'chat.file_replace_as(text,text,text,integer)',
  'chat.file_upload_take(text)',
  'chat.file_blob_register(text,text,text,bigint,text,integer,integer)',
  'chat.file_blob_settle(text,text,text,text,bigint,text,integer,integer,jsonb)',
  'chat.attachment_declare(text,text,bigint,text,integer,integer,text)',
  'chat.workspace_create_file_as(text,text,text,text,bigint,text,text[],text)',
  'chat.files_record_version(uuid,text,text)',
  'chat.workspace_import_document(uuid,integer,uuid,jsonb)',
  'chat.files_replace_stage(uuid,text,text,text,integer,jsonb,boolean)',
  'file_private.publish_revision(uuid,text,text,text,text,text,bigint,text,text,integer,uuid,integer,integer)',
  'file_private.publish_revision_by(uuid,text,text,text,text,bigint,text,text,integer,uuid,text)',
  'file_private.link_project_message(uuid,text)',
  'chat.send_friend_file_as_owner(text,text,text,text,text,text)',
  'chat.session_attachment_commit(text,uuid,text,text,text[],text)',
  'chat.file_version_handoff_publish(uuid,text,text,bigint)',
  'file_private.storage_mark_audit_base(jsonb,text,text)',
  'chat.send_message_idempotent(text,text,text,text[],text,text,text,text,boolean,boolean,text,uuid,integer,text,uuid)',
  'chat.workspace_item_for(text,text,boolean)',
  'chat.messages_file_ref()',
])
const admission = '    -- #359: quota admission before any file row lock.\n'
  + '    PERFORM pg_catalog.pg_advisory_xact_lock(\n'
  + "        pg_catalog.hashtextextended('gugu:file-transfer:quota',0));\n"

function allowance(signature) {
  if (signature === 'chat.messages_file_ref()') return {
    anchor: 'BEGIN\n',
    insertion: "    IF TG_OP='INSERT' AND (NEW.content_type='attachment'\n"
      + '        OR NEW.file_item_id IS NOT NULL OR NEW.file_blob_id IS NOT NULL) THEN\n'
      + admission + '    END IF;\n',
  }
  if (signature.startsWith('chat.send_message_idempotent(')) return {
    anchor: 'BEGIN\n',
    insertion: "    IF p_content_type='attachment' OR p_file_item_id IS NOT NULL\n"
      + '        OR p_file_blob_id IS NOT NULL THEN\n' + admission + '    END IF;\n',
  }
  return { anchor: signature === 'chat.workspace_item_for(text,text,boolean)' ? '    IF p_lock THEN\n' : 'BEGIN\n', insertion: admission }
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
function body(row) {
  assert.match(row.body_utf8_hex, /^(?:[0-9a-f]{2})*$/, 'snapshot must contain exact UTF-8 hex bytes')
  return Buffer.from(row.body_utf8_hex, 'hex')
}

// This is a reverse check of actual installed bytes, not a comparison against
// the migration's own generated "changed" variable. No whitespace/SQL/Unicode
// normalization and no general replace-all: exactly one allowed fragment at the
// original lock-entry position may be removed.
export function verifyQuotaFunction(before, after) {
  const oldBody = body(before), newBody = body(after)
  const allowed = allowance(before.signature)
  const fragment = Buffer.from(allowed.insertion), anchor = Buffer.from(allowed.anchor)
  const oldAnchor = oldBody.indexOf(anchor), insertedAt = newBody.indexOf(fragment)
  const errors = []
  if (oldAnchor < 0 || (allowed.anchor !== 'BEGIN\n' && oldBody.indexOf(anchor, oldAnchor + 1) >= 0)) errors.push('predecessor_anchor')
  if (oldBody.includes(Buffer.from('#359: quota admission'))) errors.push('already_patched_predecessor')
  if (insertedAt < 0 || newBody.indexOf(fragment, insertedAt + 1) >= 0) errors.push('admission_count')
  if (insertedAt !== oldAnchor + anchor.length) errors.push('admission_position')
  const restored = insertedAt < 0 ? newBody : Buffer.concat([newBody.subarray(0, insertedAt), newBody.subarray(insertedAt + fragment.length)])
  const bodyEqual = restored.equals(oldBody)
  const aclEqual = isDeepStrictEqual(before.acl, after.acl)
  const metadataEqual = isDeepStrictEqual(before.metadata, after.metadata)
  if (!bodyEqual) errors.push('body_bytes')
  if (!aclEqual) errors.push('acl')
  if (!metadataEqual) errors.push('function_metadata')
  return {
    signature: before.signature, oid: before.oid, errors,
    body_bytes_identical_after_removing_allowance: bodyEqual,
    acl_identical: aclEqual, metadata_identical: metadataEqual,
    before_sha256: sha256(oldBody), after_sha256: sha256(newBody), restored_sha256: sha256(restored),
    before_bytes: oldBody.length, after_bytes: newBody.length,
    allowance_offset: insertedAt, allowance_utf8_hex: fragment.toString('hex'),
    before_body_utf8_hex: before.body_utf8_hex, after_body_utf8_hex: after.body_utf8_hex,
    before_acl: before.acl, after_acl: after.acl,
    before_metadata: before.metadata, after_metadata: after.metadata,
  }
}

export function auditQuotaSnapshots(before, after) {
  const errors = [], functions = [], unexpectedChanges = []
  const oldByOid = new Map(before.map(row => [row.oid, row]))
  const newByOid = new Map(after.map(row => [row.oid, row]))
  if (oldByOid.size !== before.length || newByOid.size !== after.length) errors.push('duplicate_catalog_oid')
  for (const signature of quotaWriterSignatures) {
    const old = before.filter(row => row.signature === signature), fresh = after.filter(row => row.signature === signature)
    if (old.length !== 1 || fresh.length !== 1) { errors.push('missing_or_duplicate:' + signature); continue }
    const result = verifyQuotaFunction(old[0], fresh[0])
    functions.push(result)
    if (result.errors.length) errors.push('function_changed:' + signature)
  }
  for (const oid of new Set([...oldByOid.keys(), ...newByOid.keys()])) {
    const old = oldByOid.get(oid), fresh = newByOid.get(oid)
    if (!old || !fresh || (!quotaWriterSignatures.includes(old.signature) && !isDeepStrictEqual(old, fresh))) {
      unexpectedChanges.push({ oid, signature: old?.signature ?? fresh?.signature, change: !old ? 'added' : !fresh ? 'removed' : 'changed' })
    }
  }
  if (unexpectedChanges.length) errors.push('unexpected_catalog_changes')
  if (functions.length !== 24) errors.push('expected_24_functions')
  return { schema_version: 1, release: quotaLockOrderVersion, passed: errors.length === 0,
    expected_functions: 24, audited_functions: functions.length, errors, unexpected_changes: unexpectedChanges, functions }
}

async function snapshot(db) {
  // pg_node_tree defaults carry parser source locations that CREATE OR REPLACE
  // may change. Compare their deparsed expression, while retaining all other
  // catalog attributes (owner, security mode, settings, language, signature).
  return (await db.query(`WITH wanted AS (SELECT signature,to_regprocedure(signature) AS oid FROM unnest($1::text[]) signature)
    SELECT p.oid::text AS oid,w.signature,
      encode(convert_to(p.prosrc,'UTF8'),'hex') AS body_utf8_hex,
      (to_jsonb(p)-'prosrc'-'proacl'-'proargdefaults')
        || jsonb_build_object('default_arguments',pg_get_expr(p.proargdefaults,0)) AS metadata,
      (SELECT COALESCE(jsonb_agg(jsonb_build_object('grantor',a.grantor::text,'grantee',a.grantee::text,
        'privilege',a.privilege_type,'grantable',a.is_grantable)
        ORDER BY a.grantor,a.grantee,a.privilege_type,a.is_grantable),'[]'::jsonb)
       FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a) AS acl
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace LEFT JOIN wanted w ON w.oid=p.oid
    WHERE n.nspname IN ('chat','file_private') ORDER BY p.oid`, [quotaWriterSignatures])).rows
}

export async function installQuotaLockOrderWithEvidence({ db, query, sql, artifactPath = '.local/verification/attachment-quota-359.json' }) {
  let report = { schema_version: 1, release: quotaLockOrderVersion, passed: false, stage: 'before_snapshot' }
  try {
    const before = await snapshot(db)
    assert.equal(before.filter(row => quotaWriterSignatures.includes(row.signature)).length, 24, 'all 24 actual predecessor functions must exist')
    report.stage = 'migration'
    const result = await query(sql)
    report.stage = 'after_snapshot'
    const after = await snapshot(db)
    report = { ...auditQuotaSnapshots(before, after), stage: 'verified', executed_sql_sha256: sha256(sql),
      provenance: { commit: process.env.GITHUB_SHA ?? null, run_id: process.env.GITHUB_RUN_ID ?? null,
        source: 'pg_proc immediately before and after the actual incremental release', utf8: true } }
    assert.equal(report.passed, true, 'quota release changed bytes/ACLs outside its 24 allowed admission fragments; see JSON evidence')
    return result
  } finally {
    mkdirSync(path.dirname(artifactPath), { recursive: true })
    writeFileSync(artifactPath, JSON.stringify(report, null, 2) + '\n')
  }
}
