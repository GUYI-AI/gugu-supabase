import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * gugu#7199 「家随处安」:开通 saga 的成员可以是已有的 agent(existing_agent_user_id)—— 把它的家搬到另一台设备。
 *
 * 判据(每条用例 BEGIN…ROLLBACK):
 *   · start 只认「调用者名下、类型一致、还不在目标设备上、不带记忆继承 / 历史 / 首条消息 / first_task」的 existing;
 *   · prepare 复用原有身份与私聊,向目标设备发 agent.create(adopt:true、adopt_from_device_id),身份证据指向原有 agent;
 *   · settle 把 agent.create 做完 = ready 的同一事务里切 users.device_id、给旧家发一条 agent.retire、改投未领走的 agent.deliver;
 *   · complete 不发欢迎消息(message_id / client_message_id 为 NULL);
 *   · cancel 在 ready 之前只撤这次搬家,原有的 agent 不动;ready 之后拒绝;
 *   · users.device_id 照旧不可改 —— 只有 settle 这条路径、且只对被搬的那一个 agent 放行;
 *   · 不带 existing 的普通开通原样不受影响。
 */

interface QueryResult<Row> { rows: Row[] }
interface DatabaseClient {
  connect(): Promise<void>
  end(): Promise<void>
  query<Row = never>(sql: string, values?: unknown[]): Promise<QueryResult<Row>>
}

const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => DatabaseClient
}

const DATABASE_URL = (process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '').trim()

let db: DatabaseClient

beforeAll(async () => {
  const parsed = new URL(DATABASE_URL)
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname)) {
    throw new Error(`agentProvisionAdopt7199.test requires loopback PostgreSQL, got ${parsed.hostname}`)
  }
  db = new Client({ connectionString: DATABASE_URL })
  await db.connect()
})

afterAll(async () => {
  await db?.end()
})

interface World {
  owner: string
  stranger: string
  oldDevice: string
  newDevice: string
  agent: string
}

/** 一个主人、两台设备(旧家 / 新家)、旧家上有一个 claude-code 的 agent。整个事务回滚。 */
async function world(body: (w: World) => Promise<void>): Promise<void> {
  await db.query('BEGIN')
  try {
    const owner = randomUUID()
    const stranger = randomUUID()
    const oldDevice = `adopt-old-${randomUUID()}`
    const newDevice = `adopt-new-${randomUUID()}`
    for (const id of [owner, stranger]) {
      await db.query('INSERT INTO auth.users (id, email) VALUES ($1::uuid, $2)', [id, `adopt-${id}@example.test`])
      await db.query("INSERT INTO identity.users (id, type, display_name) VALUES ($1, 'human', 'adopt test') ON CONFLICT (id) DO NOTHING", [id])
    }
    for (const device of [oldDevice, newDevice]) {
      await db.query(
        "INSERT INTO identity.gugu_devices (device_id, user_id, label, hostname, platform) VALUES ($1, $2, $1, 'test', 'linux')",
        [device, owner],
      )
    }
    const w: World = { owner, stranger, oldDevice, newDevice, agent: '' }
    w.agent = (
      await asUser(owner, async () =>
        (await db.query<{ id: string }>(
          "SELECT id FROM identity.create_owned_agent('旧家助理', NULL, 'claude-code', $1, '/Users/x/助理', NULL, true, NULL, NULL)",
          [oldDevice],
        )).rows[0].id)
    )
    await body(w)
  } finally {
    await db.query('ROLLBACK')
  }
}

/** 以这个用户的身份(authenticated + jwt sub)跑一段;跑完回到超级用户,断言用后者读表。 */
async function asUser<T>(user: string, fn: () => Promise<T>): Promise<T> {
  await db.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: 'authenticated' })])
  await db.query('SET LOCAL ROLE authenticated')
  try {
    return await fn()
  } finally {
    // 事务已因报错作废时 RESET ROLE 也会失败,别让它盖掉真正的错;回滚时角色自会还原。
    await db.query('RESET ROLE').catch(() => undefined)
  }
}


