import { describe, expect, it, vi } from 'vitest'
import { handleStagingCleanup, handleStagingCleanupControl } from '../../../supabase/functions/_shared/staging-cleanup-core'
import { ObjectStorageError } from '../../../supabase/functions/_shared/object-storage'
const run = '11111111-1111-4111-8111-111111111111'
const owner = '22222222-2222-4222-8222-222222222222'
const object = '33333333-3333-4333-8333-333333333333'
const key = `staging/${owner}/${object}`
const claim = '44444444-4444-4444-8444-444444444444'
const job = { staging_key: key, claim_token: claim, attempt_count: 1 }
function fixture(options: { jobs?: unknown; disabled?: boolean; rpc?: (name: string, args: Record<string, unknown>) => unknown } = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const serviceRpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args })
    const replaced = options.rpc?.(name, args)
    if (replaced !== undefined) return replaced as { data: unknown; error: null }
    const data = name === 'file_staging_cleanup_run_begin'
      ? { admitted: !options.disabled, ...(options.disabled ? {} : { run_token: run }), batch_limit: 5, concurrency: 1 }
      : name === 'file_staging_cleanup_claim' ? options.jobs ?? [job] : true
    return { data, error: null }
  })
  const objects = { remove: vi.fn(async (_key: string, _signal?: AbortSignal) => {}), exists: vi.fn(async (_key: string, _signal?: AbortSignal) => false) }
  const log = vi.fn()
  return { serviceRpc, objects, log, calls }
}
describe('trusted committed staging cleanup', () => {
  it('does no claim or storage work while disabled', async () => {
    const f = fixture({ disabled: true })
    expect(await handleStagingCleanup(f)).toEqual({ admitted: false, claimed: 0, deleted: 0, failed: 0, unconfirmed: 0 })
    expect(f.calls.map(x => x.name)).toEqual(['file_staging_cleanup_run_begin'])
    expect(f.objects.remove).not.toHaveBeenCalled()
  })
  it('confirms physical absence before acknowledging removal and closing the run', async () => {
    const f = fixture()
    expect(await handleStagingCleanup(f)).toMatchObject({ admitted: true, claimed: 1, deleted: 1, failed: 0 })
    expect(f.objects.remove).toHaveBeenCalledWith(key, expect.any(AbortSignal))
    expect(f.objects.exists).toHaveBeenCalledWith(key, expect.any(AbortSignal))
    expect(f.calls.map(x => x.name)).toEqual(['file_staging_cleanup_run_begin', 'file_staging_cleanup_claim',
      'file_staging_cleanup_run_renew', 'file_staging_cleanup_run_renew', 'file_staging_cleanup_run_renew',
      'file_staging_cleanup_finish', 'file_staging_cleanup_run_end'])
    expect(f.calls.find(x => x.name === 'file_staging_cleanup_finish')?.args).toEqual({ p_run: run, p_key: key, p_claim: claim })
  })
  it('treats a previously deleted object as idempotent only after an absent HEAD', async () => {
    const f = fixture(); f.objects.remove.mockRejectedValue(new ObjectStorageError(404, null, 'not found'))
    expect(await handleStagingCleanup(f)).toMatchObject({ deleted: 1, failed: 0 })
    expect(f.objects.exists).toHaveBeenCalledOnce()
  })
  it('retains the hold and schedules retry when DELETE succeeds but HEAD still sees the object', async () => {
    const f = fixture(); f.objects.exists.mockResolvedValue(true)
    expect(await handleStagingCleanup(f)).toMatchObject({ deleted: 0, failed: 1 })
    expect(f.calls.find(x => x.name === 'file_staging_cleanup_fail')?.args.p_error).toBe('still_present')
    expect(f.calls.some(x => x.name === 'file_staging_cleanup_finish')).toBe(false)
  })
  it('reports transient provider failure without leaking its request body and continues sequentially', async () => {
    const second = { ...job, staging_key: `staging/${owner}/${claim}`, claim_token: object }
    const f = fixture({ jobs: [job, second] })
    let active = 0, maximum = 0
    f.objects.remove.mockImplementation(async () => {
      maximum = Math.max(maximum, ++active); await Promise.resolve(); active--
      if (f.objects.remove.mock.calls.length === 1) throw new ObjectStorageError(429, null, 'https://private.invalid/?signature=do-not-log')
    })
    expect(await handleStagingCleanup(f)).toMatchObject({ claimed: 2, deleted: 1, failed: 1 })
    expect(maximum).toBe(1)
    expect(JSON.stringify(f.log.mock.calls)).not.toContain('signature')
    expect(JSON.stringify(f.log.mock.calls)).not.toContain(key)
    expect(f.calls.find(x => x.name === 'file_staging_cleanup_fail')?.args.p_error).toBe('storage_failed')
  })
  it('keeps the run lease after a provider timeout and passes an actual abort signal', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture()
      f.objects.remove.mockImplementation((_key: string, signal?: AbortSignal) => new Promise((_, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }))
      const result = handleStagingCleanup(f)
      await vi.advanceTimersByTimeAsync(10_001)
      expect(await result).toMatchObject({ deleted: 0, failed: 1, unconfirmed: 1 })
      expect(f.calls.some(x => x.name === 'file_staging_cleanup_run_end')).toBe(false)
      expect(f.calls.find(x => x.name === 'file_staging_cleanup_fail')?.args.p_error).toBe('storage_timeout')
    } finally { vi.useRealTimers() }
  })
  it('retains its lease after a lost transport response instead of starting a second delete', async () => {
    const f = fixture({ jobs: [job, { ...job, staging_key: `staging/${owner}/${claim}`, claim_token: object }] })
    f.objects.remove.mockRejectedValue(new TypeError('private network diagnostics'))
    expect(await handleStagingCleanup(f)).toMatchObject({ deleted: 0, failed: 1, unconfirmed: 1 })
    expect(f.objects.remove).toHaveBeenCalledOnce()
    expect(f.calls.some(x => x.name === 'file_staging_cleanup_run_end')).toBe(false)
    expect(JSON.stringify(f.log.mock.calls)).not.toContain('private network')
  })
  it('does not claim that a retry or lease release was recorded without a true acknowledgement', async () => {
    const f = fixture({ rpc: name => name === 'file_staging_cleanup_fail' ? { data: false, error: null } : undefined })
    f.objects.exists.mockResolvedValue(true)
    expect(await handleStagingCleanup(f)).toMatchObject({ deleted: 0, failed: 1, unconfirmed: 1 })
    expect(f.calls.some(x => x.name === 'file_staging_cleanup_run_end')).toBe(false)
    const ended = fixture({ rpc: name => name === 'file_staging_cleanup_run_end' ? { data: false, error: null } : undefined })
    expect(await handleStagingCleanup(ended)).toMatchObject({ deleted: 1, unconfirmed: 1 })
  })
  it('does not claim completion after an uncertain acknowledgement', async () => {
    const f = fixture({ rpc: name => name === 'file_staging_cleanup_finish'
      ? { data: null, error: { message: 'sensitive transport detail', status: 0 } } : undefined })
    expect(await handleStagingCleanup(f)).toMatchObject({ deleted: 0, failed: 1, unconfirmed: 1 })
    expect(f.calls.some(x => x.name === 'file_staging_cleanup_run_end')).toBe(false)
    expect(JSON.stringify(f.log.mock.calls)).not.toContain('sensitive')
  })
  it('does not delete after the run is revoked', async () => {
    const f = fixture({ rpc: name => name === 'file_staging_cleanup_run_renew' ? { data: false, error: null } : undefined })
    expect(await handleStagingCleanup(f)).toMatchObject({ deleted: 0, failed: 1, unconfirmed: 1 })
    expect(f.objects.remove).not.toHaveBeenCalled()
  })
  it.each([
    Array.from({ length: 6 }, () => job), [job, job], [{ ...job, staging_key: `ab/${'ab'.repeat(32)}` }],
    [{ ...job, staging_key: `staging/../${object}` }], [{ ...job, claim_token: 'changed' }], [{ ...job, attempt_count: 0 }],
  ])('rejects a malformed or oversized batch before touching storage', async jobs => {
    const f = fixture({ jobs })
    await expect(handleStagingCleanup(f)).rejects.toMatchObject({ code: 'invalid_claim_receipt' })
    expect(f.objects.remove).not.toHaveBeenCalled()
  })
  it('accepts only explicit bounded configuration controls', async () => {
    const f = fixture({ rpc: name => name === 'configure_file_staging_cleanup' ? { data: { enabled: false }, error: null } : undefined })
    await handleStagingCleanupControl(f.serviceRpc, 'staging-cleanup-configure', { enabled: false, single_batch: true })
    expect(f.calls[0]).toEqual({ name: 'configure_file_staging_cleanup', args: { p_enabled: false, p_single_batch: true, p_keys: null } })
    await expect(handleStagingCleanupControl(f.serviceRpc, 'staging-cleanup-configure', { enabled: true, single_batch: false, limit: 500 }))
      .rejects.toMatchObject({ code: 'invalid_controls' })
  })
  it('records only validated terminal and historical publication evidence, with no response keys', async () => {
    const f = fixture()
    const evidence = { staging_key: key, reservation_id: object, blob_id: claim,
      permit_expires_at: '2026-01-01T00:00:00.000000Z', terminal_at: '2026-01-01T00:01:00.000000Z',
      terminal_sha256: 'ab'.repeat(32), publication_sha256: 'cd'.repeat(32), publication_at: '2026-01-01T00:00:30Z' }
    expect(await handleStagingCleanupControl(f.serviceRpc, 'staging-cleanup-evidence', evidence)).toEqual({ recorded: true })
    expect(f.calls[0]?.name).toBe('file_staging_cleanup_evidence')
    await expect(handleStagingCleanupControl(f.serviceRpc, 'staging-cleanup-evidence', { ...evidence, terminal_sha256: 'https://signed.invalid/?key=secret' }))
      .rejects.toMatchObject({ code: 'invalid_evidence' })
  })
})
