import { describe, expect, it } from 'vitest'
import { objectKey, ossSign, uriEncode } from '../../../supabase/functions/_shared/oss'
import { connectionBodyStore, connectionOssGet } from '../../../scripts/platform-connection-bodies.mjs'
import { connectionCutoverRefusal, connectionOperatorPattern, cutoverConnectionAccounts, parseConnectionOwners }
  from '../../../scripts/platform-connection-cutover.mjs'

const oss = { region: 'cn-hangzhou', bucket: 'fixture-bucket', endpoint: 'oss-cn-hangzhou.aliyuncs.com',
  accessKeyId: 'fixture-id', accessKeySecret: 'fixture-secret', objectPrefix: 'env/beta' }
const ossEnv = { OSS_REGION: oss.region, OSS_BUCKET: oss.bucket, OSS_ENDPOINT_PUBLIC: oss.endpoint,
  OSS_ACCESS_KEY_ID: oss.accessKeyId, OSS_ACCESS_KEY_SECRET: oss.accessKeySecret, ATTACHMENTS_OBJECT_PREFIX: oss.objectPrefix }
const location = (bucketId: string, objectName = 'ab/' + 'ab'.repeat(32), sizeBytes: number | null = 4) =>
  ({ bucketId, objectName, sizeBytes, live: true })

function recorder(body: Uint8Array | string = 'body', init: ResponseInit = {}) {
  const calls: { url: string; headers: Record<string, string> }[] = []
  const fetch = async (url: string, request: RequestInit = {}) => {
    calls.push({ url, headers: request.headers as Record<string, string> })
    return new Response(body, init)
  }
  return { calls, fetch }
}

describe('server-side connection body reads', () => {
  it('signs OSS GETs exactly like the attachments function signer', async () => {
    const date = new Date('2026-11-11T08:09:10.123Z')
    for (const key of ['ab/' + 'ab'.repeat(32), "odd name/with(*)'!~.json"]) {
      for (const objectPrefix of ['', 'env/beta']) {
        const cfg = { ...oss, objectPrefix }
        const expected = await ossSign({ ...cfg, endpointInternal: 'internal', endpointPublic: cfg.endpoint }, {
          method: 'GET', key, headers: { 'Accept-Encoding': 'identity' }, date })
        const actual = connectionOssGet(cfg, key, date)
        expect(actual.headers).toEqual(expected.headers)
        expect(actual.url).toBe(`https://${cfg.bucket}.${cfg.endpoint}/${uriEncode(objectKey(cfg, key), true)}`)
      }
    }
  })

  it('reads workspace rows from Supabase Storage with the service key, and OSS rows from OSS when configured', async () => {
    const supabase = recorder()
    const store = connectionBodyStore({ SUPABASE_URL: 'http://127.0.0.1:54321/', SUPABASE_SERVICE_ROLE_KEY: 'service-fixture' }, { fetch: supabase.fetch })
    expect(new TextDecoder().decode(await store(location('workspace', 'chat/one two'), 16))).toBe('body')
    await store(location('oss'), 16)
    expect(supabase.calls.map(call => call.url)).toEqual(['http://127.0.0.1:54321/storage/v1/object/workspace/chat/one%20two',
      'http://127.0.0.1:54321/storage/v1/object/attachments/ab/' + 'ab'.repeat(32)])
    expect(supabase.calls[0].headers).toEqual({ apikey: 'service-fixture', Authorization: 'Bearer service-fixture' })
    const remote = recorder(), date = new Date('2026-11-11T00:00:00Z')
    await connectionBodyStore({ ...ossEnv, GUGU_ATTACHMENTS_BUCKET: 'unused' }, { fetch: remote.fetch, now: () => date })(location('oss'), 16)
    expect(remote.calls).toEqual([connectionOssGet(oss, 'ab/' + 'ab'.repeat(32), date)])
  })

  it('fails closed on partial OSS settings, missing storage, refusals and oversized bodies', async () => {
    expect(() => connectionBodyStore({ OSS_REGION: 'cn-hangzhou' })).toThrow('CONNECTION_BODY_STORAGE_PARTIAL_OSS')
    await expect(connectionBodyStore({})(location('workspace'), 16)).rejects.toMatchObject({ code: 'CONNECTION_BODY_STORAGE_NOT_CONFIGURED' })
    const env = { SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_SERVICE_ROLE_KEY: 'k' }
    const read = (response: ReturnType<typeof recorder>, where = location('workspace'), limit = 4) => connectionBodyStore(env, { fetch: response.fetch })(where, limit)
    await expect(read(recorder('missing', { status: 404 }))).rejects.toMatchObject({ code: 'CONNECTION_BODY_UNAVAILABLE' })
    await expect(read(recorder('12345'))).rejects.toMatchObject({ code: 'CONNECTION_BODY_TOO_LARGE' })
    await expect(read(recorder('1234'), location('workspace', undefined, 5))).rejects.toMatchObject({ code: 'CONNECTION_BODY_TOO_LARGE' })
    await expect(read(recorder('1234'), { ...location('workspace'), live: false })).rejects.toMatchObject({ code: 'CONNECTION_BODY_UNAVAILABLE' })
    await expect(read(recorder('1234'), location('elsewhere'))).rejects.toMatchObject({ code: 'CONNECTION_BODY_UNAVAILABLE' })
    await expect(read(recorder('1234'), null as never)).rejects.toMatchObject({ code: 'CONNECTION_BODY_UNAVAILABLE' })
    expect(new TextDecoder().decode(await read(recorder('1234')))).toBe('1234')
  })
})

