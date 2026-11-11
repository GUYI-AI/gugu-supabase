import { open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { auditConnectionInventory, boundedConnectionFile, connectionAuditLimits } from './platform-connection-audit.mjs'
import { connectionBodyLocations, connectionBodyStore } from './platform-connection-bodies.mjs'
import { prepareConnectionCandidate } from './platform-connection-prepare.mjs'

// Per-account legacy -> owner cutover: inventory, server-side body fetch, audit,
// prepare, cutover. Dry-run never writes. Reports hold owner IDs, counts, hashes
// and stable codes only: never credentials, body text or raw database messages.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// The same rule as identity.connection_authority_switches.operator_id.
export const connectionOperatorPattern = /^[A-Za-z0-9][A-Za-z0-9._@:+-]{0,127}$/
const fail = code => { throw Object.assign(new Error(code), { code }) }
export const connectionCutoverLimits = Object.freeze({ owners: 500, ownersFileBytes: 64 * 1024 })

const databaseRefusals = new Map([
  ['Connection authority was already switched', 'CONNECTION_CUTOVER_ALREADY_OWNER'],
  ['Connection preparation is closed after the authority switch', 'CONNECTION_CUTOVER_ALREADY_OWNER'],
  ['Connection legacy rows belong to several assistants', 'CONNECTION_CUTOVER_SEVERAL_ASSISTANTS'],
  ['Connection candidate has rows outside an owned scope', 'CONNECTION_CUTOVER_UNSCOPED_ROWS'],
  // Raised by the official overlay's guard on identity.connection_heads.
  ['Connection platform credentials have no owner mapping yet', 'CONNECTION_CUTOVER_PLATFORM_CREDENTIAL'],
  ['Connection authority changed or is quiescing', 'CONNECTION_CUTOVER_AUTHORITY_CHANGED'],
  ['Connection authority changed during cutover', 'CONNECTION_CUTOVER_AUTHORITY_CHANGED'],
  ['Connection candidate differs from the audited preparation', 'CONNECTION_CUTOVER_CANDIDATE_CHANGED'],
  ['Connection candidate differs from its legacy source', 'CONNECTION_CUTOVER_CANDIDATE_CHANGED'],
  ['Connection source changed after preparation', 'CONNECTION_CUTOVER_SOURCE_CHANGED'],
  ['Connection source changed after audit', 'CONNECTION_CUTOVER_SOURCE_CHANGED'],
  ['Connection legacy operations are unfinished', 'CONNECTION_CUTOVER_UNFINISHED_OPERATIONS'],
  ['Connection legacy data requires an audited preparation', 'CONNECTION_CUTOVER_LEGACY_DATA'],
  ['Connection candidate requires its audited preparation digest', 'CONNECTION_CUTOVER_LEGACY_DATA'],
  ['Connection account is unavailable', 'CONNECTION_CUTOVER_ACCOUNT_UNAVAILABLE'],
  ['Connection preparation owner is unavailable', 'CONNECTION_CUTOVER_ACCOUNT_UNAVAILABLE'],
  ['Connection legacy identity is ambiguous', 'CONNECTION_CUTOVER_AMBIGUOUS_ASSISTANT'],
  ['Connection legacy control is unprepared', 'CONNECTION_CUTOVER_COLLECTION_NOT_READY'],
  ['Connection collection is incomplete', 'CONNECTION_CUTOVER_COLLECTION_NOT_READY'],
  ['Connection collection is unprepared', 'CONNECTION_CUTOVER_COLLECTION_NOT_READY'],
  ['Connection preparation exceeds the record limit', 'CONNECTION_CUTOVER_TOO_LARGE'],
  ['Connection preparation exceeds the inventory limit', 'CONNECTION_CUTOVER_TOO_LARGE'],
])
const lostSession = new Set(['57P01', '57P02', '57P03', '25P04', '08000', '08003', '08006'])

/** Maps any failure to a stable code; the raw message is never reported. */
export function connectionCutoverRefusal(error, fallback = 'CONNECTION_CUTOVER_FAILED') {
  if (typeof error?.code === 'string' && error.code.startsWith('CONNECTION_')) return { code: error.code }
  // Only PostgreSQL errors carry a severity; filesystem/network codes are not SQLSTATEs.
  const sqlstate = typeof error?.severity === 'string' && /^[0-9A-Z]{5}$/.test(error.code ?? '') ? error.code : null
  const code = databaseRefusals.get(error?.message)
    ?? (sqlstate === '55P03' || sqlstate === '57014' ? 'CONNECTION_CUTOVER_LOCK_TIMEOUT' : fallback)
  return sqlstate ? { code, sqlstate } : { code }
}

async function readState(db, ownerId) {
  await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
  try {
    await db.query("SET LOCAL statement_timeout = '2s'")
    // A role that row security would filter fails instead of seeing fewer rows.
    await db.query('SET LOCAL row_security = off')
    const account = (await db.query("SELECT type='human' AND removed_at IS NULL AS available FROM identity.users WHERE id=$1", [ownerId])).rows[0]
    const head = (await db.query(`SELECT authority_mode AS mode,authority_epoch::text AS epoch,authority_phase AS phase,
      prepared_at IS NOT NULL AS prepared,native_initialized_at IS NOT NULL AS initialized
      FROM identity.connection_heads WHERE owner_user_id=$1`, [ownerId])).rows[0] ?? null
    const legacyData = (await db.query('SELECT identity.connection_has_legacy_data($1) AS value', [ownerId])).rows[0].value
    const devices = new Set((await db.query('SELECT device_id FROM identity.gugu_devices WHERE user_id::text=$1', [ownerId])).rows
      .map(row => row.device_id))
    // Platform-held credentials (official overlay) have no owner-scope mapping yet;
    // the overlay also refuses the switch itself. Absent table: nothing to strand.
    const custody = (await db.query("SELECT to_regclass('integrations.credentials') IS NOT NULL AS present")).rows[0].present
    const platformCredentials = custody && (await db.query(
      'SELECT EXISTS (SELECT 1 FROM integrations.credentials WHERE owner_user_id::text=$1) AS held', [ownerId])).rows[0].held
    let source = null, sourceRefusal = null, locations = new Map(), foreignRows = false
    if (account?.available) {
      await db.query('SAVEPOINT inventory')
      try {
        source = (await db.query('SELECT identity.connection_legacy_inventory($1) AS value', [ownerId])).rows[0].value
        await db.query('RELEASE inventory')
      } catch (error) {
        if (typeof error?.severity !== 'string' || lostSession.has(error.code)) throw error
        await db.query('ROLLBACK TO inventory')
        sourceRefusal = connectionCutoverRefusal(error)
      }
      if (source?.identityState === 'found') {
        locations = await connectionBodyLocations(db, ownerId, source.assistantId, bodyIds(source))
        foreignRows = (await db.query('SELECT identity.connection_has_legacy_data($1,$2) AS value', [ownerId, source.assistantId])).rows[0].value
      }
    }
    await db.query('ROLLBACK')
    return { available: account?.available === true, head, legacyData, devices, platformCredentials, source, sourceRefusal, locations, foreignRows }
  } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error }
}

