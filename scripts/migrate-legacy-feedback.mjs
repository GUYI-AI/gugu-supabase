import { createHash, randomUUID, X509Certificate } from 'node:crypto'
import { open, readFile, rename, unlink, lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { rootCertificates, checkServerIdentity } from 'node:tls'

const check = (ok) => { if (!ok) throw new Error('Migration refused') }
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
export const digest = value => sha256(JSON.stringify(value))
// Storage v1.60.15 wraps NoSuchKey as HTTP 400 with a semantic 404 body.
export const missingResponse = (status, body) => [400, 404].includes(status)
  && body?.code === 'NoSuchKey' && String(body?.statusCode) === '404'
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value)
const hex = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const integer = value => Number.isSafeInteger(value) && value >= 0
const modes = ['dry-run', 'migrate', 'report', 'delete']
const controlCharacters = /[\u0000-\u001f\u007f-\u009f]/u

export function databaseAddress(databaseUrl) {
  check(typeof databaseUrl === 'string' && !controlCharacters.test(databaseUrl))
  const database = new URL(databaseUrl), parameters = [...database.searchParams]
  check(['postgres:', 'postgresql:'].includes(database.protocol) && database.hostname && database.username
    && database.pathname.length > 1 && !database.hash && parameters.length <= 1
    && parameters.every(([key, value]) => key === 'sslmode' && ['require', 'verify-ca', 'verify-full'].includes(value)))
  // pg otherwise falls back to PGPORT when the URL omits a port.
  database.port = database.port || '5432'
  const port = Number(database.port)
  check(Number.isInteger(port) && port >= 1 && port <= 65535)
  const address = { connectionString: database.href, host: decodeURIComponent(database.hostname).replace(/^\[|\]$/g, ''), port,
    database: decodeURIComponent(database.pathname.slice(1)), user: decodeURIComponent(database.username),
    password: decodeURIComponent(database.password), parameters }
  check(['host', 'database', 'user'].every(key => address[key] && !controlCharacters.test(address[key]))
    && !address.password.includes('\0'))
  return address
}

export function clearPgEnvironment() {
  for (const name of Object.keys(process.env)) if (/^PG/i.test(name) || name === 'NODE_PG_FORCE_NATIVE') delete process.env[name]
}

function connectionPolicy(databaseCa, host) {
  check(databaseCa === undefined || Array.isArray(databaseCa) && databaseCa.length > 0
    && databaseCa.every(certificate => typeof certificate === 'string'))
  const ca = databaseCa === undefined ? [...rootCertificates] : databaseCa.map(certificate => new X509Certificate(certificate).toString())
  return { ssl: { rejectUnauthorized: true, ca,
    checkServerIdentity: (_servername, certificate) => checkServerIdentity(host, certificate) }, options: '', replication: false,
    application_name: 'legacy-evidence-migration', client_encoding: 'UTF8', binary: false }
}

function policyIdentity(policy) {
  check(policy.ssl && typeof policy.ssl === 'object'
    && digest(Object.keys(policy.ssl).sort()) === digest(['ca', 'checkServerIdentity', 'rejectUnauthorized'])
    && typeof policy.ssl.checkServerIdentity === 'function')
  return { ssl: { rejectUnauthorized: policy.ssl.rejectUnauthorized, caSha256: digest(policy.ssl.ca),
    checkServerIdentity: 'approved-host-v1' },
    options: policy.options ?? '', replication: policy.replication ?? false,
    application_name: policy.application_name, client_encoding: policy.client_encoding, binary: policy.binary }
}

export function createApprovedClient(Client, databaseUrl, databaseCa) {
  const approved = databaseAddress(databaseUrl)
  const policy = connectionPolicy(databaseCa, approved.host)
  clearPgEnvironment()
  // Use explicit fields: pg-connection-string must not reinterpret SSL or startup policy.
  const client = new Client({ host: approved.host, port: approved.port, database: approved.database,
    user: approved.user, password: approved.password, ...policy,
    connectionTimeoutMillis: 10000, query_timeout: 60000 })
  const actual = client.connectionParameters
  check(actual && ['host', 'port', 'database', 'user'].every(key => actual[key] === approved[key])
    && actual.ssl?.checkServerIdentity === policy.ssl.checkServerIdentity
    && digest(policyIdentity(actual)) === digest(policyIdentity(policy)))
  return client
}

