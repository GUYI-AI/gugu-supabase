import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyStagingCleanupPlan, buildStagingCleanupPlan, planSha } from '../../../scripts/staging-cleanup-plan.mjs'

const owner = '00000000-0000-4000-8000-000000000001'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const at = '2026-11-14T00:00:00.000Z'
const expiry = '2026-11-13T23:00:00.000Z'
function packets(n = 1) {
  const uploads = Array.from({ length: n }, (_, i) => ({ staging_key: `staging/${owner}/${id(i + 2)}`, reservation_id: id(i + 2),
    blob_id: id(i + 100), permit_expires_at: expiry, reservation_state: 'issued', staging_deleted: false, publication_committed: true }))
  return { snapshot: { schema: 1, kind: 'staging-cleanup-snapshot', at, uploads },
    evidence: { schema: 1, kind: 'staging-cleanup-trusted-evidence', entries: uploads.map(row => ({
      staging_key: row.staging_key, reservation_id: row.reservation_id, blob_id: row.blob_id, permit_expires_at: expiry,
      terminal_at: at, terminal_sha256: 'a'.repeat(64), publication_sha256: null, publication_at: null })) } }
}
const dirs: string[] = []
afterEach(() => { dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })) })
describe('offline staging cleanup planning', () => {
  it('selects five approved identities and defers the rest without inferring evidence', () => {
    const p = packets(8), plan = buildStagingCleanupPlan(p.snapshot, p.evidence, { now: at })
    expect(plan.counts).toMatchObject({ scanned: 8, eligible: 8, selected: 5, deferred: 3 })
    expect(plan.entries).toHaveLength(5)
    expect(plan.plan_sha256).toBe(planSha(plan))
  })
  it('requires independent publication evidence for swept receipts and terminal proof for committed receipts', () => {
    const p = packets(3)
    p.snapshot.uploads[0].publication_committed = false
    p.evidence.entries.splice(1, 1)
    p.evidence.entries[1].reservation_id = id(900)
    const plan = buildStagingCleanupPlan(p.snapshot, p.evidence, { now: at })
    expect(plan.counts).toMatchObject({ missing_publication: 1, missing_terminal: 1, mismatched_evidence: 1, selected: 0 })
  })
  it('does not equate elapsed permits, shared content or a registration with publication or terminal closure', () => {
    const p = packets(2)
    p.snapshot.uploads[0].publication_committed = false
    const plan = buildStagingCleanupPlan(p.snapshot, { ...p.evidence, entries: [] }, { now: at })
    expect(plan.counts).toMatchObject({ missing_publication: 1, missing_terminal: 1, eligible: 0 })
  })
  it('accepts exact legacy publication evidence but refuses future terminal evidence and duplicate identities', () => {
    const p = packets()
    p.snapshot.uploads[0].publication_committed = false
    Object.assign(p.evidence.entries[0], { publication_sha256: 'b'.repeat(64), publication_at: expiry })
    expect(buildStagingCleanupPlan(p.snapshot, p.evidence, { now: at }).counts.selected).toBe(1)
    p.evidence.entries[0].terminal_at = '2026-11-16T00:00:00Z'
    expect(buildStagingCleanupPlan(p.snapshot, p.evidence, { now: at }).counts.mismatched_evidence).toBe(1)
    p.evidence.entries.push(p.evidence.entries[0])
    expect(() => buildStagingCleanupPlan(p.snapshot, p.evidence, { now: at })).toThrow('duplicate_or_invalid_evidence')
  })
  it('runs the default CLI entirely offline, protects its output and prints no identities', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'staging-plan-')); dirs.push(dir)
    const p = packets(), snapshot = path.join(dir, 'snapshot.json'), evidence = path.join(dir, 'evidence.json'), output = path.join(dir, 'plan.json')
    writeFileSync(snapshot, JSON.stringify(p.snapshot), { mode: 0o600 })
    writeFileSync(evidence, JSON.stringify(p.evidence), { mode: 0o600 })
    const run = spawnSync(process.execPath, ['scripts/staging-cleanup-plan.mjs', '--snapshot', snapshot, '--evidence', evidence, '--out', output], {
      encoding: 'utf8', env: { PATH: process.env.PATH },
    })
    expect(run.status, run.stderr).toBe(0)
    expect(JSON.parse(run.stdout)).toMatchObject({ dry_run: true, requests: 0, mutations: 0, counts: { selected: 1 } })
    expect(run.stdout + run.stderr).not.toContain(owner)
    expect(statSync(output).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(output, 'utf8')).entries).toHaveLength(1)
  })
})
describe('explicit reviewed staging plan execution', () => {
  it('makes no requests for an empty plan or a changed digest', async () => {
    const p = packets(), plan = buildStagingCleanupPlan(p.snapshot, { ...p.evidence, entries: [] }, { now: at }), call = vi.fn()
    expect(await applyStagingCleanupPlan(plan, plan.plan_sha256, call)).toMatchObject({ selected: 0, no_eligible_entries: true })
    expect(call).not.toHaveBeenCalled()
    await expect(applyStagingCleanupPlan({ ...plan, entries: [{}] }, plan.plan_sha256, call)).rejects.toThrow('plan_confirmation_mismatch')
    expect(call).not.toHaveBeenCalled()
  })
  it('enables only the reviewed exact scope and reports committed readback separately from HTTP results', async () => {
    const p = packets(5), plan = buildStagingCleanupPlan(p.snapshot, p.evidence, { now: at })
    let reads = 0
    const call = vi.fn(async (route: string, body: any) => {
      if (route === 'staging-cleanup-status' && !body.keys) return { batch_limit: 5, concurrency: 1, inflight: 0, enabled: false }
      if (route === 'staging-cleanup-status') return { known: 5, completed: reads++ ? 5 : 0 }
      if (route === 'staging-cleanup-evidence') return { recorded: true }
      if (route === 'staging-cleanup-configure') return { enabled: true, single_batch: true, batch_limit: 5, concurrency: 1, inflight: 0, scope_count: 5 }
      return { admitted: true, claimed: 5, deleted: 5, failed: 0, unconfirmed: 0 }
    })
    expect(await applyStagingCleanupPlan(plan, plan.plan_sha256, call)).toMatchObject({ recorded: 5, newly_confirmed: 5, completed: 5 })
    expect(call.mock.calls.find(([route]) => route === 'staging-cleanup-configure')?.[1]).toEqual({ enabled: true, single_batch: true, keys: plan.entries.map(e => e.staging_key) })
    expect(call.mock.calls.filter(([route]) => route === 'staging-cleanup')).toEqual([['staging-cleanup', {}]])
  })
  it('does not admit an active run or automatically retry an uncertain evidence acknowledgement', async () => {
    const p = packets(), plan = buildStagingCleanupPlan(p.snapshot, p.evidence, { now: at })
    const active = vi.fn(async () => ({ batch_limit: 5, concurrency: 1, inflight: 1, enabled: false }))
    await expect(applyStagingCleanupPlan(plan, plan.plan_sha256, active)).rejects.toThrow('cleanup_not_quiescent')
    expect(active).toHaveBeenCalledOnce()
    const call = vi.fn(async (route: string) => route === 'staging-cleanup-status'
      ? { batch_limit: 5, concurrency: 1, inflight: 0, enabled: false } : {})
    await expect(applyStagingCleanupPlan(plan, plan.plan_sha256, call)).rejects.toThrow('evidence_acknowledgement_unknown')
    expect(call.mock.calls.map(([route]) => route)).toEqual(['staging-cleanup-status', 'staging-cleanup-evidence'])
  })
})
