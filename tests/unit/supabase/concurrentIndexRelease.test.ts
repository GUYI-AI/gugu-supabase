import { describe, expect, it } from 'vitest'
import { installReleases, releases } from '../../../scripts/foundation.mjs'

const index = releases.find((r) => r.concurrentIndex)!
const split = releases.find((r) => r.previousDigest)!
function fixture({ legacy = false, missingSplit = false, present = false, invalid = false, failCreate = false } = {}) {
  const ledger = new Map(releases.filter((r) => r !== index && (!missingSplit || r !== split)).map((r) => [r.version, r.digest]))
  if (legacy) ledger.set(split.version, split.previousDigest)
  const sent: string[] = []
  const query = async (sql: string) => {
    sent.push(sql)
    if (sql.startsWith('SELECT version,digest')) return [...ledger].map(([version,digest]) => ({ version,digest }))
    if (sql.startsWith('SELECT indisvalid')) return present ? [{ indisvalid: !invalid, indisready: true }] : []
    if (sql === index.sql) {
      if (failCreate) throw new Error('build cancelled')
      present = true
    } else {
      expect(sql).not.toContain('CREATE INDEX CONCURRENTLY')
      const record = /INSERT INTO gugu_install.releases\(version,digest\) VALUES\('([^']+)','([^']+)'\)/.exec(sql)
      if (record) ledger.set(record[1], record[2])
    }
    return []
  }
  return { ledger, sent, query }
}
describe('workspace index release split', () => {
  it('installs the function-only release then builds the index as one standalone request before recording it', async () => {
    const f = fixture({ missingSplit: true })
    expect((await installReleases(f.query)).applied).toEqual([split.version,index.version])
    expect(split.sql).not.toContain('CREATE INDEX ')
    const create = f.sent.indexOf(index.sql)
    expect(create).toBeGreaterThan(0)
    expect(f.sent[create]).not.toMatch(/BEGIN|COMMIT/)
    expect(f.sent[create + 1]).toContain('SELECT indisvalid')
    expect(f.sent[create + 2]).toContain(`VALUES('${index.version}','${index.digest}')`)
  })
  it('accepts only the known legacy digest, preserves that row and skips its body', async () => {
    const f = fixture({ legacy: true, present: true })
    const old = f.ledger.get(split.version)
    expect((await installReleases(f.query)).applied).toEqual([index.version])
    expect(f.ledger.get(split.version)).toBe(old)
    expect(f.sent.some((s) => s.includes('DO $list$'))).toBe(false)
    expect((await installReleases(f.query)).applied).toEqual([])
  })
  it('refuses an unknown checksum before any writes', async () => {
    const f = fixture()
    f.ledger.set(split.version, '0'.repeat(64))
    await expect(installReleases(f.query)).rejects.toThrow(/differs from source/)
    expect(f.sent).toHaveLength(1)
  })
  it('refuses a newer ledger before any writes', async () => {
    const f = fixture()
    f.ledger.set('20990101000000_future', '0'.repeat(64))
    await expect(installReleases(f.query)).rejects.toThrow(/does not know/)
    expect(f.sent).toHaveLength(1)
  })
  it('rejects INVALID indexes before IF NOT EXISTS can hide them', async () => {
    const f = fixture({ present: true, invalid: true })
    await expect(installReleases(f.query)).rejects.toThrow(/DROP INDEX CONCURRENTLY/)
    expect(f.sent).not.toContain(index.sql)
    expect(f.ledger.has(index.version)).toBe(false)
  })
  it('does not record a cancelled build', async () => {
    const f = fixture({ failCreate: true })
    await expect(installReleases(f.query)).rejects.toThrow('build cancelled')
    expect(f.ledger.has(index.version)).toBe(false)
  })
  it('can retry a successful build whose ledger write was interrupted', async () => {
    const f = fixture()
    await expect(installReleases(async (sql: string) => {
      if (sql.includes(`VALUES('${index.version}'`)) throw new Error('connection lost')
      return f.query(sql)
    })).rejects.toThrow('connection lost')
    expect(f.ledger.has(index.version)).toBe(false)
    expect((await installReleases(f.query)).applied).toEqual([index.version])
  })
  it('defers only the marked index for an outer transaction', async () => {
    const f = fixture({ missingSplit: true })
    expect((await installReleases(f.query, { deferConcurrentIndexes: true })).applied).toEqual([split.version])
    expect(f.sent).not.toContain(index.sql)
    expect(f.ledger.has(index.version)).toBe(false)
    expect((await installReleases(f.query)).applied).toEqual([index.version])
  })
})