// This digest is compared with an independently provisioned authorization, not self-approved.
export function environmentFingerprint(config, databaseUrl) {
  check(['local', 'staging', 'production'].includes(config.environment) && uuid(config.installationId))
  check(typeof config.sourceBucket === 'string' && config.sourceBucket && typeof config.targetBucket === 'string'
    && config.targetBucket && config.sourceBucket !== config.targetBucket)
  check(integer(config.maxBytes) && config.maxBytes > 0 && config.maxBytes <= 5242880)
  for (const value of [config.storageRoot, config.publicRoot]) {
    const url = new URL(value)
    check(!url.username && !url.password && !url.search && !url.hash
      && (url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  }
  check(!config.storageRoot.endsWith('/') && config.publicRoot.endsWith('/'))
  const database = databaseAddress(databaseUrl)
  // No query parameter may override host, port, database, user, or connection options.
  return digest([2, config.environment, config.installationId, database.host, String(database.port),
    database.database, database.user, database.parameters, policyIdentity(connectionPolicy(config.databaseCa, database.host)),
    config.storageRoot, config.publicRoot, config.sourceBucket, config.targetBucket, config.maxBytes])
}

export function validateEnvironment(config, databaseUrl, authorization, mode, scriptSha256) {
  const fingerprint = environmentFingerprint(config, databaseUrl)
  check(authorization?.schema === 1 && authorization.kind === 'gugu-legacy-environment-authorization'
    && authorization.environment === config.environment
    && authorization.installationId === config.installationId && authorization.fingerprint === fingerprint
    && hex(scriptSha256) && authorization.scriptSha256 === scriptSha256
    && hex(authorization.databaseIdentitySha256) && hex(authorization.feedbackValidatorSha256)
    && typeof authorization.approvedBy === 'string' && authorization.approvedBy.trim().length > 0
    && Array.isArray(authorization.modes) && authorization.modes.every(item => modes.includes(item))
    && authorization.modes.includes(mode)
    && (config.environment !== 'production' || authorization.productionApproved === true))
  return fingerprint
}

export function validateDatabaseIdentity(identity, authorization) {
  check(identity && /^\d+$/.test(identity.cluster) && /^\d+$/.test(identity.oid)
    && typeof identity.database === 'string' && identity.database.length > 0
    && digest([identity.cluster, identity.database, identity.oid]) === authorization.databaseIdentitySha256)
}

// The opener (including importing pg) is unreachable until this independent gate passes.
export async function authorizedConnection(config, databaseUrl, token, mode, authorization, scriptSha256, opener = connect) {
  check(config.fingerprint === validateEnvironment(config, databaseUrl, authorization, mode, scriptSha256))
  return opener(config, databaseUrl, token, mode !== 'dry-run', authorization)
}

export function bindInstalledTarget(config, validatorSource, authorization) {
  check(typeof validatorSource === 'string' && sha256(validatorSource) === authorization.feedbackValidatorSha256)
  const patterns = [
    /WHERE\s+o\.bucket_id\s*=\s*'((?:[^']|'')*)'\s+AND\s+o\.name\s*=\s*object_path\s+FOR\s+KEY\s+SHARE\s*;/g,
    /evidence_blob\s*:=\s*chat\.file_blob_for_object\(\s*'((?:[^']|'')*)'\s*,\s*object_path\s*\)\s*;/g,
    /WHERE\s+b\.bucket_id\s*=\s*'((?:[^']|'')*)'\s+AND\s+b\.object_name\s*=\s*object_path\s*;/g
  ]
  const targets = patterns.map(pattern => {
    const found = [...validatorSource.matchAll(pattern)]; check(found.length === 1)
    return found[0][1].replaceAll("''", "'")
  })
  check(targets[0] && targets.every(value => value === targets[0]) && config.targetBucket === targets[0])
  return targets[0]
}

export const targetName = object => `${object.owner}/feedback/${object.id}`
const objectIdentity = object => digest([object.id, object.bucket_id, object.name, object.version, object.updated_at, object.metadata])
const rowIdentity = row => digest([row.user_id, row.screenshot_urls, row.screenshot_paths])
const totals = state => ({ rows: state.rows.length, objects: state.objects.length,
  bytes: state.objects.reduce((sum, object) => { check(integer(sum + object.bytes)); return sum + object.bytes }, 0) })
const mapping = (state, row) => row.objects.map(id => targetName(state.objects.find(object => object.id === id)))
const stateIdentity = state => digest({ ...state, failures: [], objects: state.objects.map(object => {
  const { deletion, ...stable } = object; return stable
}) })

