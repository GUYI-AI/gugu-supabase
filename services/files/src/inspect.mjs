// 附件字节的检查(内部口 POST /inspect):attachments 函数签好一条读暂存对象的请求交过来,这里流式读完,
// 算 sha256、数字节、留前缀,回给它。为什么在这里:edge worker 每个请求只有 2 s CPU,256 MiB 的 sha256 一项就超了;
// 这个常驻进程没有那道限额。这里不持有任何存储凭据 —— 能读哪个对象,由调用方签的那条请求决定。

import { createHash, timingSafeEqual } from 'node:crypto'
import { Denied, bearerFromAuthorization } from './auth.mjs'

/** 等长才比内容;比较时间不随第一个不同的位置变。 */
export function sameSecret(/** @type {string | null} */ offered, /** @type {string} */ secret) {
  if (!offered) return false
  const a = Buffer.from(offered), b = Buffer.from(secret)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * @param {unknown} body
 * @returns {{ url: string, headers: Record<string, string>, limit: number, retain: number }}
 */
function requestOf(body) {
  const b = /** @type {any} */ (body)
  const url = b?.source?.url, headers = b?.source?.headers ?? {}, limit = b?.limit, retain = b?.retain
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new Denied('bad-request', 400)
  if (typeof headers !== 'object' || Array.isArray(headers) || Object.values(headers).some((v) => typeof v !== 'string')) {
    throw new Denied('bad-request', 400)
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(retain) || retain < 1) throw new Denied('bad-request', 400)
  return { url, headers, limit, retain }
}

/**
 * 读完 source,超过 limit 一个字节就停。前缀最多 min(limit, retain) 字节。
 * @param {unknown} body
 * @param {{ fetch?: typeof fetch, timeoutMs?: number }} [options]
 */
export async function inspectSource(body, { fetch: fetchFn = fetch, timeoutMs = 300_000 } = {}) {
  const { url, headers, limit, retain } = requestOf(body)
  const res = await fetchFn(url, { headers: { ...headers, 'Accept-Encoding': 'identity' }, signal: AbortSignal.timeout(timeoutMs) })
  const etag = res.headers.get('etag')
  if (!res.ok || !res.body) {
    await res.body?.cancel()
    throw new Denied(res.status === 404 ? 'source-missing' : 'source-unreadable', res.status === 404 ? 404 : 502)
  }
  if (!etag) {
    await res.body.cancel()
    throw new Denied('source-unreadable', 502)
  }
  const declared = Number(res.headers.get('content-length'))
  if (declared > limit) {
    await res.body.cancel()
    throw new Denied('too-large', 413)
  }
  const hash = createHash('sha256')
  const prefix = Buffer.alloc(Math.min(limit, retain))
  let sizeBytes = 0
  for await (const chunk of res.body) {
    if (sizeBytes + chunk.byteLength > limit) throw new Denied('too-large', 413)
    if (sizeBytes < prefix.length) prefix.set(chunk.subarray(0, prefix.length - sizeBytes), sizeBytes)
    sizeBytes += chunk.byteLength
    hash.update(chunk)
  }
  return { sizeBytes, sha256: hash.digest('hex'), etag, prefix: prefix.subarray(0, Math.min(sizeBytes, prefix.length)) }
}
