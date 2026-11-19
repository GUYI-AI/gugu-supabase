import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

let db: Client
beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
      || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Account erasure checks require a disposable loopback database')
  }
  db = new Client({ connectionString: url.href })
  await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => { await db.query('BEGIN') })
afterEach(async () => { await db.query('ROLLBACK') })

describe('account-erasure foreign-key lookups', () => {
  it('has valid leading B-tree keys with predicates implied by foreign-key equality', async () => {
    const expected = [
      ['chat.message_agent_wakes', 'agent_user_id', 'idx_message_agent_wakes_agent_user_id', null],
      ['identity.assistant_panel_changes', 'owner_user_id', 'idx_assistant_panel_changes_owner_user_id', null],
      ['chat.workspace_item_versions', 'made_by', 'workspace_item_versions_made_by_idx', '(made_by IS NOT NULL)'],
      ['identity.users', 'owner_user_id', 'idx_users_owner_user_id', '(owner_user_id IS NOT NULL)'],
    ]
    for (const [table, column, index, predicate] of expected) {
      const result = await db.query(`SELECT a.attname, am.amname, i.indisvalid, i.indisready,
          pg_get_expr(i.indpred, i.indrelid) AS predicate
        FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
        JOIN pg_am am ON am.oid=c.relam
        JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=i.indkey[0]
        WHERE i.indrelid=$1::regclass AND c.relname=$2`, [table, index])
      expect(result.rows).toEqual([{ attname: column, amname: 'btree', indisvalid: true, indisready: true, predicate }])
    }
  })

  it('auth deletion cascades through multiple owned agents and leaves version contents with NULL authors', async () => {
    const [owner, peer, device, agentA, agentB, otherAgent, room, message] = Array.from({ length: 8 }, randomUUID)
    for (const id of [owner, peer]) {
      await db.query(`INSERT INTO auth.users(id,aud,role,email,created_at,updated_at)
        VALUES($1,'authenticated','authenticated',$2,now(),now())`, [id, `${id}@erasure-fk.invalid`])
    }
    for (const id of [owner, peer]) {
      await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform)
        VALUES($1,$2,'erasure fixture','fixture','linux')`, [`${device}-${id}`, id])
    }
    for (const [id, parent] of [[agentA, owner], [agentB, owner], [otherAgent, peer]]) {
      await db.query(`INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id)
        VALUES($1,'agent','Erasure fixture',$2,$3)`, [id, parent, `${device}-${parent}`])
    }
    await db.query(`INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','Retained room',$2)`, [room, peer])
    for (const id of [owner, peer, agentA, agentB, otherAgent]) {
      await db.query(`INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,$3)`, [room, id, id === peer ? 'owner' : 'member'])
    }
    await db.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES($1,$2,$3,'Retained message')`, [message, room, peer])
    for (const id of [agentA, agentB, otherAgent]) {
      await db.query(`INSERT INTO chat.message_agent_wakes(message_id,agent_user_id) VALUES($1,$2)
        ON CONFLICT DO NOTHING`, [message, id])
    }
    // The owner cascade must also reach applied/runtime rows, outside the pending index.
    const changes: string[] = []
    for (const [assistant, parent, source, status] of [
      [agentA, owner, 'panel', 'pending'], [agentB, owner, 'runtime', 'applied'],
      [otherAgent, peer, 'runtime', 'applied'],
    ]) {
      const operation = randomUUID(); changes.push(operation)
      await db.query(`INSERT INTO identity.assistant_panel_changes(operation_id,assistant_user_id,owner_user_id,
        domain,resource_key,source,operation,expected_item_revision,request_hash,payload,status)
        VALUES($1,$2,$3,'personality','current',$4,'save',0,'fixture','{}',$5)`, [operation, assistant, parent, source, status])
    }
    const item = (await db.query(`INSERT INTO chat.workspace_items(chat_id,kind,filename,content_type,
      inline_text,size_bytes,created_by) VALUES($1,'document','retained.md','text/markdown','history',7,$2) RETURNING id`, [room, peer])).rows[0].id
    for (const [i, author] of [owner, agentA, agentB, peer, null].entries()) {
      await db.query(`INSERT INTO chat.workspace_item_versions(item_id,n,inline_text,content_type,size_bytes,made_by)
        VALUES($1,$2,'history','text/markdown',7,$3)`, [item, i + 10, author])
    }
    const versions = (await db.query('SELECT * FROM chat.workspace_item_versions WHERE item_id=$1 ORDER BY n', [item])).rows
    // Removed agents and their historical references still participate in erasure.
    await db.query('UPDATE identity.users SET removed_at=now() WHERE id=$1', [agentB])

    await db.query('DELETE FROM auth.users WHERE id=$1', [owner])

    expect((await db.query('SELECT id FROM identity.users WHERE id=ANY($1)', [[owner, agentA, agentB]])).rows).toEqual([])
    expect((await db.query('SELECT id FROM identity.users WHERE id=ANY($1) ORDER BY id', [[peer, otherAgent]])).rows).toHaveLength(2)
    expect((await db.query('SELECT agent_user_id FROM chat.message_agent_wakes WHERE message_id=$1', [message])).rows).toEqual([{ agent_user_id: otherAgent }])
    expect((await db.query('SELECT operation_id FROM identity.assistant_panel_changes WHERE operation_id=ANY($1)', [changes])).rows).toEqual([{ operation_id: changes[2] }])
    expect((await db.query('SELECT * FROM chat.workspace_item_versions WHERE item_id=$1 ORDER BY n', [item])).rows)
      .toEqual(versions.map(row => ({ ...row, made_by: [owner, agentA, agentB].includes(row.made_by) ? null : row.made_by })))
    expect((await db.query('SELECT content FROM chat.messages WHERE id=$1', [message])).rows).toEqual([{ content: 'Retained message' }])
  })
})
