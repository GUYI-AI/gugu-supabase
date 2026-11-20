import { readFile } from 'node:fs/promises'
import { createApnsProvider } from './apns.mjs'
import { createFcmProvider } from './providers/fcm.mjs'

export async function loadPushProviders(env, log = () => {}) {
  const environment = env.GUGU_PUSH_ENVIRONMENT ?? env.GUGU_APNS_ENVIRONMENT
  if (!['sandbox', 'production'].includes(environment)
    || (env.GUGU_APNS_ENVIRONMENT && env.GUGU_APNS_ENVIRONMENT !== environment)) throw new Error('Invalid push environment')
  const providers = {}
  try {
    const apns = ['GUGU_APNS_TOPIC', 'GUGU_APNS_KEY_ID', 'GUGU_APNS_TEAM_ID', 'GUGU_APNS_PRIVATE_KEY_PATH']
    if (apns.some(name => env[name])) {
      if (!apns.every(name => env[name])) throw new Error('Incomplete APNs configuration')
      providers.apns = createApnsProvider({ environment, topic: env.GUGU_APNS_TOPIC,
        keyId: env.GUGU_APNS_KEY_ID, teamId: env.GUGU_APNS_TEAM_ID,
        privateKey: await readFile(env.GUGU_APNS_PRIVATE_KEY_PATH, 'utf8') })
    }
    if (env.GUGU_FCM_SERVICE_ACCOUNT_PATH) {
      if (environment !== 'production') throw new Error('FCM requires production transport environment')
      providers.fcm = createFcmProvider({ serviceAccount: JSON.parse(await readFile(env.GUGU_FCM_SERVICE_ACCOUNT_PATH, 'utf8')) })
    }
    for (const provider of ['apns', 'fcm']) log({ event: 'push_provider_configuration', provider, configured: Boolean(providers[provider]) })
    if (!Object.keys(providers).length) throw new Error('No push provider configured')
    return { providers, environment }
  } catch (error) {
    for (const provider of Object.values(providers)) provider.close()
    throw error
  }
}
