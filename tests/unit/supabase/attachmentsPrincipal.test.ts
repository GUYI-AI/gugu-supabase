// The attachments function says "sign in first" only when the caller is signed out; a database or PostgREST failure is a 503.
import { describe, expect, it } from 'vitest'
import { principalOf, Refusal, type Rpc } from '../../../supabase/functions/_shared/attachments-core'

const answering = (data: unknown, error: { message: string; status?: number } | null): Rpc => async () => ({ data, error })
const refusal = async (rpc: Rpc) => {
  const error = await principalOf(rpc).then(() => null, (e) => e)
  expect(error).toBeInstanceOf(Refusal)
  return { status: (error as Refusal).status, code: (error as Refusal).code }
}

describe('principalOf', () => {
  it('answers the signed-in id', async () => {
    expect(await principalOf(answering('u1', null))).toBe('u1')
  })
  it('a token PostgREST refuses (401) or a principal the database does not recognise is signed out', async () => {
    expect(await refusal(answering(null, { message: 'JWT expired', status: 401 }))).toEqual({ status: 401, code: 'denied' })
    expect(await refusal(answering(null, null))).toEqual({ status: 401, code: 'denied' })
  })
  it('a database timeout, PostgREST 5xx or an unreachable PostgREST is unavailable, not signed out', async () => {
    for (const status of [500, 502, 503, 504, 0, undefined]) {
      expect(await refusal(answering(null, { message: 'canceling statement due to statement timeout', status })))
        .toEqual({ status: 503, code: 'unavailable' })
    }
  })
})
