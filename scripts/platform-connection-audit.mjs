import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const connectionAuditLimits = Object.freeze({
  items: 2_000, operations: 2_000, inventoryBytes: 16 * 1024 * 1024,
  bodyBytes: 1024 * 1024, totalBodyBytes: 8 * 1024 * 1024,
})
const itemFields = new Set(['providerId', 'accountId', 'displayName', 'configured', 'isDefault', 'checkResult', 'checkedAt', 'permission', 'enabled'])
const markerFields = new Set(['state', 'schemaVersion', 'itemCount', 'errorCode'])
const accountFields = new Set(['version', 'providerId', 'accountId', 'isDefault', 'connectedAt', 'updatedAt', 'host', 'login', 'avatarUrl', 'credentialSource', 'displayName'])
const payloadFields = new Set(['data', 'before', 'deviceId', 'bodyItemId', 'bodySha256', 'deleted'])
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const hashPattern = /^[0-9a-f]{64}$/
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const decimal = value => typeof value === 'string' && /^\d+$/.test(value)
const nullableText = value => value === null || typeof value === 'string'
const digest = value => createHash('sha256').update(value).digest('hex')
const fail = code => { throw Object.assign(new Error(code), { code }) }

/** The manifest never contains body text or unknown metadata values. */
export function stableConnectionJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableConnectionJson).join(',')}]`
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableConnectionJson(value[key])}`).join(',')}}`
  if (value === undefined || typeof value === 'number' && !Number.isFinite(value)) fail('CONNECTION_AUDIT_INVALID_JSON')
  return JSON.stringify(value)
}

function metadata(value, allowed) {
  if (!record(value)) fail('CONNECTION_AUDIT_INVALID_METADATA')
  for (const [key, entry] of Object.entries(value)) {
    if (!allowed.has(key) || record(entry) || Array.isArray(entry)
      || entry === undefined || typeof entry === 'number' && !Number.isFinite(entry)) fail('CONNECTION_AUDIT_UNSUPPORTED_METADATA')
  }
  if (Buffer.byteLength(stableConnectionJson(value)) > 262_144) fail('CONNECTION_AUDIT_METADATA_TOO_LARGE')
  return value
}

// A provider directory row may also carry the provider's public category and
// search aliases ({categoryId, aliases?}), the same bounded shape as
// identity.assistant_panel_validate; no other row kind may.
const catalogIdentifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
function directoryMetadata(value) {
  if (!record(value)) fail('CONNECTION_AUDIT_INVALID_METADATA')
  const { catalog, ...fields } = value
  metadata(fields, itemFields)
  if (catalog !== undefined && catalog !== null && (!record(catalog)
    || Object.keys(catalog).some(key => key !== 'categoryId' && key !== 'aliases')
    || typeof catalog.categoryId !== 'string' || !catalogIdentifier.test(catalog.categoryId)
    || 'aliases' in catalog && (!Array.isArray(catalog.aliases) || catalog.aliases.length > 32
      || catalog.aliases.some(alias => typeof alias !== 'string' || [...alias].length < 1 || [...alias].length > 128
        || /[\u0000-\u001f\u007f-\u009f]/.test(alias)))))
    fail('CONNECTION_AUDIT_UNSUPPORTED_METADATA')
  if (Buffer.byteLength(stableConnectionJson(value)) > 262_144) fail('CONNECTION_AUDIT_METADATA_TOO_LARGE')
  return value
}

function payload(value, directory) {
  if (!record(value)) fail('CONNECTION_AUDIT_INVALID_OPERATION')
  for (const [key, entry] of Object.entries(value)) {
    if (!payloadFields.has(key)) fail('CONNECTION_AUDIT_UNSUPPORTED_OPERATION')
    if (key === 'data' || key === 'before') directory ? directoryMetadata(entry) : metadata(entry, itemFields)
    else if (!nullableText(entry) && typeof entry !== 'boolean') fail('CONNECTION_AUDIT_INVALID_OPERATION')
  }
  return value
}

/** Accepts the complete read-only export, including tombstones and terminal failures.
 * A regular visible panel snapshot is deliberately insufficient for migration. */
export async function auditConnectionInventory(source, { readBody } = {}) {
  if (!record(source) || source.version !== 1 || source.complete !== true || !uuid.test(source.ownerId) || !hashPattern.test(source.databaseDigest ?? '')
    || !['found', 'none'].includes(source.identityState) || !decimal(source.headRevision)
    || !Array.isArray(source.items) || !Array.isArray(source.operations)) fail('CONNECTION_AUDIT_INCOMPLETE_SOURCE')
  if (source.identityState === 'found' && !uuid.test(source.assistantId)
    || source.identityState === 'none' && (source.assistantId !== null || source.items.length || source.operations.length || source.headRevision !== '0'))
    fail('CONNECTION_AUDIT_INVALID_IDENTITY')
  if (source.items.length > connectionAuditLimits.items || source.operations.length > connectionAuditLimits.operations)
    fail('CONNECTION_AUDIT_TOO_MANY_RECORDS')
  // Tombstones of removed (reinstalled) assistants are imported; the source lists
  // those assistants. A prepared candidate keeps each row's assistant but no list.
  const removedAssistants = source.removedAssistants === undefined ? null : source.removedAssistants
  if (removedAssistants !== null && (!record(removedAssistants) || !Array.isArray(removedAssistants.assistantIds)
    || removedAssistants.assistantIds.some(id => !uuid.test(id) || id === source.assistantId))) fail('CONNECTION_AUDIT_INCOMPLETE_SOURCE')
  if (Buffer.byteLength(stableConnectionJson(source)) > connectionAuditLimits.inventoryBytes) fail('CONNECTION_AUDIT_INVENTORY_TOO_LARGE')

  const keys = new Set(), operationIds = new Set(), normalizedItems = [], normalizedOperations = [], markers = []
  const groups = new Map(), bodyCache = new Map()
  let totalBodyBytes = 0, verifiedBodies = 0
  for (const item of source.items) {
    const removedTombstone = record(item) && item.assistant_user_id !== source.assistantId
    if (removedTombstone && (!uuid.test(item.assistant_user_id ?? '') || !item.deleted_at || item.body_item_id !== null
      || typeof item.resource_key !== 'string' || item.resource_key.startsWith('catalog:') || item.resource_key === '__collection__'
      || item.resource_key.startsWith('__collection__:')
      || removedAssistants !== null && !removedAssistants.assistantIds.includes(item.assistant_user_id))) fail('CONNECTION_AUDIT_INVALID_ITEM')
    if (!record(item) || item.domain !== 'integrations' || item.owner_user_id !== source.ownerId
      || typeof item.resource_key !== 'string' || !item.resource_key
      || item.resource_key.length > 512 || !decimal(item.revision) || BigInt(item.revision) > BigInt(source.headRevision)
      || !nullableText(item.device_id) || !nullableText(item.deleted_at) || !nullableText(item.stale_at ?? null)
      || !nullableText(item.body_item_id) || !nullableText(item.body_sha256)) fail('CONNECTION_AUDIT_INVALID_ITEM')
    if (keys.has(item.resource_key)) fail('CONNECTION_AUDIT_DUPLICATE_RESOURCE')
    keys.add(item.resource_key)
    const marker = item.resource_key === '__collection__' || item.resource_key.startsWith('__collection__:')
    const kind = marker ? 'collection' : item.resource_key.startsWith('catalog:') ? 'catalog' : 'account'
    const data = kind === 'catalog' ? directoryMetadata(item.data) : metadata(item.data, marker ? markerFields : itemFields)
    if (!marker && !item.deleted_at && (typeof data.providerId !== 'string'
      || kind === 'account' && typeof data.accountId !== 'string')) fail('CONNECTION_AUDIT_INVALID_ACCOUNT')
    let publicBody = null
    if (item.body_item_id !== null) {
      if (!uuid.test(item.body_item_id) || !hashPattern.test(item.body_sha256 ?? '') || item.deleted_at) fail('CONNECTION_AUDIT_INVALID_BODY_REFERENCE')
      const previous = bodyCache.get(item.body_item_id)
      if (previous && previous.hash !== item.body_sha256) fail('CONNECTION_AUDIT_BODY_REFERENCE_CONFLICT')
      let bytes = previous?.bytes
      if (!bytes) {
        if (!readBody) fail('CONNECTION_AUDIT_BODY_BYTES_REQUIRED')
        try { bytes = await readBody(item.body_item_id, connectionAuditLimits.bodyBytes) }
        catch { fail('CONNECTION_AUDIT_BODY_UNAVAILABLE') }
        if (!(bytes instanceof Uint8Array) || bytes.byteLength > connectionAuditLimits.bodyBytes) fail('CONNECTION_AUDIT_BODY_TOO_LARGE')
        totalBodyBytes += bytes.byteLength
        if (totalBodyBytes > connectionAuditLimits.totalBodyBytes) fail('CONNECTION_AUDIT_BODIES_TOO_LARGE')
        if (digest(bytes) !== item.body_sha256) fail('CONNECTION_AUDIT_BODY_HASH_MISMATCH')
        bodyCache.set(item.body_item_id, { bytes, hash: item.body_sha256 }); verifiedBodies++
      }
      let parsed
      try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
      catch { fail('CONNECTION_AUDIT_INVALID_BODY') }
      if (kind === 'account') {
        publicBody = metadata(parsed, accountFields)
        if (publicBody.version !== 1 || publicBody.providerId !== data.providerId || publicBody.accountId !== data.accountId)
          fail('CONNECTION_AUDIT_ACCOUNT_BODY_MISMATCH')
      } else if (kind === 'catalog') {
        if (!record(parsed) || parsed.version !== 1 || !record(parsed.en) || !record(parsed['zh-CN'])
          || parsed.en.id !== data.providerId || parsed['zh-CN'].id !== data.providerId
          || item.resource_key !== `catalog:${data.providerId}`) fail('CONNECTION_AUDIT_INVALID_CATALOG')
        // The immutable bytes have already been verified; do not put the full
        // provider definition into the audit report or treat it as account data.
      } else fail('CONNECTION_AUDIT_INVALID_BODY_REFERENCE')
    } else if (item.body_sha256 !== null) fail('CONNECTION_AUDIT_INVALID_BODY_REFERENCE')
    else if (!marker && !item.deleted_at) fail('CONNECTION_AUDIT_BODY_BYTES_REQUIRED')
    if ('prepared_public_metadata' in item && stableConnectionJson(item.prepared_public_metadata) !== stableConnectionJson(publicBody))
      fail('CONNECTION_AUDIT_ACCOUNT_BODY_MISMATCH')
    const normalized = { resourceKey: item.resource_key, kind, deviceId: item.device_id, revision: item.revision,
      data, publicBody, bodyItemId: item.body_item_id, bodySha256: item.body_sha256,
      deletedAt: item.deleted_at, staleAt: item.stale_at ?? null, observedAt: item.observed_at ?? null, updatedAt: item.updated_at ?? null }
    normalizedItems.push(normalized)
    if (marker) markers.push(normalized)
    const state = item.deleted_at ? 'revoked' : item.stale_at ? 'retired' : 'active'
    const groupKey = stableConnectionJson([kind, item.device_id, state])
    groups.set(groupKey, (groups.get(groupKey) ?? 0) + 1)
  }
  if (source.identityState === 'found') {
    const currentMarkers = markers.filter(item => !item.deletedAt && !item.staleAt)
    if (!currentMarkers.length || currentMarkers.some(item => item.data.state !== 'ready' || item.data.schemaVersion !== 1))
      fail('CONNECTION_AUDIT_COLLECTION_NOT_READY')
    for (const marker of currentMarkers) {
      const device = marker.resourceKey === '__collection__' ? null : marker.resourceKey.slice('__collection__:'.length)
      if (device !== null && device !== marker.deviceId) fail('CONNECTION_AUDIT_INVALID_COLLECTION_DEVICE')
      const count = normalizedItems.filter(item => item.kind !== 'collection' && !item.deletedAt && !item.staleAt
        && (device === null || item.deviceId === device)).length
      if (!Number.isSafeInteger(marker.data.itemCount) || marker.data.itemCount !== count) fail('CONNECTION_AUDIT_COLLECTION_COUNT_MISMATCH')
    }
  }
  for (const operation of source.operations) {
    if (!record(operation) || !uuid.test(operation.operation_id) || operationIds.has(operation.operation_id)
      || operation.owner_user_id !== source.ownerId || operation.assistant_user_id !== source.assistantId
      || operation.domain !== 'integrations' || operation.source !== 'panel'
      || !['pending', 'failed'].includes(operation.status) || !['save', 'remove', 'enable', 'disable'].includes(operation.operation)
      || !decimal(operation.revision) || !decimal(operation.expected_item_revision)
      || BigInt(operation.revision) > BigInt(source.headRevision) || !keys.has(operation.resource_key)
      || !nullableText(operation.device_id)) fail('CONNECTION_AUDIT_INVALID_OPERATION')
    operationIds.add(operation.operation_id)
    normalizedOperations.push({ operationId: operation.operation_id, resourceKey: operation.resource_key,
      revision: operation.revision, expectedRevision: operation.expected_item_revision, operation: operation.operation,
      deviceId: operation.device_id, payload: payload(operation.payload, typeof operation.resource_key === 'string' && operation.resource_key.startsWith('catalog:')), status: operation.status,
      terminalAt: operation.terminal_at ?? null, errorCode: operation.error_code ?? null,
      createdAt: operation.created_at ?? null, appliedAt: operation.applied_at ?? null,
      appliedDeviceId: operation.applied_device_id ?? null, cleanupAttemptedAt: operation.cleanup_attempted_at ?? null,
      requestHash: operation.request_hash })
  }
  normalizedItems.sort((left, right) => left.resourceKey < right.resourceKey ? -1 : left.resourceKey > right.resourceKey ? 1 : 0)
  normalizedOperations.sort((left, right) => BigInt(left.revision) < BigInt(right.revision) ? -1 : BigInt(left.revision) > BigInt(right.revision) ? 1 : left.operationId < right.operationId ? -1 : left.operationId > right.operationId ? 1 : 0)
  const entries = normalizedItems.map(item => ({ keyHash: digest(item.resourceKey), kind: item.kind,
    hash: digest(stableConnectionJson(item)) }))
  const operations = normalizedOperations.map(operation => ({ operationId: operation.operationId,
    hash: digest(stableConnectionJson(operation)) }))
  const inventory = { version: 1, ownerId: source.ownerId, assistantId: source.assistantId, identityState: source.identityState,
    sourceRevision: source.headRevision, databaseDigest: source.databaseDigest, entries, operations,
    counts: [...groups].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, count]) => ({ scope: JSON.parse(key), count })),
    verifiedBodies, verifiedBodyBytes: totalBodyBytes }
  return { ...inventory, hash: digest(stableConnectionJson(inventory)) }
}

export function compareConnectionInventories(source, candidate) {
  const differences = []
  for (const field of ['ownerId', 'assistantId', 'identityState', 'sourceRevision', 'hash'])
    if (source[field] !== candidate[field]) differences.push(field)
  return { version: 1, eligible: differences.length === 0 && source.identityState === 'found',
    nativeInitialization: differences.length === 0 && source.identityState === 'none',
    differences, source, candidate }
}

export async function boundedConnectionFile(path, limit) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > limit) fail('CONNECTION_AUDIT_FILE_TOO_LARGE')
    const bytes = await file.readFile()
    if (bytes.byteLength > limit) fail('CONNECTION_AUDIT_FILE_TOO_LARGE')
    return bytes
  } finally { await file.close() }
}

async function main(args) {
  const options = new Map()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1]
    if (!['--source', '--candidate', '--bodies-dir', '--output'].includes(key) || !value || options.has(key)) fail('CONNECTION_AUDIT_INVALID_ARGUMENTS')
    options.set(key, resolve(value))
  }
  if (!options.has('--source') || !options.has('--output')) fail('CONNECTION_AUDIT_INVALID_ARGUMENTS')
  const parse = async path => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await boundedConnectionFile(path, connectionAuditLimits.inventoryBytes)))
  const bodies = options.get('--bodies-dir')
  const deps = { readBody: bodies ? (id, limit) => boundedConnectionFile(join(bodies, id), limit) : undefined }
  const source = await auditConnectionInventory(await parse(options.get('--source')), deps)
  const report = options.has('--candidate')
    ? compareConnectionInventories(source, await auditConnectionInventory(await parse(options.get('--candidate')), deps))
    : { version: 1, eligible: false, nativeInitialization: false, differences: ['candidate-not-provided'], source }
  await writeFile(options.get('--output'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  process.stdout.write(JSON.stringify({ audited: true, eligible: report.eligible, nativeInitialization: report.nativeInitialization,
    itemCount: source.entries.length, operationCount: source.operations.length, verifiedBodies: source.verifiedBodies }) + '\n')
  return options.has('--candidate') && report.differences.length ? 2 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await main(process.argv.slice(2)) }
  catch (error) {
    // Raw filesystem, JSON, SQL, provider and body diagnostics never go to logs.
    process.stderr.write((typeof error?.code === 'string' && error.code.startsWith('CONNECTION_AUDIT_') ? error.code : 'CONNECTION_AUDIT_FAILED') + '\n')
    process.exitCode = 1
  }
}
