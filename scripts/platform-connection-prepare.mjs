import { writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { auditConnectionInventory, boundedConnectionFile, compareConnectionInventories, connectionAuditLimits } from './platform-connection-audit.mjs'

const fail = code => { throw Object.assign(new Error(code), { code }) }

/** The one legacy inventory: maintenance scope, the same function and digest the
 * cutover tool records, preparation rechecks under its locks, and the switch compares. */
export async function readConnectionInventory(db, ownerId) {
  return (await db.query('SELECT identity.connection_legacy_inventory($1) AS inventory', [ownerId])).rows[0]?.inventory
}

/** All body IO finishes before taking database locks. Dry-run never writes.
 * Apply only stages and compares a candidate; it never activates a new writer. */
export async function prepareConnectionCandidate(db, source, { readBody, apply = false } = {}) {
  const documents = new Map()
  const audited = await auditConnectionInventory(source, { readBody: async (id, limit) => {
    const bytes = await readBody?.(id, limit)
    if (bytes instanceof Uint8Array) documents.set(id, new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    return bytes
  } })
  if (source.identityState !== 'found') fail('CONNECTION_PREPARE_NO_LEGACY_SOURCE')
  await db.query(apply ? 'BEGIN' : 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
  try {
    await db.query("SET LOCAL statement_timeout = '2s'")
    await db.query("SET LOCAL lock_timeout = '250ms'")
    await db.query("SET LOCAL transaction_timeout = '2s'")
    const current = await readConnectionInventory(db, source.ownerId)
    if (current?.databaseDigest !== source.databaseDigest) fail('CONNECTION_PREPARE_SOURCE_CHANGED')
    if (!apply) {
      await db.query('ROLLBACK')
      return { version: 1, prepared: false, activated: false, dryRun: true, source: audited }
    }
    const prepared = (await db.query('SELECT identity.connection_prepare_import($1,$2,$3,$4::jsonb) AS receipt',
      [source.ownerId, source.databaseDigest, audited.hash, JSON.stringify(Object.fromEntries(documents))])).rows[0].receipt
    const candidate = (await db.query('SELECT identity.connection_prepared_inventory($1) AS inventory', [source.ownerId])).rows[0]?.inventory
    const stored = (await db.query('SELECT legacy_body_item_id,body_document FROM identity.connection_items WHERE owner_user_id=$1 AND legacy_body_item_id IS NOT NULL', [source.ownerId])).rows
    const actualBodies = new Map(stored.map(row => [row.legacy_body_item_id, new TextEncoder().encode(row.body_document)]))
    const comparison = compareConnectionInventories(audited, await auditConnectionInventory(candidate, { readBody: id => actualBodies.get(id) }))
    if (!comparison.eligible) fail('CONNECTION_PREPARE_CANDIDATE_DIFFERS')
    const measuredLockMsBeforeCommit = Number((await db.query(
      'SELECT extract(epoch FROM clock_timestamp()-$1::timestamptz)*1000 AS ms', [prepared.lockAcquiredAt])).rows[0].ms)
    // Preparation can become stale immediately after COMMIT. A later authority
    // transfer must audit/recheck again; this report never grants a cutover.
    await db.query('COMMIT')
    return { version: 1, prepared: true, activated: false, dryRun: false, measuredLockMsBeforeCommit, comparison }
  } catch (error) {
    await db.query('ROLLBACK').catch(() => {})
    throw error
  }
}

async function main(args) {
  const options = new Map(); let apply = false
  for (let index = 0; index < args.length; index++) {
    const key = args[index]
    if (key === '--apply' && !apply) { apply = true; continue }
    const value = args[++index]
    if (!['--source','--bodies-dir','--output','--database-url-env'].includes(key) || !value || options.has(key)) fail('CONNECTION_PREPARE_INVALID_ARGUMENTS')
    options.set(key, value)
  }
  if (!options.has('--source') || !options.has('--bodies-dir') || !options.has('--output')) fail('CONNECTION_PREPARE_INVALID_ARGUMENTS')
  const envName = options.get('--database-url-env') ?? 'GUGU_INSTALL_TEST_DATABASE_URL'
  if (!/^[A-Z][A-Z0-9_]*$/.test(envName) || !process.env[envName]) fail('CONNECTION_PREPARE_DATABASE_REQUIRED')
  const source = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await boundedConnectionFile(resolve(options.get('--source')), connectionAuditLimits.inventoryBytes)))
  const { default: pg } = await import('pg')
  const db = new pg.Client({ connectionString: process.env[envName], connectionTimeoutMillis: 5000, application_name: 'gugu-connection-preparation' })
  try {
    await db.connect()
    const report = await prepareConnectionCandidate(db, source, { apply,
      readBody: (id, limit) => boundedConnectionFile(join(resolve(options.get('--bodies-dir')), id), limit) })
    await writeFile(resolve(options.get('--output')), JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    process.stdout.write(JSON.stringify({ prepared: report.prepared, activated: false, dryRun: report.dryRun }) + '\n')
  } finally { await db.end() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(process.argv.slice(2)) }
  catch (error) {
    process.stderr.write((typeof error?.code === 'string' && error.code.startsWith('CONNECTION_') ? error.code : 'CONNECTION_PREPARE_FAILED') + '\n')
    process.exitCode = 1
  }
}
