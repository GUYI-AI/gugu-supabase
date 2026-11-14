import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import pg from 'pg'
import { afterAll, beforeAll, expect, it } from 'vitest'

// The rollback/regrant scripts run through psql against a scratch database in the
// fixture cluster: closing the real fixture's owner RPCs would break other suites.
const url = process.env.GUGU_INTEGRATION_DATABASE_URL ?? ''
const execute = promisify(execFile)
const script = (name: string) => fileURLToPath(new URL(`../../../ops/${name}`, import.meta.url))
const scratch = `gugu_ops_${randomBytes(6).toString('hex')}`
const target = Object.assign(new URL(url || 'postgresql://invalid/x'), { pathname: `/${scratch}` }).href
const rpcs = ['identity.connection_snapshot(text)', 'identity.connection_resource(text,text)',
  'identity.connection_recreate_begin(uuid,text,text,bigint,text,text,bigint)',
  'identity.connection_commit(uuid,text,text,bigint,text,jsonb,text,text,text,uuid)',
  'identity.connection_commit_batch(uuid,uuid,jsonb,text)', 'identity.connection_pending(text)',
  'identity.connection_admit(text,bigint,uuid)', 'identity.connection_ack(text,uuid,uuid,text,boolean)']
let admin: pg.Client, db: pg.Client

const psql = (name: string, variables: string[] = []) =>
  execute('psql', ['-X', '-d', target, ...variables.flatMap(variable => ['-v', variable]), '-f', script(name)])
// Effective EXECUTE per API role, plus any PUBLIC grant (ordered in JS, not by collation).
const bySignature = <T extends { signature: string }>(rows: T[]) => rows.sort((left, right) => left.signature < right.signature ? -1 : 1)
const grants = async () => bySignature((await db.query(`SELECT s.signature,
    has_function_privilege('authenticated',s.signature,'EXECUTE') AS authenticated,
    has_function_privilege('anon',s.signature,'EXECUTE') AS anon,
    has_function_privilege('service_role',s.signature,'EXECUTE') AS service_role,
    EXISTS (SELECT 1 FROM pg_proc p,aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
      WHERE p.oid=s.signature::regprocedure AND a.grantee=0) AS public
  FROM unnest($1::text[]) s(signature)`, [rpcs])).rows)
const every = (authenticated: boolean) => bySignature(rpcs.map(signature => ({ signature, authenticated, anon: false, service_role: false, public: false })))

beforeAll(async () => {
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) throw new Error('Ops script tests require the disposable loopback fixture')
  admin = new pg.Client({ connectionString: url }); await admin.connect()
  await admin.query(`CREATE DATABASE ${scratch}`)
  db = new pg.Client({ connectionString: target }); await db.connect()
  await db.query('CREATE SCHEMA identity')
  await db.query('CREATE TABLE identity.connection_heads(owner_user_id text PRIMARY KEY,authority_mode text NOT NULL)')
  for (const signature of rpcs) await db.query(`CREATE FUNCTION ${signature} RETURNS integer LANGUAGE sql AS 'SELECT 1'`)
})

afterAll(async () => {
  await db?.end()
  if (admin) { try { await admin.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`) } finally { await admin.end() } }
})

it('regrant restores exactly the release grants, and both scripts only dry-run by default', async () => {
  const initial = await grants()
  const dry = await psql('regrant-owner-connection-api.sql')
  expect(dry.stdout).toContain('owner-mode accounts: 0')
  expect(dry.stdout).toContain('dry run: rolled back')
  expect(await grants()).toEqual(initial)
  // Only the exact value 1 applies.
  await psql('regrant-owner-connection-api.sql', ['apply=yes'])
  expect(await grants()).toEqual(initial)
  expect((await psql('regrant-owner-connection-api.sql', ['apply=1'])).stdout).toContain('applied')
  expect(await grants()).toEqual(every(true))
  const rollbackDry = await psql('rollback-owner-connection-api.sql')
  expect(rollbackDry.stdout).toContain('dry run: rolled back')
  expect(await grants()).toEqual(every(true))
})

it('rollback refuses while accounts are in owner mode unless forced, and regrant reopens', async () => {
  await db.query("INSERT INTO identity.connection_heads VALUES('owner-a','owner'),('owner-b','owner'),('legacy-c','legacy')")
  const refused = await psql('rollback-owner-connection-api.sql', ['apply=1']).catch(error => error)
  expect(refused.code).toBe(3)
  expect(refused.stdout).toContain('owner-mode accounts: 2')
  expect(refused.stderr).toContain('Accounts are in owner mode')
  expect(await grants()).toEqual(every(true))
  expect((await psql('rollback-owner-connection-api.sql', ['apply=1', 'force=1'])).stdout).toContain('applied')
  expect(await grants()).toEqual(every(false))
  expect((await db.query('SELECT count(*)::int AS n FROM identity.connection_heads')).rows[0].n).toBe(3)
  await psql('regrant-owner-connection-api.sql', ['apply=1'])
  expect(await grants()).toEqual(every(true))
  await db.query("DELETE FROM identity.connection_heads WHERE authority_mode='owner'")
  expect((await psql('rollback-owner-connection-api.sql', ['apply=1'])).stdout).toContain('applied')
  expect(await grants()).toEqual(every(false))
})