/** 期望这条失败,并让事务活下来(用 SAVEPOINT 兜住):之后还能在同一个事务里继续断言。 */
async function rejectsKeepingTransaction(fn: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  await db.query('SAVEPOINT expect_failure')
  try {
    await expect(fn()).rejects.toThrow(pattern)
  } finally {
    await db.query('ROLLBACK TO SAVEPOINT expect_failure')
  }
}

function member(w: World, overrides: Record<string, unknown> = {}) {
  return {
    provision_id: randomUUID(),
    member_key: 'single',
    display_name: '旧家助理',
    agent_type: 'claude-code',
    project_path: '',
    inherit_memory: false,
    history_import_required: false,
    existing_agent_user_id: w.agent,
    ...overrides,
  }
}

async function start(w: World, m: Record<string, unknown>, opts: { op?: string; device?: string; extra?: unknown[] } = {}): Promise<string> {
  const op = opts.op ?? randomUUID()
  await asUser(w.owner, () =>
    db.query(
      'SELECT identity.start_agent_provision_operation($1, $2, $3::jsonb, NULL, NULL, $4, NULL, $5, $6, NULL)',
      [op, opts.device ?? w.newDevice, JSON.stringify({ kind: 'single', members: [m] }), 'platform:deepseek-v4-pro', 'full-access', 'claude'],
    ))
  return op
}

async function claimAndPrepare(w: World, op: string, m: Record<string, unknown>): Promise<void> {
  await asUser(w.owner, async () => {
    await db.query('SELECT identity.claim_provision_slots($1)', [op])
    await db.query(
      'SELECT identity.prepare_agent_provision($1, $2, $3, $4, $5, $6, $7, NULL, NULL, NULL, NULL)',
      [m.provision_id, op, m.member_key, w.newDevice, m.display_name, m.agent_type, m.project_path],
    )
  })
}

async function row(provision: string) {
  return (await db.query<{
    phase: string; existing_agent_user_id: string | null; agent_user_id: string | null
    provisioned_agent_user_id: string | null; create_command_id: string | null; dm_chat_id: string | null
  }>('SELECT phase, existing_agent_user_id, agent_user_id, provisioned_agent_user_id::text, create_command_id, dm_chat_id FROM identity.agent_provisions WHERE id = $1', [provision])).rows[0]
}

async function agentDevice(agent: string): Promise<string | null> {
  return (await db.query<{ device_id: string | null }>('SELECT device_id FROM identity.users WHERE id = $1', [agent])).rows[0].device_id
}

async function commandsOf(agent: string, type: string) {
  return (await db.query<{ id: string; device_id: string; status: string; payload: Record<string, unknown> }>(
    "SELECT id, device_id, status, payload FROM identity.gugu_device_commands WHERE type = $1 AND payload->>'agent_user_id' = $2 ORDER BY created_at",
    [type, agent],
  )).rows
}

async function finishCreate(provision: string, status: 'done' | 'error' | 'running' = 'done'): Promise<void> {
  const { create_command_id } = await row(provision)
  await db.query("UPDATE identity.gugu_device_commands SET status = $2, completed_at = CASE WHEN $2 = 'running' THEN NULL ELSE now() END WHERE id = $1", [create_command_id, status])
}

async function settle(w: World, provision: string): Promise<string> {
  return await asUser(w.owner, async () =>
    (await db.query<{ phase: string }>('SELECT (identity.settle_agent_provision_terminal($1)).phase AS phase', [provision])).rows[0].phase)
}

/** 把 w.agent 从它现在的家搬到 to:start → claim → prepare → agent.create 做完 → settle → complete。 */
async function moveTo(w: World, to: string): Promise<void> {
  const m = member(w, { provision_id: randomUUID() })
  const op = await start(w, m, { device: to })
  await asUser(w.owner, async () => {
    await db.query('SELECT identity.claim_provision_slots($1)', [op])
    await db.query(
      'SELECT identity.prepare_agent_provision($1, $2, $3, $4, $5, $6, $7, NULL, NULL, NULL, NULL)',
      [m.provision_id, op, m.member_key, to, m.display_name, m.agent_type, m.project_path],
    )
  })
  await finishCreate(m.provision_id as string)
  expect(await settle(w, m.provision_id as string)).toBe('ready')
  await asUser(w.owner, () => db.query('SELECT identity.complete_agent_provision($1)', [m.provision_id]))
}

