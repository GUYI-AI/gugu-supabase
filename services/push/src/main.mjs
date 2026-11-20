import { readFile, writeFile, rename } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'
import { loadPushProviders } from './configuration.mjs'
import { runPushBatch } from './worker.mjs'

let stopping = false
let providers
let database
let phase = 'configuration'
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true })
try {
  if (process.env.GUGU_PUSH_ENABLED !== '1') throw new Error('Push worker is not enabled')
  const required = name => {
    const value = process.env[name]
    if (!value) throw new Error('Missing push configuration')
    return value
  }
  const configured = await loadPushProviders(process.env, entry => process.stdout.write(JSON.stringify(entry) + '\n'))
  providers = configured.providers
  const environment = configured.environment
  const connectionString = process.env.GUGU_PUSH_DATABASE_URL_PATH
    ? (await readFile(process.env.GUGU_PUSH_DATABASE_URL_PATH, 'utf8')).trim() : required('GUGU_PUSH_DATABASE_URL')
  database = new pg.Client({ connectionString,
    application_name: 'gugu-push', connectionTimeoutMillis: 5000, query_timeout: 15000 })
  // A lost idle connection must exit visibly; never reconnect and replay a batch.
  database.on('error', () => { stopping = true; process.exitCode = 1 })
  phase = 'database_connect'
  await database.connect()
  phase = 'database_role'
  await database.query('SET ROLE gugu_push')
  await database.query("SET statement_timeout = '12s'")
  await database.query("SET idle_in_transaction_session_timeout = '15s'")
  const progress = async () => {
    const path = process.env.GUGU_PUSH_HEALTH_PATH
    if (!path) return
    if (!path.startsWith('/')) throw new Error('Invalid push health path')
    await writeFile(path + '.next', JSON.stringify({ progressAt: Date.now() }), { mode: 0o600 })
    await rename(path + '.next', path)
  }
  phase = 'delivery_batch'
  while (!stopping) {
    await runPushBatch(database, providers, environment, entry => process.stdout.write(JSON.stringify(entry) + '\n'), progress, () => stopping)
    if (!stopping) await delay(1000)
  }
} catch {
  process.stderr.write(JSON.stringify({ event: 'push_worker_failed', phase }) + '\n')
  process.exitCode = 1
} finally {
  for (const provider of Object.values(providers ?? {})) provider.close()
  await database?.end().catch(() => {})
}
