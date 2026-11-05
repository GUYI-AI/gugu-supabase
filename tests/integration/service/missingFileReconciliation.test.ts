import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply, digest, objectPath, rollback, scan } from '../../../scripts/reconcile-missing-attachments.mjs'

const url = process.env.GUGU_INTEGRATION_DATABASE_URL ?? ''
let db: pg.Client
beforeAll(async () => {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) throw Error('Requires a disposable loopback database')
  db = new pg.Client({ connectionString: url }); await db.connect()
})
afterAll(async () => { await db?.end() })
describe('reversible physical reconciliation', () => {
  it('checks actual files, marks only the ledger, restores both existing and newly inserted rows, and refuses stale candidates', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'missing-file-reconcile-')), owner = randomUUID()
    const records = ['control', 'tracked', 'untracked'].map(label => ({ id: randomUUID(), bucket_id: 'chat-media', name: `${owner}/${label}.txt`, version: randomUUID() }))
    const storage = { root, tenant: 'fixture', storageBucket: 'fixture', separator: '/' }
    try {
      await db.query("INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data) VALUES($1,'authenticated','authenticated',$2,'{\"provider\":\"email\"}','{}')", [owner, owner + '@reconciliation.invalid'])
      for (const row of records) await db.query("INSERT INTO storage.objects(id,bucket_id,name,version,owner,owner_id,metadata) VALUES($1,$2,$3,$4,$5::uuid,$5::text,'{\"size\":1,\"mimetype\":\"text/plain\"}')", [row.id, row.bucket_id, row.name, row.version, owner])
      await db.query("INSERT INTO chat.file_transfer_storage(bucket_id,object_name,size_bytes,owner_account) VALUES('chat-media',$1,1,$2)", [records[1].name, owner])
      const controlPath = objectPath(storage, records[0])
      await mkdir(path.dirname(controlPath), { recursive: true }); await writeFile(controlPath, 'x')
      const before = (await db.query('SELECT to_jsonb(o) AS o FROM storage.objects o WHERE id=ANY($1::uuid[]) ORDER BY id', [records.map(row => row.id)])).rows
      const ledgerBefore = (await db.query('SELECT to_jsonb(s) AS s FROM chat.file_transfer_storage s WHERE owner_account=$1 ORDER BY id', [owner])).rows
      const manifest = await scan(db, url, { ...storage, control: records[0].id, buckets: ['chat-media'], owner })
      expect(manifest.entries.map(row => row.id).sort()).toEqual(records.slice(1).map(row => row.id).sort())
      const backupFile = path.join(root, 'before.json')
      const result = await apply(db, url, manifest, backupFile, digest(manifest))
      expect(result.marked).toBe(2)
      expect((await db.query('SELECT state FROM chat.file_transfer_storage WHERE owner_account=$1', [owner])).rows).toEqual([{ state: 'gone' }, { state: 'gone' }])
      expect((await db.query('SELECT to_jsonb(o) AS o FROM storage.objects o WHERE id=ANY($1::uuid[]) ORDER BY id', [records.map(row => row.id)])).rows).toEqual(before)
      const backup = JSON.parse(await readFile(backupFile, 'utf8'))
      expect(await rollback(db, url, backup, result.backupDigest)).toEqual({ restored: 2 })
      expect((await db.query('SELECT to_jsonb(s) AS s FROM chat.file_transfer_storage s WHERE owner_account=$1 ORDER BY id', [owner])).rows).toEqual(ledgerBefore)
      // The same path can reappear between review and apply: reject it without classifying it missing.
      const restoredPath = objectPath(storage, records[1])
      await mkdir(path.dirname(restoredPath), { recursive: true }); await writeFile(restoredPath, 'x')
      await expect(apply(db, url, manifest, path.join(root, 'stale.json'), digest(manifest))).rejects.toThrow('candidate now exists')
      expect((await db.query('SELECT to_jsonb(s) AS s FROM chat.file_transfer_storage s WHERE owner_account=$1 ORDER BY id', [owner])).rows).toEqual(ledgerBefore)
    } finally {
      // Only this disposable loopback fixture is changed. The owning test-db stop removes the database.
      await rm(root, { recursive: true, force: true })
    }
  })
})
