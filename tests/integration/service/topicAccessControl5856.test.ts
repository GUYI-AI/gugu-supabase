// @@@5856 话题的访问控制与投递判据 —— 对着**真库**跑的判官。
//
// 为什么非有这个文件不可:这条 PR 的五个真洞全部在数据层(悄悄话的正文变成话题名、
// 已退群的人靠 agent 回来、hide_history 被话题整段穿透、说一句话就解锁全部历史、
// 面包屑把来源正文发给读不到的人),而它们的修法此前只由一次性探针验证过 —— 探针随会话消失,
// 迁移注释里的「实测」不会再跑第二遍。判据没有判官,下一个人改动 RLS 时不会有任何东西变红。
//
// 与 productionFunctionAcl2733 同形:loopback PostgreSQL、`GUGU_INTEGRATION_DATABASE_URL`,
// 在 .github/ci-spec-coverage.json 里登记为 loopback-postgres-integration(普通 PR CI 不起这套库)。
// 跑法:`GUGU_INTEGRATION_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:34890/postgres \
//        pnpm exec vitest run topicAccessControl5856`
//
// 每条用例自己 BEGIN…ROLLBACK,库里零残留;**每条否定断言都配一个正对照** ——
// 「读到 0 行」既可能是判据生效,也可能是我连错了库或 RLS 上下文没设对,只有正对照能把两者分开。
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

interface QueryResult<Row> { rows: Row[] }
interface DatabaseClient {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = never>(sql: string, values?: unknown[]): Promise<QueryResult<Row>>
}

const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => DatabaseClient
}
const DATABASE_URL = (
  process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? ''
).trim()

let database: DatabaseClient

function requireLoopbackDatabase(): void {
  let parsed: URL
  try {
    parsed = new URL(DATABASE_URL)
  } catch {
    throw new Error('GUGU_INTEGRATION_DATABASE_URL is required')
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error(`topicAccessControl5856.test requires PostgreSQL, got ${parsed.protocol}`)
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
    throw new Error(`topicAccessControl5856.test requires loopback PostgreSQL, got ${parsed.hostname}`)
  }
}

/** 一个合法的十六进制 uuid —— auth.uid() 按 uuid 解析,随便编的字符串会在函数入口就炸。 */
function uid(tag: string, n: number): string {
  const head = tag.padEnd(8, '0').slice(0, 8).replace(/[^0-9a-f]/g, '0')
  return `${head}-aaaa-4000-8000-${String(n).padStart(12, '0')}`
}

/** 以某个身份跑一段 SQL。role/claims 都是 LOCAL 的,事务一回滚就没了。 */
async function asUser(userId: string): Promise<void> {
  await database.query('SET LOCAL role TO authenticated')
  await database.query(`SET LOCAL request.jwt.claims TO '{"sub":"${userId}","role":"authenticated"}'`)
}
async function asService(): Promise<void> {
  await database.query('RESET role')
}

beforeAll(async () => {
  requireLoopbackDatabase()
  database = new Client({ connectionString: DATABASE_URL })
  await database.connect()
})
afterAll(async () => { await database?.end() })

/** 每条用例一个事务;无论断言成败都回滚,❌ 不给库留任何一行。 */
async function inRollback(body: () => Promise<void>): Promise<void> {
  await database.query('BEGIN')
  try {
    await body()
  } finally {
    await database.query('ROLLBACK')
  }
}

/**
 * 跑一条**预期会被拒**的语句,并把它的错误原文交出来。
 * 必须包 SAVEPOINT:Postgres 里一次异常会把整个事务置为 aborted,后面每一条都只回
 * 「current transaction is aborted」—— 那时第二条否定断言看的是这句话,而不是真正的拒绝理由,
 * 等于判据失效了却仍然绿。
 */
async function rejection(sql: string, values: unknown[]): Promise<string> {
  await database.query('SAVEPOINT probe')
  try {
    await database.query(sql, values)
  } catch (error) {
    await database.query('ROLLBACK TO SAVEPOINT probe')
    return String((error as Error)?.message ?? error)
  }
  await database.query('RELEASE SAVEPOINT probe')
  throw new Error(`expected this to be rejected, but it succeeded: ${sql}`)
}

interface Fixture { owner: string; bob: string; carol: string; group: string; sourceMessage: string }

/**
 * 一个开了「新成员看不到入群前的历史」的群:owner 与 carol 是老成员(无时间界),
 * 群里有一条入群前的消息。bob 还没进来 —— 由用例自己决定什么时候让他入群。
 */
async function seedHiddenHistoryGroup(tag: string): Promise<Fixture> {
  const owner = uid(tag, 1)
  const bob = uid(tag, 2)
  const carol = uid(tag, 3)
  const group = uid(tag, 11)
  const sourceMessage = uid(tag, 21)
  await database.query(
    `INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human','群主'),($2,'human','Bob'),($3,'human','Carol')`,
    [owner, bob, carol],
  )
  await database.query(
    `INSERT INTO chat.chats (id, kind, name, creator_user_id, hide_history) VALUES ($1,'group','隐历史群',$2,true)`,
    [group, owner],
  )
  await database.query(
    `INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,'owner'),($1,$3,'member')`,
    [group, owner, carol],
  )
  // 建群的人与老成员没有「入群前」可言;入群触发器对每一行都置界,这里还原成 NULL。
  await database.query(
    `UPDATE chat.chat_members SET hide_history_before = NULL WHERE chat_id = $1 AND user_id IN ($2,$3)`,
    [group, owner, carol],
  )
  await database.query(
    `INSERT INTO chat.messages (id, chat_id, sender_user_id, seq, content, content_type, created_at)
     VALUES ($1,$2,$3,1,'裁员名单已定 SECRET-SOURCE','text', now() - interval '2 hour')`,
    [sourceMessage, group, owner],
  )
  return { owner, bob, carol, group, sourceMessage }
}

/** 主人替名下 agent 拉收件箱(客户端的 pull 路径),交出这一批的消息 id(按线内 seq)。 */
async function pulled(owner: string, agent: string): Promise<string[]> {
  await asUser(owner)
  const { rows } = await database.query<{ id: string }>(
    'SELECT id FROM identity.pull_agent_inbox_v2($1) ORDER BY chat_id, seq', [agent],
  )
  await asService()
  return rows.map(({ id }) => id)
}

