import { randomUUID, createHash } from 'node:crypto'
import { readFile, open, stat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import pg from 'pg'

const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex')
const requireThat = (condition, message) => { if (!condition) throw new Error(message) }
const databaseId = url => { const value = new URL(url); return digest([value.hostname, value.port || '5432', value.pathname]) }
const load = async file => JSON.parse(await readFile(file, 'utf8'))
async function save(file, value) {
  const handle = await open(file, 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync() }
  finally { await handle.close() }
  const directory = await open(path.dirname(path.resolve(file)), 'r')
  try { await directory.sync() } finally { await directory.close() }
}
const columns = "jsonb_build_object('id',o.id,'bucket_id',o.bucket_id,'name',o.name,'version',o.version,'owner',o.owner::text,'owner_id',o.owner_id,'metadata',o.metadata) AS object"

export function objectPath(storage, object) {
  const segments = [storage.storageBucket, storage.tenant, object.bucket_id, ...object.name.split('/')]
  if (object.version) segments.push(object.version)
  requireThat(segments.every(part => typeof part === 'string' && part && !['.', '..'].includes(part) && !/[\\/\0]/.test(part)), 'Unsafe storage object path')
  requireThat(storage.separator === '/' || storage.separator === '-$v-', 'Unsupported file version separator')
  const name = storage.separator === '-$v-' && object.version
    ? path.join(...segments.slice(0, -2), segments.at(-2) + storage.separator + segments.at(-1)) : path.join(...segments)
  const result = path.resolve(storage.root, name)
  requireThat(result.startsWith(path.resolve(storage.root) + path.sep), 'Storage object escaped its root')
  return result
}

/** Only physical ENOENT is absence. Permission, I/O and all other failures abort the run. */
export async function physicallyMissing(file, inspect = stat) {
  try { requireThat((await inspect(file)).isFile(), 'Storage object is not a regular file'); return false }
  catch (error) { if (error.code === 'ENOENT') return true; throw error }
}
async function objectById(db, id, lock = false) {
  const result = await db.query(`SELECT ${columns} FROM storage.objects o WHERE o.id=$1 ${lock ? 'FOR UPDATE' : ''}`, [id])
  requireThat(result.rows.length === 1, 'Expected storage metadata is unavailable')
  return result.rows[0].object
}
async function control(db, manifest) {
  const object = await objectById(db, manifest.control.object.id)
  requireThat(digest(object) === digest(manifest.control.object), 'Control metadata changed')
  const file = await stat(objectPath(manifest.storage, object))
  requireThat(file.isFile() && file.size === manifest.control.size && String(file.dev) === manifest.control.device && String(file.ino) === manifest.control.inode,
    'Storage mount or known-good control changed; refusing to infer absence')
}
async function transaction(db, operation) {
  await db.query('BEGIN')
  try {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('gugu:file-transfer:quota',0))")
    const value = await operation()
    await db.query('COMMIT')
    return value
  } catch (error) { await db.query('ROLLBACK'); throw error }
}

export async function scan(db, url, options) {
  const root = await realpath(options.root)
  requireThat((await stat(root)).isDirectory(), 'Storage root is unavailable')
  const storage = { root, tenant: options.tenant, storageBucket: options.storageBucket, separator: options.separator || '/' }
  const object = await objectById(db, options.control)
  const known = await stat(objectPath(storage, object))
  requireThat(known.isFile(), 'Known-good control must be a physical file')
  const manifest = { schema: 1, kind: 'gugu-missing-attachments', database: databaseId(url), storage,
    control: { object, size: known.size, device: String(known.dev), inode: String(known.ino) }, entries: [] }
  requireThat(Array.isArray(options.buckets) && options.buckets.length > 0, 'Explicit storage buckets are required')
  const result = await db.query(`SELECT ${columns} FROM storage.objects o
    WHERE o.bucket_id=ANY($1::text[]) AND ($2::text IS NULL OR COALESCE(NULLIF(o.owner_id,''),o.owner::text)=$2) ORDER BY o.id`, [options.buckets, options.owner || null])
  for (const row of result.rows) if (await physicallyMissing(objectPath(storage, row.object))) manifest.entries.push(row.object)
  await control(db, manifest)
  return manifest
}

