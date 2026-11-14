import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateKeyPairSync, verify } from 'node:crypto'
import { createServer, connect } from 'node:http2'
import { once } from 'node:events'
import { createApnsProvider, notificationRequest, providerResult } from '../../services/push/src/apns.mjs'

const ids = Array.from({ length: 5 }, (_, n) => `00000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`)
const endpoint = () => ({ token: 'ab'.repeat(32), environment: 'production', topic: 'app.gugu.chat', sound: true,
  gugu: { v: 1, notificationId: ids[0], ownerId: ids[1], installationId: ids[2], registrationId: ids[3],
    generation: ids[4], kind: 'chat_message', revision: '9007199254740993', chatId: 'chat-fixture', messageId: 'message-fixture' } })
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const config = { environment: 'production', topic: 'app.gugu.chat', teamId: 'SYNTHETIC', keyId: 'FIXTURE',
  privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) }

test('visible alert contains only correlation fields and has one stable collapse ID', () => {
  const value = endpoint()
  value.gugu.content = 'PRIVATE_MESSAGE_CANARY'
  value.gugu.toolArguments = { secret: 'PRIVATE_TOOL_CANARY' }
  const request = notificationRequest(value)
  assert.equal(request.origin, 'https://api.push.apple.com')
  assert.equal(request.headers['apns-push-type'], 'alert')
  assert.equal(request.headers['apns-expiration'], '0')
  assert.equal(request.headers['apns-collapse-id'], ids[0])
  assert.equal(request.headers['apns-id'], ids[0])
  assert.doesNotMatch(request.body, /PRIVATE_|ab{20}|content-available/)
  assert.equal(JSON.parse(request.body).gugu.revision, '9007199254740993')
  assert.equal(JSON.parse(request.body).aps.sound, 'default')
  value.sound = false
  assert.equal(JSON.parse(notificationRequest(value).body).aps.sound, undefined)
})

test('accepts variable-length APNs tokens and rejects malformed bindings without echoing them', () => {
  for (const length of [16, 32, 100]) {
    const value = endpoint(); value.token = 'cd'.repeat(length)
    assert.doesNotThrow(() => notificationRequest(value))
  }
  for (const mutation of [x => { x.token = 'private-token-canary' }, x => { x.token = 'AABB' },
    x => { x.environment = 'other' }, x => { x.topic = 'other.app' }, x => { x.gugu.ownerId = 'other' },
    x => { x.gugu.revision = 1 }, x => { x.gugu.kind = 'completed' }]) {
    const value = endpoint(); mutation(value)
    assert.throws(() => notificationRequest(value), error => error.message === 'Invalid APNs binding')
  }
})

test('only confirmed invalid-token responses request cleanup; provider errors preserve registrations', () => {
  const start = 1700000000000
  assert.deepEqual(providerResult(200, '', start), { outcome: 'accepted', invalidBefore: null })
  assert.equal(providerResult(410, JSON.stringify({ reason: 'Unregistered', timestamp: start - 1000 }), start).invalidBefore,
    new Date(start - 1000).toISOString())
  for (const reason of ['BadDeviceToken', 'DeviceTokenNotForTopic']) {
    assert.equal(providerResult(400, JSON.stringify({ reason }), start).invalidBefore, new Date(start).toISOString())
  }
  for (const [status, body] of [[403, '{"reason":"ExpiredProviderToken"}'], [429, '{}'], [500, '{}'],
    [410, '{}'], [410, `{"reason":"Unregistered","timestamp":${start + 1}}`], [400, 'null'], [400, '[]'], [400, 'not-json']]) {
    assert.equal(providerResult(status, body, start).invalidBefore, null)
  }
})

test('exercises an actual loopback HTTP/2 stream, ES256 signing, JWT reuse and renewal', async () => {
  const server = createServer()
  const requests = []
  const sessions = new Set()
  server.on('session', s => { sessions.add(s); s.on('close', () => sessions.delete(s)) })
  server.on('stream', (stream, headers) => {
    let body = ''; stream.setEncoding('utf8'); stream.on('data', x => { body += x })
    stream.on('end', () => { requests.push({ headers, body }); stream.respond({ ':status': 200 }); stream.end() })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  let clock = 1700000000000
  let opened = 0
  const provider = createApnsProvider(config, { now: () => clock, open: origin => {
    assert.equal(origin, 'https://api.push.apple.com'); opened++
    return connect(`http://127.0.0.1:${server.address().port}`)
  } })
  try {
    for (let n = 0; n < 3; n++) {
      if (n === 2) clock += 2400000
      assert.equal((await provider.send(endpoint())).outcome, 'accepted')
    }
    assert.equal(opened, 1)
    assert.equal(requests[0].headers.authorization, requests[1].headers.authorization)
    assert.notEqual(requests[0].headers.authorization, requests[2].headers.authorization)
    const jwt = requests[0].headers.authorization.slice('bearer '.length).split('.')
    assert.deepEqual(JSON.parse(Buffer.from(jwt[0], 'base64url')), { alg: 'ES256', kid: 'FIXTURE' })
    assert.equal(verify('sha256', Buffer.from(jwt.slice(0, 2).join('.')),
      { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(jwt[2], 'base64url')), true)
    assert.equal(requests[0].headers[':path'], `/3/device/${endpoint().token}`)
    assert.equal(JSON.parse(requests[0].body).gugu.ownerId, ids[1])
    const wrong = endpoint(); wrong.environment = 'sandbox'
    await assert.rejects(provider.send(wrong), /environment binding mismatch/)
    assert.equal(requests.length, 3)
  } finally {
    provider.close(); for (const session of sessions) session.destroy()
    await new Promise(resolve => server.close(resolve))
  }
})

test('a stalled HTTP/2 response becomes unknown and is not retried', async () => {
  const server = createServer()
  const sessions = new Set()
  let streams = 0
  server.on('session', s => { sessions.add(s); s.on('close', () => sessions.delete(s)) })
  server.on('stream', stream => { streams++; stream.on('error', () => {}) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const provider = createApnsProvider(config, { timeoutMs: 50,
    open: () => connect(`http://127.0.0.1:${server.address().port}`) })
  try {
    assert.deepEqual(await provider.send(endpoint()), { outcome: 'unknown', invalidBefore: null })
    assert.equal(streams, 1)
  } finally {
    provider.close(); for (const session of sessions) session.destroy()
    await new Promise(resolve => server.close(resolve))
  }
})
