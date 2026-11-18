import { randomUUID } from 'node:crypto'
import { Client } from 'pg'
import { expect, it } from 'vitest'
import { BEGIN_READING_REVISIONS } from '../../support/revisionTransaction'

it('keeps contact and group aliases private, synchronized and backward compatible', async () => {
  const url = process.env.GUGU_INTEGRATION_DATABASE_URL ?? ''
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)) {
    throw new Error('privateDisplayOverrides requires a disposable loopback database')
  }
  const db = new Client({ connectionString: url })
  await db.connect()
  const [owner, member, stranger, group, direct] = Array.from({ length: 5 }, () => randomUUID())
  const q = async (sql: string, values: unknown[] = []) => (await db.query(sql, values)).rows
  const as = async (user: string) => {
    await q('RESET ROLE')
    await q("SELECT set_config('request.jwt.claim.sub', $1, true)", [user])
    await q('SET LOCAL ROLE authenticated')
  }
  const denied = async (sql: string, values: unknown[] = []) => {
    await q('SAVEPOINT denied_write')
    await expect(q(sql, values)).rejects.toThrow()
    await q('ROLLBACK TO SAVEPOINT denied_write')
  }
  try {
    await q(BEGIN_READING_REVISIONS)
    await q('INSERT INTO auth.users(id, created_at) SELECT id, now() FROM unnest($1::uuid[]) id', [[owner, member, stranger]])
    await q("INSERT INTO chat.chats(id, kind, name, creator_user_id) VALUES ($1,'group','Shared group',$3),($2,'dm',NULL,$3)", [group, direct, owner])
    await q("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'member'),($4,$2,'owner')", [group, owner, member, direct])
    const start = await q('SELECT user_id, revision::text FROM chat.account_revision_heads WHERE user_id = ANY($1::text[])', [[owner, member, stranger]])
    const boundaries = new Map(start.map(row => [row.user_id, BigInt(row.revision)]))
    await as(owner)
    // The unchanged, deployed contact upsert still writes the very same table.
    const oldUpsert = `INSERT INTO identity.contact_overrides(owner_user_id,contact_user_id,alias)
      VALUES ($1,$2,$3) ON CONFLICT(owner_user_id,contact_user_id) DO UPDATE SET alias=EXCLUDED.alias`
    await q(oldUpsert, [owner, member, 'My friend'])
    const upsert = `INSERT INTO identity.contact_overrides(owner_user_id,target_kind,group_chat_id,alias)
      VALUES ($1,'group',$2,$3) ON CONFLICT(owner_user_id,target_kind,target_id) DO UPDATE SET alias=EXCLUDED.alias`
    await q(upsert, [owner, group, 'My group'])
    await q(upsert, [owner, group, 'My renamed group'])
    await q(upsert, [owner, group, 'My renamed group']) // No redundant revision.
    const snapshot = (await q('SELECT chat.sync_snapshot() AS data'))[0].data
    expect(snapshot.overrides).toEqual(expect.arrayContaining([
      expect.objectContaining({ target_kind: 'contact', target_id: member, alias: 'My friend' }),
      expect.objectContaining({ target_kind: 'group', target_id: group, alias: 'My renamed group' }),
    ]))
    await denied(upsert, [owner, direct, 'Not a group'])
    await denied(upsert, [owner, group, 'x'.repeat(81)])
    await denied('UPDATE identity.contact_overrides SET contact_user_id=$1 WHERE target_kind=\'group\'', [member])
    await as(member)
    expect(await q('SELECT * FROM identity.contact_overrides')).toEqual([])
    expect((await q('SELECT chat.sync_snapshot() AS data'))[0].data.overrides).toEqual([])
    await denied(upsert, [owner, group, 'Write another owner'])
    await q(upsert, [member, group, 'Independent alias'])
    await as(stranger)
    await denied(upsert, [stranger, group, 'Not a member'])
    await as(owner)
    await q('DELETE FROM identity.contact_overrides WHERE owner_user_id=$1', [owner])
    expect((await q('SELECT chat.sync_snapshot() AS data'))[0].data.overrides).toEqual([])
    expect((await q('SELECT name FROM chat.chats WHERE id=$1', [group]))[0].name).toBe('Shared group')
    await q('RESET ROLE')
    const revisions = await q("SELECT user_id,event,resource_key,tombstone,revision::text FROM chat.account_revisions WHERE user_id=ANY($1::text[]) ORDER BY user_id,revision", [[owner, member, stranger]])
    const changed = revisions.filter(row => BigInt(row.revision) > (boundaries.get(row.user_id) ?? 0n))
    const own = changed.filter(row => row.user_id === owner)
    expect(own.filter(row => !row.tombstone).map(row => [row.event, row.resource_key])).toEqual([
      ['friendship_changed', { contact_user_id: member }],
      ['chat_meta_changed', { chat_id: group }],
      ['chat_meta_changed', { chat_id: group }],
    ])
    expect(own.filter(row => row.tombstone).map(row => [row.event, row.resource_key])).toEqual(expect.arrayContaining([
      ['friendship_changed', { contact_user_id: member }],
      ['chat_meta_changed', { chat_id: group }],
    ]))
    expect(own).toHaveLength(5)
    expect(changed.filter(row => row.user_id !== owner)).toEqual([
      expect.objectContaining({ user_id: member, event: 'chat_meta_changed', resource_key: { chat_id: group } }),
    ])
    // Group deletion cascades through the same target FK.
    await q('DELETE FROM chat.chats WHERE id=$1', [group])
    expect(await q('SELECT * FROM identity.contact_overrides WHERE target_kind=\'group\'')).toEqual([])
  } finally {
    await db.query('ROLLBACK')
    await db.end()
  }
})
