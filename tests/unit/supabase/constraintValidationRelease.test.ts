import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { installReleases, releases } from '../../../scripts/foundation.mjs'

const validation = releases.find((r) => r.constraintValidation)!
const replacement = releases.find((r) => r.version.endsWith('_remove_archived_device_agents'))!

function fixture({ fail = false, verified = true, missingReplacement = false } = {}) {
  const ledger = new Map(releases.filter((r) => r !== validation && (!missingReplacement || r !== replacement)).map((r) => [r.version, r.digest]))
  const sent: string[] = []
  const query = async (sql: string) => {
    sent.push(sql)
    if (sql.startsWith('SELECT version,digest')) return [...ledger].map(([version,digest]) => ({ version,digest }))
    if (sql.startsWith('SELECT convalidated')) return [{ convalidated: verified }]
    if (sql === validation.sql) {
      if (fail) throw new Error('check violation')
    } else {
      expect(sql).not.toContain('VALIDATE CONSTRAINT')
      const record = /INSERT INTO gugu_install.releases\(version,digest\) VALUES\('([^']+)','([^']+)'\)/.exec(sql)
      if (record) ledger.set(record[1], record[2])
    }
    return []
  }
  return { ledger, sent, query }
}

describe('archived-agent device CHECK validation release', () => {
  it('replaces the check without scanning, then validates outside the replacement transaction', async () => {
    const f = fixture({ missingReplacement: true })
    expect(replacement.sql).toContain('NOT VALID;')
    expect(replacement.sql).toContain("set_config('lock_timeout', '1s', true)")
    expect(replacement.sql).toContain("set_config('lock_timeout', previous_lock_timeout, true)")
    expect((await installReleases(f.query)).applied).toEqual([replacement.version, validation.version])
    const validate = f.sent.indexOf(validation.sql)
    expect(f.sent[validate - 1]).toMatch(/COMMIT;\s*$/)
    expect(f.sent[validate + 1]).toContain('SELECT convalidated')
    expect(f.sent[validate + 2]).toContain(`VALUES('${validation.version}','${validation.digest}')`)
    expect((await installReleases(f.query)).applied).toEqual([])
  })
  it.each([{ deferNontransactional: true }, { deferConcurrentIndexes: true }])('defers validation inside an official outer transaction: %j', async (options) => {
    const f = fixture({ missingReplacement: true })
    expect((await installReleases(f.query, options)).applied).toEqual([replacement.version])
    expect(f.sent).not.toContain(validation.sql)
    expect((await installReleases(f.query)).applied).toEqual([validation.version])
  })
  it('leaves a failed or unverified validation unrecorded', async () => {
    for (const options of [{ fail: true }, { verified: false }]) {
      const f = fixture(options)
      await expect(installReleases(f.query)).rejects.toThrow()
      expect(f.ledger.has(validation.version)).toBe(false)
    }
  })
  it('retries validation after its ledger write was interrupted', async () => {
    const f = fixture()
    await expect(installReleases(async (sql: string) => {
      if (sql.includes(`VALUES('${validation.version}'`)) throw new Error('connection lost')
      return f.query(sql)
    })).rejects.toThrow('connection lost')
    expect((await installReleases(f.query)).applied).toEqual([validation.version])
  })
  it.each([
    'ALTER TABLE identity.users VALIDATE CONSTRAINT users_agent_device_required; SELECT 1;',
    'ALTER TABLE identity.users VALIDATE CONSTRAINT users_agent_device_required, DROP COLUMN id;',
    'BEGIN; ALTER TABLE identity.users VALIDATE CONSTRAINT users_agent_device_required; COMMIT;',
  ])('refuses extra statements or ALTER actions before connecting: %s', async (statement) => {
    const root = mkdtempSync(path.join(tmpdir(), 'gugu-validation-parser-'))
    try {
      const source = path.resolve(import.meta.dirname, '../../..')
      cpSync(path.join(source, 'scripts'), path.join(root, 'scripts'), { recursive: true })
      cpSync(path.join(source, 'supabase/migrations'), path.join(root, 'supabase/migrations'), { recursive: true })
      writeFileSync(path.join(root, 'supabase/migrations', validation.version + '.sql'), '-- gugu:transaction off\n' + statement + '\n')
      await expect(import(pathToFileURL(path.join(root, 'scripts/foundation.mjs')).href)).rejects.toThrow(/Nontransactional release must contain one/)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it.each(['\r', '\r\n'])('recognizes a standalone directive and statement with %j line endings', async (ending) => {
    const root = mkdtempSync(path.join(tmpdir(), 'gugu-validation-eol-'))
    try {
      const source = path.resolve(import.meta.dirname, '../../..')
      cpSync(path.join(source, 'scripts'), path.join(root, 'scripts'), { recursive: true })
      cpSync(path.join(source, 'supabase/migrations'), path.join(root, 'supabase/migrations'), { recursive: true })
      const sql = validation.sql.replace(/\n/g, ending)
      writeFileSync(path.join(root, 'supabase/migrations', validation.version + '.sql'), sql)
      const mod = await import(pathToFileURL(path.join(root, 'scripts/foundation.mjs')).href)
      const release = mod.releases.find((r) => r.version === validation.version)
      expect(release.constraintValidation).toEqual(validation.constraintValidation)
      expect(release.sql).toBe(sql)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  it.each([validation, releases.find((r) => r.concurrentIndex)!])('rejects SQL hidden after a CR line comment in $version', async (release) => {
    const root = mkdtempSync(path.join(tmpdir(), 'gugu-validation-cr-'))
    try {
      const source = path.resolve(import.meta.dirname, '../../..')
      cpSync(path.join(source, 'scripts'), path.join(root, 'scripts'), { recursive: true })
      cpSync(path.join(source, 'supabase/migrations'), path.join(root, 'supabase/migrations'), { recursive: true })
      writeFileSync(path.join(root, 'supabase/migrations', release.version + '.sql'), release.sql + '-- ignored\rSELECT 158;\n')
      await expect(import(pathToFileURL(path.join(root, 'scripts/foundation.mjs')).href)).rejects.toThrow(/Nontransactional release must contain one/)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
