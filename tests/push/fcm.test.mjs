import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer, request } from 'node:http'
import { generateKeyPairSync, verify } from 'node:crypto'
import { once } from 'node:events'
import { notificationRequest, providerResult, createFcmProvider } from '../../services/push/src/providers/fcm.mjs'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const serviceAccount = { project_id: 'gugu-fixture', client_email: 'fixture@gugu-fixture.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }
const id = '11111111-1111-4111-8111-111111111111'
const endpoint = { provider: 'fcm', environment: 'production', topic: 'app.gugu.chat.beta',
  token: 'PRIVATE_TOKEN_CANARY:token', sound: true, gugu: { v: 1, kind: 'chat_message',
    notificationId: id, ownerId: id, installationId: id, registrationId: id, generation: id,
    revision: '12', chatId: 'chat-fixture', messageId: 'message-fixture', body: 'PRIVATE_MESSAGE_CANARY', fileUrl: 'PRIVATE_FILE_CANARY' } }

async function loopback(run, { status = 200, body = { name: 'projects/gugu-fixture/messages/fixture' }, authStatus = 200, disconnect = false, hang = false } = {}) {
  const received = []
  const server = createServer(async (req, res) => {
    let text = ''; for await (const part of req) text += part
    received.push({ url: req.url, body: text, authorization: req.headers.authorization })
    if (req.url === '/token') {
      res.writeHead(authStatus); res.end(JSON.stringify({ access_token: 'PRIVATE_OAUTH_CANARY', token_type: 'Bearer', expires_in: 3600 })); return
    }
    if (disconnect) { req.socket.destroy(); return }
    if (hang) return
    res.writeHead(status); res.end(JSON.stringify(body))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const provider = createFcmProvider({ serviceAccount }, { timeoutMs: 1000,
    open: (url, options, callback) => request(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}`, options, callback) })
  try { await run(provider, received) } finally { provider.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
}

test('sends visible generic notification with exact package, channel, tap data; excludes private source fields', () => {
  const body = notificationRequest(endpoint); const value = JSON.parse(body).message
  assert.equal(value.android.restricted_package_name, 'app.gugu.chat.beta')
  assert.equal(value.android.notification.channel_id, 'gugu-alerts')
  assert.equal(value.android.notification.click_action, 'app.gugu.chat.OPEN_PUSH')
  assert.equal(value.notification.body, '有一条新消息需要你查看')
  assert.equal(value.data.v, '1'); assert.equal(value.data.chatId, 'chat-fixture')
  assert.doesNotMatch(body, /PRIVATE_MESSAGE|PRIVATE_FILE|content_available/)
  const quiet = JSON.parse(notificationRequest({ ...endpoint, sound: false })).message
  assert.equal(quiet.android.notification.channel_id, 'gugu-alerts-quiet-v2')
  assert.equal(quiet.android.notification.sound, undefined)
  for (const input of [{ ...endpoint, topic: 'other.package' }, { ...endpoint, environment: 'sandbox' },
    { ...endpoint, provider: 'apns' }, { ...endpoint, token: 'with space' }]) assert.throws(() => notificationRequest(input))
})
test('loopback validates signed OAuth JWT, HTTP v1 authorization, acceptance ID and cached token', async () => {
  await loopback(async (provider, received) => {
    for (let i = 0; i < 2; i++) assert.deepEqual(await provider.send(endpoint), {
      outcome: 'accepted', invalidBefore: null, providerMessageId: 'projects/gugu-fixture/messages/fixture' })
    assert.equal(received.length, 3)
    const jwt = new URLSearchParams(received[0].body).get('assertion').split('.')
    assert.equal(verify('RSA-SHA256', Buffer.from(jwt.slice(0, 2).join('.')), publicKey, Buffer.from(jwt[2], 'base64url')), true)
    assert.equal(JSON.parse(Buffer.from(jwt[1], 'base64url')).aud, 'https://oauth2.googleapis.com/token')
    assert.equal(JSON.parse(Buffer.from(jwt[1], 'base64url')).scope, 'https://www.googleapis.com/auth/firebase.messaging')
    assert.equal(received[1].url, '/v1/projects/gugu-fixture/messages:send')
    assert.equal(received[1].authorization, 'Bearer PRIVATE_OAUTH_CANARY')
  })
})
for (const status of [400, 401, 403, 429, 503]) test(`loopback refusal ${status} is terminal, preserves registration and never retries`, async () => {
  await loopback(async (provider, received) => {
    assert.deepEqual(await provider.send(endpoint), { outcome: 'rejected', invalidBefore: null })
    assert.equal(received.length, 2)
  }, { status, body: { error: { status: 'INVALID_ARGUMENT' } } })
})
test('only confirmed UNREGISTERED fences invalid-token cleanup at request start', async () => {
  const body = { error: { details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } }
  await loopback(async provider => {
    const start = Date.now(); const result = await provider.send(endpoint)
    assert.equal(result.outcome, 'rejected'); assert.ok(Date.parse(result.invalidBefore) >= start)
  }, { status: 404, body })
  assert.equal(providerResult(404, JSON.stringify({ error: {} }), Date.now()).invalidBefore, null)
})
for (const options of [{ disconnect: true }, { hang: true }]) test(`uncertain loopback transport does not replay ${JSON.stringify(options)}`, async () => {
  await loopback(async (provider, received) => {
    assert.deepEqual(await provider.send(endpoint), { outcome: 'unknown', invalidBefore: null })
    assert.equal(received.length, 2)
  }, options)
})
test('OAuth refusal sends no notification and cannot invalidate the device token', async () => {
  await loopback(async (provider, received) => {
    assert.deepEqual(await provider.send(endpoint), { outcome: 'rejected', invalidBefore: null }); assert.equal(received.length, 1)
  }, { authStatus: 401 })
})
test('malformed success and response overflow remain uncertain', async () => {
  assert.equal(providerResult(200, '{}', Date.now()).outcome, 'unknown')
  await loopback(async provider => assert.equal((await provider.send(endpoint)).outcome, 'unknown'), { body: { name: 'x'.repeat(17000) } })
})
