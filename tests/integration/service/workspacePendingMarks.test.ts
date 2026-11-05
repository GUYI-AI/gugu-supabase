import { randomUUID } from 'node:crypto'
import pg from 'pg'
import * as Y from 'yjs'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createFixtureGroup } from '../../support/groupFixture'

let db: pg.Client
let owner: string
let chats: string[]
let items: Set<string>

async function asUser() {
  await db.query('SET LOCAL ROLE authenticated')
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: owner, role: 'authenticated' })])
}

async function document(name: string, text: string, chat = chats[0]!) {
  await asUser()
  const { rows } = await db.query<{ id: string }>(
    'SELECT id FROM chat.workspace_create_document_as($1,$2,$3,$4)', [chat, owner, name, text])
  const id = rows[0]!.id
  items.add(id)
  return id
}

async function selected() {
  await db.query('RESET ROLE')
  await db.query("SELECT set_config('request.jwt.claims','',true)")
  await db.query('SET LOCAL ROLE gugu_files')
  const { rows } = await db.query<{ id: string }>(
    `SELECT id::text AS id FROM chat.workspace_items
      WHERE kind = 'document' AND ystate IS NULL AND inline_text LIKE '%"$text"%'`)
  return rows.map(row => row.id).filter(id => items.has(id)).sort()
}

beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('Pending marker checks require a disposable loopback database')
  }
  db = new pg.Client({ connectionString: url.href })
  await db.connect()
})
afterAll(async () => { await db?.end() })
beforeEach(async () => {
  await db.query('BEGIN')
  await db.query("DO $$ BEGIN EXECUTE format('GRANT gugu_files TO %I', current_user); END $$")
  owner = randomUUID()
  chats = [randomUUID(), randomUUID()]
  items = new Set()
  await db.query(`INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES($1,'authenticated','authenticated',$2,'{"provider":"email","providers":["email"]}','{}',now(),now())`,
  [owner, `${owner}@pending-marks.invalid`])
  await asUser()
  for (const chat of chats) await createFixtureGroup(db, [chat, 'Pending marker fixture', owner, '[]'])
})
afterEach(async () => {
  await db.query('RESET ROLE')
  await db.query('ROLLBACK')
})

describe('file-service pending-marker selection', () => {
  it('retains the literal marker predicate and scans pending documents across chats', async () => {
    const a = await document('one.txt', '{"$text":"first"}')
    const b = await document('two.txt', 'literal "$text" remains a match', chats[1])
    await document('unquoted.txt', '$text is not the quoted marker')
    await document('plain.txt', 'ordinary text', chats[1])
    expect(await selected()).toEqual([a, b].sort())
  })

  it('tracks marker insertion, removal and non-null state without changing the selected IDs', async () => {
    const id = await document('transition.txt', 'ordinary text')
    expect(await selected()).toEqual([])
    await db.query('SET LOCAL ROLE gugu_files')
    await db.query('UPDATE chat.workspace_items SET inline_text=$1 WHERE id=$2', ['{"$text":"pending"}', id])
    expect(await selected()).toEqual([id])
    await db.query('SET LOCAL ROLE gugu_files')
    await db.query('UPDATE chat.workspace_items SET inline_text=$1 WHERE id=$2', ['projected text', id])
    expect(await selected()).toEqual([])
    await db.query('SET LOCAL ROLE gugu_files')
    await db.query('UPDATE chat.workspace_items SET inline_text=$1 WHERE id=$2', ['{"$text":"pending again"}', id])
    expect(await selected()).toEqual([id])
    const doc = new Y.Doc()
    const state = Buffer.from(Y.encodeStateAsUpdate(doc))
    doc.destroy()
    await db.query('UPDATE chat.workspace_items SET ystate=$1 WHERE id=$2', [state, id])
    expect(await selected()).toEqual([])
    await db.query('UPDATE chat.workspace_items SET ystate=NULL WHERE id=$1', [id])
    expect(await selected()).toEqual([id])
  })

  it('drops deleted pending documents while leaving another chat\'s selection unchanged', async () => {
    const removed = await document('removed.txt', '{"$text":"removed"}')
    const retained = await document('retained.txt', '{"$text":"retained"}', chats[1])
    expect(await selected()).toEqual([removed, retained].sort())
    await asUser()
    await db.query('SELECT chat.workspace_delete_as($1,$2)', [removed, owner])
    expect(await selected()).toEqual([retained])
  })
})
