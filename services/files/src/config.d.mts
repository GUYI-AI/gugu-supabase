export interface Rate {
  perSecond: number
  burst: number
}

export interface FilesConfig {
  host: string
  port: number
  adminHost: string
  adminPort: number
  dbUrl: string
  dbPoolMax: number
  jwksUrl: string | null
  jwtSecret: Uint8Array | null
  jwtIssuer: string | null
  /** Service secret for the internal POST /inspect; null answers 503. */
  inspectSecret: string | null
  timeoutMs: number
  debounceMs: number
  maxDebounceMs: number
  maxFileBytes: number
  maxFrameBytes: number
  maxBodyBytes: number
  rateUpdates: Rate
  rateBytes: Rate
  rateAwareness: Rate
  compactRatio: number
  compactMinBytes: number
  /** 文件开着时的热压缩(F71):ystate > max(ratio × 正文, minBytes) 才压;两次尝试至少隔 cooldown;排空最多等 drainMs。 */
  hotCompactRatio: number
  hotCompactMinBytes: number
  hotCompactCooldownMs: number
  compactDrainMs: number
  roundIdleMs: number
  storeWaitsHistoryMs: number
  logLevel: 'debug' | 'info' | 'warn' | 'error'
}

export function loadConfig(env?: NodeJS.ProcessEnv): FilesConfig
