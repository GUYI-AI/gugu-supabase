import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { objectKey, ossSign, uriEncode } from '../../../supabase/functions/_shared/oss'
import { connectionBodyStore, connectionOssGet } from '../../../scripts/platform-connection-bodies.mjs'
import { connectionCutoverExitCode, connectionCutoverRefusal, connectionOperatorPattern, cutoverConnectionAccounts, parseConnectionOwners }
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

  it('reads the legacy inventory in one place, so the recorded digest and the rechecked one cannot drift', () => {
    // The import rule once lived in an owner-run export and in the database function, and they drifted. The tool, the
    // preparation and the switch now all go through readConnectionInventory; no other script or ops file reads it.
    const root = new URL('../../../', import.meta.url)
    const sites = ['scripts', 'ops'].flatMap(dir => readdirSync(new URL(dir, root)).map(name => `${dir}/${name}`))
      .filter(file => /\.(mjs|sql)$/.test(file) && readFileSync(new URL(file, root), 'utf8').includes('connection_legacy_inventory'))
    expect(sites).toEqual(['scripts/platform-connection-prepare.mjs'])
    expect(readFileSync(new URL('scripts/platform-connection-prepare.mjs', root), 'utf8').match(/connection_legacy_inventory/g)).toHaveLength(1)
    expect(existsSync(new URL('ops/audit-platform-connections.sql', root))).toBe(false)
  })

  it('uses one code for a collection that is not ready, wherever it is detected', () => {
    const database = (message: string) => Object.assign(new Error(message), { code: '55000', severity: 'ERROR' })
    for (const message of ['Connection legacy control is unprepared', 'Connection collection is incomplete', 'Connection collection is unprepared'])
      expect(connectionCutoverRefusal(database(message))).toEqual({ code: 'CONNECTION_CUTOVER_COLLECTION_NOT_READY', sqlstate: '55000' })
    for (const code of ['CONNECTION_AUDIT_COLLECTION_NOT_READY', 'CONNECTION_AUDIT_COLLECTION_COUNT_MISMATCH', 'CONNECTION_AUDIT_INVALID_COLLECTION_DEVICE'])
      expect(connectionCutoverRefusal(Object.assign(new Error(code), { code }))).toEqual({ code: 'CONNECTION_CUTOVER_COLLECTION_NOT_READY' })
  })

  it('tells a lost database session apart from other failures', () => {
    for (const error of [Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }), new Error('Connection terminated unexpectedly'),
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' })])
      expect(connectionCutoverRefusal(error)).toEqual({ code: 'CONNECTION_CUTOVER_DATABASE_CONNECTION_LOST' })
    expect(connectionCutoverRefusal(Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01', severity: 'FATAL' })))
      .toEqual({ code: 'CONNECTION_CUTOVER_DATABASE_CONNECTION_LOST', sqlstate: '57P01' })
    expect(connectionCutoverRefusal(new Error('something else'))).toEqual({ code: 'CONNECTION_CUTOVER_FAILED' })
  })
})

// A scripted database for the per-account flow: heads, credential custody and the cutover write.
function scripted({ mode = 'legacy', credentials }: { mode?: 'legacy' | 'owner'; credentials: number[] | null }) {
  let head = mode === 'owner' ? { mode: 'owner', epoch: '1', phase: 'stable', prepared: false, initialized: true } : null
  const counts = credentials && [...credentials]
  const query = async (sql: string) => {
    if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL|SAVEPOINT|RELEASE)/.test(sql)) return { rows: [] }
    if (sql.includes("to_regclass('integrations.credentials')")) return { rows: [{ present: counts !== null }] }
    if (sql.includes('FROM integrations.credentials')) return { rows: [{ n: counts!.length > 1 ? counts!.shift() : counts![0] }] }
    if (sql.includes('FROM identity.connection_heads')) return { rows: head ? [head] : [] }
    if (sql.includes('FROM identity.users')) return { rows: [{ available: true }] }
    if (sql.includes('connection_has_legacy_data')) return { rows: [{ value: false }] }
    if (sql.includes('identity.gugu_devices')) return { rows: [] }
    if (sql.includes('connection_legacy_inventory')) return { rows: [{ inventory: { identityState: 'none' } }] }
    if (sql.includes('connection_authority_cutover')) {
      head = { mode: 'owner', epoch: '1', phase: 'stable', prepared: false, initialized: true }
      return { rows: [{ result: {} }] }
    }
    throw new Error(`unexpected query: ${sql}`)
  }
  return { query }
}

describe('cutover tool platform credential custody', () => {
  const owner = '6f1c2b9e-1b7e-4f3e-9d43-0a7b8c9d0e1f'
  const run = (db: ReturnType<typeof scripted>, apply = false) => cutoverConnectionAccounts(db, [owner], { apply, operator: 'ops.alice' })

  it('counts credentials of already-owner accounts and exits 2 when any remain', async () => {
    const held = await run(scripted({ mode: 'owner', credentials: [2] }))
    expect(held.accounts[0]).toMatchObject({ result: 'already-owner', code: 'CONNECTION_CUTOVER_STRANDED_PLATFORM_CREDENTIAL', platformCredentials: 2 })
    expect(held.summary).toMatchObject({ 'already-owner': 1, stranded: 1 })
    expect(connectionCutoverExitCode(held.summary)).toBe(2)
    const clear = await run(scripted({ mode: 'owner', credentials: [0] }))
    expect(clear.accounts[0]).toMatchObject({ result: 'already-owner', platformCredentials: 0 })
    expect(clear.accounts[0].code).toBeUndefined()
    expect(connectionCutoverExitCode(clear.summary)).toBe(0)
    // Community installs have no custody table: nothing to count, nothing reported.
    const community = await run(scripted({ mode: 'owner', credentials: null }))
    expect(community.accounts[0]).not.toHaveProperty('platformCredentials')
    expect(connectionCutoverExitCode(community.summary)).toBe(0)
  })

  it('recounts after a switch, and keeps an account with credentials legacy before it', async () => {
    const appeared = await run(scripted({ credentials: [0, 1] }), true)
    expect(appeared.accounts[0]).toMatchObject({ plan: 'native', result: 'switched', platformCredentials: 1,
      code: 'CONNECTION_CUTOVER_STRANDED_PLATFORM_CREDENTIAL' })
    expect(appeared.accounts[0].switchedAt).toMatch(/Z$/)
    expect(connectionCutoverExitCode(appeared.summary)).toBe(2)
    const held = await run(scripted({ credentials: [3] }), true)
    expect(held.accounts[0]).toMatchObject({ result: 'kept-legacy', code: 'CONNECTION_CUTOVER_PLATFORM_CREDENTIAL', platformCredentials: 3 })
    const switched = await run(scripted({ credentials: [0] }), true)
    expect(switched.accounts[0]).toMatchObject({ result: 'switched', platformCredentials: 0 })
    expect(connectionCutoverExitCode(switched.summary)).toBe(0)
  })

  it('stops the run on a lost session and reports when', async () => {
    const lost = { query: async () => { throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) } }
    const report = await cutoverConnectionAccounts(lost, [owner, '0e1f2a3b-4c5d-4e6f-8a9b-0c1d2e3f4a5b'], {})
    expect(report.accounts).toMatchObject([{ result: 'failed', code: 'CONNECTION_CUTOVER_DATABASE_CONNECTION_LOST', failedAt: expect.stringMatching(/Z$/) },
      { result: 'not-attempted' }])
    expect(connectionCutoverExitCode(report.summary)).toBe(2)
  })
})
