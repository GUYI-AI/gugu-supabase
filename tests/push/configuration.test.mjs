import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadPushProviders } from '../../services/push/src/configuration.mjs'

test('unconfigured providers are reported, and zero providers refuses startup', async () => {
  const logs = []
  await assert.rejects(() => loadPushProviders({ GUGU_PUSH_ENVIRONMENT: 'production' }, entry => logs.push(entry)))
  assert.deepEqual(logs.map(entry => [entry.provider, entry.configured]), [['apns', false], ['fcm', false]])
})
test('partial APNs, conflicting environment and sandbox FCM cannot silently start', async () => {
  for (const env of [
    { GUGU_PUSH_ENVIRONMENT: 'production', GUGU_APNS_TOPIC: 'app.gugu.chat' },
    { GUGU_PUSH_ENVIRONMENT: 'production', GUGU_APNS_ENVIRONMENT: 'sandbox' },
    { GUGU_PUSH_ENVIRONMENT: 'sandbox', GUGU_FCM_SERVICE_ACCOUNT_PATH: '/synthetic/private.json' },
  ]) await assert.rejects(() => loadPushProviders(env))
})
