import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSafeLogger, type SafeLogFields } from '../../../supabase/functions/_shared/safe-log.ts'

const marker = 'synthetic-log-marker@example.invalid'
afterEach(() => vi.restoreAllMocks())
function capture() {
  const lines: string[] = []
  for (const method of ['log', 'warn', 'error'] as const) vi.spyOn(console, method).mockImplementation((line) => { lines.push(line) })
  return { lines, records: () => lines.map((line) => JSON.parse(line)) }
}

describe('allowlisted Edge events', () => {
  it('rebuilds a fixed envelope, owns correlation/time, and preserves bounded GC counters', () => {
    const out = capture(), log = createSafeLogger('attachments', { gc_result: 'info' })
    log('gc_result', { claimed: null, deleted: 2, finished: 1, failed: 1, entry: 'kick', outcome: 'error' })
    log('gc_result', { claimed: 0, deleted: 0, finished: 0, failed: 0, entry: 'file-accept', outcome: 'completed', status: 200, duration_ms: 0.5 })
    const [first, second] = out.records()
    expect(Object.keys(first).sort()).toEqual(['schema_version', 'service', 'boot_id', 'sequence', 'emitted_at', 'function', 'event', 'level', 'count', 'reason', 'claimed', 'deleted', 'finished', 'failed', 'entry', 'outcome'].sort())
    expect(first).toMatchObject({ schema_version: 1, service: 'edge', function: 'attachments', event: 'gc_result', reason: 'gc_result', count: 1, sequence: 1, claimed: null, deleted: 2, finished: 1, failed: 1 })
    expect(first.boot_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(first.emitted_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
    expect(second.boot_id).toBe(first.boot_id)
    expect(second).toMatchObject({ sequence: 2, claimed: 0, status: 200, duration_ms: 0.5 })
    expect(log.snapshot()).toEqual({ accepted: 2, rejected: 0, write_failed: 0 })
  })

  it.each([
    { email: marker }, { count: marker }, { reason: marker }, { event: marker }, { status: 99 }, { status: 600 },
    { status: 200.1 }, { duration_ms: NaN }, { duration_ms: Infinity }, { duration_ms: -1 },
    { count: -1 }, { count: 1.1 }, { count: Number.MAX_SAFE_INTEGER + 1 }, { claimed: marker },
    { entry: marker }, { outcome: marker }, { headers: { email: marker } }, { boot_id: marker },
    { [marker]: 1 }, { toJSON: () => marker }, Object.assign([], { count: 1 }), new Error(marker),
  ])('rejects dirty fields without serializing them: case %#', fields => {
    const out = capture(), log = createSafeLogger('attachments', { failed: 'error' })
    log('failed', fields as SafeLogFields)
    expect(out.lines.join('\n')).not.toContain(marker)
    expect(out.records()).toMatchObject([{ event: 'log_input_rejected', reason: 'log_input_rejected', level: 'WARNING', count: 1 }])
    expect(log.snapshot()).toEqual({ accepted: 0, rejected: 1, write_failed: 0 })
  })

  it('never calls getters, toJSON, or coercion on event/fields and catches proxy failures', () => {
    const out = capture(), log = createSafeLogger('attachments', { failed: 'error' })
    const getter = vi.fn(() => marker), toJSON = vi.fn(() => marker), toString = vi.fn(() => marker)
    const circular: Record<string, unknown> = {}; circular.self = circular
    for (const fields of [Object.defineProperty({}, 'count', { get: getter }), { toJSON }, circular,
      new Proxy({}, { ownKeys: () => { throw new Error(marker) } }),
      Object.create({ count: marker }), { [Symbol(marker)]: marker }]) log('failed', fields as SafeLogFields)
    log({ toString } as unknown as 'failed')
    log(marker as 'failed')
    expect(getter).not.toHaveBeenCalled(); expect(toJSON).not.toHaveBeenCalled(); expect(toString).not.toHaveBeenCalled()
    expect(out.lines.join('\n')).not.toContain(marker)
    expect(log.snapshot()).toEqual({ accepted: 0, rejected: 8, write_failed: 0 })
  })

  it('does not let an unavailable diagnostic outlet change a business outcome', () => {
    const write = vi.spyOn(console, 'error').mockImplementation(() => { throw new Error(marker) })
    const fallback = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const log = createSafeLogger('attachments', { failed: 'error' })
    expect(() => log('failed')).not.toThrow()
    expect(write).toHaveBeenCalledTimes(1); expect(fallback).not.toHaveBeenCalled()
    expect(log.snapshot()).toEqual({ accepted: 1, rejected: 0, write_failed: 1 })
  })

  it('snapshots the source definition and refuses invalid logger definitions with fixed errors', () => {
    const out = capture(), definitions = { failed: 'error' as const }, log = createSafeLogger('attachments', definitions)
    Object.assign(definitions, { failed: marker })
    log('failed')
    expect(out.records()[0]).toMatchObject({ level: 'ERROR', event: 'failed' })
    for (const [name, defs] of [[marker, { failed: 'error' }], ['attachments', { [marker]: 'error' }], ['attachments', {}]]) {
      expect(() => createSafeLogger(name as string, defs as Record<string, 'error'>)).toThrow('Invalid safe log definition')
    }
  })
})
