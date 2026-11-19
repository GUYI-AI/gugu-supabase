import { request as httpsRequest } from 'node:https'
import { createPrivateKey, sign } from 'node:crypto'

const oauthURL = 'https://oauth2.googleapis.com/token'
const scope = 'https://www.googleapis.com/auth/firebase.messaging'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const unknown = () => ({ outcome: 'unknown', invalidBefore: null })

export function notificationRequest(endpoint) {
  const g = endpoint.gugu
  if (endpoint.provider !== 'fcm' || endpoint.environment !== 'production'
    || !['app.gugu.chat', 'app.gugu.chat.beta'].includes(endpoint.topic)
    || typeof endpoint.token !== 'string' || !/^[!-~]{1,4096}$/.test(endpoint.token)
    || typeof endpoint.sound !== 'boolean' || g?.v !== 1
    || !['chat_message', 'task_attention'].includes(g.kind)
    || ![g.notificationId, g.ownerId, g.installationId, g.registrationId, g.generation].every(x => typeof x === 'string' && uuid.test(x))
    || typeof g.revision !== 'string' || !/^[1-9][0-9]*$/.test(g.revision)) throw new Error('Invalid FCM binding')
  const correlation = { v: '1', notificationId: g.notificationId, ownerId: g.ownerId,
    installationId: g.installationId, registrationId: g.registrationId,
    generation: g.generation, kind: g.kind, revision: g.revision }
  for (const field of ['chatId', 'messageId', 'agentId']) {
    if (g[field] !== undefined) {
      if (typeof g[field] !== 'string' || !g[field].length || g[field].length > 256) throw new Error('Invalid FCM correlation')
      correlation[field] = g[field]
    }
  }
  // Notification + data: Android displays while the process is dead. Data-only
  // messages cannot provide that guarantee. The SDK does not display in foreground.
  const body = JSON.stringify({ message: { token: endpoint.token, data: correlation,
    notification: { title: '咕咕', body: g.kind === 'chat_message' ? '有一条新消息需要你查看' : '有任务等待你处理' },
    android: { priority: 'HIGH', ttl: '0s', restricted_package_name: endpoint.topic,
      notification: { channel_id: endpoint.sound ? 'gugu-alerts' : 'gugu-alerts-quiet-v2',
        tag: g.notificationId, click_action: 'app.gugu.chat.OPEN_PUSH',
        ...(endpoint.sound ? { sound: 'default' } : {}) } } } })
  if (Buffer.byteLength(body) > 4096) throw new Error('FCM payload exceeds limit')
  return body
}

export function providerResult(status, body, startedAt) {
  let response
  try { response = JSON.parse(body) } catch { return unknown() }
  if (status === 200 && typeof response?.name === 'string'
    && /^projects\/[^/]+\/messages\/[^\s]+$/.test(response.name) && response.name.length <= 512) {
    return { outcome: 'accepted', invalidBefore: null, providerMessageId: response.name }
  }
  if (!Number.isInteger(status) || status < 400 || status > 599 || !response?.error) return unknown()
  // INVALID_ARGUMENT also describes malformed payloads. Only the explicit
  // UNREGISTERED FCM error proves that this registration must be removed.
  const unregistered = status === 404 && Array.isArray(response.error.details)
    && response.error.details.some(detail => detail?.['@type'] === 'type.googleapis.com/google.firebase.fcm.v1.FcmError'
      && detail.errorCode === 'UNREGISTERED')
  return { outcome: 'rejected', invalidBefore: unregistered ? new Date(startedAt).toISOString() : null }
}

export function createFcmProvider({ serviceAccount }, { open = httpsRequest, now = Date.now, timeoutMs = 8000 } = {}) {
  const { project_id: projectId, client_email: email, private_key: privateKey } = serviceAccount ?? {}
  if (typeof projectId !== 'string' || !/^[a-z][a-z0-9-]{4,62}$/.test(projectId)
    || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.gserviceaccount\.com$/.test(email)
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) throw new Error('Invalid FCM configuration')
  const key = createPrivateKey(privateKey)
  if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength < 2048) throw new Error('FCM requires an RSA signing key')
  let accessToken; let expiresAt = 0; let issuedAt = 0
  const pending = new Set()
  function exchange(url, body, authorization, deadline) {
    return new Promise(resolve => {
      let request; let timer; let settled = false
      const done = result => {
        if (settled) return
        settled = true; clearTimeout(timer); pending.delete(request); resolve(result)
      }
      try {
        request = open(url, { method: 'POST', headers: {
          'content-type': authorization ? 'application/json' : 'application/x-www-form-urlencoded',
          'content-length': Buffer.byteLength(body), ...(authorization ? { authorization: `Bearer ${authorization}` } : {}) } }, response => {
          let content = ''
          response.setEncoding('utf8')
          response.on('data', chunk => {
            content += chunk
            if (Buffer.byteLength(content) > 16384) { done(null); response.destroy(); request.destroy() }
          })
          response.on('end', () => done({ status: response.statusCode, body: content }))
          response.on('error', () => done(null))
          response.on('aborted', () => done(null))
        })
        pending.add(request)
        request.on('error', () => done(null))
        request.on('close', () => done(null))
        timer = setTimeout(() => { done(null); request.destroy() }, Math.max(1, deadline - now()))
        request.end(body)
      } catch { done(null) }
    })
  }
  return {
    async send(endpoint) {
      const body = notificationRequest(endpoint)
      const startedAt = now(); const deadline = startedAt + timeoutMs
      if (!accessToken || now() >= expiresAt - 60000 || now() < issuedAt) {
        const seconds = Math.floor(now() / 1000)
        const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
        const claims = Buffer.from(JSON.stringify({ iss: email, scope, aud: oauthURL, iat: seconds, exp: seconds + 3600 })).toString('base64url')
        const input = `${header}.${claims}`
        const assertion = `${input}.${sign('RSA-SHA256', Buffer.from(input), key).toString('base64url')}`
        const result = await exchange(oauthURL, new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(), null, deadline)
        if (!result) return unknown()
        if (result.status !== 200) return { outcome: 'rejected', invalidBefore: null }
        let auth
        try { auth = JSON.parse(result.body) } catch { return unknown() }
        if (typeof auth.access_token !== 'string' || !/^[!-~]{1,8192}$/.test(auth.access_token)
          || auth.token_type?.toLowerCase() !== 'bearer' || !Number.isInteger(auth.expires_in)
          || auth.expires_in < 1 || auth.expires_in > 3600) return unknown()
        accessToken = auth.access_token; issuedAt = startedAt; expiresAt = startedAt + auth.expires_in * 1000
      }
      if (now() >= deadline) return unknown()
      const response = await exchange(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, body, accessToken, deadline)
      if (!response) return unknown()
      if (response.status === 401) { accessToken = undefined; expiresAt = 0 }
      // No same-event retries, including OAuth failure and throttling.
      return providerResult(response.status, response.body, startedAt)
    },
    close() { for (const request of pending) request.destroy(); pending.clear(); accessToken = undefined },
  }
}