const bodyIds = source => [...new Set(source.items.map(item => item.body_item_id).filter(id => typeof id === 'string'))]
const headShape = head => ({ mode: head?.mode ?? 'legacy', epoch: head?.epoch ?? '0', phase: head?.phase ?? 'stable',
  prepared: head?.prepared === true, initialized: head?.initialized === true })

async function boundedCutover(db, values) {
  await db.query('BEGIN')
  try {
    await db.query("SET LOCAL statement_timeout = '2s'")
    await db.query("SET LOCAL lock_timeout = '250ms'")
    await db.query("SET LOCAL transaction_timeout = '2s'")
    const result = (await db.query('SELECT identity.connection_authority_cutover($1,$2,$3,$4,$5) AS result', values)).rows[0].result
    await db.query('COMMIT')
    return result
  } catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error }
}

// prepare stages a row under device:<id>, or legacy:unknown without a device;
// the owner API can write only platform or a device the owner still owns.
const unscoped = (source, devices) => [...source.items, ...source.operations]
  .some(row => typeof row.device_id !== 'string' || !devices.has(row.device_id))

/** One account. Every refusal leaves the account on legacy authority. */
export async function cutoverConnectionAccount(db, ownerId, { readBody, apply = false, operator } = {}) {
  if (apply && !connectionOperatorPattern.test(operator ?? '')) fail('CONNECTION_CUTOVER_OPERATOR_REQUIRED')
  const state = await readState(db, ownerId)
  const report = { ownerId, plan: null, before: { ...headShape(state.head), legacyData: state.legacyData } }
  const keep = refusal => ({ ...report, result: 'kept-legacy', ...refusal })
  if (!state.available) return keep({ code: 'CONNECTION_CUTOVER_ACCOUNT_UNAVAILABLE' })
  if (report.before.mode === 'owner') return { ...report, plan: 'none', result: 'already-owner' }
  if (report.before.phase !== 'stable') return keep({ code: 'CONNECTION_CUTOVER_AUTHORITY_CHANGED' })
  // An account without legacy connection data becomes owner directly; anything else is imported.
  report.plan = !state.legacyData && !report.before.prepared ? 'native' : 'import'
  // Stays legacy: a platform-held credential has no owner-scope mapping yet.
  if (state.platformCredentials) return keep({ code: 'CONNECTION_CUTOVER_PLATFORM_CREDENTIAL' })
  let source = null, documents = null, manifestHash = null
  if (report.plan === 'import') {
    if (state.sourceRefusal) return keep(state.sourceRefusal)
    source = state.source
    if (source.identityState !== 'found') return keep({ code: 'CONNECTION_CUTOVER_NO_LEGACY_ASSISTANT' })
    if (source.operations.length) return keep({ code: 'CONNECTION_CUTOVER_UNFINISHED_OPERATIONS' })
    // Stays legacy: rows under several assistants (only one would be imported).
    if (state.foreignRows) return keep({ code: 'CONNECTION_CUTOVER_SEVERAL_ASSISTANTS' })
    // Stays legacy: a row the owner API could never write again.
    if (unscoped(source, state.devices)) return keep({ code: 'CONNECTION_CUTOVER_UNSCOPED_ROWS' })
    documents = new Map()
    let total = 0
    for (const id of bodyIds(source)) {
      if (!readBody) return keep({ code: 'CONNECTION_CUTOVER_BODY_SOURCE_REQUIRED' })
      try {
        const bytes = await readBody(id, state.locations.get(id) ?? null, connectionAuditLimits.bodyBytes)
        if (!(bytes instanceof Uint8Array)) fail('CONNECTION_BODY_UNAVAILABLE')
        total += bytes.byteLength
        if (total > connectionAuditLimits.totalBodyBytes) fail('CONNECTION_AUDIT_BODIES_TOO_LARGE')
        documents.set(id, bytes)
      } catch (error) { return keep(connectionCutoverRefusal(error, 'CONNECTION_BODY_UNAVAILABLE')) }
    }
    try {
      const audited = await auditConnectionInventory(source, { readBody: async id => documents.get(id) })
      manifestHash = audited.hash
      report.inventory = { sourceRevision: audited.sourceRevision, items: audited.entries.length, operations: audited.operations.length,
        verifiedBodies: audited.verifiedBodies, verifiedBodyBytes: audited.verifiedBodyBytes, manifestHash }
    } catch (error) { return keep(connectionCutoverRefusal(error)) }
  }
  if (!apply) return { ...report, result: 'eligible' }
  try {
    if (report.plan === 'import') {
      const prepared = await prepareConnectionCandidate(db, source, { readBody: async id => documents.get(id), apply: true })
      if (prepared.comparison?.source?.hash !== manifestHash) fail('CONNECTION_CUTOVER_CANDIDATE_CHANGED')
      await boundedCutover(db, [ownerId, report.before.epoch, operator, source.databaseDigest, manifestHash])
    } else await boundedCutover(db, [ownerId, report.before.epoch, operator, null, null])
  } catch (error) {
    // Coded refusals keep this account legacy; a lost session or uncoded failure stops the run.
    if (typeof error?.code !== 'string' || lostSession.has(error.code)) throw error
    return keep(connectionCutoverRefusal(error))
  }
  const after = headShape((await db.query(`SELECT authority_mode AS mode,authority_epoch::text AS epoch,authority_phase AS phase,
    prepared_at IS NOT NULL AS prepared,native_initialized_at IS NOT NULL AS initialized
    FROM identity.connection_heads WHERE owner_user_id=$1`, [ownerId])).rows[0])
  const verified = after.mode === 'owner' && after.phase === 'stable' && after.initialized
    && after.epoch === String(BigInt(report.before.epoch) + 1n)
  return { ...report, after, result: verified ? 'switched' : 'failed', ...(verified ? {} : { code: 'CONNECTION_CUTOVER_UNVERIFIED' }) }
}

