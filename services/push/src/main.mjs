import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'
import { createApnsProvider } from './apns.mjs'
import { runPushBatch } from './worker.mjs'

let stopping = false
let provider
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
  const environment = required('GUGU_APNS_ENVIRONMENT')
  provider = createApnsProvider({ environment, topic: required('GUGU_APNS_TOPIC'),
    keyId: required('GUGU_APNS_KEY_ID'), teamId: required('GUGU_APNS_TEAM_ID'),
    privateKey: await readFile(required('GUGU_APNS_PRIVATE_KEY_PATH'), 'utf8') })
  database = new pg.Client({ connectionString: required('GUGU_PUSH_DATABASE_URL'),
    application_name: 'gugu-push', connectionTimeoutMillis: 5000, query_timeout: 15000 })
  // A lost idle connection must exit visibly; never reconnect and replay a batch.
  database.on('error', () => { stopping = true; process.exitCode = 1 })
  phase = 'database_connect'
  await database.connect()
  phase = 'database_role'
  await database.query('SET ROLE gugu_push')
  await database.query("SET statement_timeout = '12s'")
  await database.query("SET idle_in_transaction_session_timeout = '15s'")
  phase = 'delivery_batch'
  while (!stopping) {
    await runPushBatch(database, provider, environment, entry => process.stdout.write(JSON.stringify(entry) + '\n'))
    if (!stopping) await delay(1000)
  }
} catch {
  process.stderr.write(JSON.stringify({ event: 'push_worker_failed', phase }) + '\n')
  process.exitCode = 1
} finally {
  provider?.close()
  await database?.end().catch(() => {})
}
