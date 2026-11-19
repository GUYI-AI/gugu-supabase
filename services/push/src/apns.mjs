import { connect, sensitiveHeaders } from 'node:http2'
import { createPrivateKey, sign } from 'node:crypto'

const origins = { sandbox: 'https://api.sandbox.push.apple.com', production: 'https://api.push.apple.com' }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function notificationRequest(endpoint) {
  const g = endpoint.gugu
  if (!origins[endpoint.environment] || endpoint.topic !== 'app.gugu.chat'
    || typeof endpoint.token !== 'string' || !/^([0-9a-f]{2})+$/.test(endpoint.token) || endpoint.token.length > 4096
    || !g || g.v !== 1 || !['chat_message', 'task_attention'].includes(g.kind)
    || ![g.notificationId, g.ownerId, g.installationId, g.registrationId, g.generation].every(x => uuid.test(x))
    || typeof g.revision !== 'string' || !/^[1-9][0-9]*$/.test(g.revision) || typeof endpoint.sound !== 'boolean') {
    throw new Error('Invalid APNs binding')
  }
  // Allow only the agreed correlation fields. No upstream object spread on wire.
  const correlation = { v: 1, notificationId: g.notificationId, ownerId: g.ownerId,
    installationId: g.installationId, registrationId: g.registrationId, generation: g.generation,
    kind: g.kind, revision: g.revision }
  for (const field of ['chatId', 'messageId', 'agentId']) {
    if (g[field] !== undefined && (typeof g[field] !== 'string' || g[field].length === 0 || g[field].length > 256)) {
      throw new Error('Invalid APNs correlation')
    }
    if (g[field] !== undefined) correlation[field] = g[field]
  }
  const body = JSON.stringify({ aps: { alert: { title: '咕咕',
    body: g.kind === 'chat_message' ? '有一条新消息需要你查看' : '有任务等待你处理' },
    ...(endpoint.sound ? { sound: 'default' } : {}) }, gugu: correlation })
  if (Buffer.byteLength(body) > 4096) throw new Error('APNs payload exceeds limit')
  return { origin: origins[endpoint.environment], body, headers: {
    ':method': 'POST', ':path': `/3/device/${endpoint.token}`, 'apns-topic': endpoint.topic,
    'apns-push-type': 'alert', 'apns-priority': '10', 'apns-expiration': '0',
    'apns-id': g.notificationId, 'apns-collapse-id': g.notificationId,
    'content-type': 'application/json',
  } }
}

export function providerResult(status, body, startedAt) {
  if (status === 200) return { outcome: 'accepted', invalidBefore: null }
  let response
  try { response = JSON.parse(body) } catch { return { outcome: 'unknown', invalidBefore: null } }
  if (!response || typeof response !== 'object' || Array.isArray(response)) return { outcome: 'unknown', invalidBefore: null }
  let invalidBefore = null
  if (status === 410 && response.reason === 'Unregistered' && Number.isSafeInteger(response.timestamp)
    && response.timestamp > 0 && response.timestamp <= startedAt) invalidBefore = new Date(response.timestamp).toISOString()
  if (status === 400 && ['BadDeviceToken', 'DeviceTokenNotForTopic'].includes(response.reason)) {
    invalidBefore = new Date(startedAt).toISOString()
  }
  // Explicit refusal is terminal too. No retries for uncertain transport outcomes.
  return { outcome: Number.isInteger(status) && status >= 400 && status <= 599 ? 'rejected' : 'unknown', invalidBefore }
}

export function createApnsProvider({ environment, topic, teamId, keyId, privateKey },
  { open = connect, now = Date.now, timeoutMs = 8000 } = {}) {
  if (!origins[environment] || topic !== 'app.gugu.chat'
    || !/^[A-Z0-9]{1,64}$/.test(teamId) || !/^[A-Z0-9]{1,64}$/.test(keyId)
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw new Error('Invalid APNs configuration')
  const key = createPrivateKey(privateKey)
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('APNs requires an ES256 key')
  }
  let client = null
  let issuedAt = -Infinity
  let authorization
  function bearer() {
    const seconds = Math.floor(now() / 1000)
    if (seconds < issuedAt || seconds - issuedAt >= 2400) {
      const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: keyId })).toString('base64url')
      const claims = Buffer.from(JSON.stringify({ iss: teamId, iat: seconds })).toString('base64url')
      const input = `${header}.${claims}`
      authorization = `bearer ${input}.${sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
      issuedAt = seconds
    }
    return authorization
  }
  return {
    async send(endpoint) {
      if (endpoint.environment !== environment || endpoint.topic !== topic) throw new Error('APNs environment binding mismatch')
      const request = notificationRequest(endpoint)
      const startedAt = now()
      if (!client || client.closed || client.destroyed) {
        const connection = open(request.origin)
        client = connection
        connection.on('error', () => { /* Request handlers classify failures without logging tokens. */ })
        connection.on('goaway', () => connection.close())
      }
      return new Promise(resolve => {
        let stream
        let finished = false
        let status = 0
        let body = ''
        const done = (result) => {
          if (finished) return
          finished = true
          clearTimeout(timer)
          resolve(result)
        }
        const timer = setTimeout(() => {
          done({ outcome: 'unknown', invalidBefore: null })
          stream?.close()
          client?.destroy()
        }, timeoutMs)
        try {
          stream = client.request({ ...request.headers, authorization: bearer(),
            [sensitiveHeaders]: [':path', 'authorization'] })
          stream.on('response', headers => { status = Number(headers[':status']) })
          stream.setEncoding('utf8')
          stream.on('data', chunk => {
            body += chunk
            if (Buffer.byteLength(body) > 8192) { done({ outcome: 'unknown', invalidBefore: null }); stream.close() }
          })
          stream.on('end', () => done(providerResult(status, body, startedAt)))
          stream.on('error', () => done({ outcome: 'unknown', invalidBefore: null }))
          stream.on('close', () => done({ outcome: 'unknown', invalidBefore: null }))
          stream.end(request.body)
        } catch {
          done({ outcome: 'unknown', invalidBefore: null })
        }
      })
    },
    close() { client?.destroy() },
  }
}
