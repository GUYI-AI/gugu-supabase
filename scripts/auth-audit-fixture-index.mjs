import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'

// Disposable fixtures need the same separately prepared platform index as a
// deployed database. This entry can never target an arbitrary host or service.
export function prepareAuthAuditFixtureIndex(root, run = execFileSync) {
  if (realpathSync(root) !== root.replace(/\/$/, '')) throw new Error('Fixture checkout path differs')
  const owner = JSON.parse(readFileSync(path.join(root, '.local/test-db/owner.json'), 'utf8'))
  const checkout = root.endsWith('/') ? root : root + '/'
  const project = 'gugucommunitytest' + createHash('sha256').update(checkout).digest('hex').slice(0, 10)
  if (owner.root !== checkout || owner.project !== project || !Number.isInteger(owner.port)
      || owner.port < 1026 || owner.port > 65535) {
    throw new Error('Auth audit preparation requires this checkout\'s disposable fixture')
  }
  const container = 'supabase_db_' + project
  const binding = run('docker', ['port', container, '5432/tcp'], { encoding: 'utf8' }).trim()
  if (binding !== '127.0.0.1:' + owner.port) throw new Error('Auth audit fixture is not owned loopback')
  const sql = readFileSync(path.join(root, 'ops/auth-audit-retention-index.sql'), 'utf8')
  try {
    run('docker', ['exec', '-i', container, 'psql', '-X', '-U', 'supabase_admin', '-d', 'postgres',
      '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=sqlstate', '-P', 'pager=off'], { input: sql, stdio: ['pipe', 'pipe', 'pipe'], timeout: 125_000 })
  } catch (error) {
    const state = error?.stderr?.toString().match(/ERROR:\s+([A-Z0-9]{5})\b/)?.[1] ?? 'unavailable'
    throw new Error('Auth audit fixture index preparation failed (SQLSTATE=' + state + '); no automatic drop or rebuild was attempted')
  }
}
