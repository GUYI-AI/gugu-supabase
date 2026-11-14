import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

/**
 * 谁来叫回收(迁移 20261016124500;机制在 20261016104500):chat.file_blob_gc_kick 由 pg_cron 每 10 分钟叫一次 ——
 *   · 没有到期的活:什么都不发,回 NULL;
 *   · 有到期的(或租约过期该收回的):用 pg_net 带 service_role 的钥匙 POST attachments 函数的 /gc,地址和钥匙取 Vault;
 *   · 有活、Vault 里没设:当场报错,❌ 安静地什么都不做。
 * pg_net 在事务提交以后才发:每条用例 BEGIN…ROLLBACK,排进 net.http_request_queue 的请求随它回滚,一个都不会真发出去。
 * 回收队列全库共享:先拿 advisory 锁 tests:file_blob_gc(见 messageFileRefsConcurrency)。
 */
interface DatabaseClient {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>
}
const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => DatabaseClient
}
let database: DatabaseClient
const URL_SECRET = 'http://supabase_kong_test:8000/functions/v1/attachments/gc'

async function fails(sql: string, values: unknown[] = []): Promise<string> {
  await database.query('SAVEPOINT expected_failure')
  try {
    await database.query(sql, values)
  } catch (error) {
    await database.query('ROLLBACK TO SAVEPOINT expected_failure')
    return (error as Error).message
  }
  await database.query('RELEASE SAVEPOINT expected_failure')
  throw new Error(`expected failure, but succeeded: ${sql}`)
}
/** A blob queued for collection, due now (or with a lease gone stale). */
async function queued(state: 'due' | 'later' | 'stale'): Promise<string> {
  const user = randomUUID()
  await database.query(`INSERT INTO auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES ($1,'authenticated','authenticated',$2,'{"provider":"email","providers":["email"]}','{}',now(),now())`, [user, `${user}@gc-kick.invalid`])
  await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human','GC kick') ON CONFLICT (id) DO NOTHING`, [user])
  const digest = createHash('sha256').update(randomUUID()).digest('hex')
  await database.query('SET LOCAL role TO service_role')
  const { rows } = await database.query<{ blob_id: string }>('SELECT blob_id FROM chat.file_blob_register($1,$2,$3,10,$4)', [user, `staging/${user}/${randomUUID()}`, digest, 'image/png'])
  await database.query('RESET role')
  const blob = rows[0]!.blob_id
  if (state === 'stale') {
    await database.query(`INSERT INTO chat.file_blob_gc (blob_id, status, claim_token, claimed_at, next_attempt_at, attempt_count)
      VALUES ($1, 'running', gen_random_uuid(), now() - interval '601 seconds', now(), 1)`, [blob])
  } else {
    await database.query(`INSERT INTO chat.file_blob_gc (blob_id, next_attempt_at) VALUES ($1, now() + $2::interval)`, [blob, state === 'due' ? '-1 second' : '24 hours'])
  }
  return blob
}
const kick = async () => (await database.query<{ id: string | null }>('SELECT chat.file_blob_gc_kick() AS id')).rows[0]!.id
const requests = async () => (await database.query<{ id: string; method: string; url: string; headers: Record<string, string>; timeout_milliseconds: number }>(
  'SELECT id::text, method, url, headers, timeout_milliseconds FROM net.http_request_queue ORDER BY id')).rows
async function secrets(url: string | null, key: string | null) {
  // 这个库原来设没设,都先清掉(本事务内,随回滚恢复),再按用例设。
  await database.query(`DELETE FROM vault.secrets WHERE name IN ('attachments_gc_url', 'attachments_gc_key')`)
  if (url !== null) await database.query(`SELECT vault.create_secret($1, 'attachments_gc_url')`, [url])
  if (key !== null) await database.query(`SELECT vault.create_secret($1, 'attachments_gc_key')`, [key])
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('fileBlobGcKick.test requires a loopback PostgreSQL database')
  }
  database = new Client({ connectionString: url.href })
  await database.connect()
})
afterAll(async () => { await database?.end() })
beforeEach(async () => {
  await database.query('BEGIN')
  await database.query(`SELECT pg_advisory_xact_lock(hashtextextended('tests:file_blob_gc', 0))`)
  await database.query('UPDATE chat.file_blob_gc_control SET enabled=true,batch_limit=50 WHERE singleton')
})
afterEach(async () => { await database?.query('ROLLBACK') })

describe('chat.file_blob_gc_kick', () => {
  it('没有到期的活:不发请求、回 NULL(Vault 设没设都一样)', async () => {
    await secrets(URL_SECRET, 'service-key-for-test')
    await queued('later')
    const before = (await requests()).length
    expect(await kick()).toBeNull()
    expect((await requests()).length).toBe(before)
  })

  it('有到期的:带 service_role 的钥匙 POST Vault 里的地址,事务提交以后才发;租约过期该收回的也算', async () => {
    await secrets(URL_SECRET, 'service-key-for-test')
    await queued('due')
    const id = await kick()
    expect(id).not.toBeNull()
    const sent = (await requests()).find((r) => r.id === id)!
    expect(sent).toMatchObject({ method: 'POST', url: URL_SECRET, timeout_milliseconds: 120000 })
    expect(sent.headers).toMatchObject({ Authorization: 'Bearer service-key-for-test', 'Content-Type': 'application/json' })
    // 租约过期(调用者死了):领取那一步会收回,也要叫。
    await database.query('DELETE FROM chat.file_blob_gc')
    await queued('stale')
    expect(await kick()).not.toBeNull()
  })

  it('有活、Vault 里没设(或设成空):当场报错,点名缺什么', async () => {
    await queued('due')
    await secrets(null, null)
    expect(await fails('SELECT chat.file_blob_gc_kick()')).toMatch(/blobs are due for collection but Vault has no attachments_gc_url \/ attachments_gc_key/)
    await secrets(URL_SECRET, null)
    expect(await fails('SELECT chat.file_blob_gc_kick()')).toMatch(/attachments_gc_key/)
    await secrets(URL_SECRET, '  ')
    expect(await fails('SELECT chat.file_blob_gc_kick()')).toMatch(/attachments_gc_key/)
  })

  it('谁都不能直接调(只有 pg_cron 那个角色);排在 pg_cron 里,每 10 分钟一次(本库是 pg_cron 调度的那个库时)', async () => {
    const { rows } = await database.query<{ anon: boolean; auth: boolean; service: boolean }>(`
      SELECT has_function_privilege('anon', 'chat.file_blob_gc_kick()', 'EXECUTE') AS anon,
             has_function_privilege('authenticated', 'chat.file_blob_gc_kick()', 'EXECUTE') AS auth,
             has_function_privilege('service_role', 'chat.file_blob_gc_kick()', 'EXECUTE') AS service`)
    expect(rows[0]).toEqual({ anon: false, auth: false, service: false })
    const cronDb = (await database.query<{ db: string | null }>(`SELECT current_setting('cron.database_name', true) AS db`)).rows[0]!.db
    const here = (await database.query<{ db: string }>('SELECT current_database() AS db')).rows[0]!.db
    if (cronDb !== here) return
    const job = (await database.query<{ schedule: string; command: string }>(`SELECT schedule, command FROM cron.job WHERE jobname = 'file-blob-gc-kick'`)).rows
    expect(job).toEqual([{ schedule: '*/10 * * * *', command: 'SELECT chat.file_blob_gc_kick()' }])
  })
})