/** The immutable backup is written before any ledger mutation; Storage tables are read-only. */
export async function apply(db, url, manifest, backupFile, expectedDigest) {
  requireThat(manifest.schema === 1 && manifest.kind === 'gugu-missing-attachments' && manifest.database === databaseId(url), 'Wrong reconciliation manifest/database')
  requireThat(digest(manifest) === expectedDigest, 'Manifest differs from the reviewed digest')
  requireThat(new Set(manifest.entries.map(row => row.id)).size === manifest.entries.length, 'Duplicate manifest objects')
  return transaction(db, async () => {
    await control(db, manifest)
    const changes = [], now = (await db.query('SELECT to_jsonb(transaction_timestamp()) AS at')).rows[0].at
    for (const expected of [...manifest.entries].sort((a, b) => a.id.localeCompare(b.id))) {
      const object = await objectById(db, expected.id, true)
      requireThat(digest(object) === digest(expected), 'Object metadata changed since the scan')
      requireThat(await physicallyMissing(objectPath(manifest.storage, object)), 'A candidate now exists; rescan before applying')
      const found = await db.query('SELECT to_jsonb(s) AS ledger FROM chat.file_transfer_storage s WHERE bucket_id=$1 AND object_name=$2 FOR UPDATE', [object.bucket_id, object.name])
      const before = found.rows[0]?.ledger || null
      requireThat(!before || ['ready', 'gone'].includes(before.state), 'Object is being deleted; do not race its owner')
      let after
      if (before) after = { ...before, state: 'gone' }
      else {
        const owner = object.owner_id || object.owner || object.name.split('/')[0]
        const account = (await db.query("SELECT CASE WHEN type='human' THEN id ELSE owner_user_id END AS id FROM identity.users WHERE id=$1", [owner])).rows[0]?.id || null
        const blob = (await db.query('SELECT id FROM chat.file_blobs WHERE bucket_id=$1 AND object_name=$2', [object.bucket_id, object.name])).rows
        requireThat(blob.length <= 1, 'Ambiguous file blob identity')
        const bytes = object.metadata?.size == null ? null : Number(object.metadata.size)
        requireThat(bytes === null || Number.isSafeInteger(bytes) && bytes >= 0, 'Invalid historical object length')
        after = { id: randomUUID(), blob_id: blob[0]?.id || null, owner_account: account, bucket_id: object.bucket_id,
          object_name: object.name, size_bytes: bytes, state: 'gone', created_at: now }
      }
      changes.push({ object, before, after })
    }
    const backup = { schema: 1, kind: 'gugu-missing-attachments-backup', database: manifest.database, manifestDigest: expectedDigest, changes }
    await save(backupFile, backup)
    for (const change of changes) {
      const { before, after } = change
      const result = before
        ? await db.query("UPDATE chat.file_transfer_storage SET state='gone' WHERE id=$1 RETURNING to_jsonb(file_transfer_storage) AS ledger", [before.id])
        : await db.query(`INSERT INTO chat.file_transfer_storage(id,blob_id,owner_account,bucket_id,object_name,size_bytes,state,created_at)
          VALUES($1,$2,$3,$4,$5,$6,'gone',$7) RETURNING to_jsonb(file_transfer_storage) AS ledger`,
        [after.id, after.blob_id, after.owner_account, after.bucket_id, after.object_name, after.size_bytes, after.created_at])
      requireThat(digest(result.rows[0].ledger) === digest(after), 'Unexpected ledger shape; transaction rolled back')
    }
    await control(db, manifest)
    return { marked: changes.length, backupDigest: digest(backup) }
  })
}

