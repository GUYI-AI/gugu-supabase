// 文件服务(真源 gugu-base notes/2026-09-29-app-platform/workspace-app §2.1–2.3)。
//
// 一个文件 = chat.workspace_items 一行。打开的文件在内存里是一份 Yjs 文档,文档名 <itemId>@<epoch>。
//   · 加载:ystate 有就用;没有就按正文建,并以 `WHERE ystate IS NULL` 立即钉回库 —— 否则第一次存盘前卸载,
//     下次会按同一份正文生成另一套 item id,内容重复一遍。钉不上(别人先钉了)就用库里那份。
//   · 协同文本的正文标记 {"$text": "..."}(@gugu/files-core 的 content):建状态的那条 UPDATE 同时把正文换成投影。
//     带标记的文件一建出来就有通知(files_item_marked),不等人打开就建好;标记只在建文件那一刻出现在正文里。
//   · 存盘:去抖 1 s、最长 5 s;同一条 UPDATE 写 ystate、inline_text、size_bytes,条件带 epoch。
//   · 卸载:最后一个连接走了立刻存盘并卸载;卸载后才考虑冷压缩(ystate > 4 × 正文 + 4 KB,且此刻没人开着
//     这个文件的任何代号)—— 按当前的 Yjs 结构重建(不是按正文:JSON 里的协同文本要保住类型)、epoch + 1,
//     拿旧代号的客户端再连会被拒(stale-epoch:<n>)后重载。
//   · 开着时的热压缩(F71):存盘后 ystate 超过 max(8 × 正文, 256 KB),而且每条连接都声明过支持 ⇒ 先让所有页面排空、暂停,
//     再按当前结构重建、epoch + 1(和冷压缩同一把 itemLock),以 compacted:<n> 关掉连接;页面重开并补上暂停期间的改动。
//     排空超时就作废这一轮。agent 的 HTTP edit 撞上换代就等它结束、在新代号上再做;连着 4 代都撞上就 503 compacting,
//     ❌ 写进已经换走的那一代(onLiveGeneration)。规则在 @gugu/files-core 的 open-files。
//   · 同一个文件的「加载」与「冷压缩」按 itemId 串行:否则压缩提交之前开始的加载会拿着旧代号活下来,
//     之后每一次存盘都写不进去(条件里的 epoch 已经变了)。
//   · 同时建同一条嵌套路径(两端各建一个中间容器、键上后写者胜):输家的内容并进胜者,见 @gugu/files-core 的 concurrent(F43)。
//   · 通知:成员移出 ⇒ 断开这个人在该群所有文件上的连接(removed-from-group);文件删除 ⇒ 断开(deleted)、卸载、不再存盘。
//     LISTEN 连接断过就把所有开着的连接重核一遍(断线期间的通知收不到)。
//
// 两个端口:对外口只有 /:id、/:id/edit、/:id/replace 与 WebSocket(nginx 的 /files/ 剥掉前缀后转到这里);
// 内部口只有 /healthz 与 /stats,只绑回环、❌ 经 nginx 暴露。

import http from 'node:http'
import { Server, isTransactionOrigin } from '@hocuspocus/server'
import pg from 'pg'
import * as Y from 'yjs'
import { contentOriginOf } from '@gugu/files-core/concurrent'

import {
  Denied,
  SUBPROTOCOL,
  authorizeItem,
  asAgentFromProtocols,
  bearerFromAuthorization,
  bearerFromProtocols,
  createVerifier,
  isUuid,
  offeredProtocols,
} from './auth.mjs'
import { InvalidJson, applyEdit, buildDoc, isJson, parseJsonObject, readText, rebuildDoc, sameContent, withoutMarks } from '@gugu/files-core/content'
import { createOpenFiles, readHead } from '@gugu/files-core/open-files'
import { colorFor } from '@gugu/files-core/presence'
import { errorFields } from './log.mjs'
import { createRounds } from './rounds.mjs'
import { replaceIncoming } from './replacement.mjs'

const NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@(0|[1-9]\d{0,8})$/i

// 对外口的跨域:浏览器里直接 fetch 的(手机壳没有主进程,WebView 里读文件)先发预检,不放行就到不了 GET。
// 凭证只走 Authorization、不走 cookie ⇒ Origin 用 *:别的站拿不到令牌,放行了也什么都读不到;
// 收窄成白名单反而要跟着每一种壳的 Origin(capacitor://localhost、https://localhost、网页版)改服务。
// Authorization 不被 Allow-Headers 的 * 覆盖(Fetch 规范),逐个列出。错误响应也带:浏览器才读得到 401 / 404 的原因。
// 内部口不带:它不经 nginx,也不给浏览器。
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'Authorization, Content-Type, X-Gugu-As-Agent',
  'access-control-max-age': '600',
}

/** @param {string} name */
export function parseDocName(name) {
  const m = NAME.exec(name)
  return m ? { itemId: m[1].toLowerCase(), epoch: Number(m[2]) } : null
}

/** How many generations an HTTP edit tries before it gives up on a file swapped under it each time (F71). */
const EDIT_TRIES = 4

