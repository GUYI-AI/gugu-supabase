import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { releases } from './foundation.mjs'

// Only this checkout's disposable fixture; no arbitrary database URL or shared data.
const root = fileURLToPath(new URL('../', import.meta.url))
const project = 'gugucommunitytest' + createHash('sha256').update(root).digest('hex').slice(0, 10)
const owner = JSON.parse(readFileSync(new URL('../.local/test-db/owner.json', import.meta.url), 'utf8'))
assert.equal(owner.root, root); assert.equal(owner.project, project)
assert.equal(execFileSync('docker', ['port', 'supabase_db_' + project, '5432/tcp'], { encoding: 'utf8' }).trim(), '127.0.0.1:' + owner.port)
const db = new pg.Client({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${owner.port}/postgres?sslmode=disable` })
const account = randomUUID(), group = randomUUID(), folder = randomUUID(), device = randomUUID()
const count = 2400, warmups = 5, samples = 30
await db.connect()
try {
  const release = releases.find(row => row.version === '20261115080000_file_overall_availability')
  assert.ok(release)
  assert.equal((await db.query('SELECT digest FROM gugu_install.releases WHERE version=$1', [release.version])).rows[0]?.digest, release.digest, 'Install the exact migration before measuring')
  await db.query('BEGIN')
  await db.query("SET LOCAL statement_timeout='30s'")
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: account, role: 'authenticated' })])
  await db.query(`INSERT INTO auth.users(id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
    VALUES($1,'authenticated','authenticated',$2,'{"provider":"email"}','{}',now(),now())`, [account, account + '@availability-bench.invalid'])
  await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','availability benchmark',$2)", [group, account])
  await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner')", [group, account])
  await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform,status) VALUES($1,$2,'benchmark','fixture','linux','offline')", [device, account])
  await db.query("INSERT INTO identity.device_projects(device_id,user_id,local_project_id,name,root_path,created_at,chat_id) VALUES($1,$2,'root','benchmark','/fixture',now(),$3)", [device, account, group])
  await db.query("INSERT INTO chat.file_transfer_limits(scope,scope_id,settings) VALUES('global','*',$1) ON CONFLICT(scope,scope_id) DO UPDATE SET settings=EXCLUDED.settings", [{
    inventory_ready: true, storage_global_bytes: 1000000000, storage_account_bytes: 1000000000, storage_group_bytes: 1000000000,
    download_global_bytes: 1000000000, download_account_bytes: 1000000000, download_group_bytes: 1000000000,
    upload_permit_seconds: 120, upload_edge_seconds:400, upload_sign_seconds:900, upload_inflight_seconds:600, sign_window_seconds: 60, sign_account_count: 1000, sign_group_count: 1000,
    file_max_bytes: 10000, temporary_group_bytes: 1000000,
  }])
  await db.query("INSERT INTO chat.workspace_items(id,chat_id,kind,filename,created_by) VALUES($1,$2,'folder','Availability load',$3)", [folder, group, account])
  await db.query(`CREATE TEMP TABLE availability_bench_items ON COMMIT DROP AS
    SELECT n,gen_random_uuid() AS item,CASE WHEN n%4<>0 THEN gen_random_uuid() END AS blob,gen_random_uuid() AS storage
    FROM generate_series(1,$1::integer) n`, [count])
  await db.query(`INSERT INTO chat.file_blobs(id,bucket_id,object_name,size_bytes,sha256,content_type,created_by)
    SELECT blob,'oss',left(md5(blob::text),2)||'/'||repeat(md5(blob::text),2),60,repeat(md5(blob::text),2),'application/pdf',$1
    FROM availability_bench_items WHERE blob IS NOT NULL`, [account])
  await db.query(`INSERT INTO chat.workspace_items(id,chat_id,parent_id,kind,filename,content_type,size_bytes,blob_id,created_by,created_at,updated_at)
    SELECT item,$1,$2,'file','bench-'||lpad(n::text,5,'0')||'.pdf','application/pdf',60,blob,$3,
    now()-n*interval '1 millisecond',now()-n*interval '1 millisecond' FROM availability_bench_items`, [group, folder, account])
  await db.query(`INSERT INTO chat.workspace_item_versions(item_id,n,content_type,size_bytes,made_by,file_name,sha256,host_device_id,host_project_id,relative_path)
    SELECT item,1,'application/pdf',60,$1,'bench-'||lpad(n::text,5,'0')||'.pdf',repeat(md5(item::text),2),$2,'root','bench-'||n||'.pdf'
    FROM availability_bench_items WHERE n%4=0`, [account, device])
  await db.query(`INSERT INTO chat.file_transfer_storage(id,bucket_id,object_name,blob_id,size_bytes,state,owner_account)
    SELECT storage,'oss',left(md5(blob::text),2)||'/'||repeat(md5(blob::text),2),blob,60,CASE WHEN n%4=1 THEN 'ready' ELSE 'gone' END,$1
    FROM availability_bench_items WHERE blob IS NOT NULL
    ON CONFLICT(bucket_id,object_name) DO UPDATE SET state=EXCLUDED.state`, [account])
  await db.query('UPDATE availability_bench_items b SET storage=o.id FROM chat.file_transfer_storage o WHERE o.blob_id=b.blob')
  await db.query(`INSERT INTO chat.file_transfer_storage_refs(storage_id,chat_id,account_id,expires_at,expired_at)
    SELECT storage,$1,$2,CASE WHEN n%4=2 THEN now()-interval '1 day' END,
      CASE WHEN n%4=2 THEN now()-interval '1 day' END
    FROM availability_bench_items WHERE blob IS NOT NULL
    ON CONFLICT(storage_id,chat_id) DO UPDATE SET expires_at=EXCLUDED.expires_at,expired_at=EXCLUDED.expired_at`, [group, account])
  await db.query(`INSERT INTO chat.workspace_item_opens(user_id,item_id,opened_at)
    SELECT $1,item,now()-n*interval '1 millisecond' FROM availability_bench_items`, [account])
  for (const table of ['workspace_items','workspace_item_versions','file_blobs','file_transfer_storage','file_transfer_storage_refs','workspace_item_opens']) {
    await db.query('ANALYZE chat.' + table)
  }
  const sample = (await db.query('SELECT item FROM availability_bench_items WHERE n=1')).rows[0].item
  // These exact original implementations are closed in the product. The temporary
  // benchmark grant and every synthetic row roll back together in finally.
  await db.query(`GRANT EXECUTE ON FUNCTION chat.workspace_list_as_availability_base(text,text,integer,integer,text,text,text,boolean),
    chat.workspace_search_availability_base(text,text[],integer,text),chat.workspace_recent_availability_base(integer,text),
    chat.file_resolve_availability_base(jsonb,text) TO authenticated`)
  await db.query('SET LOCAL ROLE authenticated')
  const queries = [
    { name: 'list', fn: 'workspace_list_as', args: [group, account], sql: "$1,$2,p_kind=>'file',p_folder=>'Availability load'", rows: count },
    { name: 'search', fn: 'workspace_search', args: [account], sql: "p_query=>'bench-',p_limit=>200,p_as_user_id=>$1", rows: 200 },
    { name: 'recent', fn: 'workspace_recent', args: [account], sql: 'p_limit=>200,p_as_user_id=>$1', rows: 200 },
    { name: 'resolve', fn: 'file_resolve_as', base: 'file_resolve_availability_base', args: [sample, account], sql: "jsonb_build_object('item_id',$1::text),$2", rows: 1 },
  ]
  const output = { rows: count, eachSourceClass: count / 4, warmups, samples, node: process.version, releaseDigest: release.digest, measurements: [] }
  for (const query of queries) {
    const timings = { before: [], after: [] }
    for (let round = -warmups; round < samples; round++) {
      for (const variant of round % 2 ? ['before','after'] : ['after','before']) {
        const name = variant === 'before' ? query.base ?? query.fn + '_availability_base' : query.fn
        const start = performance.now()
        const result = await db.query('SELECT * FROM chat.' + name + '(' + query.sql + ')', query.args)
        const elapsed = performance.now() - start
        assert.equal(result.rowCount, query.rows)
        if (variant === 'after' && query.name === 'list') {
          const distribution = result.rows.reduce((all, row) => { all[row.availability] = (all[row.availability] ?? 0) + 1; return all }, {})
          assert.deepEqual(distribution, { available: count / 2, expired: count / 4, unavailable: count / 4 })
        }
        if (round >= 0) timings[variant].push(elapsed)
      }
    }
    const summary = values => { const sorted = [...values].sort((a,b) => a-b); return { p50_ms: +sorted[Math.floor(sorted.length / 2)].toFixed(3), max_ms: +sorted.at(-1).toFixed(3) } }
    const before = summary(timings.before), after = summary(timings.after)
    output.measurements.push({ query: query.name, returnedRows: query.rows, before, after, p50_ratio: +(after.p50_ms / before.p50_ms).toFixed(3) })
  }
  console.log(JSON.stringify(output, null, 2))
} finally {
  await db.query('ROLLBACK').catch(() => {})
  await db.end()
}
