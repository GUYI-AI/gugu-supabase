// 鉴权:谁(验 JWT)+ 能不能进这个文件(chat.files_authorize)。
//
// 凭证从哪来(真源 §2.2):
//   · WebSocket:子协议。客户端提供 ['gugu-files.v1', 'bearer.<JWT>'],服务端取 bearer. 那一项验签,回应 gugu-files.v1。
//     浏览器与 WebView 的 WebSocket 设不了 Authorization 头;query 参数会进访问日志 —— ❌ 接受。
//   · HTTP(/files):Authorization: Bearer <JWT>;agent 另带 X-Gugu-As-Agent: <agentId>。
// 判据只有一处:库里的 chat.files_authorize(资格走 chat.is_acting_as,可见域同 workspace_item_for)。
// 不是成员与不存在一律 not-found,不泄露条目存不存在。

import * as jose from 'jose'

export const SUBPROTOCOL = 'gugu-files.v1'
const BEARER_PREFIX = 'bearer.'
const AS_PREFIX = 'as.'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const isUuid = (/** @type {unknown} */ value) => typeof value === 'string' && UUID.test(value)

/** 拒绝:reason 原样给客户端(WebSocket 的认证失败原因 / HTTP 的 error 字段),status 给 HTTP。 */
export class Denied extends Error {
  /** @param {string} reason @param {number} [status] */
  constructor(reason, status = 404) {
    super(reason)
    this.reason = reason
    this.status = status
  }
}

/** @param {string | null | undefined} header Sec-WebSocket-Protocol 的原值 */
export function offeredProtocols(header) {
  if (!header) return []
  return header.split(',').map((p) => p.trim()).filter(Boolean)
}

/**
 * 从子协议里取令牌。必须同时提供 gugu-files.v1:否则我们回应不了一个客户端认得的子协议,浏览器会直接断开。
 * @param {string[]} offered
 */
export function bearerFromProtocols(offered) {
  if (!offered.includes(SUBPROTOCOL)) return null
  const entry = offered.find((p) => p.startsWith(BEARER_PREFIX))
  return entry ? entry.slice(BEARER_PREFIX.length) : null
}

/**
 * 以哪个 agent 的身份:子协议 `as.<agentId>`,没有就是令牌主人本人。和 HTTP 的 `X-Gugu-As-Agent` 同一个判据,
 * 交给 authorizeItem(不是合法 id、不是自己的 agent、agent 不在群里,一律 not-found)。
 * 一条连接只有一个身份:给了两个、或者给了空的,都拒。
 * @param {string[]} offered @returns {string | null}
 */
export function asAgentFromProtocols(offered) {
  const entries = offered.filter((p) => p.startsWith(AS_PREFIX))
  if (entries.length === 0) return null
  const id = entries[0].slice(AS_PREFIX.length)
  if (entries.length > 1 || !id) throw new Denied('not-found')
  return id
}

/** @param {string | null | undefined} header */
export function bearerFromAuthorization(header) {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '')
  return m ? m[1] : null
}

/**
 * @typedef {{ userId: string, exp: number, sessionId: string | null }} Identity
 * @param {{ jwksUrl: string | null, jwtSecret: Uint8Array | null, jwtIssuer: string | null }} options
 * @returns {(token: string | null) => Promise<Identity>}
 */
export function createVerifier({ jwksUrl, jwtSecret, jwtIssuer }) {
  const jwks = jwksUrl ? jose.createRemoteJWKSet(new URL(jwksUrl), { cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 }) : null
  const common = { issuer: jwtIssuer ?? undefined, requiredClaims: ['sub', 'exp'] }
  return async (token) => {
    if (!token) throw new Denied('bad-credential', 401)
    /** @type {jose.JWTPayload} */
    let payload
    try {
      const { alg } = jose.decodeProtectedHeader(token)
      if (alg === 'HS256') {
        if (!jwtSecret) throw new Error('HS256 not configured')
        ;({ payload } = await jose.jwtVerify(token, jwtSecret, { ...common, algorithms: ['HS256'] }))
      } else {
        if (!jwks) throw new Error('JWKS not configured')
        ;({ payload } = await jose.jwtVerify(token, jwks, { ...common, algorithms: ['ES256', 'RS256', 'EdDSA'] }))
      }
    } catch {
      throw new Denied('bad-credential', 401)
    }
    if (payload.role !== 'authenticated' || !isUuid(payload.sub)) throw new Denied('bad-credential', 401)
    return { userId: /** @type {string} */ (payload.sub), exp: /** @type {number} */ (payload.exp),
      sessionId: isUuid(payload.session_id) ? /** @type {string} */ (payload.session_id) : null }
  }
}

/**
 * @typedef {object} Grant
 * @property {string} chatId
 * @property {number} epoch
 * @property {string} contentType
 * @property {string} kind
 * @property {string} actorId   本人,或以其身份行事的 agent
 * @property {string} actorName
 * @property {boolean} teamSessionRequired
 */

/**
 * @param {import('pg').Pool} pool
 * @param {string} itemId
 * @param {string} userId  验过的 JWT sub
 * @param {string | null} asAgent
 * @param {string | null} [sessionId] The verified JWT session, never a request-body value.
 * @returns {Promise<Grant>}
 */
export async function authorizeItem(pool, itemId, userId, asAgent, sessionId = null) {
  if (!isUuid(itemId)) throw new Denied('not-found')
  if (asAgent !== null && !isUuid(asAgent)) throw new Denied('not-found')
  const { rows } = await pool.query('SELECT * FROM chat.files_authorize($1::uuid, $2, $3, $4)', [itemId, userId, asAgent, sessionId])
  const row = rows[0]
  if (!row) throw new Denied('not-found')
  return {
    chatId: row.chat_id,
    epoch: row.epoch,
    contentType: row.content_type,
    kind: row.kind,
    actorId: row.actor_id,
    actorName: row.actor_name ?? '',
    teamSessionRequired: row.team_session_required === true,
  }
}