async function createTopic(actor: string, f: Fixture, name: string, asUserId: string | null = null): Promise<string> {
  await asUser(actor)
  const { rows } = await database.query<{ chat_id: string }>(
    `SELECT chat_id FROM chat.create_topic($1,$2,$3,NULL,$4)`,
    [f.group, f.sourceMessage, name, asUserId],
  )
  return rows[0]!.chat_id
}

describe('#5856 话题的访问控制(对着真库跑)', () => {
  it('#6004: topic @all only notifies current participants and never invites source-only members', async () => {
    await inRollback(async () => {
      const f = await seedHiddenHistoryGroup('6004')
      const participant = uid('6004', 71)
      const invitee = uid('6004', 72)
      await database.query(
        `INSERT INTO identity.gugu_devices (device_id, user_id, label, hostname, platform)
         VALUES ('dev-6004',$1,'本机','mbp','darwin')`, [f.owner],
      )
      await database.query(
        `INSERT INTO identity.users (id, type, display_name, owner_user_id, device_id)
         VALUES ($1,'agent','话题参与者',$3,'dev-6004'),($2,'agent','来源群候选',$3,'dev-6004')`,
        [participant, invitee, f.owner],
      )
      await database.query(
        `INSERT INTO chat.chat_members (chat_id, user_id, role)
         VALUES ($1,$2,'member'),($1,$3,'member'),($1,$4,'member')`,
        [f.group, f.bob, participant, invitee],
      )
      const topic = await createTopic(f.owner, f, '@所有人范围')
      await asService()
      await database.query(
        `INSERT INTO chat.chat_members (chat_id, user_id, role, listen_mode)
         VALUES ($1,$2,'member','active'),($1,$3,'member','passive')`,
        [topic, f.carol, participant],
      )
      const memberIds = async () => (await database.query<{ user_id: string }>(
        'SELECT user_id FROM chat.chat_members WHERE chat_id = $1 ORDER BY user_id', [topic],
      )).rows.map(({ user_id }) => user_id)
      const send = async (messageId: string, to: string[]) => {
        await asUser(f.owner)
        const sent = await database.query<{ chat_id: string; to_user_ids: string[] }>(
          `SELECT chat_id, to_user_ids FROM chat.send_message_idempotent(
            $1,$2,$3,$4,'请本话题成员看一下','text',NULL,NULL,false,false)`,
          [messageId, topic, f.owner, to],
        )
        expect(sent.rows).toEqual([{ chat_id: topic, to_user_ids: to }])
        await asService()
      }
      const recipients = async (messageId: string) => {
        const commands = await database.query<{ user_id: string }>(
          `SELECT payload->>'agent_user_id' AS user_id FROM identity.gugu_device_commands
           WHERE type = 'agent.deliver' AND payload->>'message_id' = $1 ORDER BY user_id`, [messageId],
        )
        const revisions = await database.query<{ user_id: string }>(
          `SELECT user_id FROM chat.account_revisions WHERE event = 'message_created'
           AND resource_key->>'entity_id' = $1 AND resource_key->>'chat_id' = $2 ORDER BY user_id`,
          [messageId, topic],
        )
        return { agents: commands.rows.map(({ user_id }) => user_id), notified: revisions.rows.map(({ user_id }) => user_id) }
      }
      const originalMembers = [f.owner, f.carol, participant].sort()
      // Human account journals and agent delivery are separate contracts.
      const humanViewers = [f.owner, f.carol].sort()
      expect(await memberIds()).toEqual(originalMembers)
      const broadcast = uid('6004', 81)
      await send(broadcast, ['*'])
      expect(await memberIds()).toEqual(originalMembers)
      expect(await recipients(broadcast)).toEqual({ agents: [participant], notified: humanViewers })

      // Positive control: an explicit source mention still invites and delivers. The next @all
      // includes that new participant, while the source-only human (Bob) stays outside.
      const invitation = uid('6004', 82)
      await send(invitation, [invitee])
      const joinedMembers = [...originalMembers, invitee].sort()
      expect(await memberIds()).toEqual(joinedMembers)
      expect((await recipients(invitation)).agents).toEqual([invitee])
      // #6405(#6327 回归):push 给它排了 nudge,pull 也必须交得出这一条 —— 被拉进来的那条不是「入群前的历史」。
      // 正对照:同一个 agent 被拉进来之后的下一条 @ 本来就拉得到(没有这一格,「拉不到」可能只是 RLS 上下文没设对)。
      const followUp = uid('6004', 84)
      await send(followUp, [invitee])
      expect(await pulled(f.owner, invitee)).toEqual([invitation, followUp])
      const nextBroadcast = uid('6004', 83)
      await send(nextBroadcast, ['*'])
      expect(await memberIds()).toEqual(joinedMembers)
      expect(await recipients(nextBroadcast)).toEqual({ agents: [participant, invitee].sort(), notified: humanViewers })
    })
  })

  it('#6405 入群位置不能由调用方自报:直接插成员行时带的 joined_ingest_seq 被序列覆盖', async () => {
    await inRollback(async () => {
      const f = await seedHiddenHistoryGroup('6405')
      const { rows: [{ fence }] } = await database.query<{ fence: string }>(
        'SELECT max(ingest_seq)::text AS fence FROM chat.messages',
      )
      // 深度 1 的插入(PostgREST / RPC 函数体都是这个深度):自报 0 = 想把入群前的全部历史收进收件箱。
      await database.query(
        `INSERT INTO chat.chat_members (chat_id, user_id, role, joined_ingest_seq) VALUES ($1,$2,'member',0)`,
        [f.group, f.bob],
      )
      const { rows: [{ joined }] } = await database.query<{ joined: string }>(
        'SELECT joined_ingest_seq::text AS joined FROM chat.chat_members WHERE chat_id = $1 AND user_id = $2',
        [f.group, f.bob],
      )
      expect(BigInt(joined)).toBeGreaterThan(BigInt(fence))
    })
  })

  it('hide_history 继承来源线:被时间界挡住的人读不到话题里入群前的消息', async () => {
    await inRollback(async () => {
      const f = await seedHiddenHistoryGroup('a1')
      const topic = await createTopic(f.owner, f, '机密话题')
      await asService()
      await database.query(
        `INSERT INTO chat.messages (id, chat_id, sender_user_id, seq, content, content_type, created_at)
         VALUES ($1,$2,$3,1,'话题里的老消息 SECRET-TOPIC','text', now() - interval '90 minute')`,
        [uid('a1', 31), topic, f.owner],
      )
      await database.query(
        `INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,'member')`,
        [f.group, f.bob],
      )
      await database.query(
        `INSERT INTO chat.messages (id, chat_id, sender_user_id, seq, content, content_type)
         VALUES ($1,$2,$3,2,'VISIBLE-GROUP','text')`,
        [uid('a1', 32), f.group, f.owner],
      )

      await asUser(f.bob)
      // 正对照:群这一侧的门本来就是好的(他读得到入群后那条)——
      // 没有这一格,下面的「读不到」可能只是我 RLS 上下文没设对。
      const inGroup = await database.query<{ content: string }>(
        `SELECT content FROM chat.messages WHERE chat_id = $1 ORDER BY seq`, [f.group],
      )
      expect(inGroup.rows.map((r) => r.content)).toEqual(['VISIBLE-GROUP'])

      const inTopic = await database.query<{ content: string }>(
        `SELECT content FROM chat.messages WHERE chat_id = $1`, [topic],
      )
      expect(inTopic.rows).toHaveLength(0)
    })
  })

  it('❌ 在话题里说一句话不许解锁历史;而来源线里本来没有时间界的人照样读得到全部', async () => {
    await inRollback(async () => {
      const f = await seedHiddenHistoryGroup('a2')
      const topic = await createTopic(f.owner, f, '机密话题')
      await asService()
      await database.query(
        `INSERT INTO chat.messages (id, chat_id, sender_user_id, seq, content, content_type, created_at)
         VALUES ($1,$2,$3,1,'SECRET-TOPIC','text', now() - interval '90 minute')`,
        [uid('a2', 31), topic, f.owner],
      )
      await database.query(
        `INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,'member')`,
        [f.group, f.bob],
      )

      // 说话即参与(spec)—— 这一步必须成功,否则下面那条断言是空过的。
      await asUser(f.bob)
      await database.query(
        `INSERT INTO chat.messages (id, chat_id, sender_user_id, seq, content, content_type)
         VALUES ($1,$2,$3,2,'我也来说一句','text')`,
        [uid('a2', 33), topic, f.bob],
      )
      const afterSpeaking = await database.query<{ content: string }>(
        `SELECT content FROM chat.messages WHERE chat_id = $1 ORDER BY seq`, [topic],
      )
      expect(afterSpeaking.rows.map((r) => r.content)).toEqual(['我也来说一句'])

      // 反例:Carol 在来源线上没有时间界,被拉进话题之后读得到全部 —— 证明上面那条不是把门焊死。
      await asService()
      await database.query(
        `INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,'member')`,
        [topic, f.carol],
      )
      await asUser(f.carol)
      const carolSees = await database.query<{ content: string }>(
        `SELECT content FROM chat.messages WHERE chat_id = $1 ORDER BY seq`, [topic],
      )
      expect(carolSees.rows.map((r) => r.content)).toEqual(['SECRET-TOPIC', '我也来说一句'])
    })
  })

  it('来源预览不许把读不到的正文发出去,而读得到的人照常读得到', async () => {
    await inRollback(async () => {
      const f = await seedHiddenHistoryGroup('a3')
      await asService()
      await database.query(
        `INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,'member')`,
        [f.group, f.bob],
      )
      await asUser(f.bob)
      const blocked = await database.query(
        `SELECT reply_to_content FROM chat.message_reply_preview($1)`, [f.sourceMessage],
      )
      expect(blocked.rows).toHaveLength(0)

      // 正对照:同一条 RPC、同一个 message id,群主读得到 —— 证明不是把函数废了。
      await asUser(f.owner)
      const allowed = await database.query<{ reply_to_content: string }>(
        `SELECT reply_to_content FROM chat.message_reply_preview($1)`, [f.sourceMessage],
      )
      expect(allowed.rows[0]?.reply_to_content).toContain('SECRET-SOURCE')
    })
  })

  it('悄悄话与撤回的消息开不出话题;同一条线上正常的消息开得出', async () => {
    await inRollback(async () => {
      const f = await seedHiddenHistoryGroup('a4')
      await asService()
      await database.query(
        `INSERT INTO chat.messages (id, chat_id, sender_user_id, seq, content, content_type, is_whisper, to_user_ids)
         VALUES ($1,$2,$3,2,'只说给你听','text',true,ARRAY[$4])`,
        [uid('a4', 41), f.group, f.owner, f.carol],
      )
      await database.query(
        `INSERT INTO chat.messages (id, chat_id, sender_user_id, seq, content, content_type, retracted_at)
         VALUES ($1,$2,$3,3,'这句我收回','text', now())`,
        [uid('a4', 42), f.group, f.owner],
      )

      // 正对照:正常消息开得出,且名字截自正文。
      const ok = await createTopic(f.owner, f, '')
      const named = await database.query<{ name: string }>(`SELECT name FROM chat.chats WHERE id = $1`, [ok])
      expect(named.rows[0]?.name).toContain('裁员名单已定')

      await asUser(f.owner)
      expect(await rejection(
        `SELECT chat_id FROM chat.create_topic($1,$2,NULL,NULL,NULL)`, [f.group, uid('a4', 41)],
      )).toMatch(/whisper|not readable/i)
      expect(await rejection(
        `SELECT chat_id FROM chat.create_topic($1,$2,NULL,NULL,NULL)`, [f.group, uid('a4', 42)],
      )).toMatch(/retracted/i)
    })
  })

  it('离开来源线就离开它长出来的全部话题,别的线一行不动', async () => {
    await inRollback(async () => {
      const f = await seedHiddenHistoryGroup('a5')
      const topic = await createTopic(f.owner, f, '本群的话题')
      await asService()
      const other = uid('a5', 51)
      await database.query(
        `INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'group','另一个群',$2)`,
        [other, f.owner],
      )
      await database.query(
        `INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,'member'),($3,$2,'member')`,
        [topic, f.carol, other],
      )

      const before = await database.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM chat.chat_members WHERE user_id = $1`, [f.carol],
      )
      expect(before.rows[0]?.n).toBe('3') // 来源群 + 话题 + 另一个群

      await database.query(`DELETE FROM chat.chat_members WHERE chat_id = $1 AND user_id = $2`, [f.group, f.carol])

      const after = await database.query<{ chat_id: string }>(
        `SELECT chat_id FROM chat.chat_members WHERE user_id = $1`, [f.carol],
      )
      // 只剩「另一个群」—— 来源群与它的话题一起走,别的线不受连累。
      expect(after.rows.map((r) => r.chat_id)).toEqual([other])
    })
  })

  it('list_topics_of_chat 的 is_participant 回答的是**这个 actor** 在不在,不是主人在不在', async () => {
    await inRollback(async () => {
      const f = await seedHiddenHistoryGroup('a6')
      const agent = uid('a6', 61)
      await asService()
      await database.query(
        `INSERT INTO identity.gugu_devices (device_id, user_id, label, hostname, platform)
         VALUES ('dev-a6',$1,'本机','mbp','darwin')`, [f.owner],
      )
      await database.query(
        `INSERT INTO identity.users (id, type, display_name, owner_user_id, device_id)
         VALUES ($1,'agent','我的Agent',$2,'dev-a6')`, [agent, f.owner],
      )
      // 主人自己开一条话题,agent 不在里面。
      const topic = await createTopic(f.owner, f, '主人开的')
      const ground = await database.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM chat.chat_members WHERE chat_id = $1 AND user_id = $2`, [topic, agent],
      )
      expect(ground.rows[0]?.n).toBe('0')

      await asUser(f.owner)
      // 正对照:不传 actor(主人自己问)是 true。
      const mine = await database.query<{ is_participant: boolean }>(
        `SELECT is_participant FROM chat.list_topics_of_chat($1)`, [f.group],
      )
      expect(mine.rows[0]?.is_participant).toBe(true)

      const asAgent = await database.query<{ is_participant: boolean }>(
        `SELECT is_participant FROM chat.list_topics_of_chat($1,$2)`, [f.group, agent],
      )
      expect(asAgent.rows[0]?.is_participant).toBe(false)

      // ❌ 不许拿别人的 id 当 actor 去问「他在不在」。
      expect(await rejection(
        `SELECT chat_id FROM chat.list_topics_of_chat($1,$2)`, [f.group, f.carol],
      )).toMatch(/Not allowed to act as/)
    })
  })

  it('话题里不点名的发言唤醒 active,dm 不广播、passive 只认点名', async () => {
    await inRollback(async () => {
      const f = await seedHiddenHistoryGroup('a7')
      const agent = uid('a7', 71)
      await asService()
      await database.query(
        `INSERT INTO identity.gugu_devices (device_id, user_id, label, hostname, platform)
         VALUES ('dev-a7',$1,'本机','mbp','darwin')`, [f.bob],
      )
      await database.query(
        `INSERT INTO identity.users (id, type, display_name, owner_user_id, device_id)
         VALUES ($1,'agent','我的Agent',$2,'dev-a7')`, [agent, f.bob],
      )
      const topic = await createTopic(f.owner, f, '对照话题')
      await asService()
      await database.query(
        `INSERT INTO chat.chat_members (chat_id, user_id, role, listen_mode) VALUES ($1,$2,'member','active')`,
        [topic, agent],
      )

      const delivered = async (chatId: string, mode: string, to: string[] | null, seq: number): Promise<number> => {
        const id = uid('a7', 80 + seq)
        await database.query(
          `UPDATE chat.chat_members SET listen_mode = $1 WHERE chat_id = $2 AND user_id = $3`,
          [mode, chatId, agent],
        )
        await database.query(
          `INSERT INTO chat.messages (id, chat_id, sender_user_id, seq, content, content_type, to_user_ids)
           VALUES ($1,$2,$3,$4,'这个怎么改','text',$5)`,
          [id, chatId, f.owner, seq, to],
        )
        const { rows } = await database.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM identity.gugu_device_commands
            WHERE payload->>'message_id' = $1 AND payload->>'agent_user_id' = $2`, [id, agent],
        )
        return Number(rows[0]!.n)
      }

      expect(await delivered(topic, 'active', null, 10)).toBeGreaterThan(0)
      expect(await delivered(topic, 'passive', null, 12)).toBe(0)
      expect(await delivered(topic, 'passive', [agent], 13)).toBeGreaterThan(0)

      // dm 不走 listen_mode 那一支:人在私聊里没点名的话就是说给对端的(dmPeerIsAddressee),passive 也唤醒。
      await database.query(`UPDATE chat.chats SET kind = 'dm', source_chat_id = NULL, source_message_id = NULL WHERE id = $1`, [topic])
      expect(await delivered(topic, 'passive', null, 14)).toBeGreaterThan(0)
    })
  })

  /**
   * 第七轮的根因:回复上下文是**给收件人看的**,而投递触发器里的 auth.uid() 是**发件人**。
   * 拿发件人的权限去守收件人的可见域,这道门永远守不住。下面三格分别盯住它的三条出口:
   * 实时投递的 payload、agent 冷启动补历史的 pull_agent_inbox_v2、以及改名要不要回传来源线。
   */
  async function seedLateJoiningAgent(tag: string): Promise<Fixture & { agent: string }> {
    const f = await seedHiddenHistoryGroup(tag)
    const agent = uid(tag, 91)
    await database.query(
      `INSERT INTO identity.gugu_devices (device_id, user_id, label, hostname, platform)
       VALUES ($1,$2,'本机','mbp','darwin')`, [`dev-${tag}`, f.owner],
    )
    await database.query(
      `INSERT INTO identity.users (id, type, display_name, owner_user_id, device_id)
       VALUES ($1,'agent','晚到的Agent',$2,$3)`, [agent, f.owner, `dev-${tag}`],
    )
    // agent 在那条机密消息**之后**才入群 —— 入群触发器给它置了时间界,所以它读不到那条。
    await database.query(
      `INSERT INTO chat.chat_members (chat_id, user_id, role, listen_mode) VALUES ($1,$2,'member','active')`,
      [f.group, agent],
    )
    return { ...f, agent }
  }

  it('实时投递的 reply_context 按**收件人**算:他读不到的来源正文不进 payload,读得到的照常进', async () => {
    await inRollback(async () => {
      const f = await seedLateJoiningAgent('a8')
      // 回复必须由 Carol **本人**发出:错法(拿 auth.uid() 当 viewer)只有在发件人读得到、
      // 收件人读不到时才显形;用 service role 插会让 auth.uid() 为空,判官就没牙了。
      await asUser(f.carol)
      await database.query(
        `INSERT INTO chat.messages (id, chat_id, sender_user_id, seq, content, content_type, reply_to_message_id, to_user_ids)
         VALUES ($1,$2,$3,2,'这个名单怎么说','text',$4,ARRAY[$5])`,
        [uid('a8', 92), f.group, f.carol, f.sourceMessage, f.agent],
      )
      await asService()
      const leaked = await database.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM identity.gugu_device_commands
          WHERE payload->>'message_id' = $1 AND payload->>'agent_user_id' = $2`, [uid('a8', 92), f.agent],
      )
      // 正对照的一半:这条**确实投出去了**(否则下面「没有正文」是空过的)。
      expect(leaked.rows).toHaveLength(1)
      expect(JSON.stringify(leaked.rows[0]!.payload)).not.toContain('SECRET-SOURCE')
      expect(leaked.rows[0]!.payload.reply_to_content ?? null).toBeNull()

      // 正对照的另一半:回复一条 agent 入群后的消息,上下文原样带过去。
      await database.query(
        `INSERT INTO chat.messages (id, chat_id, sender_user_id, seq, content, content_type)
         VALUES ($1,$2,$3,3,'READABLE-SOURCE','text')`,
        [uid('a8', 93), f.group, f.owner],
      )
      await asUser(f.carol)
      await database.query(
        `INSERT INTO chat.messages (id, chat_id, sender_user_id, seq, content, content_type, reply_to_message_id, to_user_ids)
         VALUES ($1,$2,$3,4,'这条呢','text',$4,ARRAY[$5])`,
        [uid('a8', 94), f.group, f.carol, uid('a8', 93), f.agent],
      )
      await asService()
      const allowed = await database.query<{ payload: Record<string, string> }>(
        `SELECT payload FROM identity.gugu_device_commands
          WHERE payload->>'message_id' = $1 AND payload->>'agent_user_id' = $2`, [uid('a8', 94), f.agent],
      )
      expect(allowed.rows[0]?.payload.reply_to_content).toBe('READABLE-SOURCE')
      // #1761 的配套:有 reply_context 就必须有 reply_to_sender_user_id,否则客户端 passive gate 会吞掉它。
      expect(allowed.rows[0]?.payload.reply_to_sender_user_id).toBe(f.owner)
    })
  })

  it('pull_agent_inbox_v2 补历史时同样按 agent 自己判:读不到的来源正文不回传', async () => {
    await inRollback(async () => {
      const f = await seedLateJoiningAgent('a9')
      await asService()
      await database.query(
        `INSERT INTO chat.messages (id, chat_id, sender_user_id, seq, content, content_type, reply_to_message_id, to_user_ids)
         VALUES ($1,$2,$3,2,'这个名单怎么说','text',$4,ARRAY[$5])`,
        [uid('a9', 92), f.group, f.carol, f.sourceMessage, f.agent],
      )
      await database.query(
        `INSERT INTO chat.messages (id, chat_id, sender_user_id, seq, content, content_type)
         VALUES ($1,$2,$3,3,'READABLE-SOURCE','text')`,
        [uid('a9', 93), f.group, f.owner],
      )
      await database.query(
        `INSERT INTO chat.messages (id, chat_id, sender_user_id, seq, content, content_type, reply_to_message_id, to_user_ids)
         VALUES ($1,$2,$3,4,'这条呢','text',$4,ARRAY[$5])`,
        [uid('a9', 94), f.group, f.carol, uid('a9', 93), f.agent],
      )

      // 这条 RPC 由**主人的设备**来拉,所以身份是主人;agent 自己的可见域由 p_agent_user_id 决定。
      await asUser(f.owner)
      const { rows } = await database.query<{ id: string; reply_to_content: string | null }>(
        `SELECT id, reply_to_content FROM identity.pull_agent_inbox_v2($1,$2,0,50)`, [f.agent, f.group],
      )
      const byId = new Map(rows.map((r) => [r.id, r.reply_to_content]))
      // 正对照:两条都补出来了,差别只在上下文 —— 否则「为空」可能只是这条根本没回传。
      expect(byId.has(uid('a9', 92))).toBe(true)
      expect(byId.get(uid('a9', 92))).toBeNull()
      expect(byId.get(uid('a9', 94))).toBe('READABLE-SOURCE')
    })
  })

  /**
   * 找茬第八轮的三条阻断。三条都在「零自动覆盖」的那一层,所以各配一格判官 ——
   * 其中第一条(messages_view 掉了 security_invoker)是仓里 2026-06-17 就写过警示注释、
   * 这轮还是漏了一次的同一个坑:注释被漏第二次就该换成判据。
   */
  it('messages_view 走 security_invoker:非成员读 0 行,成员自己照常读得到', async () => {
    await inRollback(async () => {
      const f = await seedHiddenHistoryGroup('c1')
      const stranger = uid('c1', 99)
      await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human','陌生人')`, [stranger])

      await asUser(stranger)
      const leaked = await database.query<{ content: string }>(
        `SELECT content FROM chat.messages_view WHERE chat_id = $1`, [f.group],
      )
      expect(leaked.rows).toHaveLength(0)

      // 正对照:群主自己读得到 —— 证明「0 行」不是视图坏了。
      await asUser(f.owner)
      const seen = await database.query<{ content: string }>(
        `SELECT content FROM chat.messages_view WHERE chat_id = $1`, [f.group],
      )
      expect(seen.rows.map((r) => r.content)).toContain('裁员名单已定 SECRET-SOURCE')
    })
  })

  it('message_reply_preview_for 传 NULL viewer 不是免判:读 0 行,传自己的 id 才读得到', async () => {
    await inRollback(async () => {
      const f = await seedHiddenHistoryGroup('c2')
      const stranger = uid('c2', 99)
      await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human','陌生人')`, [stranger])

      await asUser(stranger)
      const viaNull = await database.query(
        `SELECT reply_to_content FROM chat.message_reply_preview_for($1, NULL)`, [f.sourceMessage],
      )
      expect(viaNull.rows).toHaveLength(0)
      const viaSelf = await database.query(
        `SELECT reply_to_content FROM chat.message_reply_preview_for($1, $2)`, [f.sourceMessage, stranger],
      )
      expect(viaSelf.rows).toHaveLength(0)

      // 正对照:群主传自己的 id 读得到 —— 证明不是把函数废了。
      await asUser(f.owner)
      const allowed = await database.query<{ reply_to_content: string }>(
        `SELECT reply_to_content FROM chat.message_reply_preview_for($1, $2)`, [f.sourceMessage, f.owner],
      )
      expect(allowed.rows[0]?.reply_to_content).toContain('SECRET-SOURCE')
    })
  })

  // 找茵第九轮:第八轮只堵住了「viewer 传 NULL」,更大的那个口子是**viewer 填别人**。
  // 这一格要守的不是「读不读得到」,是「你有没有资格以这个身份提问」—— 两件事。
  // 找茬第九轮:那道 security_invoker 闸判的是**迁移文本**,而要守的是**目录里的事实**。
  // 实测它有六种拼法能穿过去(不带 schema 前缀、加引号、点号旁空格、format() 动态拼、
  // 行尾注释里出现这个词、以及它根本不扫的 ALTER VIEW)。所以真正的判官只能长在这里:
  // 这个库是全量迁移重放出来的,直接问目录。
  it('所有视图都带 security_invoker —— 判据问目录,不问迁移文本', async () => {
    await inRollback(async () => {
      const sql = `
        SELECT n.nspname || '.' || c.relname AS view_name
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relkind = 'v'
           AND n.nspname IN ('chat','identity','public','billing','moments')
           AND NOT COALESCE(array_to_string(c.reloptions, ',') ILIKE '%security_invoker=true%', false)
         ORDER BY 1`
      const bad = await database.query<{ view_name: string }>(sql)
      expect(bad.rows.map((r) => r.view_name)).toEqual([])

      // 阳控:探针确实能产出与期待相反的结果 —— 现造一个不带该选项的视图,它必须被逮到。
      await database.query(`CREATE VIEW chat.security_invoker_probe_5856 AS SELECT 1 AS x`)
      const caught = await database.query<{ view_name: string }>(sql)
      expect(caught.rows.map((r) => r.view_name)).toContain('chat.security_invoker_probe_5856')
    })
  })

  it('message_reply_preview_for:拿别人的 id 当 viewer 读不到任何东西', async () => {
    await inRollback(async () => {
      const f = await seedHiddenHistoryGroup('c9')
      const stranger = uid('c9', 99)
      await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human','陌生人')`, [stranger])

      // 阴控一:陌生人直读表与视图都是 0 行 —— 他本就不该看到这条。
      await asUser(stranger)
      const rawRows = await database.query(`SELECT content FROM chat.messages WHERE id = $1`, [f.sourceMessage])
      expect(rawRows.rows).toHaveLength(0)

      // 这一格本体:拿受害者(群主)的 id 当 viewer 提问。
      const impersonated = await database.query(
        `SELECT reply_to_content FROM chat.message_reply_preview_for($1, $2)`, [f.sourceMessage, f.owner],
      )
      expect(impersonated.rows).toHaveLength(0)

      // 正对照:群主本人传自己的 id 读得到 —— 证明 0 行不是把函数废了。
      await asUser(f.owner)
      const allowed = await database.query<{ reply_to_content: string }>(
        `SELECT reply_to_content FROM chat.message_reply_preview_for($1, $2)`, [f.sourceMessage, f.owner],
      )
      expect(allowed.rows[0]?.reply_to_content).toContain('SECRET-SOURCE')
    })
  })

  it('投递路径仍然算得出收件人的回复上下文 —— 收紧 actor 不能把它一同堵死', async () => {
    await inRollback(async () => {
      const f = await seedHiddenHistoryGroup('ca')
      // 内核那一口是给 DEFINER 触发器用的:它就是拿第三方当 viewer 的那一个。
      await asService()
      const forRecipient = await database.query<{ reply_to_content: string }>(
        `SELECT reply_to_content FROM chat.message_reply_preview_row($1, $2)`, [f.sourceMessage, f.carol],
      )
      expect(forRecipient.rows[0]?.reply_to_content).toContain('SECRET-SOURCE')
      // 阴控:内核也不是「什么都给」—— 读不到的人仍然 0 行。
      const outsider = uid('ca', 98)
      await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human','局外人')`, [outsider])
      const forOutsider = await database.query(
        `SELECT reply_to_content FROM chat.message_reply_preview_row($1, $2)`, [f.sourceMessage, outsider],
      )
      expect(forOutsider.rows).toHaveLength(0)
      // 而客户端根本叩不到这一口:authenticated 没有 EXECUTE。
      await asUser(f.carol)
      const denied = await rejection(
        `SELECT reply_to_content FROM chat.message_reply_preview_row($1, $2)`, [f.sourceMessage, f.carol],
      )
      expect(denied).toContain('permission denied')
    })
  })

  it('成员关系探针不对局外人开口(is_addressable_in / can_read_message)', async () => {
    await inRollback(async () => {
      const f = await seedHiddenHistoryGroup('cb')
      const stranger = uid('cb', 99)
      await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human','陌生人')`, [stranger])

      // 局外人问「某人在不在这条线里 / 读不读得到这条」—— 一律否。
      await asUser(stranger)
      const probes = await database.query<{ addressable: boolean; readable: boolean }>(
        `SELECT chat.is_addressable_in($1,$2) AS addressable, chat.can_read_message($3,$2) AS readable`,
        [f.group, f.carol, f.sourceMessage],
      )
      expect(probes.rows[0]?.addressable).toBe(false)
      expect(probes.rows[0]?.readable).toBe(false)

      // 正对照:群里的人问同一个问题,答案是真 —— 证明否的是提问的人而不是问题。
      // can_read_message 收得更紧:主体也必须是本人(或自己名下的 agent),因为它的全部调用方都只这么传。
      await asUser(f.owner)
      const insider = await database.query<{ addressable: boolean; readable: boolean }>(
        `SELECT chat.is_addressable_in($1,$2) AS addressable, chat.can_read_message($3,$4) AS readable`,
        [f.group, f.carol, f.sourceMessage, f.owner],
      )
      expect(insider.rows[0]?.addressable).toBe(true)
      expect(insider.rows[0]?.readable).toBe(true)
    })
  })

  it('话题的时间界读**来源线当下**的 hide_history,❌ 不读建立时那份快照', async () => {
    await inRollback(async () => {
      // 来源群一开始没开「隐藏聊天记录」——话题因此继承到 false。
      const f = await seedHiddenHistoryGroup('c3')
      await asService()
      await database.query(`UPDATE chat.chats SET hide_history = false WHERE id = $1`, [f.group])
      const topic = await createTopic(f.owner, f, '薪资话题')
      await asService()
      await database.query(
        `INSERT INTO chat.messages (id, chat_id, sender_user_id, seq, content, content_type, created_at)
         VALUES ($1,$2,$3,1,'TOPIC-SECRET 薪资表','text', now() - interval '90 minute')`,
        [uid('c3', 31), topic, f.owner],
      )
      const snapshot = await database.query<{ hide_history: boolean }>(
        `SELECT hide_history FROM chat.chats WHERE id = $1`, [topic],
      )
      expect(snapshot.rows[0]?.hide_history).toBe(false)

      // 群主**此刻**才打开开关;话题自己那一列仍是 false(快照不跟着走)。
      await database.query(`UPDATE chat.chats SET hide_history = true WHERE id = $1`, [f.group])
      await database.query(
        `INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,'member')`,
        [f.group, f.bob],
      )

      // 说话即参与 —— 这一步必须成功,否则下面那条断言是空过的。
      await asUser(f.bob)
      await database.query(
        `INSERT INTO chat.messages (id, chat_id, sender_user_id, seq, content, content_type)
         VALUES ($1,$2,$3,2,'我也参与一下','text')`,
        [uid('c3', 32), topic, f.bob],
      )
      const bobSees = await database.query<{ content: string }>(
        `SELECT content FROM chat.messages WHERE chat_id = $1 ORDER BY seq`, [topic],
      )
      expect(bobSees.rows.map((r) => r.content)).toEqual(['我也参与一下'])

      // 正对照:老成员照样读得到全部 —— 证明这道门不是把话题焊死。
      await asUser(f.owner)
      const ownerSees = await database.query<{ content: string }>(
        `SELECT content FROM chat.messages WHERE chat_id = $1 ORDER BY seq`, [topic],
      )
      expect(ownerSees.rows.map((r) => r.content)).toEqual(['TOPIC-SECRET 薪资表', '我也参与一下'])
    })
  })

  it('主人看得见的线,替他办事的 agent 也读得到名单;两人都不在时仍然读不到', async () => {
    await inRollback(async () => {
      const f = await seedHiddenHistoryGroup('c4')
      const agent = uid('c4', 91)
      await asService()
      await database.query(
        `INSERT INTO identity.gugu_devices (device_id, user_id, label, hostname, platform)
         VALUES ('dev-c4',$1,'本机','mbp','darwin')`, [f.owner],
      )
      await database.query(
        `INSERT INTO identity.users (id, type, display_name, owner_user_id, device_id)
         VALUES ($1,'agent','我的Agent',$2,'dev-c4')`, [agent, f.owner],
      )
      // agent **不在**来源群里(主人在)。
      const ground = await database.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM chat.chat_members WHERE chat_id = $1 AND user_id = $2`, [f.group, agent],
      )
      expect(ground.rows[0]?.n).toBe('0')

      await asUser(f.owner)
      const asAgent = await database.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM chat.list_member_ids($1,$2)`, [f.group, agent],
      )
      // 这就是服务端 is_addressable_in 的可见域,客户端的闸必须算得出同一个集合。
      expect(Number(asAgent.rows[0]!.n)).toBeGreaterThan(0)

      // 反向对照:主人也不在的那条线,仍然一行都读不到(❌ 没有顺手放宽)。
      const outsider = uid('c4', 98)
      const foreign = uid('c4', 97)
      await asService()
      await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human','陌生人')`, [outsider])
      await database.query(
        `INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,'group','陌生群',$2)`, [foreign, outsider],
      )
      await database.query(
        `INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,'owner')`, [foreign, outsider],
      )
      await asUser(f.owner)
      const denied = await database.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM chat.list_member_ids($1,$2)`, [foreign, agent],
      )
      expect(denied.rows[0]?.n).toBe('0')
    })
  })

  it('来源线成员的 agent 还没进话题、主人也没进:照样读得到话题名单(看得见就能说话,说话即参与)', async () => {
    await inRollback(async () => {
      const f = await seedHiddenHistoryGroup('c6')
      const topic = await createTopic(f.owner, f, '旧话题')
      const agent = uid('c6', 91)
      await asService()
      await database.query(
        `INSERT INTO identity.gugu_devices (device_id, user_id, label, hostname, platform)
         VALUES ('dev-c6',$1,'本机','mbp','darwin')`, [f.carol],
      )
      await database.query(
        `INSERT INTO identity.users (id, type, display_name, owner_user_id, device_id)
         VALUES ($1,'agent','Carol的Agent',$2,'dev-c6')`, [agent, f.carol],
      )
      await database.query(`INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,'member')`, [f.group, agent])
      // 地面:agent 与它的主人 Carol 都不在话题里,话题里只有建它的群主。
      const ground = await database.query<{ user_id: string }>(
        `SELECT user_id FROM chat.chat_members WHERE chat_id = $1 ORDER BY user_id`, [topic],
      )
      expect(ground.rows.map((r) => r.user_id)).toEqual([f.owner])

      await asUser(f.carol)
      const seen = await database.query<{ user_id: string }>(
        `SELECT user_id FROM chat.list_member_ids($1,$2)`, [topic, agent],
      )
      expect(seen.rows.map((r) => r.user_id)).toEqual([f.owner])

      // 反向对照:来源线也不在的人,话题名单仍然一行都读不到。
      const outsider = uid('c6', 98)
      await asService()
      await database.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human','陌生人')`, [outsider])
      await asUser(outsider)
      const denied = await database.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM chat.list_member_ids($1)`, [topic],
      )
      expect(denied.rows[0]?.n).toBe('0')
    })
  })

  it('来源状态分三态:读得到 / 读不到 / 真没了 —— ❌ 不把「读不到」说成「已删除」', async () => {
    await inRollback(async () => {
      const f = await seedHiddenHistoryGroup('c5')
      const topic = await createTopic(f.owner, f, '机密话题')
      await asService()
      // Bob 入群(时间界落在现在)→ 他读不到那条来源消息;把他拉进话题,好让他看得见这条话题。
      await database.query(
        `INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,'member'),($3,$2,'member')`,
        [f.group, f.bob, topic],
      )

      await asUser(f.bob)
      const blocked = await database.query<{ state: string; preview: string | null }>(
        `SELECT state, preview FROM chat.topic_source_state($1)`, [topic],
      )
      expect(blocked.rows[0]?.state).toBe('unreadable')
      expect(blocked.rows[0]?.preview).toBeNull()

      // 正对照:群主读得到,拿到的是真正文 —— 证明「unreadable」不是把函数废了。
      await asUser(f.owner)
      const readable = await database.query<{ state: string; preview: string }>(
        `SELECT state, preview FROM chat.topic_source_state($1)`, [topic],
      )
      expect(readable.rows[0]?.state).toBe('readable')
      expect(readable.rows[0]?.preview).toContain('SECRET-SOURCE')

      // 第三态:来源消息真被删了 ⇒ 'gone'(这一种界面上必须说出来)。
      await asService()
      await database.query(`UPDATE chat.messages SET deleted_at = now() WHERE id = $1`, [f.sourceMessage])
      await asUser(f.owner)
      const gone = await database.query<{ state: string }>(
        `SELECT state FROM chat.topic_source_state($1)`, [topic],
      )
      expect(gone.rows[0]?.state).toBe('gone')
    })
  })

  it('话题改名要回传来源线(锚点卡跟着改),而改别的列不回传', async () => {
    await inRollback(async () => {
      const f = await seedHiddenHistoryGroup('b1')
      const topic = await createTopic(f.owner, f, '旧名字')
      await asService()
      const sourceLineEvents = async (): Promise<number> => {
        const { rows } = await database.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM realtime.messages
            WHERE topic = $1 AND event = 'chat_changed'
              AND payload->>'topic_of_source_chat' = $2 AND payload->>'op' = 'update'`,
          [`gugu:user:${f.carol}:events`, f.group],
        )
        return Number(rows[0]!.n)
      }
      // Carol 在来源线上、不在话题里 —— 她正是「看得见它存在」的那类人。
      // 创建者入列也发一次成员摘要失效通知(#6010)。
      expect(await sourceLineEvents()).toBe(1)

      await database.query(`UPDATE chat.chats SET name = '新名字' WHERE id = $1`, [topic])
      expect(await sourceLineEvents()).toBe(2)

      // 反例:改的不是名字就不回传,❌ 不许每次写这张表都惊动整条来源线。
      await database.query(`UPDATE chat.chats SET last_message_at = now() WHERE id = $1`, [topic])
      expect(await sourceLineEvents()).toBe(2)
    })
  })

  it('#6010 纯成员加入/退出刷新来源线 observer 的人数，已读更新不产生摘要失效', async () => {
    await inRollback(async () => {
      const f = await seedHiddenHistoryGroup('b2')
      await database.query(`INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,'member')`, [f.group, f.bob])
      const topic = await createTopic(f.owner, f, '参与人数')
      await asService()
      const revisions = async () => {
        const { rows } = await database.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM chat.account_revisions
            WHERE user_id = $1 AND event = 'chat_changed' AND resource_key->>'chat_id' = $2`,
          [f.carol, f.group],
        )
        return Number(rows[0]!.n)
      }
      const countAsObserver = async () => {
        await asUser(f.carol)
        const { rows } = await database.query<{ participant_count: string; message_count: string; is_participant: boolean }>(
          `SELECT participant_count, message_count, is_participant FROM chat.list_topics_of_chat($1) WHERE chat_id = $2`,
          [f.group, topic],
        )
        await asService()
        expect(rows[0]?.is_participant).toBe(false)
        expect(Number(rows[0]?.message_count)).toBe(0)
        return Number(rows[0]?.participant_count)
      }
      const before = await revisions()
      expect(await countAsObserver()).toBe(1)
      await database.query(`INSERT INTO chat.chat_members (chat_id, user_id, role) VALUES ($1,$2,'member')`, [topic, f.bob])
      expect(await revisions()).toBe(before + 1)
      expect(await countAsObserver()).toBe(2)
      await database.query(`UPDATE chat.chat_members SET last_read_seq = 1 WHERE chat_id = $1 AND user_id = $2`, [topic, f.bob])
      expect(await revisions()).toBe(before + 1)
      await database.query(`DELETE FROM chat.chat_members WHERE chat_id = $1 AND user_id = $2`, [topic, f.bob])
      expect(await revisions()).toBe(before + 2)
      expect(await countAsObserver()).toBe(1)
      // 普通群的成员变动不伪装成其上话题摘要失效。
      await database.query(`DELETE FROM chat.chat_members WHERE chat_id = $1 AND user_id = $2`, [f.group, f.bob])
      expect(await revisions()).toBe(before + 2)
    })
  })
})
