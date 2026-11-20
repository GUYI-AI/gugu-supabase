import { createFixtureGroup } from '../../support/groupFixture'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * 附件的两个竞态,两个连接各自提交(复核 L11 实测过的那两组,gugu-base notes/reviews/2026-10-16-file-blobs-sb123-27933585-kit/
 * race.sh、deadlock.sh):
 *   · 修剪 vs 钉旧版本:换版本那边(workspace_replace_file_as)拿着条目、裁掉了第 2 版还没提交,这边发一条钉第 2 版的附件 ⇒
 *     排在它后面,拿到锁时看得见第 2 版已经没了,拒;反过来这边先到,修剪等这边提交、看得见钉住,第 2 版留下。
 *   · 回收领取 vs 正在用它的写:一个事务先用上 blob X(FOR SHARE)、接着又让 X 失去一个引用(要写 X 的回收队列行),
 *     领取那边已经锁住了 X 的队列行 ⇒ 领取锁不到 X 就跳过这一轮(SKIP LOCKED),不等、不成环;下一轮再核,还有人用就出队。
 * 夹具要提交,另一个连接才看得见;用完按确切 id 删(对话、这里建的 blob)。
 * 回收队列全库共享:这里提交的到期行只在拿着 advisory 锁 tests:file_blob_gc 的时候存在,别的文件领任务前先拿同一把锁。
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
let other: DatabaseClient
let monitor: DatabaseClient
const chats: string[] = []
const pointers: string[] = []
const GC_LOCK = `hashtextextended('tests:file_blob_gc', 0)`