describe('开通 saga 收养已有的 agent(搬家)', () => {
  it('start → claim → prepare:复用原有身份与私聊,agent.create 发给新家且带 adopt 标记;旧家照旧', async () => {
    await world(async (w) => {
      const m = member(w)
      const op = await start(w, m)
      await claimAndPrepare(w, op, m)
      const r = await row(m.provision_id as string)
      expect(r).toMatchObject({
        phase: 'awaiting_terminal',
        existing_agent_user_id: w.agent,
        agent_user_id: w.agent,
        provisioned_agent_user_id: w.agent,
      })
      expect(r.dm_chat_id).toBeTruthy()
      const [create] = await commandsOf(w.agent, 'agent.create')
      expect(create.device_id).toBe(w.newDevice)
      expect(create.payload).toMatchObject({
        agent_user_id: w.agent, display_name: '旧家助理', agent_type: 'claude-code',
        greeting_chat_id: r.dm_chat_id, adopt: true, adopt_from_device_id: w.oldDevice,
        model: 'platform:deepseek-v4-pro', permission_mode: 'full-access', child_harness: 'claude',
      })
      // 没有铸新身份:这个主人名下还是只有这一个 agent;旧家一动没动。
      const { rows: agents } = await db.query("SELECT id FROM identity.users WHERE owner_user_id = $1 AND type = 'agent'", [w.owner])
      expect(agents).toEqual([{ id: w.agent }])
      expect(await agentDevice(w.agent)).toBe(w.oldDevice)
    })
  })

  it('settle 在 ready 的同一事务里切家:device_id → 新家、只发一条 agent.retire 给旧家、未领走的投递改投新家;重放不再发', async () => {
    await world(async (w) => {
      const m = member(w)
      const op = await start(w, m)
      await claimAndPrepare(w, op, m)
      await db.query(
        "INSERT INTO identity.gugu_device_commands (user_id, device_id, type, payload) VALUES ($1, $2, 'agent.deliver', $3::jsonb)",
        [w.owner, w.oldDevice, JSON.stringify({ agent_user_id: w.agent, chat_id: 'c', message_id: 'm-pending', content: 'hi' })],
      )
      await db.query(
        "INSERT INTO identity.gugu_device_commands (user_id, device_id, type, status, payload) VALUES ($1, $2, 'agent.deliver', 'running', $3::jsonb)",
        [w.owner, w.oldDevice, JSON.stringify({ agent_user_id: w.agent, chat_id: 'c', message_id: 'm-running', content: 'hi' })],
      )
      await finishCreate(m.provision_id as string)

      expect(await settle(w, m.provision_id as string)).toBe('ready')
      expect(await agentDevice(w.agent)).toBe(w.newDevice)
      const retires = await commandsOf(w.agent, 'agent.retire')
      expect(retires).toHaveLength(1)
      expect(retires[0]).toMatchObject({
        device_id: w.oldDevice,
        payload: { agent_user_id: w.agent, moved_to_device_id: w.newDevice, reason: 'moved' },
      })
      const delivers = await commandsOf(w.agent, 'agent.deliver')
      expect(Object.fromEntries(delivers.map((d) => [d.payload.message_id, d.device_id]))).toEqual({
        'm-pending': w.newDevice, // 没被旧家领走的:改投新家
        'm-running': w.oldDevice, // 旧家已经领走在跑的:归它自己跑完
      })

      // 重放 settle:仍 ready、不再发第二条 retire、device_id 不变。
      expect(await settle(w, m.provision_id as string)).toBe('ready')
      expect(await commandsOf(w.agent, 'agent.retire')).toHaveLength(1)
      expect(await agentDevice(w.agent)).toBe(w.newDevice)
    })
  })

  it('complete 不发欢迎消息:message_id / client_message_id 为 NULL,重放 already = true;operation 一并 completed', async () => {
    await world(async (w) => {
      const m = member(w)
      const op = await start(w, m)
      await claimAndPrepare(w, op, m)
      await finishCreate(m.provision_id as string)
      await settle(w, m.provision_id as string)
      const complete = () => asUser(w.owner, async () =>
        (await db.query<{ message_id: string | null; client_message_id: string | null; already: boolean }>(
          'SELECT * FROM identity.complete_agent_provision($1)', [m.provision_id])).rows[0])
      expect(await complete()).toEqual({ message_id: null, client_message_id: null, already: false })
      expect(await complete()).toEqual({ message_id: null, client_message_id: null, already: true })
      expect((await row(m.provision_id as string)).phase).toBe('completed')
      const { rows: ops } = await db.query<{ phase: string }>('SELECT phase FROM identity.agent_provision_operations WHERE id = $1', [op])
      expect(ops[0].phase).toBe('completed')
      // 欢迎模板没有落进私聊。
      const { rows: msgs } = await db.query(
        "SELECT 1 FROM chat.messages WHERE sender_user_id = $1 AND client_message_id LIKE 'agent-bootstrap:%'", [w.agent])
      expect(msgs).toHaveLength(0)
    })
  })

  it('agent.create 报错:settle 落成 failed,不切家;重试经 claim 再发一条 agent.create(同一身份、同一私聊)', async () => {
    await world(async (w) => {
      const m = member(w)
      const op = await start(w, m)
      await claimAndPrepare(w, op, m)
      const first = await row(m.provision_id as string)
      await finishCreate(m.provision_id as string, 'error')
      expect(await settle(w, m.provision_id as string)).toBe('failed')
      expect(await agentDevice(w.agent)).toBe(w.oldDevice)
      expect(await commandsOf(w.agent, 'agent.retire')).toHaveLength(0)

      await asUser(w.owner, async () => {
        await db.query('SELECT identity.claim_provision_slots($1, 1, $2::uuid[])', [op, [m.provision_id]])
        await db.query(
          'SELECT identity.prepare_agent_provision($1, $2, $3, $4, $5, $6, $7, NULL, NULL, NULL, NULL)',
          [m.provision_id, op, m.member_key, w.newDevice, m.display_name, m.agent_type, m.project_path],
        )
      })
      const second = await row(m.provision_id as string)
      expect(second.phase).toBe('awaiting_terminal')
      expect(second.dm_chat_id).toBe(first.dm_chat_id)
      expect(second.create_command_id).not.toBe(first.create_command_id)
      expect(await commandsOf(w.agent, 'agent.create')).toHaveLength(2)
    })
  })

  it('来回搬:旧→新→旧→新每一程都成功,每一程给上一个家发一条 agent.retire;同一台设备上先后两条已完成的收养记录互不干扰', async () => {
    await world(async (w) => {
      await moveTo(w, w.newDevice)
      expect(await agentDevice(w.agent)).toBe(w.newDevice)
      await moveTo(w, w.oldDevice)
      expect(await agentDevice(w.agent)).toBe(w.oldDevice)
      await moveTo(w, w.newDevice)
      expect(await agentDevice(w.agent)).toBe(w.newDevice)

      // 同一个事务里 created_at 相同,不靠顺序:数「发给谁、搬去哪」。
      const retires = (await commandsOf(w.agent, 'agent.retire')).map((c) => `${c.device_id} -> ${c.payload.moved_to_device_id}`).sort()
      expect(retires).toEqual([
        `${w.newDevice} -> ${w.oldDevice}`,
        `${w.oldDevice} -> ${w.newDevice}`,
        `${w.oldDevice} -> ${w.newDevice}`,
      ].sort())
      // 新家上有两条已完成的收养记录(同一个 member_key、不同的 operation):后一次不被前一次挡住。
      const { rows } = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM identity.agent_provisions WHERE device_id = $1 AND phase = 'completed' AND agent_user_id = $2",
        [w.newDevice, w.agent],
      )
      expect(rows[0].n).toBe(2)
    })
  })

  describe('start 的校验', () => {
    it('不是调用者名下的 agent / 不存在:拒', async () => {
      await world(async (w) => {
        const m = member(w)
        await expect(asUser(w.stranger, () =>
          db.query('SELECT identity.start_agent_provision_operation($1, $2, $3::jsonb)',
            [randomUUID(), w.newDevice, JSON.stringify({ kind: 'single', members: [m] })]),
        )).rejects.toThrow(/not owned by current user|not found or not owned/)
        await db.query('ROLLBACK')
        await db.query('BEGIN')
      })
    })

    it.each([
      ['agent_type 与身份不一致', { agent_type: 'codex' }, /is a claude-code agent, the member says codex/],
      ['不是 uuid', { existing_agent_user_id: 'agent-not-a-uuid' }, /must be an agent id/],
      ['继承记忆', { inherit_memory: true }, /not allowed/],
      ['要求导入历史', { history_import_required: true }, /not allowed/],
      ['带记忆来源', { memory_sources: ['claude-code'] }, /not allowed/],
    ])('%s:拒', async (_name, overrides, pattern) => {
      await world(async (w) => {
        const m = member(w, overrides)
        await expect(start(w, m)).rejects.toThrow(pattern)
      })
    })

    it('目标设备就是它现在的家:拒;同一个 agent 已有一单在途:拒;多成员:拒', async () => {
      await world(async (w) => {
        await expect(start(w, member(w), { device: w.oldDevice })).rejects.toThrow(/already lives on device/)
      })
      await world(async (w) => {
        await start(w, member(w))
        await expect(start(w, member(w))).rejects.toThrow(/already has a move in flight/)
      })
      await world(async (w) => {
        await expect(asUser(w.owner, () =>
          db.query('SELECT identity.start_agent_provision_operation($1, $2, $3::jsonb)', [
            randomUUID(), w.newDevice,
            JSON.stringify({ kind: 'single', members: [member(w), member(w, { provision_id: randomUUID(), member_key: 'b' })] }),
          ]),
        )).rejects.toThrow()
      })
    })

    it('带首条消息 / first_task:拒', async () => {
      await world(async (w) => {
        await expect(asUser(w.owner, () =>
          db.query('SELECT identity.start_agent_provision_operation($1, $2, $3::jsonb, NULL, NULL, NULL, NULL, NULL, NULL, $4)', [
            randomUUID(), w.newDevice, JSON.stringify({ kind: 'single', members: [member(w)] }), '初始化',
          ]),
        )).rejects.toThrow(/not allowed/)
      })
    })

    it('同一单重放:同一个 agent = 原样返回;换成别的 agent = 拒', async () => {
      await world(async (w) => {
        const m = member(w)
        const op = await start(w, m)
        await start(w, m, { op }) // 同一单、同一个 agent:幂等
        const other = (await asUser(w.owner, async () =>
          (await db.query<{ id: string }>(
            "SELECT id FROM identity.create_owned_agent('另一个', NULL, 'claude-code', $1, '/p', NULL, true, NULL, NULL)", [w.oldDevice],
          )).rows[0].id))
        await expect(start(w, { ...m, existing_agent_user_id: other }, { op })).rejects.toThrow()
      })
    })
  })

  describe('cancel', () => {
    it('ready 之前、命令还没被领走:命令撤掉、成员与 operation 一并 cancelled,原有身份与旧家不动', async () => {
      await world(async (w) => {
        const m = member(w)
        const op = await start(w, m)
        await claimAndPrepare(w, op, m)
        await asUser(w.owner, () => db.query('SELECT identity.cancel_agent_provision_operation($1)', [op]))
        expect((await row(m.provision_id as string)).phase).toBe('cancelled')
        const { rows: ops } = await db.query<{ phase: string }>('SELECT phase FROM identity.agent_provision_operations WHERE id = $1', [op])
        expect(ops[0].phase).toBe('cancelled')
        expect(await commandsOf(w.agent, 'agent.create')).toHaveLength(0)
        expect(await agentDevice(w.agent)).toBe(w.oldDevice)
        const { rows: alive } = await db.query("SELECT 1 FROM identity.users WHERE id = $1 AND type = 'agent'", [w.agent])
        expect(alive).toHaveLength(1)
        // 之后 settle_provision_cancellation 是幂等的终态,不会去 remove_owned_agent。
        await asUser(w.owner, () => db.query('SELECT identity.settle_provision_cancellation($1)', [op]))
        expect(await agentDevice(w.agent)).toBe(w.oldDevice)
      })
    })

    it('新家那台已经做完 agent.create(还没 settle):cancel 给新家发 agent.retire 拆半成品;旧家不动', async () => {
      await world(async (w) => {
        const m = member(w)
        const op = await start(w, m)
        await claimAndPrepare(w, op, m)
        await finishCreate(m.provision_id as string)
        await asUser(w.owner, () => db.query('SELECT identity.cancel_agent_provision_operation($1)', [op]))
        const retires = await commandsOf(w.agent, 'agent.retire')
        expect(retires).toHaveLength(1)
        expect(retires[0]).toMatchObject({ device_id: w.newDevice, payload: { agent_user_id: w.agent, reason: 'move_cancelled' } })
        expect(await agentDevice(w.agent)).toBe(w.oldDevice)
      })
    })

    it('设备还在做 agent.create:拒,等它做完;ready 之后:拒', async () => {
      await world(async (w) => {
        const m = member(w)
        const op = await start(w, m)
        await claimAndPrepare(w, op, m)
        await finishCreate(m.provision_id as string, 'running')
        await expect(asUser(w.owner, () => db.query('SELECT identity.cancel_agent_provision_operation($1)', [op])))
          .rejects.toThrow(/still creating the new home/)
      })
      await world(async (w) => {
        const m = member(w)
        const op = await start(w, m)
        await claimAndPrepare(w, op, m)
        await finishCreate(m.provision_id as string)
        await settle(w, m.provision_id as string)
        await rejectsKeepingTransaction(
          () => asUser(w.owner, () => db.query('SELECT identity.cancel_agent_provision_operation($1)', [op])),
          /already ready cannot be cancelled/,
        )
        expect(await agentDevice(w.agent)).toBe(w.newDevice)
      })
    })
  })

  describe('device_id 照旧不可改', () => {
    it('直接改:拒;开关指着别的 agent 也拒;只有 settle 那条路径放行', async () => {
      await world(async (w) => {
        await expect(db.query('UPDATE identity.users SET device_id = $2 WHERE id = $1', [w.agent, w.newDevice]))
          .rejects.toThrow(/immutable once set/)
        await db.query('ROLLBACK')
        await db.query('BEGIN')
      })
      await world(async (w) => {
        await db.query("SELECT set_config('identity.agent_adopt_move_agent_id', $1, true)", [randomUUID()])
        await expect(db.query('UPDATE identity.users SET device_id = $2 WHERE id = $1', [w.agent, w.newDevice]))
          .rejects.toThrow(/immutable once set/)
        await db.query('ROLLBACK')
        await db.query('BEGIN')
      })
    })
  })

  describe('不带 existing 的普通开通原样不变', () => {
    it('start → claim → prepare → settle → complete:铸新身份、欢迎消息落进私聊、没有 adopt 标记、没有 retire', async () => {
      await world(async (w) => {
        const provision = randomUUID()
        const op = randomUUID()
        const m = {
          provision_id: provision, member_key: 'single', display_name: '新助理', agent_type: 'claude-code',
          project_path: '', inherit_memory: false, history_import_required: false,
        }
        await asUser(w.owner, async () => {
          await db.query('SELECT identity.start_agent_provision_operation($1, $2, $3::jsonb)', [op, w.newDevice, JSON.stringify({ kind: 'single', members: [m] })])
          await db.query('SELECT identity.claim_provision_slots($1)', [op])
          await db.query('SELECT identity.prepare_agent_provision($1, $2, $3, $4, $5, $6, $7, NULL, NULL, NULL, NULL)', [provision, op, 'single', w.newDevice, '新助理', 'claude-code', ''])
        })
        const r = await row(provision)
        expect(r.existing_agent_user_id).toBeNull()
        expect(r.agent_user_id).toBeTruthy()
        expect(r.agent_user_id).not.toBe(w.agent)
        const [create] = await commandsOf(r.agent_user_id!, 'agent.create')
        expect(create.device_id).toBe(w.newDevice)
        expect(create.payload).not.toHaveProperty('adopt')
        await finishCreate(provision)
        expect(await settle(w, provision)).toBe('ready')
        expect(await agentDevice(r.agent_user_id!)).toBe(w.newDevice)
        expect(await commandsOf(r.agent_user_id!, 'agent.retire')).toHaveLength(0)
        const completed = await asUser(w.owner, async () =>
          (await db.query<{ message_id: string | null; already: boolean }>('SELECT * FROM identity.complete_agent_provision($1)', [provision])).rows[0])
        expect(completed.message_id).toBeTruthy()
        expect(completed.already).toBe(false)
      })
    })

    // 欢迎模板是开通一完成就秒回的那一句:每个 agent 都发,助理也发;写成开通时的界面语言(blueprint.locale)。
    const provisionWithLocale = async (w: World, locale: string | null, firstTask: string | null) => {
      const provision = randomUUID()
      const op = randomUUID()
      const m = {
        provision_id: provision, member_key: 'single', display_name: 'Gugu', agent_type: 'claude-code',
        project_path: '', inherit_memory: false, history_import_required: false,
      }
      const blueprint = { kind: 'single', members: [m], ...(locale ? { locale } : {}) }
      await asUser(w.owner, async () => {
        await db.query(
          'SELECT identity.start_agent_provision_operation($1, $2, $3::jsonb, NULL, NULL, NULL, NULL, NULL, $4, $5)',
          [op, w.newDevice, JSON.stringify(blueprint), firstTask ? 'claude' : null, firstTask],
        )
        await db.query('SELECT identity.claim_provision_slots($1)', [op])
        await db.query('SELECT identity.prepare_agent_provision($1, $2, $3, $4, $5, $6, $7, NULL, NULL, NULL, NULL)', [provision, op, 'single', w.newDevice, 'Gugu', 'claude-code', ''])
      })
      const r = await row(provision)
      await finishCreate(provision)
      expect(await settle(w, provision)).toBe('ready')
      const complete = () => asUser(w.owner, async () =>
        (await db.query<{ message_id: string | null; already: boolean }>('SELECT * FROM identity.complete_agent_provision($1)', [provision])).rows[0])
      const first = await complete()
      expect(first.already).toBe(false)
      expect(await complete()).toEqual({ ...first, already: true })
      const { rows } = await db.query<{ content: string }>('SELECT content FROM chat.messages WHERE sender_user_id = $1', [r.agent_user_id])
      return rows.map(row => row.content)
    }

    it('开通助理(带 first_task)也发欢迎模板,英文界面写英文;重放 already = true、不再发', async () => {
      await world(async (w) => {
        expect(await provisionWithLocale(w, 'en-US', '你刚开通。')).toEqual(['I\'m Gugu, ready to help. Tell me what you need.'])
      })
    })

    it('普通 agent:中文界面写中文;没带 locale(旧客户端)照旧中文', async () => {
      await world(async (w) => {
        expect(await provisionWithLocale(w, 'zh-CN', null)).toEqual(['我是 Gugu，已就位。有什么可以帮你的，直接说。'])
        expect(await provisionWithLocale(w, null, null)).toEqual(['我是 Gugu，已就位。有什么可以帮你的，直接说。'])
      })
    })

    it('blueprint.locale 只认 zh-CN / en-US', async () => {
      await world(async (w) => {
        const m = { provision_id: randomUUID(), member_key: 'single', display_name: 'Gugu', agent_type: 'claude-code',
          project_path: '', inherit_memory: false, history_import_required: false }
        await asUser(w.owner, () => rejectsKeepingTransaction(() => db.query('SELECT identity.start_agent_provision_operation($1, $2, $3::jsonb)',
          [randomUUID(), w.newDevice, JSON.stringify({ kind: 'single', members: [m], locale: 'fr-FR' })]), /blueprint\.locale must be zh-CN\|en-US/))
      })
    })
  })

  it('设备命令类型认 agent.retire,别的陌生类型照旧被拒', async () => {
    await world(async (w) => {
      await db.query(
        "INSERT INTO identity.gugu_device_commands (user_id, device_id, type, payload) VALUES ($1, $2, 'agent.retire', '{}'::jsonb)",
        [w.owner, w.newDevice],
      )
      await expect(db.query(
        "INSERT INTO identity.gugu_device_commands (user_id, device_id, type, payload) VALUES ($1, $2, 'agent.teleport', '{}'::jsonb)",
        [w.owner, w.newDevice],
      )).rejects.toThrow(/gugu_device_commands_type_chk/)
      await db.query('ROLLBACK')
      await db.query('BEGIN')
    })
  })
})