/**
 * An HTTP edit on the generation there is now (F71). A generation being swapped, or swapped already (frozen), is never
 * written: its content went into the next one and a store of it is skipped, so a write there would answer 200 and be
 * gone. The edit waits the swap out and opens the file again on the new generation; frozen `tries` times running, it is
 * refused out loud — 503 `compacting`, try again — never written quietly (L3's review of #77).
 * @template T
 * @param {{
 *   tries: number,
 *   open: () => Promise<{ name: string, write: () => Promise<T>, close: () => Promise<unknown> }>,
 *   frozen: (name: string) => boolean,
 *   settled: (name: string) => Promise<unknown>,
 * }} steps
 * @returns {Promise<T>}
 */
export async function onLiveGeneration({ tries, open, frozen, settled }) {
  for (let attempt = 1; ; attempt += 1) {
    const at = await open()
    if (!frozen(at.name)) {
      try {
        return await at.write()
      } finally {
        await at.close()
      }
    }
    await at.close()
    if (attempt >= tries) throw new Denied('compacting', 503)
    await settled(at.name)
  }
}

/** @param {Headers | Record<string, string | string[] | undefined> | undefined} headers @param {string} name */
function header(headers, name) {
  if (!headers) return undefined
  if (typeof (/** @type {any} */ (headers).get) === 'function') return /** @type {Headers} */ (headers).get(name) ?? undefined
  const v = /** @type {Record<string, string | string[] | undefined>} */ (headers)[name]
  return Array.isArray(v) ? v.join(', ') : v
}

/**
 * @param {import('./config.mjs').FilesConfig} config
 * @param {{ log: import('./log.mjs').Logger, pool?: pg.Pool }} deps
 */