async function asUser(id: string, db = database) {
  await db.query('SET LOCAL role TO authenticated')
  await db.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id, role: 'authenticated' })])
}
async function asOwner(db = database) {
  await db.query('RESET role')
}
async function human(name: string): Promise<string> {
  await asOwner()
  const id = randomUUID()
  await database.query(`INSERT INTO auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES ($1,'authenticated','authenticated',$2,'{"provider":"email","providers":["email"]}','{}',now(),now())`,
  [id, `${id}@message-file-refs-concurrency.invalid`])
  await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human',$2)
    ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`, [id, name])
  return id
}
async function newGroup(creator: string, initial: string[]): Promise<string> {
  const id = randomUUID()
  await asUser(creator)
  await createFixtureGroup(database, [
    id, 'Message file refs concurrency', creator, JSON.stringify(initial.map((user_id) => ({ user_id, role: 'member' }))),
  ])
  await asOwner()
  chats.push(id)
  return id
}
async function object(chatId: string, by: string): Promise<string> {
  const pointer = `${chatId}/${by}/${randomUUID()}.bin`
  await asOwner()
  await database.query(`INSERT INTO storage.objects (bucket_id, name) VALUES ('workspace',$1)`, [pointer])
  pointers.push(pointer)
  return pointer
}
async function binary(chatId: string, by: string, pointer?: string, filename = 'deck.bin'): Promise<string> {
  const at = pointer ?? await object(chatId, by)
  await asOwner()
  const { rows } = await database.query<{ id: string }>(
    `INSERT INTO chat.workspace_items (chat_id, kind, filename, content_type, blob_id, size_bytes, source_message_ids, created_by, version)
     VALUES ($1,'file',$2,'application/octet-stream',chat.file_blob_for_pointer($3,1,'application/octet-stream',$4),1,'{}',$4,1) RETURNING id`, [chatId, filename, at, by])
  return rows[0]!.id
}
const REPLACE = 'SELECT version FROM chat.workspace_replace_file_as($1,$2,$3,$4,NULL,NULL)'
const SEND = 'SELECT id FROM chat.send_message_idempotent($1,$2,$3,$4,$5,$6,NULL,NULL,false,false,NULL,$7,$8,NULL)'

/**
 * Until the statement on backend `pid` settles, or the database says it waits on a lock: a fact, read on `monitor`
 * (never a wall clock). The poll only sets how often it is read.
 */
async function waitingOn(pid: number, pending: Promise<unknown>): Promise<string> {
  let state = 'pending'
  pending.then(() => (state = 'settled'), () => (state = 'failed'))
  for (;;) {
    if (state !== 'pending') return state
    const { rows } = await monitor.query<{ t: string | null; e: string | null }>(
      'SELECT wait_event_type AS t, wait_event AS e FROM pg_stat_activity WHERE pid = $1', [pid])
    if (rows[0]?.t === 'Lock') return `waiting on ${rows[0].e}`
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
async function waitingOnQuota(waiter: number, holder: number, pending: Promise<unknown>) {
  expect(await waitingOn(waiter, pending)).toBe('waiting on advisory')
  const { rows } = await monitor.query<{ quota: boolean; blocker: boolean }>(`
    WITH quota AS (SELECT hashtextextended('gugu:file-transfer:quota',0) AS key)
    SELECT EXISTS (
      SELECT 1 FROM pg_locks waiting JOIN pg_locks held
        ON held.locktype=waiting.locktype AND held.database=waiting.database
       AND held.classid=waiting.classid AND held.objid=waiting.objid AND held.objsubid=waiting.objsubid
      CROSS JOIN quota
      WHERE waiting.pid=$1 AND NOT waiting.granted AND waiting.locktype='advisory'
        AND waiting.mode='ExclusiveLock' AND waiting.objsubid=1
        AND waiting.classid::bigint=((quota.key>>32)&4294967295::bigint)
        AND waiting.objid::bigint=(quota.key&4294967295::bigint)
        AND held.pid=$2 AND held.granted AND held.mode='ExclusiveLock'
    ) AS quota, $2::integer=ANY(pg_blocking_pids($1::integer)) AS blocker`, [waiter, holder])
  expect(rows).toEqual([{ quota: true, blocker: true }])
}
const pidOf = async (db: DatabaseClient) => (await db.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
/** The error a pending statement ended with (message | hint), or 'ok'. */
const outcome = (pending: Promise<unknown>) =>
  pending.then(() => 'ok', (error: Error & { hint?: string }) => `${error.message} | hint: ${error.hint ?? ''}`)

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('messageFileRefsConcurrency.test requires a loopback PostgreSQL database')
  }
  database = new Client({ connectionString: url.href })
  other = new Client({ connectionString: url.href })
  // Never switches role: a connection as authenticated cannot see other backends' waits.
  monitor = new Client({ connectionString: url.href })
  await Promise.all([database.connect(), other.connect(), monitor.connect()])
})
afterAll(async () => {
  if (!database) return
  await Promise.all([database, other].map(db => db.query('ROLLBACK').catch(() => undefined)))
  // 只删这里建的对话(条目、历史、消息随它走)和这里的 pointer 的 blob(回收队列行随它走);测试号留在用完即弃的库里。
  for (const chat of chats) await database.query('DELETE FROM chat.chats WHERE id = $1', [chat])
  await database.query(`DELETE FROM chat.file_blobs WHERE bucket_id = 'workspace' AND object_name = ANY($1)`, [pointers])
  await Promise.all([database.end(), other.end(), monitor.end()])
})

describe('修剪 vs 钉旧版本(复核 L11 要改 5)', () => {
  /** A committed file at version 51 (history 2..51): replacing it once more prunes version 2. Returns it and the text a message pinning v2 carries. */
  async function fileAt51(owner: string, group: string): Promise<{ file: string; envelope2: string }> {
    await database.query('BEGIN')
    const file = await binary(group, owner)
    for (let n = 2; n <= 51; n++) {
      await asUser(owner)
      await database.query(REPLACE, [file, owner, await object(group, owner), n])
    }
    await asOwner()
    const envelope2 = (await database.query<{ e: string }>('SELECT chat.workspace_version_envelope($1, 2) AS e', [file])).rows[0]!.e
    await database.query('COMMIT')
    return { file, envelope2 }
  }
  const versions = async (file: string) =>
    (await database.query<{ n: number }>('SELECT n FROM chat.workspace_item_versions WHERE item_id = $1 ORDER BY n', [file])).rows.map((r) => r.n)

  it('换版本的先到、拿着:钉第 2 版的那条排在它后面,拿到锁时第 2 版已经裁掉 ⇒ 拒;对照:钉的先到、拿着 ⇒ 修剪等它,第 2 版留下', async () => {
    await database.query('BEGIN')
    const owner = await human('Pin owner')
    const member = await human('Pin member')
    const group = await newGroup(owner, [member])
    await database.query('COMMIT')
    const a = await fileAt51(owner, group)
    const b = await fileAt51(owner, group)
    expect((await versions(a.file))[0]).toBe(2)
    const databasePid = await pidOf(database)
    const otherPid = await pidOf(other)

    // ① other 换到第 52 版(裁掉第 2 版),事务开着;database 发一条钉第 2 版的附件。
    await other.query('BEGIN')
    await asUser(owner, other)
    expect((await other.query<{ version: number }>(REPLACE, [a.file, owner, await object(group, owner), 99])).rows[0]!.version).toBe(52)
    await database.query('BEGIN')
    await asUser(member)
    const pinning = database.query(SEND, [randomUUID(), group, member, [], a.envelope2, 'attachment', a.file, 2])
    const pinned = outcome(pinning)
    let pinResult: string
    try {
      // The file row is now protected behind the same quota admission used by
      // replacement. Prove the exact key and peer holder, not any advisory wait.
      await waitingOnQuota(databasePid, otherPid, pinning)
    } finally {
      await other.query('COMMIT')
      pinResult = await pinned
      await database.query('ROLLBACK')
    }
    expect(pinResult).toMatch(/^version 2 of that file has no bytes to send \| hint: message_file_not_here$/)
    expect((await versions(a.file))[0], '第 2 版裁掉了,没有消息钉着它').toBe(3)

    // ② 对照:database 先钉第 2 版、事务开着;other 换到第 52 版,等它提交,修剪看得见钉住。
    await database.query('BEGIN')
    await asUser(member)
    await database.query(SEND, [randomUUID(), group, member, [], b.envelope2, 'attachment', b.file, 2])
    await other.query('BEGIN')
    await asUser(owner, other)
    const replacing = other.query(REPLACE, [b.file, owner, await object(group, owner), 99])
    const replaced = outcome(replacing)
    let replaceResult: string
    try {
      await waitingOnQuota(otherPid, databasePid, replacing)
    } finally {
      await database.query('COMMIT')
      replaceResult = await replaced
      await other.query('COMMIT')
    }
    expect(replaceResult).toBe('ok')
    const kept = await versions(b.file)
    expect(kept[0], '钉着的第 2 版留下').toBe(2)
    expect(kept).toHaveLength(51)
  })
})

describe('回收领取 vs 正在用它的写(复核 L11 建议:SKIP LOCKED)', () => {
  it('一个事务先用上 X、再让 X 失去一个引用;领取在两步之间:锁不到 X 就跳过这一轮、不等,写的那边照常提交(不死锁);下一轮核出还有人用,出队', async () => {
    await monitor.query(`SELECT pg_advisory_lock(${GC_LOCK})`)
    try {
      await database.query('BEGIN')
      const owner = await human('GC owner')
      const mate = await human('GC mate')
      const group = await newGroup(owner, [mate])
      const pointer = await object(group, owner)
      const d1 = await binary(group, owner, pointer, 'd1.bin')
      const d2 = await binary(group, owner, pointer, 'd2.bin')
      await database.query('DELETE FROM chat.workspace_items WHERE id = $1', [d2])
      const blob = (await database.query<{ id: string }>(`SELECT id FROM chat.file_blobs WHERE bucket_id = 'workspace' AND object_name = $1`, [pointer])).rows[0]!.id
      await database.query(`UPDATE chat.file_blob_gc SET next_attempt_at = now() - interval '1 second' WHERE blob_id = $1`, [blob])
      await database.query('COMMIT')
      const otherPid = await pidOf(other)
      const claim = async () => {
        await other.query('BEGIN')
        await other.query('SET LOCAL role TO service_role')
        const pending = other.query<{ blob_id: string }>('SELECT blob_id FROM chat.file_blob_gc_claim(50, 600)')
        const state = await waitingOn(otherPid, pending)
        const rows = state === 'settled' ? (await pending).rows.map((r) => r.blob_id) : []
        return { state, rows, pending }
      }

      // T(database):用上 X(又一行带它的 pointer ⇒ FOR SHARE),事务开着。
      await database.query('BEGIN')
      await binary(group, owner, pointer, 'd3.bin')
      // C(other):领。锁不到 X ⇒ 跳过,不等。
      const first = await claim()
      try {
        expect(first.state, '领取不等').toBe('settled')
        expect(first.rows, '这一轮跳过 X').not.toContain(blob)
      } finally {
        if (first.state !== 'settled') await database.query('ROLLBACK')
        await first.pending.catch(() => undefined)
        await other.query('COMMIT').catch(() => undefined)
      }
      // T 接着让 X 失去一个引用(写 X 的队列行):不撞环。
      await database.query('DELETE FROM chat.workspace_items WHERE id = $1', [d1])
      await database.query('COMMIT')
      const state = async () => (await database.query<{ state: string; queued: boolean; using: string }>(
        `SELECT b.state, EXISTS (SELECT 1 FROM chat.file_blob_gc g WHERE g.blob_id = b.id) AS queued,
                (SELECT count(*) FROM chat.workspace_items w WHERE w.blob_id = b.id)::text AS using
           FROM chat.file_blobs b WHERE b.id = $1`, [blob])).rows[0]
      expect(await state()).toEqual({ state: 'live', queued: true, using: '1' })

      // 下一轮(到期了、没人拿着):核出还有人用 ⇒ 出队,不领。
      await database.query(`UPDATE chat.file_blob_gc SET next_attempt_at = now() - interval '1 second' WHERE blob_id = $1`, [blob])
      const second = await claim()
      await other.query('COMMIT')
      expect(second.state).toBe('settled')
      expect(second.rows).not.toContain(blob)
      expect(await state()).toEqual({ state: 'live', queued: false, using: '1' })
    } finally {
      await database.query('ROLLBACK').catch(() => undefined)
      await monitor.query(`SELECT pg_advisory_unlock(${GC_LOCK})`)
    }
  })
})
