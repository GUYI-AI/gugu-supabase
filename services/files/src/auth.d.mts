import type { Pool } from 'pg'

export const SUBPROTOCOL: 'gugu-files.v1'
export function isUuid(value: unknown): value is string
export class Denied extends Error {
  constructor(reason: string, status?: number)
  reason: string
  status: number
}
export function offeredProtocols(header: string | null | undefined): string[]
export function bearerFromProtocols(offered: string[]): string | null
export function asAgentFromProtocols(offered: string[]): string | null
export function bearerFromAuthorization(header: string | null | undefined): string | null

export interface Identity {
  userId: string
  exp: number
  sessionId: string | null
}
export function createVerifier(options: {
  jwksUrl: string | null
  jwtSecret: Uint8Array | null
  jwtIssuer: string | null
}): (token: string | null) => Promise<Identity>

export interface Grant {
  chatId: string
  epoch: number
  contentType: string
  kind: string
  actorId: string
  actorName: string
  teamSessionRequired: boolean
}
export function authorizeItem(pool: Pool, itemId: string, userId: string, asAgent: string | null, sessionId?: string | null): Promise<Grant>
