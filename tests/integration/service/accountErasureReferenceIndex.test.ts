import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

let db: pg.Client
beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw Error('Disposable loopback database required')
  db = new pg.Client({ connectionString: url.href }); await db.connect()
})
afterAll(async () => { await db?.end() })

describe('erasure reference projection', () => {
  it('preserves every legacy text comparison, including non-string recipient elements', async () => {
    for (const [payload, expected] of [
      [{}, []],
      [{ agent_user_id: 'agent', sender_user_id: 'sender', reply_to_sender_user_id: 'peer', to_user_ids: ['reader', '*', null, 42] }, ['agent', 'sender', 'peer', 'reader', '*', '42']],
      [{ agent_user_id: 42, to_user_ids: { invalid: true } }, ['42']],
      [{ to_user_ids: ['same', 'same'] }, ['same', 'same']],
    ]) {
      const { rows } = await db.query('SELECT account_erasure_private.command_reference_user_ids($1::jsonb) AS ids', [JSON.stringify(payload)])
      expect(rows[0].ids).toEqual(expected)
    }
  })
  it('permits index-expression evaluation by writers without opening erasure or a public-schema helper', async () => {
    for (const role of ['authenticated', 'service_role']) {
      expect((await db.query(`SELECT has_function_privilege($1,'account_erasure_private.command_reference_user_ids(jsonb)','EXECUTE') AS ok`, [role])).rows[0].ok).toBe(true)
      expect((await db.query(`SELECT has_function_privilege($1,'identity.erase_human_account(text)','EXECUTE') AS ok`, [role])).rows[0].ok).toBe(false)
    }
    expect((await db.query(`SELECT has_function_privilege('anon','account_erasure_private.command_reference_user_ids(jsonb)','EXECUTE') AS ok`)).rows[0].ok).toBe(false)
  })
  it('finds historical recipients after their membership has been removed', async () => {
    await db.query('BEGIN')
    try {
      const [owner, peer, room, message] = Array.from({ length: 4 }, randomUUID)
      for (const id of [owner, peer]) await db.query(`INSERT INTO auth.users(id,aud,role,email,created_at) VALUES($1,'authenticated','authenticated',$2,now())`, [id, `${id}@erasure.invalid`])
      await db.query(`INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','Historical references',$2)`, [room, peer])
      for (const id of [owner, peer]) await db.query(`INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,$3)`, [room, id, id === peer ? 'owner' : 'member'])
      await db.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content,to_user_ids,deleted_for_user_ids) VALUES($1,$2,$3,'Retained peer content',$4,$5::jsonb)`, [message, room, peer, [owner, peer], JSON.stringify([owner])])
      await db.query('DELETE FROM chat.chat_members WHERE chat_id=$1 AND user_id=$2', [room, owner])
      await db.query('DELETE FROM auth.users WHERE id=$1', [owner])
      expect((await db.query('SELECT content,to_user_ids,deleted_for_user_ids FROM chat.messages WHERE id=$1', [message])).rows).toEqual([{ content: 'Retained peer content', to_user_ids: [peer], deleted_for_user_ids: [] }])
    } finally { await db.query('ROLLBACK') }
  })
})
