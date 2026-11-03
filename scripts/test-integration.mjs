import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { foundationDigest, releases } from './foundation.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const directory = path.join(root, '.local/test-db')
const owner = JSON.parse(readFileSync(path.join(directory, 'owner.json'), 'utf8'))
const project = 'gugucommunitytest' + createHash('sha256').update(root).digest('hex').slice(0, 10)
if (owner.root !== root || owner.project !== project) throw new Error('Integration fixture ownership differs')
const status = JSON.parse(execFileSync(path.join(root, 'node_modules/.bin/supabase'), ['status', '--workdir', directory, '--output', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
const url = new URL(status.API_URL)
const database = new URL(status.DB_URL)
if (url.hostname !== '127.0.0.1' || Number(url.port) !== owner.port - 1
  || database.hostname !== '127.0.0.1' || Number(database.port) !== owner.port) {
  throw new Error('Integration fixture must use this checkout\'s loopback services')
}
if (!status.ANON_KEY || !status.SERVICE_ROLE_KEY) throw new Error('Integration fixture API keys are unavailable')
const db = new pg.Client({ connectionString: database.href })
await db.connect()
try {
  const { rows } = await db.query("SELECT digest FROM gugu_install.releases WHERE version='foundation-v1'")
  if (rows[0]?.digest !== foundationDigest) throw new Error('Install the matching community foundation before running integration tests')
  const { rows: installed } = await db.query("SELECT version,digest FROM gugu_install.releases WHERE version<>'foundation-v1'")
  const expected = releases.map((release) => release.version + ':' + release.digest).join(',')
  if (installed.map((row) => row.version + ':' + row.digest).sort().join(',') !== expected) throw new Error('Install the matching community releases before running integration tests')
  // Expose schemas only after they exist. This is the local equivalent of the Cloud setup PATCH.
  await db.query("ALTER ROLE authenticator SET pgrst.db_schemas='public,identity,chat,moments,graphql_public'; NOTIFY pgrst, 'reload config'; NOTIFY pgrst, 'reload schema'")
} finally { await db.end() }
const deadline = Date.now() + 30_000
let ready = false
while (Date.now() < deadline) {
  const response = await fetch(url.origin + '/rest/v1/users?select=id&limit=0', {
    headers: { apikey: status.ANON_KEY, authorization: 'Bearer ' + status.SERVICE_ROLE_KEY, 'accept-profile': 'identity' },
    signal: AbortSignal.timeout(3000),
  }).catch(() => null)
  if (response?.ok) { await response.body?.cancel(); ready = true; break }
  await response?.body?.cancel()
  await new Promise((resolve) => setTimeout(resolve, 250))
}
if (!ready) throw new Error('The fixture Data API did not expose the installed foundation')
const options = {
  cwd: root, stdio: 'inherit',
  env: {
    ...process.env,
    GUGU_INTEGRATION_DATABASE_URL: database.href,
    GUGU_INTEGRATION_SUPABASE_URL: url.origin,
    GUGU_SUPABASE_URL: url.origin,
    VITE_SUPABASE_URL: url.origin,
    VITE_SUPABASE_ANON_KEY: status.ANON_KEY,
    GUGU_INTEGRATION_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
    SUPABASE_SERVICE_ROLE_KEY: status.SERVICE_ROLE_KEY,
  },
}
const args = process.argv.slice(2)
const run = (filters) => execFileSync(path.join(root, 'node_modules/.bin/vitest'), ['run', '--project', 'integration', ...filters], options)
if (args.length === 0) {
  // Quota configuration and next-idle-pass GC assertions share the global quota lock.
  // Keep their suites isolated; the GC race suite still runs its own concurrent transactions.
  run(['--maxWorkers=1','tests/integration/service/fileTransferBudget.test.ts','tests/integration/service/largeFileIdleExpiry.test.ts','tests/integration/service/fileTransferConcurrency.test.ts','tests/integration/service/topicSourceResources.test.ts','tests/integration/service/projectFileRevisions.test.ts','tests/integration/service/projectFilesPeer.test.ts','tests/integration/service/projectImageExpiry.test.ts','tests/integration/service/fileStorageClasses.test.ts','tests/integration/service/fileBlobs.test.ts','tests/integration/service/messageFileRefs.test.ts','tests/integration/service/messageFileRefsConcurrency.test.ts'])
  // Fault injection and operational rollback change shared DDL; finish before concurrent fixtures hold it.
  run(['--maxWorkers=1', 'tests/integration/service/groupAdminAs.test.ts','tests/integration/service/archiveSocialIdentity.test.ts','tests/integration/service/taskAgentQuietJoin.test.ts','tests/integration/service/removeDevice.test.ts','tests/integration/service/identityMemberLiveness.test.ts'])
  run(['--maxWorkers=4', '--exclude', '**/groupAdminAs.test.ts','--exclude','**/archiveSocialIdentity.test.ts','--exclude','**/taskAgentQuietJoin.test.ts','--exclude','**/removeDevice.test.ts','--exclude','**/identityMemberLiveness.test.ts','--exclude','**/fileTransferBudget.test.ts','--exclude','**/largeFileIdleExpiry.test.ts','--exclude','**/fileTransferConcurrency.test.ts','--exclude','**/topicSourceResources.test.ts','--exclude','**/projectFileRevisions.test.ts','--exclude','**/projectFilesPeer.test.ts','--exclude','**/projectImageExpiry.test.ts','--exclude','**/fileStorageClasses.test.ts','--exclude','**/fileBlobs.test.ts','--exclude','**/messageFileRefs.test.ts','--exclude','**/messageFileRefsConcurrency.test.ts'])
} else {
  run(['--maxWorkers=4', ...args])
}