export function createFileService(config, { log, pool: givenPool }) {
  const pool = givenPool ?? new pg.Pool({ connectionString: config.dbUrl, max: config.dbPoolMax, application_name: 'gugu-files' })
  const verify = createVerifier(config)
  const maxBytes = config.maxFileBytes

  const stats = {
    startedAt: new Date().toISOString(),
    loads: 0,
    builtFromText: 0,
    marksProjected: 0,
    loadMismatch: 0,
    stores: 0,
    storeBytes: 0,
    storeErrors: 0,
    storeLost: 0,
    unloads: 0,
    compactions: 0,
    hotCompactions: 0,
    compactAborted: 0,
    rejects: /** @type {Record<string, number>} */ ({}),
    edits: { ok: 0, rejected: 0 },
    reads: 0,
    kicks: { removed: 0, deleted: 0 },
    rateLimited: 0,
    tooLarge: 0,
    presenceCoalesced: 0,
    presenceFlushed: 0,
    concurrentMerges: { create: 0, lateWrite: 0 },
    listenerReconnects: 0,
    versions: { recorded: 0, errors: 0, storeWaitTimeouts: 0 },
  }
  const reject = (/** @type {string} */ reason) => {
    const key = reason.split(':')[0]
    stats.rejects[key] = (stats.rejects[key] ?? 0) + 1
  }

  // 打开的文件里和存储无关的那一半(簿记、限速与上限、presence 盖章、self、同时建合并):和桌面本地服务共用同一个包。
  /** @type {import('@gugu/files-core/open-files').OpenFiles<{ itemId: string, epoch: number, chatId: string, contentType: string, deleted: boolean, updatedBy: string | null }>} */
  const openFiles = createOpenFiles({
    maxBytes,
    limits: config,
    log,
    stats,
    compaction: { ratio: config.hotCompactRatio, minBytes: config.hotCompactMinBytes, cooldownMs: config.hotCompactCooldownMs, drainMs: config.compactDrainMs },
  })
  const docs = openFiles.docs

  // 每一轮改动留一版历史(G2,rounds.mjs):agent 那一轮的边界或停够了才切。写库排进队列,不等它 —— 历史缺一版不该
  // 拖慢、更不该挡住人和 agent 改文件;写失败只进日志。记不记、编号、只留 50 版在库里那一个函数判。
  const rounds = createRounds({
    idleMs: config.roundIdleMs,
    record: async (itemId, text, madeBy) => {
      const { rows } = await pool.query('SELECT chat.files_record_version($1::uuid, $2, $3) AS recorded', [itemId, text, madeBy])
      if (rows[0]?.recorded) stats.versions.recorded++
    },
    // 一轮停够了被拿出内存时的正文:开着就读内存;没开的读库里存的正文(卸载在存盘之后,就是最后一轮改完的样子)。
    read: (itemId) => {
      for (const [name, info] of docs) {
        const doc = info.itemId === itemId && !info.deleted ? hp().documents.get(name) : undefined
        if (doc) return readText(doc, info.contentType)
      }
      return pool
        .query("SELECT inline_text FROM chat.workspace_items WHERE id = $1::uuid AND kind = 'document'", [itemId])
        .then(({ rows }) => rows[0]?.inline_text ?? null)
    },
    onError: (itemId, error) => {
      stats.versions.errors++
      log.error('history: a round could not be recorded', { itemId, ...errorFields(error) })
    },
  })
  /**
   * 存盘之前先等这个文件排着的历史写完:上一轮的样子要先于这一轮的正文落库 —— 不然库里那条兜底(作者不明时「建好后没变过 ⇒
   * 建它的人」)读到的 updated_at 已经被这次存盘改了,作者记成空(CI 上撞到过)。等有上限:历史写不进去(库卡住、写失败)时
   * 只记日志、照常存盘 —— 作者丢了也比正文没存上强。历史的写入成功失败都会 resolve(失败已进日志)。
   * @param {Promise<unknown>} written @param {string} what @param {Record<string, unknown>} fields
   */
  async function historyFirst(written, what, fields) {
    const ms = config.storeWaitsHistoryMs
    /** @type {NodeJS.Timeout | undefined} */
    let timer
    const done = await Promise.race([
      written.then(() => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), ms) }),
    ])
    clearTimeout(timer)
    if (!done) {
      stats.versions.storeWaitTimeouts++
      log.warn(`history: still being written after ${ms} ms; ${what} anyway`, fields)
    }
  }

  /**
   * 一笔改动落地之前:writer 是这条连接的 actor;它是 agent,当且仅当连接带了 as-agent(actor 不是令牌的主人)。
   * @param {{ itemId: string, contentType: string }} info @param {{ actorId: string, userId: string }} who @param {Y.Doc} document
   * @param {Uint8Array} [update] 一个页面发来的 Yjs 更新:在副本上试一次,正文不变就不算改动(打开文件时的同步帧)
   */
  function roundBefore(info, who, document, update) {
    const changes = () => {
      if (!update) return true
      const trial = new Y.Doc()
      try {
        Y.applyUpdate(trial, Y.encodeStateAsUpdate(document))
        const before = readText(trial, info.contentType)
        Y.applyUpdate(trial, update)
        return readText(trial, info.contentType) !== before
      } finally {
        trial.destroy()
      }
    }
    try {
      rounds.before(info.itemId, { id: who.actorId, agent: who.actorId !== who.userId }, () => readText(document, info.contentType), changes)
    } catch (error) {
      stats.versions.errors++
      log.error('history: the round before this change could not be read', { itemId: info.itemId, ...errorFields(error) })
    }
  }

  // ── 同一 itemId 的加载与冷压缩串行 ──────────────────────────────────────────
  /** @type {Map<string, Promise<unknown>>} */
  const itemLocks = new Map()
  /** @template T @param {string} itemId @param {() => Promise<T>} fn @returns {Promise<T>} */
  function withItemLock(itemId, fn) {
    const prev = itemLocks.get(itemId) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    const tail = run.catch(() => undefined)
    itemLocks.set(itemId, tail)
    tail.then(() => {
      if (itemLocks.get(itemId) === tail) itemLocks.delete(itemId)
    })
    return run
  }

  /** @type {Server} */
  let server
  const hp = () => server.hocuspocus
  /**
   * 热压缩的「写成下一代」(F71):和加载、冷压缩同一把 itemLock。重建的状态、它的投影、字节数和 epoch + 1 一条 UPDATE 写进去,
   * 条件带当前的 epoch;不中 = 这一轮作废(共用包会让所有页面恢复发送)。
   * @param {{ itemId: string, epoch: number, contentType: string }} info @param {Y.Doc} fresh
   */
  const persistCompacted = (info, fresh) =>
    withItemLock(info.itemId, async () => {
      const text = readText(fresh, info.contentType)
      const { rows } = await pool.query(
        `UPDATE chat.workspace_items SET ystate = $1, inline_text = $2, size_bytes = $3, epoch = epoch + 1
          WHERE id = $4::uuid AND epoch = $5 RETURNING epoch`,
        [Buffer.from(Y.encodeStateAsUpdate(fresh)), text, Buffer.byteLength(text), info.itemId, info.epoch],
      )
      if (!rows[0]) throw new Error('epoch moved under the document')
      return /** @type {number} */ (rows[0].epoch)
    })
  const itemBusy = (/** @type {string} */ itemId) =>
    [...hp().documents.keys(), ...hp().loadingDocuments.keys()].some((n) => n.startsWith(itemId + '@'))

  // ── 按正文建状态 ────────────────────────────────────────────────────────────
  /**
   * 还没有 ystate 的文件:按正文建一份,以 `WHERE ystate IS NULL` 钉回库(第一次存盘前卸载的话,下次会按同一份正文
   * 生成另一套 item id,内容重复一遍)。正文里有协同文本标记({"$text": …})时,同一条 UPDATE 把正文换成投影:
   * 标记只在建文件那一刻出现,之后谁读正文都是普通字符串。钉不上(别人先钉了,或者正文刚被改写)就重读。
   * 调用方持这个文件的 itemLock。返回库里那一行与它的状态。
   * @param {string} itemId
   */
  async function pinFromText(itemId) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { rows } = await pool.query(
        'SELECT chat_id, ystate, inline_text, content_type, kind, epoch FROM chat.workspace_items WHERE id = $1::uuid',
        [itemId],
      )
      const row = rows[0]
      if (!row) throw new Denied('not-found')
      if (row.kind !== 'document') throw new Denied('not-a-document', 409)
      if (row.ystate) return { row, state: /** @type {Uint8Array} */ (row.ystate), built: false }
      const text = row.inline_text ?? ''
      if (Buffer.byteLength(text) > maxBytes) {
        log.warn('file over the size limit; refusing to open', { itemId, textBytes: Buffer.byteLength(text), limit: maxBytes })
        throw new Denied('too-large', 413)
      }
      let built
      try {
        built = buildDoc(row.content_type, text)
      } catch (error) {
        if (error instanceof InvalidJson) {
          log.error('stored JSON does not parse; refusing to open', { itemId, message: error.message })
          throw new Denied('invalid-json', 422)
        }
        throw error
      }
      const state = Y.encodeStateAsUpdate(built)
      const projected = readText(built, row.content_type)
      built.destroy()
      const marked = !sameContent(row.content_type, projected, text)
      const u = marked
        ? await pool.query(
            `UPDATE chat.workspace_items SET ystate = $1, inline_text = $4, size_bytes = $5
              WHERE id = $2::uuid AND epoch = $3 AND ystate IS NULL AND inline_text IS NOT DISTINCT FROM $6`,
            [Buffer.from(state), itemId, row.epoch, projected, Buffer.byteLength(projected), row.inline_text],
          )
        : await pool.query(
            `UPDATE chat.workspace_items SET ystate = $1
              WHERE id = $2::uuid AND epoch = $3 AND ystate IS NULL AND inline_text IS NOT DISTINCT FROM $4`,
            [Buffer.from(state), itemId, row.epoch, row.inline_text],
          )
      if (u.rowCount) {
        stats.builtFromText++
        if (marked) stats.marksProjected++
        return { row: marked ? { ...row, inline_text: projected } : row, state, built: true }
      }
    }
    throw new Denied('unavailable', 503)
  }

  /** 建出来的文件正文里带标记:不等有人打开,马上建状态、把正文换成投影(通知 files_item_marked)。 */
  function projectMarks(/** @type {string} */ itemId) {
    withItemLock(itemId, () => pinFromText(itemId)).catch((error) => {
      if (error instanceof Denied) return // 已删、不是文档、坏 JSON:打开时照样拒,这里不用再说
      log.error('could not build a marked file from its text', { itemId, ...errorFields(error) })
    })
  }

  // ── 撤销文件访问 ─────────────────────────────────────────────────────────────
  function markDeleted(/** @type {string} */ itemId) {
    for (const [name, info] of docs) {
      if (info.itemId !== itemId) continue
      info.deleted = true
      rounds.forget(itemId)
      const doc = hp().documents.get(name)
      for (const conn of doc?.getConnections() ?? []) {
        // 原因写 deleted,❌ 复用鉴权的 not-found:主进程据此把页面状态转成 gone(真源 §2.4)。
        conn.close({ code: 4410, reason: 'deleted' })
        stats.kicks.deleted++
      }
      log.info('file deleted while open: connections closed, no further stores', { itemId, doc: name })
    }
  }

  /** LISTEN 断过之后:断线期间的移出、删除与带标记的新文件收不到,重核一遍。 */
  async function recheckAll() {
    const marked = await pool.query(
      `SELECT id::text AS id FROM chat.workspace_items
        WHERE kind = 'document' AND ystate IS NULL AND inline_text LIKE '%"$text"%'`,
    )
    for (const { id } of marked.rows) projectMarks(id)
    const open = [...docs.values()].filter((d) => !d.deleted)
    if (open.length) {
      const ids = [...new Set(open.map((d) => d.itemId))]
      const { rows } = await pool.query('SELECT id::text AS id FROM chat.workspace_items WHERE id = ANY($1::uuid[])', [ids])
      const alive = new Set(rows.map((r) => r.id))
      for (const id of ids) if (!alive.has(id)) markDeleted(id)
    }
    const connections = []
    for (const doc of hp().documents.values()) {
      for (const conn of doc.getConnections()) {
        const c = conn.context
        if (c?.teamSessionRequired && Date.now() >= c.authExpiresAt) {
          conn.close({ code: 4401, reason: 'bad-credential' })
          continue
        }
        if (c?.itemId && c?.userId && c?.actorId) connections.push({ conn, itemId: c.itemId, userId: c.userId, actorId: c.actorId, sessionId: c.sessionId ?? null })
      }
    }
    if (!connections.length) return
    // The item's container may have changed since authentication. Reuse the
    // database's current item + delegated-actor authorization in one batch;
    // cached chat membership must neither preserve nor revoke access on its own.
    const { rows } = await pool.query(
      `SELECT p.item_id::text, p.user_id, p.actor_id, p.session_id, g.chat_id
         FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[]) AS p(item_id, user_id, actor_id, session_id)
         CROSS JOIN LATERAL chat.files_authorize(p.item_id, p.user_id, p.actor_id, p.session_id) g`,
      [connections.map((c) => c.itemId), connections.map((c) => c.userId), connections.map((c) => c.actorId), connections.map((c) => c.sessionId)],
    )
    const key = (/** @type {string} */ itemId, /** @type {string} */ userId, /** @type {string} */ actorId, /** @type {string | null} */ sessionId) => `${itemId}\u0000${userId}\u0000${actorId}\u0000${sessionId ?? ""}`
    const allowed = new Map(rows.map((r) => [key(r.item_id, r.user_id, r.actor_id, r.session_id), r.chat_id]))
    for (const { conn, itemId, userId, actorId, sessionId } of connections) {
      const chatId = allowed.get(key(itemId, userId, actorId, sessionId))
      if (chatId) conn.context.chatId = chatId
      else {
        conn.close({ code: 4403, reason: 'removed-from-group' })
        stats.kicks.removed++
        log.info('revoked file access', { itemId, actorId })
      }
    }
  }

  // ── LISTEN ──────────────────────────────────────────────────────────────────
  const listener = { client: /** @type {pg.Client | null} */ (null), up: false, stopped: false, timer: /** @type {NodeJS.Timeout | null} */ (null) }
  function onNotification(/** @type {pg.Notification} */ { channel, payload = '' }) {
    if (channel === 'files_member_removed') {
      recheckAll().catch((error) => log.error('member removal recheck failed', errorFields(error)))
    } else if (channel === 'files_item_deleted') {
      if (isUuid(payload)) markDeleted(payload.toLowerCase())
    } else if (channel === 'files_item_marked') {
      if (isUuid(payload)) projectMarks(payload.toLowerCase())
    }
  }
  async function connectListener(/** @type {number} */ backoffMs = 500) {
    if (listener.stopped) return
    const client = new pg.Client({ connectionString: config.dbUrl, application_name: 'gugu-files-listen' })
    listener.client = client
    const retry = (/** @type {unknown} */ error) => {
      if (listener.client !== client) return
      listener.up = false
      listener.client = null
      client.end().catch(() => undefined)
      if (listener.stopped) return
      log.error('listener lost; reconnecting', { ...errorFields(error), backoffMs })
      listener.timer = setTimeout(() => {
        stats.listenerReconnects++
        connectListener(Math.min(backoffMs * 2, 30_000))
      }, backoffMs)
    }
    client.on('error', retry)
    client.on('end', () => retry(new Error('connection ended')))
    client.on('notification', onNotification)
    try {
      await client.connect()
      await client.query('LISTEN files_member_removed')
      await client.query('LISTEN files_item_deleted')
      await client.query('LISTEN files_item_marked')
      listener.up = true
      await recheckAll()
    } catch (error) {
      retry(error)
    }
  }

  // ── Hocuspocus ──────────────────────────────────────────────────────────────
  server = new Server({
    name: 'gugu-files',
    port: config.port,
    address: config.host,
    quiet: true,
    stopOnSignals: false,
    timeout: config.timeoutMs,
    debounce: config.debounceMs,
    maxDebounce: config.maxDebounceMs,
    unloadImmediately: true,
    websocketOptions: {
      maxPayload: config.maxFrameBytes,
      // 回应子协议 gugu-files.v1:不回应的话浏览器会直接断开;没提供它的客户端一律不选(随后在 upgrade 里被拒)。
      handleProtocols: (/** @type {Set<string>} */ offered) => (offered.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
    },

    // 先在握手时验一次凭证:没有有效令牌的 socket 根本建不起来。
    async onUpgrade({ request, socket }) {
      const path = (request.url ?? '/').split('?')[0]
      let status = 0
      if (path !== '/') status = 404
      else {
        try {
          await verify(bearerFromProtocols(offeredProtocols(header(request.headers, 'sec-websocket-protocol'))))
        } catch {
          status = 401
        }
      }
      if (!status) return
      reject(status === 401 ? 'bad-credential' : 'bad-path')
      socket.write(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Not Found'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
      socket.destroy()
      throw null // 已处理:别再交给 WebSocket 层
    },

    async onAuthenticate({ documentName, requestHeaders }) {
      try {
        const offered = offeredProtocols(header(requestHeaders, 'sec-websocket-protocol'))
        const identity = await verify(bearerFromProtocols(offered))
        const ref = parseDocName(documentName)
        if (!ref) throw new Denied('not-found')
        // 子协议带 `as.<agentId>` 就是代这个 agent 打开:判据和 HTTP 的 X-Gugu-As-Agent 同一处,之后这条连接的
        // actor(presence 的章、self、被移出群时断开)都是这个 agent。
        const grant = await authorizeItem(pool, ref.itemId, identity.userId, asAgentFromProtocols(offered), identity.sessionId)
        if (grant.kind !== 'document') throw new Denied('not-a-document', 409)
        if (grant.epoch !== ref.epoch) throw new Denied(`stale-epoch:${grant.epoch}`, 409)
        return {
          userId: identity.userId, sessionId: identity.sessionId,
          teamSessionRequired: grant.teamSessionRequired, authExpiresAt: identity.exp * 1000,
          actorId: grant.actorId,
          actorName: grant.actorName,
          color: colorFor(grant.actorId),
          chatId: grant.chatId,
          itemId: ref.itemId,
        }
      } catch (error) {
        const reason = error instanceof Denied ? error.reason : 'unavailable'
        if (!(error instanceof Denied)) log.error('authenticate failed', { documentName, ...errorFields(error) })
        reject(reason)
        throw Object.assign(new Error(reason), { reason })
      }
    },

    async onLoadDocument({ documentName, document }) {
      const ref = parseDocName(documentName)
      if (!ref) throw new Denied('not-found')
      await withItemLock(ref.itemId, async () => {
        const { row, state, built } = await pinFromText(ref.itemId)
        if (row.epoch !== ref.epoch) throw new Denied(`stale-epoch:${row.epoch}`, 409)
        const text = row.inline_text ?? ''
        const textBytes = Buffer.byteLength(text)
        if (textBytes > maxBytes) {
          log.warn('file over the size limit; refusing to open', { itemId: ref.itemId, textBytes, limit: maxBytes })
          throw new Denied('too-large', 413)
        }
        try {
          Y.applyUpdate(document, state)
        } catch (error) {
          log.error('stored ystate does not decode; refusing to open', { itemId: ref.itemId, ...errorFields(error) })
          throw new Denied('corrupt-state', 500)
        }
        const readable = openFiles.attach(document, documentName, {
          itemId: ref.itemId,
          epoch: ref.epoch,
          chatId: row.chat_id,
          contentType: row.content_type,
          deleted: false,
          updatedBy: null,
        })
        // Capture the authenticated actor synchronously with the actual content transaction, not
        // the later debounced store. Passive sync and changes to Yjs structure alone do not count.
        let lastText = readable
        document.on('afterTransaction', (transaction) => {
          const text = readText(document, row.content_type)
          if (text === lastText) return
          lastText = text
          const origin = contentOriginOf(transaction.origin)
          const context = isTransactionOrigin(origin)
            ? origin.source === 'connection' ? origin.connection.context : origin.source === 'local' ? origin.context : null
            : null
          const info = docs.get(documentName)
          if (info) info.updatedBy = context?.actorId ?? null
        })
        // 加载时核对:ystate 算出来的和库里的正文对不上 = 有人绕过文件服务写了正文。记下来,❌ 静默吞掉。
        if (!built && !sameContent(row.content_type, readable, text)) {
          stats.loadMismatch++
          log.error('ystate and inline_text disagree at load (written around the file service?)', {
            itemId: ref.itemId,
            epoch: ref.epoch,
            ystateBytes: state.length,
            textBytes,
            readableBytes: Buffer.byteLength(readable),
          })
        }
        stats.loads++
      })
    },

    // 限速与上限、presence 盖章、self、改动标记:共用包里的那一份。
    ...openFiles.hooks,

    // 一笔内容改动落地之前:换了人、或停够了,上一轮记成一版(G2)。
    /** @param {any} data */
    async beforeHandleMessage(data) {
      const actorContext = data.connection?.context
      if (actorContext?.teamSessionRequired) {
        if (Date.now() >= actorContext.authExpiresAt) throw new Denied('bad-credential', 401)
        await authorizeItem(pool, actorContext.itemId, actorContext.userId, actorContext.actorId, actorContext.sessionId)
      }
      await openFiles.hooks.beforeHandleMessage(data)
      const head = readHead(data.update)
      if (!((head.type === 0 || head.type === 4) && head.payloadLength > 0)) return
      const info = docs.get(data.document.name)
      const context = data.connection?.context
      if (info && !info.deleted && context?.actorId && context?.userId) {
        roundBefore(info, context, data.document, data.update.subarray(head.payloadAt, head.payloadAt + head.payloadLength))
      }
    },

    async onStoreDocument({ documentName, document }) {
      const info = docs.get(documentName)
      if (!info || info.deleted || !info.dirty) return
      // 换代中或已换代(F71):这一代的内容已经随新一代写进库,这里不再写。
      if (openFiles.frozen(documentName)) return
      await historyFirst(rounds.settled(info.itemId), 'storing', { itemId: info.itemId })
      if (info.deleted || !info.dirty || openFiles.frozen(documentName)) return
      info.dirty = false
      const snap = openFiles.snapshot(documentName, document)
      const { state, text, bytes } = snap
      const updatedBy = info.updatedBy
      if (bytes > maxBytes) log.warn('storing a file over the size limit', { doc: documentName, bytes, limit: maxBytes })
      try {
        const u = await pool.query(
          'UPDATE chat.workspace_items SET ystate = $1, inline_text = $2, size_bytes = $3, updated_by = $6 WHERE id = $4::uuid AND epoch = $5',
          [Buffer.from(state), text, bytes, info.itemId, info.epoch, updatedBy],
        )
        openFiles.stored(documentName, snap)
        stats.stores++
        stats.storeBytes += state.length
        // 墓碑太多就在开着的时候换代(F71):条件、排空与作废都在共用包里,这里只管写成下一代。
        if (u.rowCount) openFiles.compactWhenDue(documentName, document, { stateBytes: state.length, textBytes: bytes }, (fresh) => persistCompacted(info, fresh))
        if (!u.rowCount) {
          const r = await pool.query('SELECT epoch FROM chat.workspace_items WHERE id = $1::uuid', [info.itemId])
          if (!r.rowCount) markDeleted(info.itemId)
          else {
            stats.storeLost++
            log.error('store lost: epoch moved under a live document', { doc: documentName, current: r.rows[0].epoch })
          }
        }
      } catch (error) {
        info.dirty = true
        stats.storeErrors++
        log.error('store failed; document stays in memory', { doc: documentName, ...errorFields(error) })
        throw error
      }
    },

    async afterUnloadDocument({ documentName }) {
      const info = docs.get(documentName)
      docs.delete(documentName)
      stats.unloads++
      if (!info || info.deleted || info.compacted) return
      await withItemLock(info.itemId, async () => {
        if (itemBusy(info.itemId)) return
        const { rows } = await pool.query(
          'SELECT ystate, inline_text, content_type, epoch FROM chat.workspace_items WHERE id = $1::uuid',
          [info.itemId],
        )
        const row = rows[0]
        if (!row || row.epoch !== info.epoch || !row.ystate) return
        const textBytes = Buffer.byteLength(row.inline_text ?? '')
        if (row.ystate.length <= config.compactRatio * textBytes + config.compactMinBytes) return
        // 从当前的 Yjs 结构重建(内容与字段类型照原样,只丢历史);❌ 从 inline_text 解析 —— JSON 里的协同文本会退化成普通字符串。
        const current = new Y.Doc()
        let built
        try {
          Y.applyUpdate(current, row.ystate)
          built = rebuildDoc(current, row.content_type)
        } catch (error) {
          log.error('compaction skipped: stored ystate does not decode', { itemId: info.itemId, ...errorFields(error) })
          return
        } finally {
          current.destroy()
        }
        const fresh = Y.encodeStateAsUpdate(built)
        built.destroy()
        const u = await pool.query(
          'UPDATE chat.workspace_items SET ystate = $1, epoch = epoch + 1 WHERE id = $2::uuid AND epoch = $3',
          [Buffer.from(fresh), info.itemId, info.epoch],
        )
        if (u.rowCount) {
          stats.compactions++
          log.info('compacted', { itemId: info.itemId, from: row.ystate.length, to: fresh.length, textBytes, epoch: info.epoch + 1 })
        }
      }).catch((error) => log.error('compaction failed', { itemId: info.itemId, ...errorFields(error) }))
    },

    async onRequest({ request, response }) {
      await handleHttp(request, response)
      throw null // 已回应:别再落到 Hocuspocus 的默认页
    },
  })

  // ── HTTP:给 agent 与主进程 ─────────────────────────────────────────────────
  /** @param {http.ServerResponse} res @param {number} status @param {unknown} body */
  function send(res, status, body) {
    if (res.headersSent) return
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  /** @param {http.IncomingMessage} req */
  function readBody(req) {
    return new Promise((resolve, reject) => {
      /** @type {Buffer[]} */
      const chunks = []
      let size = 0
      req.on('data', (/** @type {Buffer} */ c) => {
        size += c.length
        if (size > config.maxBodyBytes) {
          reject(new Denied('too-large', 413))
          req.destroy()
          return
        }
        chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  /** 打开一条直连(HTTP edit 用)。库里的代号在判权与加载之间变了(冷压缩刚做完)就重判一次。 */
  async function openDirect(/** @type {string} */ itemId, /** @type {import('./auth.mjs').Grant} */ grant, /** @type {object} */ context) {
    let g = grant
    for (let attempt = 0; ; attempt++) {
      try {
        return { grant: g, dc: await hp().openDirectConnection(`${itemId}@${g.epoch}`, context) }
      } catch (error) {
        const reason = /** @type {any} */ (error)?.reason
        if (attempt === 0 && typeof reason === 'string' && reason.startsWith('stale-epoch:')) {
          g = { ...g, epoch: Number(reason.slice('stale-epoch:'.length)) }
          continue
        }
        throw error
      }
    }
  }

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  async function handleHttp(req, res) {
    for (const [name, value] of Object.entries(CORS_HEADERS)) res.setHeader(name, value)
    const url = new URL(req.url ?? '/', 'http://files')
    // 对外口没有前缀(nginx 剥掉了 /files/):路径段不是文件 id 的一律 404,不先验令牌 —— /stats、/healthz 在这里不存在。
    const m = /^\/([^/]+)(\/edit|\/replace)?$/.exec(url.pathname)
    if (!m || !isUuid(m[1])) return send(res, 404, { error: 'not-found' })
    // 预检不带凭证(浏览器就是这么发的),只回答「这条路能怎么调」。
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }
    const itemId = m[1].toLowerCase()
    const isEdit = !!m[2]
    if (isEdit ? req.method !== 'POST' : req.method !== 'GET') return send(res, 405, { error: 'method-not-allowed' })
    try {
      const identity = await verify(bearerFromAuthorization(header(req.headers, 'authorization')))
      const asAgent = header(req.headers, 'x-gugu-as-agent')?.trim() || null
      const grant = await authorizeItem(pool, itemId, identity.userId, asAgent, identity.sessionId)
      if (grant.kind !== 'document') throw new Denied('not-a-document', 409)

      if (!isEdit) {
        const live = hp().documents.get(`${itemId}@${grant.epoch}`)
        let text
        if (live) text = readText(live, grant.contentType, { pretty: true })
        else {
          const { rows } = await pool.query('SELECT inline_text FROM chat.workspace_items WHERE id = $1::uuid', [itemId])
          if (!rows[0]) throw new Denied('not-found')
          text = rows[0].inline_text ?? ''
          if (isJson(grant.contentType)) {
            try {
              text = JSON.stringify(withoutMarks(parseJsonObject(text)), null, 2)
            } catch {
              // 库里的 JSON 解析不了就原样给:读不应该因为内容坏了而失败。
            }
          }
        }
        stats.reads++
        return send(res, 200, { epoch: grant.epoch, contentType: grant.contentType, text, live: !!live })
      }

      let body
      try {
        body = JSON.parse(await readBody(req))
      } catch (error) {
        if (error instanceof Denied) throw error
        throw new Denied('bad-request', 400)
      }
      if (m[2] === '/replace') return send(res, 200, await replaceIncoming({ pool, files: openFiles, hp: hp(), itemId, identity, grant, body,
        open: () => openDirect(itemId, grant, { userId: identity.userId, sessionId: identity.sessionId, actorId: grant.actorId, chatId: grant.chatId, itemId, via: 'http' }) }))
      if (typeof body?.old !== 'string' || typeof body?.new !== 'string') throw new Denied('bad-request', 400)
      if (body.old === '') throw new Denied('empty-old', 400)

      let g = grant
      let reauthorize = false
      /** @type {{ status: number, body: Record<string, unknown> }} */
      const result = await onLiveGeneration({
        tries: EDIT_TRIES,
        frozen: (name) => openFiles.frozen(name),
        settled: (name) => openFiles.settled(name),
        open: async () => {
          // After a swap: the grant again, for the generation the database has now.
          if (reauthorize) g = await authorizeItem(pool, itemId, identity.userId, asAgent, identity.sessionId)
          reauthorize = true
          const opened = await openDirect(itemId, g, {
            userId: identity.userId, sessionId: identity.sessionId,
            actorId: g.actorId,
            chatId: g.chatId,
            itemId,
            via: 'http',
          }).catch((error) => {
            const reason = /** @type {any} */ (error)?.reason
            if (error instanceof Denied) throw error
            if (reason === 'invalid-json') throw new Denied('invalid-json', 422)
            if (reason === 'not-found') throw new Denied('not-found')
            if (reason === 'too-large') throw new Denied('too-large', 413)
            throw error
          })
          g = opened.grant
          const dc = opened.dc
          return {
            name: `${itemId}@${g.epoch}`,
            // DirectConnection 的 transact 是同步改文档的:判断「没在换代」和改之间没有空隙。
            write: async () => {
              /** @type {{ status: number, body: Record<string, unknown> }} */
              let edited = { status: 500, body: { error: 'internal' } }
              const info = docs.get(`${itemId}@${g.epoch}`)
              const live = hp().documents.get(`${itemId}@${g.epoch}`)
              if (info && live) roundBefore(info, { actorId: g.actorId, userId: identity.userId }, live)
              await dc.transact((doc) => {
                edited = applyEdit(doc, g.contentType, body.old, body.new, maxBytes)
              })
              return edited
            },
            close: () => dc.disconnect(),
          }
        },
      })
      if (result.status === 200) stats.edits.ok++
      else stats.edits.rejected++
      return send(res, result.status, result.status === 200 ? { ...result.body, epoch: g.epoch } : result.body)
    } catch (error) {
      if (error instanceof Denied) {
        reject(error.reason)
        return send(res, error.status, { error: error.reason })
      }
      log.error('http request failed', { path: url.pathname, method: req.method, ...errorFields(error) })
      return send(res, 500, { error: 'internal' })
    }
  }

  // ── 内部口 ──────────────────────────────────────────────────────────────────
  const admin = http.createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0]
    if (req.method !== 'GET') return send(res, 405, { error: 'method-not-allowed' })
    if (path === '/healthz') {
      let db = false
      try {
        await pool.query('SELECT 1')
        db = true
      } catch {}
      const ok = db && listener.up
      return send(res, ok ? 200 : 503, { ok, db, listener: listener.up })
    }
    if (path === '/stats') {
      const h = hp()
      return send(res, 200, {
        ...stats,
        documents: h.getDocumentsCount(),
        connections: h.getConnectionsCount(),
        rounds: rounds.size(),
        listener: listener.up,
        memory: process.memoryUsage(),
        cpu: process.cpuUsage(),
        now: new Date().toISOString(),
      })
    }
    return send(res, 404, { error: 'not-found' })
  })

  /** @type {NodeJS.Timeout | null} */
  let recheckTimer = null

  return {
    stats,
    pool,
    get hocuspocus() {
      return hp()
    },
    async listen() {
      await connectListener()
      await server.listen()
      await new Promise((resolve, reject) => {
        admin.once('error', reject)
        admin.listen(config.adminPort, config.adminHost, () => resolve(undefined))
      })
      // 通知是主路;每分钟再全量核一遍兜底(断线重连时也会立即核)。
      recheckTimer = setInterval(() => {
        if (listener.up) recheckAll().catch((error) => log.error('periodic recheck failed', errorFields(error)))
      }, 60_000)
      recheckTimer.unref()
      const port = server.address.port
      const adminAddress = admin.address()
      const adminPort = typeof adminAddress === 'object' && adminAddress ? adminAddress.port : config.adminPort
      log.info('files listening', { host: config.host, port, adminPort, timeoutMs: config.timeoutMs, maxFileBytes: maxBytes })
      return { port, adminPort }
    },
    /** 先关连接、把没存的存完(Hocuspocus destroy 会 flush),再关 LISTEN 与连接池。 */
    async close() {
      if (recheckTimer) clearInterval(recheckTimer)
      listener.stopped = true
      if (listener.timer) clearTimeout(listener.timer)
      await server.destroy()
      // 正常停服:内存里还没结束的轮当场记下(存盘已落,read 读得到),作者不丢;写完再关连接池。写不进去也不挂住停服。
      await historyFirst(rounds.flush(), 'closing', {})
      await new Promise((resolve) => admin.close(() => resolve(undefined)))
      await listener.client?.end().catch(() => undefined)
      if (!givenPool) await pool.end()
    },
  }
}
