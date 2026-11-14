/**
 * 文件服务集成测试的装置(真源 gugu-base notes/2026-09-29-app-platform/workspace-app;原型 evidence/2026-09-29-workspace-lite-proto)。
 *
 * 只要一个跑完全部迁移的库(GUGU_INTEGRATION_DATABASE_URL),❌ GoTrue / Kong:
 *   · 令牌由测试自签(ES256),JWKS 由测试在回环上发;服务配这个 JWKS 地址,和线上配 GoTrue 的 JWKS 是同一条路。
 *   · 服务以 gugu_files 的权限连库:测试建一个一次性 LOGIN 角色,它是 gugu_files 的成员且登录即 SET ROLE gugu_files
 *     (ALTER ROLE … SET role)—— gugu_files 本身保持迁移建出的 NOLOGIN、无口令,不被测试改动。
 *   · 服务用自己的连接,看不到测试事务里没提交的行 ⇒ 装置都要提交,afterAll 删掉。只建 identity.users,❌ auth.users
 *     (注册触发器会往全局的计费 / 网关队列里写行,同时在跑的别的测试会认领到)。
 *   · 客户端的形状照原型:「主进程」握凭证和真正的 WebSocket(子协议里带 bearer.<JWT>),只转发字节;「页面」持有
 *     Y.Doc 副本、看不到凭证。WebSocket 用 Node 自带的那个(和浏览器一样设不了请求头)。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import * as jose from 'jose'
import pg from 'pg'
import * as Y from 'yjs'

import { keepReplacedMaps } from '../../../packages/files-core/src/concurrent.mjs'
import type { FilesConfig } from '../../../services/files/src/config.mjs'
import { createLogger } from '../../../services/files/src/log.mjs'
import { createFileService, type FileService } from '../../../services/files/src/files.mjs'

export const SUBPROTOCOL = 'gugu-files.v1'
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
export async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 10_000, stepMs = 20): Promise<number> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await pred()) return Date.now() - t0
    await sleep(stepMs)
  }
  return -1
}
export const count = (hay: string, needle: string) => hay.split(needle).length - 1

export function adminUrl(): URL {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? process.env.GUGU_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('file service integration tests require a loopback PostgreSQL database')
  }
  return url
}

// ── 数据库装置 ──────────────────────────────────────────────────────────────────
export class Fixture {
  readonly admin: pg.Client
  private readonly users: string[] = []
  private readonly chats: string[] = []
  private readonly roles: string[] = []
  private readonly accounts: string[] = []

  constructor() {
    this.admin = new pg.Client({ connectionString: adminUrl().href })
  }
  async connect() {
    await this.admin.connect()
  }
  /** 一次性 LOGIN 角色:gugu_files 的成员,登录即 SET ROLE gugu_files。返回服务用的连接串。 */
  async filesLogin(): Promise<string> {
    const role = `files_test_${randomBytes(6).toString('hex')}`
    const password = randomBytes(18).toString('hex')
    await this.admin.query(`CREATE ROLE ${role} LOGIN NOINHERIT PASSWORD '${password}' IN ROLE gugu_files`)
    await this.admin.query(`ALTER ROLE ${role} SET role = 'gugu_files'`)
    this.roles.push(role)
    const url = adminUrl()
    url.username = role
    url.password = password
    return url.href
  }
  async person(name: string): Promise<string> {
    const id = randomUUID()
    await this.admin.query(`INSERT INTO identity.users (id, type, display_name) VALUES ($1,'human',$2)`, [id, name])
    this.users.push(id)
    return id
  }
  /**
   * agent 必须挂在主人的一台设备上(users_agent_device_required),设备又要主人有 auth.users 行 ——
   * 只有 agent 的主人才建账号行(注册触发器只补 identity.users,不碰计费队列)。
   */
  async agentOf(owner: string, name: string): Promise<string> {
    const id = randomUUID()
    const device = `files-test-${owner}`
    if (!this.accounts.includes(owner)) {
      await this.admin.query(
        `INSERT INTO auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
         VALUES ($1,'authenticated','authenticated',$2,'{"provider":"email","providers":["email"]}','{}',now(),now())`,
        [owner, `${owner}@files-test.invalid`],
      )
      this.accounts.push(owner)
    }
    await this.admin.query(
      `INSERT INTO identity.gugu_devices (device_id,user_id,label,hostname,platform) VALUES ($1,$2,'files test','fixture','darwin')
       ON CONFLICT (device_id) DO NOTHING`,
      [device, owner],
    )
    await this.admin.query(`INSERT INTO identity.users (id, type, display_name, owner_user_id, device_id) VALUES ($1,'agent',$2,$3,$4)`, [
      id,
      name,
      owner,
      device,
    ])
    this.users.push(id)
    return id
  }
  async group(owner: string, members: string[], kind: 'group' | 'dm' = 'group'): Promise<string> {
    const id = randomUUID()
    await this.admin.query('BEGIN')
    await this.admin.query(`INSERT INTO chat.chats (id, kind, name, creator_user_id) VALUES ($1,$2,$3,$4)`, [id, kind, kind === 'group' ? 'files test' : null, owner])
    await this.admin.query(
      `INSERT INTO chat.chat_members (chat_id,user_id,role) SELECT $1, u, CASE WHEN u = $2 THEN 'owner' ELSE 'member' END FROM unnest($3::text[]) AS u`,
      [id, owner, [owner, ...members]],
    )
    await this.admin.query('COMMIT')
    this.chats.push(id)
    return id
  }
  async join(chatId: string, userId: string) {
    await this.admin.query(`INSERT INTO chat.chat_members (chat_id,user_id,role) VALUES ($1,$2,'member')`, [chatId, userId])
  }
  async remove(chatId: string, userId: string) {
    await this.admin.query('DELETE FROM chat.chat_members WHERE chat_id = $1 AND user_id = $2', [chatId, userId])
  }
  async file(chatId: string, by: string, filename: string, contentType: string, text: string | null, kind: 'document' | 'file' = 'document'): Promise<string> {
    const { rows } = await this.admin.query<{ id: string }>(
      `INSERT INTO chat.workspace_items (chat_id, kind, filename, content_type, inline_text, size_bytes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [chatId, kind, filename, contentType, text, text === null ? null : Buffer.byteLength(text), by],
    )
    return rows[0]!.id
  }
  async row(itemId: string) {
    const { rows } = await this.admin.query<{ inline_text: string | null; ys: number | null; epoch: number; size_bytes: string | null }>(
      'SELECT inline_text, length(ystate) AS ys, epoch, size_bytes FROM chat.workspace_items WHERE id = $1',
      [itemId],
    )
    return rows[0]
  }
  /** 回到种子正文、清掉协同状态、换一个新代号(上一轮的任何东西都混不进来)。 */
  async reseed(itemId: string, text: string) {
    await this.admin.query('UPDATE chat.workspace_items SET inline_text = $1, size_bytes = $2, ystate = NULL, epoch = epoch + 1 WHERE id = $3', [
      text,
      Buffer.byteLength(text),
      itemId,
    ])
  }
  async cleanup() {
    try {
      if (this.chats.length) await this.admin.query('DELETE FROM chat.chats WHERE id = ANY($1)', [this.chats])
      if (this.users.length) {
        await this.admin.query(`DELETE FROM identity.users WHERE id = ANY($1) AND type = 'agent'`, [this.users])
        await this.admin.query('DELETE FROM identity.gugu_devices WHERE user_id = ANY($1)', [this.users])
        if (this.accounts.length) await this.admin.query('DELETE FROM auth.users WHERE id = ANY($1::uuid[])', [this.accounts])
        await this.admin.query('DELETE FROM identity.users WHERE id = ANY($1)', [this.users])
      }
      for (const role of this.roles) {
        await this.admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = $1', [role])
        await this.admin.query(`DROP ROLE IF EXISTS ${role}`)
      }
    } finally {
      await this.admin.end()
    }
  }
}

// ── 自签令牌 ────────────────────────────────────────────────────────────────────
export interface Issuer {
  jwksUrl: string
  mint(sub: string, options?: { expiresIn?: string | number; role?: string; foreign?: boolean }): Promise<string>
  close(): Promise<void>
}
export async function startIssuer(): Promise<Issuer> {
  const { privateKey, publicKey } = await jose.generateKeyPair('ES256', { extractable: true })
  const foreignKey = (await jose.generateKeyPair('ES256')).privateKey
  const jwk = { ...(await jose.exportJWK(publicKey)), kid: 'files-test', alg: 'ES256', use: 'sig' }
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ keys: [jwk] }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port
  return {
    jwksUrl: `http://127.0.0.1:${port}/auth/v1/.well-known/jwks.json`,
    async mint(sub, { expiresIn = '1h', role = 'authenticated', foreign = false } = {}) {
      return new jose.SignJWT({ sub, role, aud: 'authenticated' })
        .setProtectedHeader({ alg: 'ES256', kid: 'files-test' })
        .setIssuedAt()
        .setExpirationTime(expiresIn)
        .sign(foreign ? foreignKey : privateKey)
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

// ── 服务 ────────────────────────────────────────────────────────────────────────
export function filesConfig(dbUrl: string, jwksUrl: string, overrides: Partial<FilesConfig> = {}): FilesConfig {
  return {
    host: '127.0.0.1',
    port: 0,
    adminHost: '127.0.0.1',
    adminPort: 0,
    dbUrl,
    dbPoolMax: 4,
    jwksUrl,
    jwtSecret: null,
    jwtIssuer: null,
    timeoutMs: 30_000,
    debounceMs: 1_000,
    maxDebounceMs: 5_000,
    maxFileBytes: 1024 * 1024,
    maxFrameBytes: 16 * 1024 * 1024,
    maxBodyBytes: 4 * 1024 * 1024,
    rateUpdates: { perSecond: 50, burst: 500 },
    rateBytes: { perSecond: 256 * 1024, burst: 8 * 1024 * 1024 },
    rateAwareness: { perSecond: 20, burst: 60 },
    compactRatio: 4,
    compactMinBytes: 4096,
    hotCompactRatio: 8,
    hotCompactMinBytes: 256 * 1024,
    hotCompactCooldownMs: 60_000,
    compactDrainMs: 1000,
    roundIdleMs: 30_000,
    storeWaitsHistoryMs: 5_000,
    logLevel: 'info',
    ...overrides,
  }
}

export interface Running {
  service: FileService
  url: string
  adminUrl: string
  logs: Record<string, unknown>[]
  close(): Promise<void>
}
/** `pool`: the service's database pool, given (the caller ends it); otherwise the service makes and ends its own. */
export async function startFiles(config: FilesConfig, { pool }: { pool?: pg.Pool } = {}): Promise<Running> {
  const logs: Record<string, unknown>[] = []
  const log = createLogger({ level: 'debug', write: (line) => logs.push(JSON.parse(line)) })
  const service = createFileService(config, { log, ...(pool ? { pool } : {}) })
  const { port, adminPort } = await service.listen()
  return { service, url: `http://127.0.0.1:${port}`, adminUrl: `http://127.0.0.1:${adminPort}`, logs, close: () => service.close() }
}

/** 服务跑在子进程里(E4 要 kill -9 它)。端口固定,重启后客户端连回同一个地址。 */
export interface Child {
  url: string
  adminUrl: string
  start(): Promise<void>
  kill(signal?: NodeJS.Signals): Promise<void>
}
export async function freePort(): Promise<number> {
  const s = net.createServer()
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve))
  const port = (s.address() as net.AddressInfo).port
  await new Promise<void>((resolve) => s.close(() => resolve()))
  return port
}
export async function childService(dbUrl: string, jwksUrl: string, env: Record<string, string> = {}): Promise<Child> {
  const port = await freePort()
  const adminPort = await freePort()
  const url = `http://127.0.0.1:${port}`
  const admin = `http://127.0.0.1:${adminPort}`
  let proc: ChildProcess | null = null
  return {
    url,
    adminUrl: admin,
    async start() {
      proc = spawn(process.execPath, [path.join(REPO, 'services/files/src/main.mjs')], {
        env: {
          PATH: process.env.PATH ?? '',
          FILES_DB_URL: dbUrl,
          FILES_JWKS_URL: jwksUrl,
          FILES_PORT: String(port),
          FILES_ADMIN_PORT: String(adminPort),
          FILES_LOG_LEVEL: 'warn',
          ...env,
        },
        // The service logs to stdout (warn and above here): keep it, so a failure in CI shows the service's side.
        stdio: ['ignore', 'inherit', 'inherit'],
      })
      const ms = await waitFor(async () => {
        try {
          return (await fetch(`${admin}/healthz`)).ok
        } catch {
          return false
        }
      }, 15_000, 50)
      if (ms < 0) throw new Error('file service child did not become healthy')
    },
    async kill(signal = 'SIGTERM') {
      const p = proc
      proc = null
      if (!p || p.exitCode !== null) return
      await new Promise<void>((resolve) => {
        p.once('exit', () => resolve())
        p.kill(signal)
      })
    },
  }
}

export async function stats(adminBase: string): Promise<Record<string, any>> {
  return (await fetch(`${adminBase}/stats`)).json()
}

// ── HTTP(agent / 主进程)──────────────────────────────────────────────────────
export async function getFile(base: string, jwt: string | null, itemId: string, asAgent?: string) {
  const headers: Record<string, string> = {}
  if (jwt) headers.authorization = `Bearer ${jwt}`
  if (asAgent) headers['x-gugu-as-agent'] = asAgent
  const r = await fetch(`${base}/${itemId}`, { headers })
  return { status: r.status, body: (await r.json()) as Record<string, any> }
}
export async function editFile(base: string, jwt: string, itemId: string, oldText: string, newText: string, asAgent?: string) {
  const headers: Record<string, string> = { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' }
  if (asAgent) headers['x-gugu-as-agent'] = asAgent
  const r = await fetch(`${base}/${itemId}/edit`, { method: 'POST', headers, body: JSON.stringify({ old: oldText, new: newText }) })
  return { status: r.status, body: (await r.json()) as Record<string, any> }
}

// ── 客户端:主进程转发 + 页面副本 ───────────────────────────────────────────────
/** 冻住一台机器(合盖):两个方向的帧都扣住,什么都不关。 */
export function makeGate() {
  const g = { paused: false, queue: [] as (() => void)[], pause() {}, resume() {} }
  g.pause = () => {
    g.paused = true
  }
  g.resume = () => {
    g.paused = false
    for (const fn of g.queue.splice(0)) fn()
  }
  return g
}
export type Gate = ReturnType<typeof makeGate>

/** 「主进程」:用 Node 自带的 WebSocket(设不了请求头),凭证放子协议;对页面的 provider 装成一个 WebSocket。 */
/** `gate` 扣住两个方向的帧(合盖);`inbound` 只扣住服务端发下来的(页面照常发出,但还听不到回音)。 */
export function relaySocket({ jwt, protocols, ipcDelayMs = 1, gate, inbound }: { jwt: string; protocols?: string[]; ipcDelayMs?: number; gate?: Gate; inbound?: Gate }) {
  return class RelaySocket extends EventTarget {
    readyState = 0
    binaryType = 'arraybuffer'
    protocol = ''
    private readonly real: WebSocket
    private readonly hop: (fn: () => void) => void
    constructor(url: string) {
      super()
      const hop = (fn: () => void) => {
        const run = () => (ipcDelayMs ? setTimeout(fn, ipcDelayMs) : queueMicrotask(fn))
        if (gate?.paused) gate.queue.push(run)
        else run()
      }
      this.hop = hop
      const real = new WebSocket(url, protocols ?? [SUBPROTOCOL, `bearer.${jwt}`])
      real.binaryType = 'arraybuffer'
      this.real = real
      real.addEventListener('open', () =>
        hop(() => {
          this.readyState = 1
          this.protocol = real.protocol
          this.dispatchEvent(new Event('open'))
        }),
      )
      real.addEventListener('message', (e) => {
        const deliver = () =>
          hop(() => {
            const ev = new Event('message') as Event & { data?: unknown }
            ev.data = e.data
            this.dispatchEvent(ev)
          })
        if (inbound?.paused) inbound.queue.push(deliver)
        else deliver()
      })
      real.addEventListener('close', (e) =>
        hop(() => {
          this.readyState = 3
          const ev = new Event('close') as Event & { code?: number; reason?: string }
          ev.code = e.code
          ev.reason = e.reason
          this.dispatchEvent(ev)
        }),
      )
      real.addEventListener('error', () => hop(() => this.dispatchEvent(new Event('error'))))
    }
    send(data: ArrayBufferLike | Uint8Array) {
      const copy = new Uint8Array(data as ArrayBuffer).slice()
      this.hop(() => {
        if (this.real.readyState === 1) this.real.send(copy)
      })
    }
    close() {
      this.readyState = 2
      this.hop(() => this.real.close())
    }
  }
}

export interface Machine {
  jwt: string
  socket: HocuspocusProviderWebsocket
}
/** 一台桌面:一条主进程连接,这台机器上的所有页面共用。 */
export function machine(base: string, jwt: string, options: { ipcDelayMs?: number; gate?: Gate; inbound?: Gate; protocols?: string[] } = {}): Machine {
  const socket = new HocuspocusProviderWebsocket({
    url: base.replace(/^http/, 'ws') + '/',
    WebSocketPolyfill: relaySocket({ jwt, ...options }) as unknown as typeof WebSocket,
    delay: 200,
    minDelay: 200,
    maxDelay: 2000,
  })
  return { jwt, socket }
}

export interface Page {
  itemId: string
  epoch: number
  doc: Y.Doc
  provider: HocuspocusProvider
  events: { authFailed: { reason: string; at: number } | null; closed: { reason?: string; code?: number; at: number } | null; synced: number | null }
  synced: Promise<void>
  text(): string
  close(): void
}
/**
 * 让一页照 F71 的页面约定回应热压缩 —— 只为服务端测试,真正的页面这一半在 gugu 运行时的 OpenFile 里:
 * 收到 compact 后,等已发出的改动都被确认,就回 drained。`respond: false` 的页一直不回
 * (模拟正在组字、卡住的页)。记下收到的 compact / resume。
 */
export function compactAware(page: Page, options: { respond?: boolean } = {}) {
  const seen = { compact: 0, resume: 0, drained: 0 }
  const drainWhenAcked = () => {
    if (page.provider.hasUnsyncedChanges) {
      const again = () => {
        page.provider.off('unsyncedChanges', again)
        drainWhenAcked()
      }
      page.provider.on('unsyncedChanges', again)
      return
    }
    seen.drained++
    page.provider.sendStateless(JSON.stringify({ t: 'drained' }))
  }
  page.provider.on('stateless', ({ payload }: { payload: string }) => {
    const message = JSON.parse(payload) as { t?: string }
    if (message.t === 'compact') {
      seen.compact++
      if (options.respond ?? true) drainWhenAcked()
    } else if (message.t === 'resume') seen.resume++
  })
  return seen
}

/** 页面打开一个文件:自己的 Y.Doc 副本,挂在这台机器的共用连接上;看不到凭证。 */
export function openPage(m: Machine, itemId: string, epoch: number, options: { clientID?: number } = {}): Page {
  const doc = new Y.Doc()
  keepReplacedMaps(doc) // 和页面运行时一样(F43):被替换掉的 map 不做 GC,离线重连时自己那份才送得到服务端
  if (options.clientID !== undefined) doc.clientID = options.clientID
  const events: Page['events'] = { authFailed: null, closed: null, synced: null }
  const provider = new HocuspocusProvider({
    websocketProvider: m.socket,
    name: `${itemId}@${epoch}`,
    document: doc,
    token: 'page-holds-no-credential',
    onAuthenticationFailed: ({ reason }) => {
      events.authFailed ??= { reason, at: Date.now() }
    },
    onClose: ({ event }) => {
      events.closed ??= { reason: event?.reason, code: event?.code, at: Date.now() }
    },
  })
  provider.attach()
  const page: Page = {
    itemId,
    epoch,
    doc,
    provider,
    events,
    synced: new Promise<void>((resolve) => {
      if (provider.isSynced) resolve()
      provider.on('synced', () => {
        events.synced ??= Date.now()
        resolve()
      })
    }),
    text: () => doc.getText('content').toString(),
    close: () => provider.destroy(),
  }
  return page
}

/** 像编辑器绑定那样打字:光标是相对位置,别人的改动不会挪动下一个字落下的地方。 */
export class Typist {
  private rel: Y.RelativePosition
  constructor(
    private readonly page: Page,
    anchorText: string,
  ) {
    const t = page.doc.getText('content')
    const i = t.toString().indexOf(anchorText)
    if (i < 0) throw new Error(`anchor not found: ${anchorText}`)
    this.rel = Y.createRelativePositionFromTypeIndex(t, i + anchorText.length)
  }
  private index() {
    const abs = Y.createAbsolutePositionFromRelativePosition(this.rel, this.page.doc)
    if (!abs) throw new Error('cursor lost')
    return abs.index
  }
  type(ch: string) {
    const t = this.page.doc.getText('content')
    const at = this.index()
    t.insert(at, ch)
    this.rel = Y.createRelativePositionFromTypeIndex(t, at + ch.length)
  }
  backspace() {
    const t = this.page.doc.getText('content')
    const at = this.index()
    if (at > 0) t.delete(at - 1, 1)
    this.rel = Y.createRelativePositionFromTypeIndex(t, Math.max(0, at - 1))
  }
}
export async function typeString(typist: Typist, s: string, cps: number) {
  for (const ch of s) {
    typist.type(ch)
    await sleep(1000 / cps)
  }
}

export const SEED = [
  '# 协同测试文档',
  '',
  '## 人写区',
  '',
  '（A 在这段后面写）',
  '',
  '（B 在这段后面写）',
  '',
  '（C 在这段后面写）',
  '',
  '## agent 改的区',
  '',
  '第一句：今天的工作区只扛得住低频写。',
  '第二句：每保存一次，整篇正文在网上走三遍。',
  '第三句：通知推给全员，而不只推给正在看的人。',
  '第四句：人和 agent 会在这句上撞车。',
  '',
].join('\n')
