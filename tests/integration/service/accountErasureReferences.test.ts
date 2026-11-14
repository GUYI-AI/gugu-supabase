import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

let db: pg.Client, owner: string, peer: string, third: string, agent: string, room: string, device: string
beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw Error('Disposable loopback database required')
  db = new pg.Client({ connectionString: url.href }); await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  ;[owner, peer, third, agent, room, device] = Array.from({ length: 6 }, randomUUID)
  for (const id of [owner, peer, third]) await db.query(`INSERT INTO auth.users(id,aud,role,email,created_at)
    VALUES($1,'authenticated','authenticated',$2,now())`, [id, `${id}@erasure.invalid`])
  await db.query(`INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform)
    VALUES($1,$2,'fixture','fixture','linux')`, [device, owner])
  await db.query(`INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id)
    VALUES($1,'agent','Erasure fixture',$2,$3)`, [agent, owner, device])
  await db.query(`INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','Shared room',$2)`, [room, peer])
  for (const id of [owner, peer, third, agent]) await db.query(`INSERT INTO chat.chat_members(chat_id,user_id,role)
    VALUES($1,$2,$3)`, [room, id, id === peer ? 'owner' : 'member'])
})
afterEach(async () => { await db.query('ROLLBACK') })

// Scan base tables, including private/adoption schemas. This is evidence, never
// a production erasure algorithm. Logs/transport events have separate lifetimes.
async function remnants(ids: string[]) {
  const columns = (await db.query(`SELECT c.table_schema s,c.table_name t,c.column_name c,c.udt_name u
    FROM information_schema.columns c JOIN information_schema.tables t USING(table_schema,table_name)
    WHERE t.table_type='BASE TABLE' AND c.table_schema NOT IN ('pg_catalog','information_schema','realtime','cron','net')
      AND (c.table_schema,c.table_name)<>('auth','audit_log_entries')
      AND c.udt_name IN ('text','uuid','varchar','_text','_uuid')
      AND c.column_name ~ '(user|owner|sender|creator|author|actor|member|agent|invite|recipient|peer|subject|_by$|account)'`)).rows
  const found: string[] = []
  for (const { s, t, c, u } of columns) {
    const quote = (x: string) => '"' + x.replaceAll('"', '""') + '"'
    const column = quote(c), table = `${quote(s)}.${quote(t)}`
    const condition = u.startsWith('_') ? `${column}::text[] && $1::text[]` : `${column}::text=ANY($1)`
    if ((await db.query(`SELECT 1 FROM ${table} WHERE ${condition} LIMIT 1`, [ids])).rows.length) found.push(`${s}.${t}.${c}`)
  }
  return found.sort()
}