// Only the explicitly configured public root is parsed. It is never fetched.
export function sourceName(address, publicRoot, owner) {
  check(uuid(owner) && typeof address === 'string')
  const base = new URL(publicRoot), value = new URL(address)
  check(!base.search && !base.hash && !base.username && !base.password && base.pathname.endsWith('/'))
  check(value.origin === base.origin && value.pathname.startsWith(base.pathname)
    && !value.search && !value.hash && !value.username && !value.password)
  const name = decodeURIComponent(value.pathname.slice(base.pathname.length))
  check(name.startsWith(`${owner}/feedback/`) && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name.slice(`${owner}/feedback/`.length)))
  return name
}

/** Metadata only: no GET, HEAD, upload, row update, or checkpoint is performed. */
export async function inventory(io, config, scriptSha256) {
  await io.assertTargetContract()
  const state = { schema: 1, run: randomUUID(), scriptSha256, environment: config.fingerprint,
    rows: [], objects: [], failures: [] }
  let number = 0
  for (const row of await io.legacyRows()) {
    const rowNumber = ++number
    try {
      check(uuid(row.id) && uuid(row.user_id) && Array.isArray(row.screenshot_urls)
        && row.screenshot_urls.length > 0 && row.screenshot_urls.length <= 4 && row.screenshot_paths.length === 0)
      const objects = []
      for (const address of row.screenshot_urls) {
        const name = sourceName(address, config.publicRoot, row.user_id)
        const source = await io.sourceByName(name)
        check(source && uuid(source.id) && source.bucket_id === config.sourceBucket && source.name === name)
        const bytes = Number(source.metadata?.size)
        check(integer(bytes) && bytes > 0 && bytes <= config.maxBytes
          && /^image\/[A-Za-z0-9.+-]+$/.test(source.metadata?.mimetype || ''))
        const existing = state.objects.find(object => object.id === source.id)
        if (existing) check(existing.owner === row.user_id && existing.identity === objectIdentity(source))
        else state.objects.push({ number: ++number, id: source.id, owner: row.user_id, sourceName: name,
          identity: objectIdentity(source), bytes, hash: null })
        objects.push(source.id)
      }
      check(new Set(objects).size === objects.length)
      state.rows.push({ number: rowNumber, id: row.id, owner: row.user_id, identity: rowIdentity(row), objects })
    } catch { state.failures.push(rowNumber) }
  }
  return state
}

async function sourceChecked(io, object) {
  const source = await io.sourceById(object.id)
  check(source && objectIdentity(source) === object.identity)
  return source
}
async function readChecked(io, object, location) {
  const bytes = await io.read(location, object.bytes)
  check(bytes.length === object.bytes && sha256(bytes) === object.hash)
}
async function rowChecked(io, state, expected) {
  const row = await io.row(expected.id)
  check(row && row.user_id === expected.owner && row.screenshot_urls.length === 0
    && digest(row.screenshot_paths) === digest(mapping(state, expected)))
}

/** Save the content digest before an upload. An existing destination is never overwritten. */
export async function migrate(io, state, save) {
  await io.assertTargetContract()
  check(state.failures.length === 0 && state.objects.every(object => !object.deletion))
  const failures = []
  for (const object of state.objects) {
    try {
      const source = await sourceChecked(io, object)
      const bytes = await io.read({ source }, object.bytes)
      check(bytes.length === object.bytes)
      const hash = sha256(bytes)
      check(!object.hash || object.hash === hash)
      object.hash = hash
      await save(state)
      if (!await io.targetExists(targetName(object))) {
        await io.upload(targetName(object), bytes, source.metadata?.mimetype)
      }
      await readChecked(io, object, { target: targetName(object) })
      await sourceChecked(io, object)
    } catch { failures.push(object.number) }
  }
  // A row changes atomically only after ALL objects for the entire run verified.
  if (!failures.length) for (const row of state.rows) {
    try { await io.assertTargetContract(); await io.replaceRow(row, mapping(state, row)); await rowChecked(io, state, row) }
    catch { failures.push(row.number) }
  }
  state.failures = failures
  await save(state)
  return { ...totals(state), failedNumbers: failures }
}