/** Sequential, independent per account; safe to rerun (switched accounts report already-owner). */
export async function cutoverConnectionAccounts(db, owners, options = {}) {
  if (options.apply === true && !connectionOperatorPattern.test(options.operator ?? '')) fail('CONNECTION_CUTOVER_OPERATOR_REQUIRED')
  const accounts = []
  let stopped = false
  for (const ownerId of owners) {
    if (stopped) { accounts.push({ ownerId, result: 'not-attempted' }); continue }
    try { accounts.push(await cutoverConnectionAccount(db, ownerId, options)) }
    catch (error) {
      // A lost session or unexpected tool failure stops the run; finished accounts stay committed.
      accounts.push({ ownerId, result: 'failed', ...connectionCutoverRefusal(error) })
      stopped = true
    }
  }
  const summary = { accounts: accounts.length }
  for (const name of ['switched', 'already-owner', 'eligible', 'kept-legacy', 'failed', 'not-attempted'])
    summary[name] = accounts.filter(account => account.result === name).length
  return { version: 1, dryRun: options.apply !== true, operator: options.operator ?? null, summary, accounts }
}

export function parseConnectionOwners(text) {
  const trimmed = text.trim()
  const values = trimmed.startsWith('[') ? JSON.parse(trimmed)
    : trimmed.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'))
  if (!Array.isArray(values) || !values.length || values.length > connectionCutoverLimits.owners
    || values.some(value => typeof value !== 'string' || !uuid.test(value))) fail('CONNECTION_CUTOVER_INVALID_OWNERS')
  const owners = values.map(value => value.toLowerCase())
  if (new Set(owners).size !== owners.length) fail('CONNECTION_CUTOVER_DUPLICATE_OWNERS')
  return owners
}