describe('auth account erasure removes residual references without losing shared content', () => {
  it('deletes a revoked attachment after its blob has been collected, including an archived owned agent', async () => {
    await db.query(`INSERT INTO chat.session_attachments(id,owner_user_id,sender_user_id,sender_session_id,
      recipient_user_ids,blob_id,staging_key,file_name,revoked_at)
      VALUES($1,$2,$3,'fixture-session',$4,NULL,$5,'collected.txt',now())`, [randomUUID(), owner, agent, [peer], randomUUID()])
    await db.query('UPDATE identity.users SET removed_at=now() WHERE id=$1', [agent])
    await db.query('DELETE FROM auth.users WHERE id=$1', [owner])
    expect(await remnants([owner, agent])).toEqual([])
    expect((await db.query('SELECT id FROM auth.users WHERE id=$1', [peer])).rows).toHaveLength(1)
    expect((await db.query('SELECT * FROM identity.account_lifecycle_context')).rows).toEqual([])
  })

  it('preserves shared file metadata, clears attribution permanently, and erases private historical tables', async () => {
    const item = (await db.query(`INSERT INTO chat.workspace_items(chat_id,kind,filename,content_type,inline_text,size_bytes,created_by,updated_by)
      VALUES($1,'document','shared.md','text/markdown','retained',8,$2,$3) RETURNING id,version,updated_at`, [room, peer, owner])).rows[0]
    const message = randomUUID(), upload = randomUUID(), stored = randomUUID(), temporary = randomUUID()
    await db.query(`INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES($1,$2,$3,'Shared peer message')`, [message, room, peer])
    await db.query(`INSERT INTO chat.message_agent_delivery_blocks(message_id,agent_user_id) VALUES($1,$2)`, [message, agent])
    await db.query(`INSERT INTO chat.file_transfer_reservations(id,kind,account_id,subject,bytes,expires_at)
      VALUES($1,'upload',$2,'fixture',8,now()+interval '1 hour')`, [upload, owner])
    await db.query(`INSERT INTO chat.file_transfer_uploads(staging_key,reservation_id,account_id,actor_id,max_bytes)
      VALUES($1::text,$1::uuid,$2,$3,8)`, [upload, owner, agent])
    await db.query(`INSERT INTO chat.file_transfer_storage(id,owner_account,bucket_id,object_name,size_bytes)
      VALUES($1,$2,'workspace',$3,8)`, [stored, owner, randomUUID()])
    await db.query(`INSERT INTO chat.workspace_item_versions(item_id,n,inline_text,content_type,size_bytes,made_by)
      VALUES($1,10,'retained','text/markdown',8,$2)`, [item.id, owner])
    await db.query(`INSERT INTO chat.file_temporary_transfers(id,item_id,version,chat_id,host_device_id,reader_account,
      reader_actor,source_ref,retention,object_name) VALUES($1,$2,10,$3,'peer-device',$4,$5,'{}','1d',$6)`,
    [temporary, item.id, room, owner, agent, randomUUID()])
    await db.query('INSERT INTO chat.presence_wake_throttles(viewer_user_id,last_sent_at) VALUES($1,now())', [owner])
    await db.query('INSERT INTO identity.gugu_device_removals(device_id,user_id) VALUES($1,$2)', [randomUUID(), owner])
    // These exist only on adopted installations. Test that path as well as the
    // normal fresh-install path where the tables do not exist.
    await db.query('CREATE SCHEMA IF NOT EXISTS chat_private; CREATE SCHEMA IF NOT EXISTS file_private')
    await db.query('CREATE TABLE chat_private.removed_agent_dm_close_backup(agent_user_id text, note text)')
    await db.query('CREATE TABLE file_private.backfill_20261106_local_file_updated_at(updated_by text, note text)')
    await db.query(`INSERT INTO chat_private.removed_agent_dm_close_backup VALUES($1,'mine'),($2,'peer')`, [agent, peer])
    await db.query(`INSERT INTO file_private.backfill_20261106_local_file_updated_at VALUES($1,'mine'),($2,'peer')`, [owner, peer])
    expect(await remnants([owner, agent])).toContain('chat.workspace_items.updated_by')

    await db.query('DELETE FROM auth.users WHERE id=$1', [owner])

    expect(await remnants([owner, agent])).toEqual([])
    expect((await db.query('SELECT inline_text,updated_by,version,updated_at FROM chat.workspace_items WHERE id=$1', [item.id])).rows)
      .toEqual([{ inline_text: 'retained', updated_by: null, version: item.version, updated_at: item.updated_at }])
    await db.query(`UPDATE chat.workspace_items SET filename='renamed.md' WHERE id=$1`, [item.id])
    expect((await db.query('SELECT updated_by FROM chat.workspace_items WHERE id=$1', [item.id])).rows).toEqual([{ updated_by: null }])
    expect((await db.query('SELECT * FROM chat.file_transfer_uploads WHERE staging_key=$1', [upload])).rows).toHaveLength(1)
    expect((await db.query('SELECT size_bytes,owner_account FROM chat.file_transfer_storage WHERE id=$1', [stored])).rows)
      .toEqual([{ size_bytes: '8', owner_account: null }])
    expect((await db.query('SELECT id FROM chat.file_temporary_transfers WHERE id=$1', [temporary])).rows).toHaveLength(1)
    for (const table of ['chat_private.removed_agent_dm_close_backup','file_private.backfill_20261106_local_file_updated_at']) {
      expect((await db.query(`SELECT note FROM ${table}`)).rows).toEqual([{ note: 'peer' }])
    }
    expect((await db.query('SELECT content FROM chat.messages WHERE id=$1', [message])).rows).toEqual([{ content: 'Shared peer message' }])
  })

  it('does not let an API caller forge erasure or clear an ordinary last author', async () => {
    const item = (await db.query(`INSERT INTO chat.workspace_items(chat_id,kind,filename,content_type,inline_text,size_bytes,created_by,updated_by)
      VALUES($1,'document','shared.md','text/markdown','retained',8,$2,$2) RETURNING id`, [room, peer])).rows[0].id
    await db.query('UPDATE chat.workspace_items SET updated_by=NULL WHERE id=$1', [item])
    expect((await db.query('SELECT updated_by FROM chat.workspace_items WHERE id=$1', [item])).rows).toEqual([{ updated_by: peer }])
    for (const role of ['anon','authenticated','service_role']) {
      expect((await db.query(`SELECT has_function_privilege($1,'identity.erase_account_references(text[])','EXECUTE') AS ok`, [role])).rows)
        .toEqual([{ ok: false }])
    }
    await db.query('SAVEPOINT denied')
    await expect(db.query('SELECT identity.erase_account_references($1)', [[owner]])).rejects.toThrow('auth deletion transaction')
    await db.query('ROLLBACK TO denied')
    await db.query('DELETE FROM auth.users WHERE id=$1', [owner])
    expect(await remnants([owner, agent])).toEqual([])
  })
})
