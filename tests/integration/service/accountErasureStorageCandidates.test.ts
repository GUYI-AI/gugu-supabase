import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, expect, it } from 'vitest'

let db: pg.Client
beforeAll(async () => {
  const url = new URL(process.env.GUGU_INTEGRATION_DATABASE_URL ?? '')
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw Error('Disposable loopback database required')
  db = new pg.Client({ connectionString: url.href }); await db.connect()
})
afterAll(async () => { await db?.end() })

it('never invokes the reference predicate for unrelated owners during real Auth deletion', async () => {
  await db.query('BEGIN')
  try {
    const [owner, peer, room] = Array.from({ length: 3 }, randomUUID)
    for (const id of [owner, peer]) await db.query(`INSERT INTO auth.users(id,aud,role,email,created_at)
      VALUES($1,'authenticated','authenticated',$2,now())`, [id, `${id}@erasure.invalid`])
    const original = (await db.query(`SELECT pg_get_functiondef('identity.storage_object_is_referenced(text,text)'::regprocedure) AS body`)).rows[0].body as string
    await db.query(original.replace('identity.storage_object_is_referenced(', 'identity.storage_object_is_referenced_test_original('))
    // A cheap STABLE predicate is deliberately attractive to the planner. It
    // must still never see a row outside the materialized ownership candidates.
    await db.query(`CREATE OR REPLACE FUNCTION identity.storage_object_is_referenced(p_bucket_id text,p_name text)
      RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER COST 1 SET search_path='' AS $$
      BEGIN
        IF p_name LIKE '%/foreign-erasure-fixture-%' THEN
          RAISE EXCEPTION 'unrelated storage object reached the reference predicate';
        END IF;
        RETURN identity.storage_object_is_referenced_test_original(p_bucket_id,p_name);
      END; $$`)
    for (let n = 0; n < 20; n++) await db.query(`INSERT INTO storage.objects(id,bucket_id,name,owner,owner_id)
      VALUES($1,'workspace',$2,$3,$3::text)`, [randomUUID(), `${room}/${peer}/foreign-erasure-fixture-${n}`, peer])
    await db.query('DELETE FROM auth.users WHERE id=$1', [owner])
    expect((await db.query('SELECT 1 FROM auth.users WHERE id=$1', [owner])).rows).toHaveLength(0)
    expect((await db.query(`SELECT count(*)::int AS n FROM storage.objects WHERE bucket_id='workspace' AND name LIKE $1`, [`${room}/${peer}/foreign-erasure-fixture-%`])).rows[0].n).toBe(20)
    expect((await db.query('SELECT 1 FROM auth.users WHERE id=$1', [peer])).rows).toHaveLength(1)
  } finally { await db.query('ROLLBACK') }
})