describe('cutover tool inputs and reports', () => {
  it('accepts a bounded unique owner list as JSON or one UUID per line', () => {
    const [a, b] = ['6f1c2b9e-1b7e-4f3e-9d43-0a7b8c9d0e1f', '0e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b']
    expect(parseConnectionOwners(JSON.stringify([a, b]))).toEqual([a, b])
    expect(parseConnectionOwners(`# test account first\n${a.toUpperCase()}\n\n${b}\n`)).toEqual([a, b])
    for (const text of ['', '[]', 'not-a-uuid', JSON.stringify([a, 1]), `${a}\n${a.toUpperCase()}`,
      Array.from({ length: 501 }, () => a).join('\n')]) expect(() => parseConnectionOwners(text)).toThrow(/CONNECTION_CUTOVER_/)
  })

  it('refuses to apply without a named operator before touching the database', async () => {
    for (const ok of ['ops.alice', 'alice@example.com', 'ci-operator', 'a']) expect(connectionOperatorPattern.test(ok)).toBe(true)
    for (const bad of ['', ' alice', 'two words', '-x', 'x'.repeat(129), 'a;b']) expect(connectionOperatorPattern.test(bad)).toBe(false)
    const db = { query: async () => { throw new Error('database touched') } }
    for (const operator of [undefined, 'two words'])
      await expect(cutoverConnectionAccounts(db, ['6f1c2b9e-1b7e-4f3e-9d43-0a7b8c9d0e1f'], { apply: true, operator }))
        .rejects.toMatchObject({ code: 'CONNECTION_CUTOVER_OPERATOR_REQUIRED' })
  })

  it('reports stable codes, never raw messages, and SQLSTATEs only for database errors', () => {
    const database = (message: string, code: string) => Object.assign(new Error(message), { code, severity: 'ERROR' })
    expect(connectionCutoverRefusal(database('Connection source changed after preparation', 'PT409')))
      .toEqual({ code: 'CONNECTION_CUTOVER_SOURCE_CHANGED', sqlstate: 'PT409' })
    for (const [message, code] of [['Connection legacy rows belong to several assistants', 'CONNECTION_CUTOVER_SEVERAL_ASSISTANTS'],
      ['Connection candidate has rows outside an owned scope', 'CONNECTION_CUTOVER_UNSCOPED_ROWS'],
      ['Connection platform credentials have no owner mapping yet', 'CONNECTION_CUTOVER_PLATFORM_CREDENTIAL'],
      ['Connection preparation is closed after the authority switch', 'CONNECTION_CUTOVER_ALREADY_OWNER']])
      expect(connectionCutoverRefusal(database(message, '55000'))).toEqual({ code, sqlstate: '55000' })
    expect(connectionCutoverRefusal(database('canceling statement due to lock timeout', '55P03')))
      .toEqual({ code: 'CONNECTION_CUTOVER_LOCK_TIMEOUT', sqlstate: '55P03' })
    expect(connectionCutoverRefusal(database('duplicate key value violates unique constraint "secret_name"', '23505')))
      .toEqual({ code: 'CONNECTION_CUTOVER_FAILED', sqlstate: '23505' })
    expect(connectionCutoverRefusal(Object.assign(new Error('/private/path'), { code: 'ELOOP' }), 'CONNECTION_BODY_UNAVAILABLE'))
      .toEqual({ code: 'CONNECTION_BODY_UNAVAILABLE' })
    expect(connectionCutoverRefusal(Object.assign(new Error('x'), { code: 'CONNECTION_AUDIT_BODY_HASH_MISMATCH' })))
      .toEqual({ code: 'CONNECTION_AUDIT_BODY_HASH_MISMATCH' })
  })
})
