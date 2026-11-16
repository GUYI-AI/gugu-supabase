/** Fixed diagnostic events. Never pass requests, identities or exceptions to this module. */
export type SafeLogLevel = 'info' | 'warn' | 'error'
export interface SafeLogFields {
  count?: number
  status?: number
  duration_ms?: number
  claimed?: number | null
  deleted?: number
  finished?: number
  failed?: number
  entry?: 'kick' | 'file-accept'
  outcome?: 'completed' | 'error'
}

export interface SafeLogger<Event extends string> {
  (event: Event, fields?: SafeLogFields): void
  snapshot(): Readonly<{ accepted: number; rejected: number; write_failed: number }>
}

const NAME = /^[a-z][a-z0-9_-]{0,63}$/
const COUNTERS = new Set(['count', 'claimed', 'deleted', 'finished', 'failed'])
const FIELDS = new Set([...COUNTERS, 'status', 'duration_ms', 'entry', 'outcome'])
const MAX_COUNT = Number.MAX_SAFE_INTEGER

function fieldsOf(input: unknown): SafeLogFields | null {
  if (typeof input !== 'object' || input === null) return null
  const proto = Object.getPrototypeOf(input)
  if (proto !== Object.prototype && proto !== null) return null
  const out: Record<string, number | string | null> = {}
  // Descriptors avoid getters and toJSON; proxy traps are caught by the caller.
  for (const key of Reflect.ownKeys(input)) {
    if (typeof key !== 'string' || !FIELDS.has(key)) return null
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return null
    const value = descriptor.value
    if (value === undefined) continue
    if (key === 'claimed' && value === null) { out[key] = null; continue }
    if (key === 'entry') {
      if (value !== 'kick' && value !== 'file-accept') return null
    } else if (key === 'outcome') {
      if (value !== 'completed' && value !== 'error') return null
    } else {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_COUNT) return null
      if (key !== 'duration_ms' && !Number.isSafeInteger(value)) return null
      if (key === 'status' && (value < 100 || value > 599)) return null
    }
    out[key] = value
  }
  return out as SafeLogFields
}

/** Definitions are source-controlled literals at each call site, never request-derived configuration. */
export function createSafeLogger<const Events extends Record<string, SafeLogLevel>>(
  functionName: string,
  definitions: Events,
): SafeLogger<Extract<keyof Events, string>> {
  if (!NAME.test(functionName)) throw new Error('Invalid safe log definition')
  const events = new Map<string, SafeLogLevel>()
  for (const key of Reflect.ownKeys(definitions)) {
    const descriptor = Object.getOwnPropertyDescriptor(definitions, key)
    const level = descriptor?.value
    if (typeof key !== 'string' || !NAME.test(key) || !descriptor || !Object.hasOwn(descriptor, 'value')
      || !['info', 'warn', 'error'].includes(level)) throw new Error('Invalid safe log definition')
    events.set(key, level)
  }
  if (!events.size) throw new Error('Invalid safe log definition')
  const bootId = crypto.randomUUID()
  let sequence = 0
  const stats = { accepted: 0, rejected: 0, write_failed: 0 }
  const write = (event: string, level: SafeLogLevel, fields: SafeLogFields) => {
    try {
      // Only this newly built object is serialized. No input object or toJSON reaches JSON.stringify.
      const record: Record<string, unknown> = {
        schema_version: 1, service: 'edge', boot_id: bootId, sequence: ++sequence,
        emitted_at: new Date().toISOString(), function: functionName, event,
        level: level === 'info' ? 'INFO' : level === 'warn' ? 'WARNING' : 'ERROR',
        count: fields.count ?? 1, reason: event,
      }
      for (const key of FIELDS) {
        if (key !== 'count' && Object.hasOwn(fields, key)) record[key] = fields[key as keyof SafeLogFields]
      }
      const line = JSON.stringify(record)
      if (level === 'error') console.error(line)
      else if (level === 'warn') console.warn(line)
      else console.log(line)
    } catch {
      // A failed diagnostic write must not replace a business result or fall back to raw stderr.
      stats.write_failed++
    }
  }
  const logger = (event: string, input: unknown = {}) => {
    try {
      const level = typeof event === 'string' ? events.get(event) : undefined
      const fields = fieldsOf(input)
      if (level && fields) {
        stats.accepted++
        write(event, level, fields)
        return
      }
    } catch { /* No exception object is retained or printed. */ }
    stats.rejected++
    write('log_input_rejected', 'warn', { count: 1 })
  }
  return Object.assign(logger, { snapshot: () => Object.freeze({ ...stats }) })
}
