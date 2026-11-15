// 文件服务的配置:全部来自环境变量。凭据(库连接串、HS256 密钥)只认 *_FILE —— 值住在库机上 0600 的文件里,
// 不进环境、不进 compose、不进部署日志。

import fs from 'node:fs'

/**
 * @typedef {object} FilesConfig
 * @property {string} host              对外口(/files 与 WebSocket)绑定的地址
 * @property {number} port
 * @property {string} adminHost         内部口(/healthz、/stats)—— ❌ 经 nginx 暴露
 * @property {number} adminPort
 * @property {string} dbUrl             gugu_files 的连接串
 * @property {number} dbPoolMax
 * @property {string | null} jwksUrl    GoTrue 的 JWKS(非对称令牌)
 * @property {Uint8Array | null} jwtSecret HS256 密钥(可缺)
 * @property {string | null} jwtIssuer  给了就核 iss
 * @property {string | null} inspectSecret 内部口 POST /inspect 的服务间密钥(attachments 函数持有同一个);没给 ⇒ /inspect 回 503
 * @property {number} timeoutMs         连接心跳超时
 * @property {number} debounceMs
 * @property {number} maxDebounceMs
 * @property {number} maxFileBytes      文本 / JSON 文件的上限(可读内容的 UTF-8 字节)
 * @property {number} maxFrameBytes     单个 WebSocket 帧
 * @property {number} maxBodyBytes      HTTP 请求体
 * @property {{ perSecond: number, burst: number }} rateUpdates   每个连接:文档消息条数
 * @property {{ perSecond: number, burst: number }} rateBytes     每个连接:文档消息字节
 * @property {{ perSecond: number, burst: number }} rateAwareness 每个连接:presence 条数
 * @property {number} compactRatio      ystate > ratio × 正文 + compactMinBytes 时冷压缩
 * @property {number} compactMinBytes
 * @property {number} hotCompactRatio      文件开着时:ystate > max(ratio × 正文, hotCompactMinBytes) 时热压缩(F71)
 * @property {number} hotCompactMinBytes
 * @property {number} hotCompactCooldownMs 同一个文件两次热压缩尝试之间至少隔多久
 * @property {number} compactDrainMs       热压缩等所有连接排空最多多久,超时作废这一轮
 * @property {number} roundIdleMs          一轮改动:谁都停了这么久就切,上一轮记一版历史(G2);内存里只留这么久之内改过的文件
 * @property {number} storeWaitsHistoryMs  存盘之前最多等这个文件排着的历史写完多久;等不到就照存(G2)
 * @property {'debug' | 'info' | 'warn' | 'error'} logLevel
 */

const MiB = 1024 * 1024

/** @param {NodeJS.ProcessEnv} env @returns {FilesConfig} */
export function loadConfig(env = process.env) {
  const int = (name, fallback) => {
    const raw = env[name]
    if (raw === undefined || raw === '') return fallback
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 0) throw new Error(`${name} 必须是非负整数: ${raw}`)
    return n
  }
  const secretFile = (name) => {
    const file = env[name]
    if (!file) return null
    const value = fs.readFileSync(file, 'utf8').trim()
    if (!value) throw new Error(`${name} 指向的文件是空的: ${file}`)
    return value
  }

  const dbUrl = secretFile('FILES_DB_URL_FILE') ?? env.FILES_DB_URL ?? ''
  if (!dbUrl) throw new Error('需要 FILES_DB_URL_FILE(gugu_files 的连接串文件)')
  const jwksUrl = env.FILES_JWKS_URL || null
  const hs = secretFile('FILES_JWT_SECRET_FILE')
  if (!jwksUrl && !hs) throw new Error('需要 FILES_JWKS_URL 或 FILES_JWT_SECRET_FILE 之一:没有验签手段就没有鉴权')

  const logLevel = /** @type {FilesConfig['logLevel']} */ (env.FILES_LOG_LEVEL || 'info')
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) throw new Error(`FILES_LOG_LEVEL 不认识: ${logLevel}`)

  return {
    host: env.FILES_HOST || '127.0.0.1',
    port: int('FILES_PORT', 18320),
    adminHost: env.FILES_ADMIN_HOST || '127.0.0.1',
    adminPort: int('FILES_ADMIN_PORT', 18321),
    dbUrl,
    dbPoolMax: int('FILES_DB_POOL_MAX', 8),
    jwksUrl,
    jwtSecret: hs ? new TextEncoder().encode(hs) : null,
    jwtIssuer: env.FILES_JWT_ISSUER || null,
    inspectSecret: secretFile('FILES_INSPECT_SECRET_FILE'),
    timeoutMs: int('FILES_TIMEOUT_MS', 30_000),
    debounceMs: int('FILES_DEBOUNCE_MS', 1_000),
    maxDebounceMs: int('FILES_MAX_DEBOUNCE_MS', 5_000),
    maxFileBytes: int('FILES_MAX_FILE_BYTES', MiB),
    maxFrameBytes: int('FILES_MAX_FRAME_BYTES', 16 * MiB),
    maxBodyBytes: int('FILES_MAX_BODY_BYTES', 4 * MiB),
    rateUpdates: { perSecond: int('FILES_RATE_UPDATES_PER_SEC', 50), burst: int('FILES_RATE_UPDATES_BURST', 500) },
    // 突发要装得下一次重连同步(整份状态;冷压缩保证它 ≤ 4 × 上限 + 4 KB)。
    rateBytes: { perSecond: int('FILES_RATE_BYTES_PER_SEC', 256 * 1024), burst: int('FILES_RATE_BYTES_BURST', 8 * MiB) },
    rateAwareness: { perSecond: int('FILES_RATE_AWARENESS_PER_SEC', 30), burst: int('FILES_RATE_AWARENESS_BURST', 90) },
    compactRatio: int('FILES_COMPACT_RATIO', 4),
    compactMinBytes: int('FILES_COMPACT_MIN_BYTES', 4096),
    // 热压缩的阈值比冷压缩宽得多:正常编辑的人不该碰到(换代会断开编辑器的撤销历史),只收拾一直整段改写的 App。
    hotCompactRatio: int('FILES_HOT_COMPACT_RATIO', 8),
    hotCompactMinBytes: int('FILES_HOT_COMPACT_MIN_BYTES', 256 * 1024),
    hotCompactCooldownMs: int('FILES_HOT_COMPACT_COOLDOWN_MS', 60_000),
    compactDrainMs: int('FILES_COMPACT_DRAIN_MS', 1000),
    roundIdleMs: int('FILES_ROUND_IDLE_MS', 30_000),
    storeWaitsHistoryMs: int('FILES_STORE_WAITS_HISTORY_MS', 5_000),
    logLevel,
  }
}