async function main(args) {
  const options = new Map(), flags = new Set()
  for (let index = 0; index < args.length; index++) {
    const key = args[index]
    if (['--apply', '--bodies-from-storage'].includes(key) && !flags.has(key)) { flags.add(key); continue }
    const value = args[++index]
    if (!['--owners', '--output', '--database-url-env', '--bodies-dir', '--operator'].includes(key) || !value || options.has(key))
      fail('CONNECTION_CUTOVER_INVALID_ARGUMENTS')
    options.set(key, value)
  }
  if (!options.has('--owners') || !options.has('--output') || options.has('--bodies-dir') && flags.has('--bodies-from-storage'))
    fail('CONNECTION_CUTOVER_INVALID_ARGUMENTS')
  // Who ran it: recorded in the report and, on apply, in every switch row.
  const operator = options.get('--operator')
  if (!connectionOperatorPattern.test(operator ?? '')) fail('CONNECTION_CUTOVER_OPERATOR_REQUIRED')
  const envName = options.get('--database-url-env') ?? 'GUGU_INSTALL_TEST_DATABASE_URL'
  if (!/^[A-Z][A-Z0-9_]*$/.test(envName) || !process.env[envName]) fail('CONNECTION_CUTOVER_DATABASE_REQUIRED')
  const owners = parseConnectionOwners(new TextDecoder('utf-8', { fatal: true }).decode(
    await boundedConnectionFile(resolve(options.get('--owners')), connectionCutoverLimits.ownersFileBytes)))
  let readBody
  if (options.has('--bodies-dir')) {
    const directory = resolve(options.get('--bodies-dir'))
    readBody = (id, _location, limit) => boundedConnectionFile(join(directory, id), limit)
  } else if (flags.has('--bodies-from-storage')) {
    const store = connectionBodyStore(process.env)
    readBody = (_id, location, limit) => store(location, limit)
  }
  // Claim the private report before touching the database, so an apply can never
  // switch accounts and then fail to record them.
  let output
  try { output = await open(resolve(options.get('--output')), 'wx', 0o600) }
  catch (error) { fail(error?.code === 'EEXIST' ? 'CONNECTION_CUTOVER_REPORT_EXISTS' : 'CONNECTION_CUTOVER_REPORT_UNWRITABLE') }
  const record = async value => { await output.writeFile(JSON.stringify(value, null, 2) + '\n'); await output.sync() }
  const { default: pg } = await import('pg')
  const db = new pg.Client({ connectionString: process.env[envName], connectionTimeoutMillis: 5000, application_name: 'gugu-connection-cutover' })
  db.on('error', () => {})
  let connected = false, report = null
  try {
    await db.connect(); connected = true
    report = await cutoverConnectionAccounts(db, owners, { readBody, apply: flags.has('--apply'), operator })
    await record(report)
    process.stdout.write(JSON.stringify({ dryRun: report.dryRun, ...report.summary }) + '\n')
    const settled = report.summary['kept-legacy'] + report.summary.failed + report.summary['not-attempted'] === 0
    return settled ? 0 : 2
  } catch (error) {
    if (!report) await record({ version: 1, dryRun: !flags.has('--apply'), operator, error: connectionCutoverRefusal(error) }).catch(() => {})
    throw error
  } finally {
    await output.close().catch(() => {})
    if (connected) await db.end().catch(() => {})
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await main(process.argv.slice(2)) }
  catch (error) {
    process.stderr.write((typeof error?.code === 'string' && error.code.startsWith('CONNECTION_') ? error.code : 'CONNECTION_CUTOVER_FAILED') + '\n')
    process.exitCode = 1
  }
}
