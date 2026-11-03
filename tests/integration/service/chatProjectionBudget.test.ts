import { createRequire } from 'node:module'
import { afterAll, beforeAll, it } from 'vitest'
import { budgetCases } from './chatProjectionBudgetCases.mjs'

const { Client } = createRequire(import.meta.url)('pg')
let db: { connect(): Promise<void>; end(): Promise<void>; query(sql: string, args?: unknown[]): Promise<unknown> }
beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1','localhost','[::1]'].includes(url.hostname)) throw new Error('chat projection tests require disposable loopback PostgreSQL')
  db = new Client({ connectionString: url.href })
  await db.connect()
})
afterAll(async () => { await db?.end() })
for (const [name, run] of budgetCases) it(name, async () => {
  await db.query('BEGIN')
  try { await db.query("SET LOCAL track_functions='all'"); await run(db) }
  finally { await db.query('ROLLBACK') }
})