/** This is a separate invocation, after migration. The immutable receipt contains no addresses. */
export async function readback(io, state) {
  await io.assertTargetContract()
  const failures = []
  let verifiedObjects = 0, verifiedBytes = 0, sourceObjects = 0, sourceBytes = 0,
    alreadyDeletedObjects = 0, alreadyDeletedBytes = 0
  for (const object of state.objects) {
    try {
      check(hex(object.hash))
      const source = await io.sourceById(object.id)
      if (source) {
        check(object.deletion !== 'done' && objectIdentity(source) === object.identity)
        await readChecked(io, object, { source })
        await io.assertTargetContract()
        sourceObjects++; sourceBytes += object.bytes
      } else {
        check(['intent', 'done'].includes(object.deletion) && !await io.sourceByName(object.sourceName)
          && await io.sourceAbsent(object.sourceName))
        alreadyDeletedObjects++; alreadyDeletedBytes += object.bytes
      }
      await readChecked(io, object, { target: targetName(object) })
      verifiedObjects++; verifiedBytes += object.bytes
    } catch { failures.push(object.number) }
  }
  for (const row of state.rows) {
    try { await rowChecked(io, state, row) } catch { failures.push(row.number) }
  }
  await io.assertTargetContract()
  check((await io.legacyRows()).length === 0)
  return { schema: 1, run: state.run, scriptSha256: state.scriptSha256, stateSha256: stateIdentity(state),
    maintenanceSha256: io.maintenanceSha256, ...totals(state), verifiedObjects, verifiedBytes,
    sourceObjects, sourceBytes, alreadyDeletedObjects, alreadyDeletedBytes,
    failedNumbers: failures, complete: failures.length === 0 }
}

export function validateApproval(state, report, approval, scriptSha256) {
  const counts = totals(state)
  check(state.schema === 1 && report.schema === 1 && approval.schema === 1
    && hex(scriptSha256) && scriptSha256 === state.scriptSha256
    && scriptSha256 === report.scriptSha256 && scriptSha256 === approval.scriptSha256
    && state.run === report.run && state.run === approval.run
    && hex(report.maintenanceSha256) && approval.maintenanceSha256 === report.maintenanceSha256
    && report.stateSha256 === stateIdentity(state) && approval.reportSha256 === digest(report)
    && report.complete === true && report.failedNumbers.length === 0 && state.failures.length === 0
    && report.verifiedObjects === counts.objects && report.verifiedBytes === counts.bytes
    && integer(report.sourceObjects) && integer(report.sourceBytes)
    && integer(report.alreadyDeletedObjects) && integer(report.alreadyDeletedBytes)
    && report.sourceObjects + report.alreadyDeletedObjects === counts.objects
    && report.sourceBytes + report.alreadyDeletedBytes === counts.bytes
    && ['rows', 'objects', 'bytes'].every(key => approval[key] === counts[key] && report[key] === counts[key])
    && typeof approval.approvedBy === 'string' && approval.approvedBy.trim().length > 0
    && approval.maintenanceWindow === true)
}

/** Caller supplies an externally established, drained maintenance window, NOT a DB lock fence. */
export async function deleteCopies(io, state, report, approval, scriptSha256, save) {
  validateApproval(state, report, approval, scriptSha256)
  await io.assertTargetContract()
  check(io.maintenanceSha256 === report.maintenanceSha256)
  check((await io.legacyRows()).length === 0)
  for (const row of state.rows) await rowChecked(io, state, row)
  // Preflight the whole set before the first deletion; repeat the checks per object below.
  for (const object of state.objects) {
    await readChecked(io, object, { target: targetName(object) })
    const source = await io.sourceById(object.id)
    if (source) {
      check(object.deletion !== 'done' && objectIdentity(source) === object.identity && !await io.referenced(source))
      await readChecked(io, object, { source })
    } else check(['intent', 'done'].includes(object.deletion) && !await io.sourceByName(object.sourceName)
      && await io.sourceAbsent(object.sourceName))
  }
  const failures = []
  for (const object of state.objects) {
    try {
      await io.assertTargetContract()
      await readChecked(io, object, { target: targetName(object) })
      const source = await io.sourceById(object.id)
      if (source) {
        check(object.deletion !== 'done' && objectIdentity(source) === object.identity && !await io.referenced(source))
        await readChecked(io, object, { source })
        await io.assertTargetContract()
        // The durable intent distinguishes a crash after API deletion from an unexplained loss.
        object.deletion = 'intent'; await save(state)
        await io.remove(source)
        check(!await io.sourceById(object.id) && !await io.sourceByName(source.name)
          && await io.sourceAbsent(source.name))
      } else check(['intent', 'done'].includes(object.deletion) && !await io.sourceByName(object.sourceName)
        && await io.sourceAbsent(object.sourceName))
      object.deletion = 'done'; await save(state)
    } catch { failures.push(object.number); break }
  }
  // Keep copy/report failures distinct from resumable deletion failures.
  const deleted = state.objects.filter(object => object.deletion === 'done')
  return { ...totals(state), deletedObjects: deleted.length, deletedBytes: deleted.reduce((sum, object) => sum + object.bytes, 0),
    failedNumbers: failures }
}