export async function rollback(db, url, backup, expectedDigest) {
  requireThat(backup.schema === 1 && backup.kind === 'gugu-missing-attachments-backup' && backup.database === databaseId(url), 'Wrong rollback backup/database')
  requireThat(digest(backup) === expectedDigest, 'Backup differs from the reviewed digest')
  return transaction(db, async () => {
    for (const change of backup.changes) {
      const found = await db.query('SELECT to_jsonb(s) AS ledger FROM chat.file_transfer_storage s WHERE id=$1 FOR UPDATE', [change.after.id])
      requireThat(digest(found.rows[0]?.ledger) === digest(change.after), 'Ledger changed after reconciliation; refusing to overwrite it')
      if (!change.before) {
        const dependencies = await db.query(`SELECT EXISTS(SELECT 1 FROM chat.file_transfer_storage_refs WHERE storage_id=$1)
          OR EXISTS(SELECT 1 FROM chat.file_transfer_reservations WHERE subject='object:'||$1::text) AS used`, [change.after.id])
        requireThat(!dependencies.rows[0].used, 'New ledger row acquired references; preserve its accounting history')
      }
    }
    for (const change of backup.changes) {
      if (change.before) await db.query('UPDATE chat.file_transfer_storage SET state=$1 WHERE id=$2', [change.before.state, change.before.id])
      else await db.query('DELETE FROM chat.file_transfer_storage WHERE id=$1', [change.after.id])
    }
    return { restored: backup.changes.length }
  })
}

async function main() {
  const [mode, ...args] = process.argv.slice(2), options = {}
  requireThat(['scan', 'apply', 'rollback'].includes(mode), 'Usage: reconcile-missing-attachments.mjs scan|apply|rollback --option value ...')
  for (let i = 0; i < args.length; i += 2) {
    requireThat(args[i].startsWith('--') && args[i + 1] && !args[i + 1].startsWith('--'), 'Options require explicit values')
    const key = args[i].slice(2).replace(/-([a-z])/g, (_match, char) => char.toUpperCase())
    const allowed = mode === 'scan' ? ['root', 'tenant', 'storageBucket', 'buckets', 'control', 'manifest', 'owner', 'separator']
      : mode === 'apply' ? ['manifest', 'backup', 'digest'] : ['backup', 'digest']
    requireThat(allowed.includes(key), 'Unknown option')
    requireThat(!(key in options), 'Duplicate option'); options[key] = args[i + 1]
  }
  const url = process.env.GUGU_MISSING_DATABASE_URL
  requireThat(url, 'Set GUGU_MISSING_DATABASE_URL privately; never put database credentials in argv')
  const db = new pg.Client({ connectionString: url })
  await db.connect()
  try {
    if (mode === 'scan') {
      for (const key of ['root', 'tenant', 'storageBucket', 'buckets', 'control', 'manifest']) requireThat(options[key], 'Missing scan option: ' + key)
      const manifest = await scan(db, url, { ...options, buckets: options.buckets.split(',') })
      await save(options.manifest, manifest)
      console.log(JSON.stringify({ candidates: manifest.entries.length, manifestDigest: digest(manifest) }))
    } else if (mode === 'apply') {
      requireThat(options.manifest && options.backup && options.digest, 'Apply requires manifest, new backup file and reviewed digest')
      console.log(JSON.stringify(await apply(db, url, await load(options.manifest), options.backup, options.digest)))
    } else {
      requireThat(options.backup && options.digest, 'Rollback requires backup and reviewed backup digest')
      console.log(JSON.stringify(await rollback(db, url, await load(options.backup), options.digest)))
    }
  } finally { await db.end() }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error instanceof Error ? error.message.replace(/postgres(?:ql)?:\/\/\S+/g, '[database credential redacted]') : 'Reconciliation failed'); process.exitCode = 1 })
}