async function privatePath(file, exists = false) {
  check(path.isAbsolute(file))
  const parent = await realpath(path.dirname(file)), folder = await lstat(parent)
  check(folder.isDirectory() && folder.uid === process.getuid() && (folder.mode & 0o077) === 0)
  for (let directory = parent; ; directory = path.dirname(directory)) {
    try { await lstat(path.join(directory, '.git')); check(false) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (directory === path.dirname(directory)) break
  }
  try {
    const item = await lstat(file)
    check(item.isFile() && !item.isSymbolicLink() && item.uid === process.getuid() && (item.mode & 0o077) === 0)
  } catch (error) { if (exists || error.code !== 'ENOENT') throw error }
  return path.join(parent, path.basename(file))
}
async function load(file) { return JSON.parse(await readFile(await privatePath(file, true), 'utf8')) }
async function save(file, value, exclusive = false) {
  file = await privatePath(file)
  const temporary = exclusive ? file : `${file}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync() }
  finally { await handle.close() }
  if (!exclusive) await rename(temporary, file)
  const directory = await open(path.dirname(file), 'r')
  try { await directory.sync() } finally { await directory.close() }
}

export function parseArguments(args) {
  let mode = 'dry-run'
  if (args[0] && !args[0].startsWith('--')) mode = args.shift()
  check(['dry-run', 'migrate', 'report', 'delete'].includes(mode))
  const options = {}
  for (let index = 0; index < args.length; index++) {
    const name = args[index]
    check(['--state', '--report', '--approval', '--execute-delete'].includes(name) && !(name in options))
    if (name === '--execute-delete') options[name] = true
    else { check(args[index + 1] && !args[index + 1].startsWith('--')); options[name] = args[++index] }
  }
  const allowed = { 'dry-run': [], migrate: ['--state'], report: ['--state', '--report'],
    delete: ['--state', '--report', '--approval', '--execute-delete'] }[mode]
  check(Object.keys(options).every(key => allowed.includes(key)) && allowed.every(key => options[key]))
  return { mode, options }
}

// Runtime settings are deliberately supplied by private files/environment only.
async function connect(config, databaseUrl, token, mutating, authorization) {
  clearPgEnvironment()
  const { default: pg } = await import('pg')
  const db = createApprovedClient(pg.Client, databaseUrl, config.databaseCa)
  // The CLI emits a fixed failure receipt, never an asynchronous driver error object.
  db.on('error', () => {})
  await db.connect()
  const query = (sql, parameters = []) => db.query(sql, parameters)
  async function installedTarget() {
    const result = await query(`SELECT p.prosrc FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
      WHERE t.tgrelid='identity.feedback'::regclass AND t.tgname='validate_feedback_screenshots'
        AND NOT t.tgisinternal AND t.tgenabled IN ('O','A')
        AND t.tgfoid='identity.validate_feedback_screenshots()'::regprocedure`)
    check(result.rows.length === 1)
    return bindInstalledTarget(config, result.rows[0].prosrc, authorization)
  }
  let targetBucket
  try {
    const identity = (await query(`SELECT system_identifier::text AS cluster, current_database() AS database,
      (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid FROM pg_control_system()`)).rows[0]
    validateDatabaseIdentity(identity, authorization)
    targetBucket = await installedTarget()
    await query("SET default_transaction_isolation='read committed'")
    check((await query("SELECT pg_try_advisory_lock(hashtextextended('gugu:legacy-evidence-migration',0)) AS ok")).rows[0].ok)
    if (mutating) check((await query("SELECT pg_try_advisory_lock(hashtextextended('gugu:file-transfer:quota',0)) AS ok")).rows[0].ok)
    const buckets = (await query('SELECT id, public FROM storage.buckets WHERE id=ANY($1::text[])', [[config.sourceBucket, config.targetBucket]])).rows
    check(buckets.length === 2 && buckets.find(row => row.id === config.sourceBucket)?.public === true
      && buckets.find(row => row.id === config.targetBucket)?.public === false)
    await query('SELECT screenshot_paths FROM identity.feedback LIMIT 0')
    const guards = await query(`SELECT count(*)::integer AS n FROM pg_trigger WHERE NOT tgisinternal
      AND tgenabled IN ('O','A') AND ((tgrelid='identity.feedback'::regclass AND tgname='validate_feedback_screenshots')
        OR (tgrelid='storage.objects'::regclass AND tgname='guard_feedback_screenshot_delete'))`)
    check(guards.rows[0].n === 2)
  } catch (error) { await db.end(); throw error }
  const objects = 'id,bucket_id,name,version,updated_at,metadata'
  async function request(suffix, method = 'GET', body, type) {
    const response = await fetch(`${config.storageRoot}${suffix}`, { method, redirect: 'error',
      signal: AbortSignal.timeout(60000), headers: { authorization: `Bearer ${token}`, apikey: token,
        ...(type ? { 'content-type': type } : {}), ...(method === 'POST' ? { 'x-upsert': 'false' } : {}) }, body })
    if (!response.ok) { await response.body?.cancel(); check(false) }
    return response
  }
  const encoded = name => name.split('/').map(encodeURIComponent).join('/')
  return {
    close: () => db.end(),
    assertTargetContract: async () => { check(await installedTarget() === targetBucket) },
    maintenanceSha256: digest(config.maintenanceId),
    legacyRows: async () => (await query('SELECT id,user_id,screenshot_urls,screenshot_paths FROM identity.feedback WHERE cardinality(screenshot_urls)>0 ORDER BY id')).rows,
    sourceByName: async name => (await query(`SELECT ${objects} FROM storage.objects WHERE bucket_id=$1 AND name=$2`, [config.sourceBucket, name])).rows[0],
    sourceById: async id => (await query(`SELECT ${objects} FROM storage.objects WHERE bucket_id=$1 AND id=$2`, [config.sourceBucket, id])).rows[0],
    sourceAbsent: async name => {
      const response = await fetch(`${config.storageRoot}/object/authenticated/${encodeURIComponent(config.sourceBucket)}/${encoded(name)}`,
        { redirect: 'error', signal: AbortSignal.timeout(60000), headers: { authorization: `Bearer ${token}`, apikey: token } })
      if (![400, 404].includes(response.status)) { await response.body?.cancel(); return false }
      const chunks = []; let size = 0
      for await (const chunk of response.body) { size += chunk.length; check(size <= 8192); chunks.push(chunk) }
      return missingResponse(response.status, JSON.parse(Buffer.concat(chunks).toString('utf8')))
    },
    row: async id => (await query('SELECT user_id,screenshot_urls,screenshot_paths FROM identity.feedback WHERE id=$1', [id])).rows[0],
    targetExists: async name => (await query('SELECT 1 FROM storage.objects WHERE bucket_id=$1 AND name=$2', [targetBucket, name])).rowCount === 1,
    read: async (location, limit) => {
      if (!location.source) check(await installedTarget() === targetBucket)
      const bucket = location.source ? config.sourceBucket : targetBucket
      const name = location.source ? location.source.name : location.target
      const response = await request(`/object/authenticated/${encodeURIComponent(bucket)}/${encoded(name)}`)
      const chunks = []; let size = 0
      for await (const chunk of response.body) { size += chunk.length; check(size <= limit); chunks.push(chunk) }
      return Buffer.concat(chunks)
    },
    upload: async (name, bytes, type) => {
      check(await installedTarget() === targetBucket)
      check(typeof type === 'string' && /^image\/[A-Za-z0-9.+-]+$/.test(type))
      const response = await request(`/object/${encodeURIComponent(targetBucket)}/${encoded(name)}`, 'POST', bytes, type)
      await response.body?.cancel()
    },
    replaceRow: async (expected, targets) => {
      await query('BEGIN')
      try {
        await query("SET LOCAL lock_timeout='3s'")
        const row = (await query('SELECT user_id,screenshot_urls,screenshot_paths FROM identity.feedback WHERE id=$1 FOR UPDATE', [expected.id])).rows[0]
        check(row && row.user_id === expected.owner)
        if (row.screenshot_urls.length === 0) check(digest(row.screenshot_paths) === digest(targets))
        else {
          check(rowIdentity(row) === expected.identity)
          await query("UPDATE identity.feedback SET screenshot_paths=$2, screenshot_urls='{}' WHERE id=$1", [expected.id, targets])
        }
        await query('COMMIT')
      } catch (error) { await query('ROLLBACK'); throw error }
    },
    referenced: async source => (await query('SELECT identity.storage_object_is_referenced($1,$2) AS used', [config.sourceBucket, source.name])).rows[0].used !== false,
    // Source bytes go through Storage, never SQL DELETE on storage.objects.
    remove: async source => {
      const response = await request(`/object/${encodeURIComponent(config.sourceBucket)}`, 'DELETE', JSON.stringify({ prefixes: [source.name] }), 'application/json')
      await response.body?.cancel()
    }
  }
}

async function main() {
  const { mode, options } = parseArguments(process.argv.slice(2))
  const scriptSha256 = sha256(await readFile(fileURLToPath(import.meta.url)))
  const configFile = process.env.GUGU_LEGACY_CONFIG || '', authorizationFile = process.env.GUGU_LEGACY_ENV_AUTH || ''
  const config = await load(configFile), authorization = await load(authorizationFile)
  check(await realpath(configFile) !== await realpath(authorizationFile))
  const configurationStat = await lstat(configFile), authorizationStat = await lstat(authorizationFile)
  check(configurationStat.dev !== authorizationStat.dev || configurationStat.ino !== authorizationStat.ino)
  const databaseUrl = process.env.GUGU_LEGACY_DATABASE_URL, token = process.env.GUGU_LEGACY_STORAGE_KEY
  check(databaseUrl && token)
  config.fingerprint = validateEnvironment(config, databaseUrl, authorization, mode, scriptSha256)
  const stateFile = options['--state']
  if (mode !== 'dry-run') check(config.maintenanceWindow === true
    && typeof config.maintenanceId === 'string' && config.maintenanceId.trim().length > 0)
  let lock, io
  try {
    if (stateFile) {
      await privatePath(stateFile)
      lock = await open(`${stateFile}.lock`, 'wx', 0o600)
      await lock.writeFile(JSON.stringify({ pid: process.pid }) + '\n'); await lock.sync()
    }
    let state, report, approval
    if (mode !== 'dry-run') {
      try { state = await load(stateFile) }
      catch (error) { if (mode !== 'migrate' || error.code !== 'ENOENT') throw error }
      if (state) check(state.schema === 1 && state.scriptSha256 === scriptSha256 && state.environment === config.fingerprint)
    }
    if (mode === 'delete') {
      report = await load(options['--report']); approval = await load(options['--approval'])
      validateApproval(state, report, approval, scriptSha256)
      check(report.maintenanceSha256 === digest(config.maintenanceId))
    }
    io = await authorizedConnection(config, databaseUrl, token, mode, authorization, scriptSha256)
    const persist = value => save(stateFile, value)
    if (mode === 'dry-run') {
      const result = await inventory(io, config, scriptSha256)
      console.log(JSON.stringify({ ...totals(result), failedNumbers: result.failures }))
      if (result.failures.length) process.exitCode = 1
    } else if (mode === 'migrate') {
      if (!state) {
        state = await inventory(io, config, scriptSha256)
        check(state.failures.length === 0)
        await save(stateFile, state, true)
      }
      // A failed attempt is retryable, but an invalid initial inventory never becomes a journal.
      state.failures = []
      const result = await migrate(io, state, persist)
      console.log(JSON.stringify(result)); if (result.failedNumbers.length) process.exitCode = 1
    } else if (mode === 'report') {
      report = await readback(io, state)
      await save(options['--report'], report, true)
      console.log(JSON.stringify({ ...report, reportSha256: digest(report) }))
      if (!report.complete) process.exitCode = 1
    } else {
      const result = await deleteCopies(io, state, report, approval, scriptSha256, persist)
      console.log(JSON.stringify(result)); if (result.failedNumbers.length) process.exitCode = 1
    }
  } finally {
    if (io) await io.close()
    if (lock) { await lock.close(); await unlink(`${stateFile}.lock`) }
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  // Provider, PostgreSQL, URL and filesystem exceptions can contain sensitive values.
  main().catch(() => { console.error(JSON.stringify({ failed: true })); process.exitCode = 1 })
}
