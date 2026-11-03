import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import { foundationDigest, installFoundation, installReleases, releases } from '../../scripts/foundation.mjs'
import { topicResourcesFixture } from './topic-resources-fixture.mjs'
import { installTopicResourcesConcurrently } from './topic-resource-concurrency.mjs'
import { assertAllocatedProjectPublisher, assertNoChatFileHost } from './project-publisher-contract.mjs'

// Deliberately requires an empty, disposable Supabase PostgreSQL 17 instance.
// Never resets schemas, migration history, or user data to make a test pass.
test('fresh foundation, repeat installation, authorization and refusal guards', async (t) => {
  const url = new URL(process.env.GUGU_INSTALL_TEST_DATABASE_URL ?? '')
  assert.ok(['postgres:', 'postgresql:'].includes(url.protocol))
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'installation tests require loopback PostgreSQL')
  const db = new pg.Client({ connectionString: url.href })
  await db.connect()
  const query = async (sql) => {
    const result = await db.query(sql)
    return Array.isArray(result) ? result.at(-1).rows : result.rows
  }
  try {
    assert.equal((await query("SELECT to_regnamespace('identity') AS existing"))[0].existing, null, 'use a fresh dedicated fixture')
    assert.deepEqual(await installFoundation(query), { installed: true, digest: foundationDigest })
    const versions = releases.map((release) => release.version)
    const userEventsRelease = releases.find((release) => release.version.endsWith('_human_user_events'))
    assert.ok(userEventsRelease, 'human user-events is an incremental release')
    const topicRelease = releases.find((release) => release.version.endsWith('_topic_source_resources'))
    assert.ok(topicRelease)
    const idleExpiryRelease = releases.find((release) => release.version.endsWith('_large_file_idle_expiry'))
    assert.ok(idleExpiryRelease)
    const downloadLockRelease = releases.find((release) => release.version.endsWith('_file_download_lock_scope'))
    assert.ok(downloadLockRelease)
    const firstFileRelease = releases.find((release) => release.version === '20261029114000_project_first_file_policy')
    assert.ok(firstFileRelease)
    const deviceCheckRelease = releases.find((release) => release.version.endsWith('_remove_archived_device_agents'))
    const validationRelease = releases.find((release) => release.constraintValidation)
    assert.ok(deviceCheckRelease && validationRelease)
    const releaseQuery = async (sql) => {
      if (sql.includes(deviceCheckRelease.sql)) {
        const beforeTimeout = await query('SHOW lock_timeout')
        const result = await query(sql)
        await t.test('device CHECK replacement skips validation and restores the previous lock timeout', async () => {
          assert.equal((await query("SELECT convalidated FROM pg_constraint WHERE conrelid='identity.users'::regclass AND conname='users_agent_device_required'"))[0].convalidated, false)
          assert.deepEqual(await query('SHOW lock_timeout'), beforeTimeout)
        })
        return result
      }
      if (sql === validationRelease.sql) {
        const transaction = (await query('SELECT txid_current() AS id'))[0].id
        const result = await query(sql)
        await t.test('device CHECK validates in a later transaction with no retained ACCESS EXCLUSIVE lock', async () => {
          assert.equal((await query("SELECT convalidated FROM pg_constraint WHERE conrelid='identity.users'::regclass AND conname='users_agent_device_required'"))[0].convalidated, true)
          assert.notEqual((await query('SELECT txid_current() AS id'))[0].id, transaction)
          assert.equal((await query("SELECT count(*)::int AS n FROM pg_locks WHERE pid=pg_backend_pid() AND relation='identity.users'::regclass AND mode='AccessExclusiveLock'"))[0].n, 0)
        })
        return result
      }
      if (sql.includes(releases.find(release => release.version.endsWith('_widget_message_shape'))?.sql)) {
        const owner = randomUUID(), group = randomUUID(), legacy = randomUUID(), deep = randomUUID(), deepGroup = randomUUID()
        await db.query("INSERT INTO identity.users(id,type,display_name) VALUES($1,'human','Widget upgrade fixture')", [owner])
        await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','Widget upgrade',$2)", [group, owner])
        await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner')", [group, owner])
        const legacyContent = JSON.stringify({ id: 'legacy', title: 'Legacy widget', html: '<p>Old widget</p>' })
        await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type) VALUES($1,$2,$3,$4,'widget')", [legacy, group, owner, legacyContent])
        const deepContent = '['.repeat(16384) + '0' + ']'.repeat(16384)
        await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','Deep widget upgrade',$2)", [deepGroup, owner])
        await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES($1,$2,'owner')", [deepGroup, owner])
        await db.query("INSERT INTO chat.messages(id,chat_id,sender_user_id,content,content_type) VALUES($1,$2,$3,$4,'widget')", [deep, deepGroup, owner, deepContent])
        const preview = () => query("SELECT oid,(SELECT array_agg(acl::text ORDER BY acl::text) FROM unnest(proacl) AS acl) AS proacl,provolatile,prosecdef,proconfig,prosrc FROM pg_proc WHERE oid='chat.message_preview(text,text)'::regprocedure")
        const before = await preview()
        const widget = JSON.stringify({ v: 2, text: 'Build status', app: 'build-board', view: 'board' })
        assert.equal((await db.query("SELECT chat.message_preview($1,'widget') AS preview", [widget])).rows[0].preview, widget.slice(0, 100))
        await t.test('widget migration rolls back its function and constraint together', async () => {
          await query(sql.replace(/COMMIT;\s*$/, 'ROLLBACK;'))
          assert.deepEqual(await preview(), before)
          assert.equal((await query("SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid='chat.messages'::regclass AND conname='messages_widget_shape'"))[0].n, 0)
        })
        const result = await query(sql)
        await t.test('widget migration preserves legacy rows and preview ACL without validating old content', async () => {
          const after = await preview()
          assert.deepEqual({ ...after[0], prosrc: before[0].prosrc }, before[0])
          assert.equal((await query("SELECT convalidated FROM pg_constraint WHERE conrelid='chat.messages'::regclass AND conname='messages_widget_shape'"))[0].convalidated, false)
          assert.equal((await db.query("SELECT chat.message_preview($1,'widget') AS preview", [widget])).rows[0].preview, 'Build status')
          assert.equal((await db.query('SELECT content FROM chat.messages WHERE id=$1', [legacy])).rows[0].content, legacyContent)
          assert.equal((await db.query('SELECT chat.message_preview(content,content_type) AS preview FROM chat.messages WHERE id=$1', [legacy])).rows[0].preview, '[Widget]')
          assert.equal((await query("SELECT has_function_privilege('anon','chat.message_preview(text,text)','EXECUTE') AS allowed"))[0].allowed, false)
          for (const role of ['authenticated', 'service_role']) {
            assert.equal((await db.query("SELECT has_function_privilege($1,'chat.message_preview(text,text)','EXECUTE') AS allowed", [role])).rows[0].allowed, true)
          }
          await query('BEGIN')
          try {
            await query('SET LOCAL ROLE authenticated')
            await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [owner])
            await db.query('UPDATE chat.messages SET edited_at=now(),retracted_at=now() WHERE id=$1', [legacy])
            assert.equal((await db.query('SELECT * FROM chat.delete_message($1)', [legacy])).rows[0].globally_deleted, true)
          } finally { await query('ROLLBACK') }
        })
        await t.test('pre-existing deeply nested widget updates retain the PostgreSQL parser-limit rejection', async () => {
          for (const statement of ['UPDATE chat.messages SET retracted_at=now() WHERE id=$1', 'SELECT * FROM chat.delete_message($1)']) {
            await query('BEGIN')
            try {
              await query('SET LOCAL ROLE authenticated')
              await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [owner])
              await assert.rejects(db.query(statement, [deep]), { code: '54001' })
            } finally { await query('ROLLBACK') }
          }
          assert.equal((await db.query('SELECT content FROM chat.messages WHERE id=$1', [deep])).rows[0].content, deepContent)
        })
        await db.query('DELETE FROM chat.messages WHERE id=$1', [deep])
        await db.query('DELETE FROM chat.chats WHERE id=$1', [deepGroup])
        await db.query('DELETE FROM chat.chats WHERE id=$1', [group])
        await db.query('DELETE FROM identity.users WHERE id=$1', [owner])
        return result
      }
      if (sql.includes(firstFileRelease.sql)) {
        await t.test('an already recorded later actor release refuses the older first-file release without changes', async () => {
          const snapshot = async () => ({
            ledger: await query('SELECT version,digest,installed_at FROM gugu_install.releases ORDER BY version'),
            functions: await query(`SELECT n.nspname,p.proname,p.proargtypes::text,p.provolatile,p.prosecdef,p.prosrc,p.proacl::text
              FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname IN ('chat','file_private') AND p.proname IN ('file_project_policy_for','publish_revision_by',
                'file_device_publish','file_version_handoff_publish','link_project_message') ORDER BY n.nspname,p.proname,p.proargtypes`),
            files: await query('SELECT id,chat_id,filename,version,source_message_ids FROM chat.workspace_items ORDER BY id'),
            policies: await query('SELECT * FROM chat.file_project_policies ORDER BY chat_id'),
          })
          const before = await snapshot()
          await query('BEGIN')
          try {
            // Model the authoritative later-release ledger state inside a rollback-only fixture. The #93
            // combined-release tests install its real body; this test exercises this release's own entry guard.
            await db.query('INSERT INTO gugu_install.releases(version,digest) VALUES($1,$2)',
              ['20261029144500_explicit_message_actor', '0'.repeat(64)])
            await assert.rejects(query(firstFileRelease.sql), { code: 'P0001', hint: 'project_file_release_order' })
          } finally {
            await query('ROLLBACK')
          }
          assert.deepEqual(await snapshot(), before)
        })
        return query(sql)
      }
      if (sql.includes(downloadLockRelease.sql)) {
        const owner=randomUUID(),group=randomUUID(),ids=[randomUUID(),randomUUID(),randomUUID()]
        await db.query("INSERT INTO identity.users(id,type,display_name) VALUES($1,'human','download upgrade fixture')",[owner])
        await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','download upgrade',$2)",[group,owner])
        await db.query("INSERT INTO chat.file_transfer_reservations(id,kind,account_id,chat_id,subject,bytes,actual_bytes,state,created_at,expires_at) VALUES($1,'download',$4,$5,'pending',100,130,'issued',now()-interval '40 days',now()-interval '1 day'),($2,'download',$4,$5,'settled',100,60,'settled',now()-interval '40 days',now()-interval '1 day'),($3,'download',$4,$5,'cancelled',100,0,'cancelled',now(),now())",[...ids,owner,group])
        await db.query("INSERT INTO chat.file_transfer_observations(event_id,reservation_id,bytes,observed_at) VALUES($1,$3,40,now()-interval '39 days'),($2,$3,20,now())",[randomUUID(),randomUUID(),ids[1]])
        const usage=async()=>Promise.all(['global','account','group'].map(async(scope)=>Number((await db.query(
          'SELECT chat.file_transfer_usage($1,$2,$3) AS n',['download',scope,scope==='global'?'*':scope==='account'?owner:group])).rows[0].n)))
        const before=await usage()
        const original=(await db.query("SELECT pg_get_functiondef('chat.file_transfer_download_as(jsonb,text,uuid)'::regprocedure) AS sql")).rows[0].sql
        const usageDefinition=(await db.query("SELECT pg_get_functiondef('chat.file_transfer_usage(text,text,text)'::regprocedure) AS sql")).rows[0].sql
        const tables=await db.query("SELECT tablename FROM pg_tables WHERE schemaname='chat' ORDER BY tablename")
        await t.test('download lock upgrade rolls back indexes and function changes',async()=>{
          await query(sql.replace(/COMMIT;\s*$/, 'ROLLBACK;'))
          assert.equal((await db.query("SELECT to_regclass('chat.file_transfer_observations_reservation') AS index")).rows[0].index,null)
          assert.equal((await db.query("SELECT pg_get_functiondef('chat.file_transfer_download_as(jsonb,text,uuid)'::regprocedure) AS sql")).rows[0].sql,original)
          assert.deepEqual(await usage(),before)
        })
        const result=await query(sql)
        await t.test('download lock upgrade preserves the original ledger calculation and accounting tables',async()=>{
          assert.deepEqual(await usage(),before)
          assert.equal(before[1],150)
          assert.equal((await db.query("SELECT pg_get_functiondef('chat.file_transfer_usage(text,text,text)'::regprocedure) AS sql")).rows[0].sql,usageDefinition)
          assert.deepEqual((await db.query("SELECT tablename FROM pg_tables WHERE schemaname='chat' ORDER BY tablename")).rows,tables.rows)
        })
        await db.query('DELETE FROM chat.file_transfer_observations WHERE reservation_id=ANY($1::uuid[])',[ids])
        await db.query('DELETE FROM chat.file_transfer_reservations WHERE id=ANY($1::uuid[])',[ids])
        await db.query('DELETE FROM chat.chats WHERE id=$1',[group])
        await db.query('DELETE FROM identity.users WHERE id=$1',[owner])
        return result
      }
      if (sql.includes(releases.find(release=>release.version.endsWith('_project_file_message_publication')).sql)) {
        await t.test('atomic publication rollback restores the old function and leaves no private schema',async()=>{
          await query(sql.replace(/COMMIT;\s*$/, 'ROLLBACK;'))
          assert.equal((await query("SELECT to_regnamespace('file_private') AS schema"))[0].schema,null)
          assert.equal((await query("SELECT prosecdef FROM pg_proc WHERE oid='chat.file_device_publish(uuid,text,text,text,text,bigint,text,text,integer,uuid)'::regprocedure"))[0].prosecdef,true)
          assert.equal((await query("SELECT to_regprocedure('chat.file_device_publish(uuid,text,text,text,text,bigint,text,text,integer,uuid,jsonb)') AS f"))[0].f,null)
        })
        return query(sql)
      }
      if (sql.includes(idleExpiryRelease.sql)) {
        const owner=randomUUID(),group=randomUUID(),blob=randomUUID(),stored=randomUUID(),sha='ef'.repeat(32)
        await db.query("INSERT INTO identity.users(id,type,display_name) VALUES($1,'human','retention upgrade fixture')",[owner])
        await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES($1,'group','retention upgrade',$2)",[group,owner])
        await db.query("INSERT INTO chat.file_blobs(id,bucket_id,object_name,sha256,size_bytes,content_type,created_by) VALUES($1,'oss',$2,$3,51,'application/octet-stream',$4)",[blob,'ef/'+sha,sha,owner])
        await db.query("INSERT INTO chat.file_transfer_storage(id,blob_id,bucket_id,object_name,size_bytes) VALUES($1,$2,'oss',$3,51)",[stored,blob,'ef/'+sha])
        await db.query("INSERT INTO chat.file_transfer_storage_refs(storage_id,chat_id,account_id,created_at) VALUES($1,$2,$3,now()-interval '2 years')",[stored,group,owner])
        const original=(await db.query('SELECT created_at FROM chat.file_transfer_storage_refs WHERE storage_id=$1',[stored])).rows[0].created_at
        await t.test('idle expiry upgrade rolls back all columns and preserves legacy references',async()=>{
          await query(sql.replace(/COMMIT;\s*$/, 'ROLLBACK;'))
          assert.equal((await db.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='chat' AND table_name='file_transfer_storage_refs' AND column_name='retention_started_at'")).rows[0].n,0)
          assert.deepEqual((await db.query('SELECT created_at FROM chat.file_transfer_storage_refs WHERE storage_id=$1',[stored])).rows[0].created_at,original)
        })
        const result=await query(sql)
        await t.test('idle expiry upgrade gives old references a full interval without inventing downloads',async()=>{
          const r=(await db.query("SELECT *,retention_started_at>now()-interval '1 minute' AS fresh FROM chat.file_transfer_storage_refs WHERE storage_id=$1",[stored])).rows[0]
          assert.deepEqual(r.created_at,original);assert.equal(r.last_download_at,null);assert.equal(r.expired_at,null);assert.equal(r.fresh,true)
        })
        await db.query('DELETE FROM chat.file_transfer_storage WHERE id=$1',[stored])
        await db.query('DELETE FROM chat.file_blobs WHERE id=$1',[blob])
        await db.query('DELETE FROM chat.chats WHERE id=$1',[group])
        await db.query('DELETE FROM identity.users WHERE id=$1',[owner])
        return result
      }
      if (sql.includes(topicRelease.sql)) {
        const rolledBack = sql.replace(/COMMIT;\s*$/, 'ROLLBACK;')
        await t.test('topic resources install on an empty community database', async () => {
          await query(rolledBack)
        })
        await t.test('a legacy non-UUID chat aborts and rolls back the complete upgrade', async () => {
          const owner = randomUUID(), id = '123456789'
          await db.query('BEGIN')
          await db.query("INSERT INTO identity.users(id,type,display_name) VALUES ($1,'human','legacy id fixture')", [owner])
          await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES ($1,'group','legacy id',$2)", [id, owner])
          await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES ($1,$2,'owner')", [id, owner])
          await db.query('COMMIT')
          try {
            await assert.rejects(query(sql), { code: '23514', constraint: 'chats_id_uuid' })
            await db.query('ROLLBACK')
            assert.equal((await query("SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid='chat.chats'::regclass AND conname='chats_id_uuid'"))[0].n, 0)
            assert.equal((await db.query('SELECT id FROM chat.chats WHERE id=$1', [id])).rows[0].id, id)
            assert.equal((await query("SELECT prorettype::regtype::text AS type FROM pg_proc WHERE oid='chat.workspace_require_room_member(text,text)'::regprocedure"))[0].type, 'void')
          } finally {
            await db.query('ROLLBACK')
            await db.query('DELETE FROM chat.chats WHERE id=$1', [id])
            await db.query('DELETE FROM identity.users WHERE id=$1', [owner])
          }
        })
        const fixture = await topicResourcesFixture(db)
        await t.test('topic metadata upgrade rolls back without changing rows, functions or guards', async () => {
          const started = performance.now()
          await query(rolledBack)
          console.log('topic upgrade quiet metadata transaction ms:', performance.now() - started)
          assert.deepEqual(await fixture.snapshot(), fixture.before)
          assert.equal((await query("SELECT prorettype::regtype::text AS type FROM pg_proc WHERE oid='chat.workspace_require_room_member(text,text)'::regprocedure"))[0].type, 'void')
        })
        await t.test('an unexpected referenced system folder aborts the whole release', async () => {
          await fixture.poison()
          const poisoned = await fixture.snapshot()
          await assert.rejects(query(sql), /system folder has content or references/)
          await query('ROLLBACK')
          assert.deepEqual(await fixture.snapshot(), poisoned)
          assert.equal((await query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid='chat.workspace_items'::regclass AND tgname IN ('workspace_items_place','workspace_items_guard_delete') AND tgenabled='O'"))[0].n, 2)
          await fixture.unpoison()
        })
        const result = await installTopicResourcesConcurrently(db, sql, (name, run) => t.test(name, run))
        await t.test('topic upgrade preserves IDs, boards, versions, bytes and upload retries', () => fixture.assertMigrated())
        await fixture.cleanup()
        return result
      }
      if (!sql.includes(userEventsRelease.sql)) return query(sql)
      // First exercise the release on the clean community schema and roll it
      // back. Then install it with an independent producer present. Both paths
      // must work without the release owning or changing that extension.
      await t.test('human user-events release installs on the community schema', async () => {
        assert.match(sql, /COMMIT;\s*$/)
        await query(sql.replace(/COMMIT;\s*$/, 'ROLLBACK;'))
        assert.equal((await query("SELECT to_regprocedure('chat.send_user_event(jsonb,text,text,boolean)') AS helper"))[0].helper, null)
      })
      let result
      await t.test('human user-events release preserves an independent user-event sender', async () => {
        await query(`CREATE SCHEMA user_events_extension;
        CREATE FUNCTION user_events_extension.emit(p_user_id text) RETURNS void
        LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $extension$
        BEGIN
          PERFORM realtime.send('{}'::jsonb,'extension_changed','gugu:user:'||p_user_id||':events',true);
        END $extension$;
        REVOKE ALL ON FUNCTION user_events_extension.emit(text) FROM PUBLIC,anon,authenticated;
        GRANT EXECUTE ON FUNCTION user_events_extension.emit(text) TO service_role;`)
        const extension = () => query(`SELECT pg_get_functiondef(oid) AS definition,proacl::text AS acl
          FROM pg_proc WHERE oid='user_events_extension.emit(text)'::regprocedure`)
        const before = await extension()
        result = await query(sql)
        assert.deepEqual(await extension(), before, 'release preserves independent producers and their ACL')
        await query('DROP SCHEMA user_events_extension CASCADE')
      })
      return result
    }
    assert.deepEqual(await installReleases(releaseQuery), { applied: versions, versions })
    await t.test('installed publishers retain directory-allocated names and private grants', async () => {
      await assertAllocatedProjectPublisher(query)
    })
    await t.test('no installed function knows a chat file host', async () => {
      await assertNoChatFileHost(query)
    })
    assert.equal((await query('SHOW row_security'))[0].row_security, 'on', 'dump settings stay local to the installation transaction')
    const before = await query('SELECT version,digest,installed_at FROM gugu_install.releases')
    assert.deepEqual(await installFoundation(query), { installed: false, digest: foundationDigest })
    assert.deepEqual(await installReleases(query), { applied: [], versions })
    await assertAllocatedProjectPublisher(query)
    assert.deepEqual(await query('SELECT version,digest,installed_at FROM gugu_install.releases'), before)
    assert.equal((await query("SELECT count(*)::integer AS n FROM pg_policies WHERE schemaname='realtime' AND policyname LIKE 'gugu_%'"))[0].n, 9, 'foundation 7 + forum events + owned agents')
    assert.equal((await query("SELECT count(*)::integer AS n FROM cron.job WHERE active AND jobname IN ('device-lease-sweep','file-blob-upload-sweep','file-blob-gc-kick')"))[0].n, 3)
    assert.equal((await query("SELECT to_regnamespace('billing') AS billing"))[0].billing, null)
    assert.equal((await query("SELECT count(*)::integer AS n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('model_access_reserve','cloud_computer_charge','gateway_pool_claim')"))[0].n, 0)

    await t.test('session archival state is readable, writes are RPC-only and replaced APIs retain their grants', async () => {
      for (const table of ['identity.agent_session_archive_intervals', 'chat.message_agent_delivery_blocks']) {
        assert.equal((await db.query('SELECT relrowsecurity AS enabled FROM pg_class WHERE oid=$1::regclass', [table])).rows[0].enabled, true)
        for (const role of ['anon', 'authenticated']) {
          for (const privilege of ['INSERT', 'UPDATE', 'DELETE']) {
            assert.equal((await db.query('SELECT has_table_privilege($1,$2,$3) AS allowed', [role, table, privilege])).rows[0].allowed, false)
          }
        }
      }
      for (const column of ['session_archived_at', 'session_lifecycle_revision', 'session_lifecycle_operation_id']) {
        assert.equal((await db.query("SELECT has_column_privilege('authenticated','identity.users',$1,'SELECT') AS allowed", [column])).rows[0].allowed, true)
        assert.equal((await db.query("SELECT has_column_privilege('authenticated','identity.users',$1,'UPDATE') AS allowed", [column])).rows[0].allowed, false)
      }
      for (const signature of [
        'identity.set_agent_session_archival(text,text,uuid,bigint,timestamp with time zone,jsonb)',
        'identity.pull_agent_inbox_v2(text,text,bigint,integer,jsonb,bigint)',
        'identity.recheck_device_command_execution(uuid,uuid)', 'chat.sync_snapshot()',
      ]) {
        assert.equal((await db.query("SELECT has_function_privilege('authenticated',$1,'EXECUTE') AS allowed", [signature])).rows[0].allowed, true)
        assert.equal((await db.query("SELECT has_function_privilege('anon',$1,'EXECUTE') AS allowed", [signature])).rows[0].allowed, false)
      }
      assert.equal((await query("SELECT has_function_privilege('authenticated','identity.assert_device_command_post_context(uuid,uuid,text,text,text,text[])','EXECUTE') AS allowed"))[0].allowed, false)
    })

    await db.query('BEGIN')
    try {
      const [owner, member, outsider, chat, message] = Array.from({ length: 5 }, randomUUID)
      for (const id of [owner, member, outsider]) {
        await db.query(`INSERT INTO auth.users (id,aud,role,email,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
          VALUES ($1,'authenticated','authenticated',$2,'{"provider":"email"}','{}',now(),now())`, [id, id + '@foundation.example.test'])
      }
      assert.equal((await db.query('SELECT count(*)::integer AS n FROM identity.users WHERE id=ANY($1)', [[owner, member, outsider]])).rows[0].n, 3, 'Auth trigger creates identities without commercial schemas')
      await db.query("INSERT INTO chat.chats(id,kind,name,creator_user_id) VALUES ($1,'group','installation fixture',$2)", [chat, owner])
      await db.query("INSERT INTO chat.chat_members(chat_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'member')", [chat, owner, member])
      await db.query('INSERT INTO chat.messages(id,chat_id,sender_user_id,content) VALUES ($1,$2,$3,$4)', [message, chat, owner, 'private fixture'])
      await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES ($1,$2,'fixture','fixture','linux')", ['foundation-' + owner, owner])
      await db.query('SET LOCAL ROLE authenticated')
      for (const [actor, visible] of [[owner, 1], [member, 1], [outsider, 0]]) {
        await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [actor])
        assert.equal((await db.query('SELECT count(*)::integer AS n FROM chat.messages WHERE id=$1', [message])).rows[0].n, visible)
        assert.equal((await db.query('SELECT count(*)::integer AS n FROM identity.gugu_devices WHERE user_id=$1', [owner])).rows[0].n, actor === owner ? 1 : 0)
      }
    } finally {
      await db.query('ROLLBACK')
    }
    await t.test('project metadata tables are closed and only intended read/publish APIs are granted', async () => {
      for (const table of ['file_device_revisions','file_temporary_transfers']) {
        assert.equal((await query(`SELECT relrowsecurity AS enabled FROM pg_class WHERE oid='chat.${table}'::regclass`))[0].enabled, true)
        for (const role of ['anon','authenticated']) {
          for (const privilege of ['SELECT','INSERT','UPDATE','DELETE']) {
            assert.equal((await db.query('SELECT has_table_privilege($1,$2,$3) AS allowed', [role,'chat.'+table,privilege])).rows[0].allowed, false)
          }
        }
      }
      for (const signature of ['file_project_policy_as(text,text,text,boolean,boolean,text)','file_project_policy_for(text,text)',
        'file_device_publish(uuid,text,text,text,text,bigint,text,text,integer,uuid,jsonb,text)','file_resolve_as(jsonb,text)']) {
        assert.equal((await db.query("SELECT has_function_privilege('authenticated',$1,'EXECUTE') AS allowed", ['chat.'+signature])).rows[0].allowed, true)
        assert.equal((await db.query("SELECT has_function_privilege('anon',$1,'EXECUTE') AS allowed", ['chat.'+signature])).rows[0].allowed, false)
      }
      // A later release that replaces file resolution must keep it read-only (STABLE), or the planner calls it per row.
      assert.equal((await query("SELECT provolatile FROM pg_proc WHERE oid='chat.file_resolve_as(jsonb,text)'::regprocedure"))[0].provolatile, 's')
    })
    await t.test('workspace metadata is an object and its atomic helper has no API grants', async () => {
      const column = (await db.query("SELECT is_nullable,column_default,data_type FROM information_schema.columns WHERE table_schema='chat' AND table_name='workspace_items' AND column_name='metadata'")).rows[0]
      assert.equal(column.is_nullable, 'NO')
      assert.equal(column.data_type, 'jsonb')
      assert.equal(column.column_default, "'{}'::jsonb")
      for (const role of ['anon','authenticated','service_role','gugu_files']) {
        assert.equal((await db.query("SELECT has_function_privilege($1,'chat.workspace_set_metadata(uuid,text,jsonb)','EXECUTE') AS allowed", [role])).rows[0].allowed, false)
      }
    })
    await db.query('BEGIN')
    try {
      await db.query('CREATE FUNCTION public.foundation_acl_probe() RETURNS integer LANGUAGE sql AS $$SELECT 1$$')
      const privileges = (await db.query("SELECT has_function_privilege('anon','public.foundation_acl_probe()','EXECUTE') AS anon, has_function_privilege('authenticated','public.foundation_acl_probe()','EXECUTE') AS authenticated")).rows[0]
      assert.deepEqual(privileges, { anon: false, authenticated: false }, 'new functions require an explicit API grant')
      await db.query('GRANT EXECUTE ON FUNCTION public.foundation_acl_probe() TO authenticated')
      assert.equal((await db.query("SELECT has_function_privilege('authenticated','public.foundation_acl_probe()','EXECUTE') AS allowed")).rows[0].allowed, true)
    } finally { await db.query('ROLLBACK') }
    await db.query('BEGIN')
    try {
      await db.query("UPDATE gugu_install.releases SET digest='different' WHERE version='foundation-v1'")
      await assert.rejects(installFoundation(query), /explicit upgrade/)
    } finally { await db.query('ROLLBACK') }
    await db.query('BEGIN')
    try {
      await db.query("UPDATE gugu_install.releases SET digest='different' WHERE version=$1", [releases[0].version])
      await assert.rejects(installReleases(query), /publish changes as a new release file/)
    } finally { await db.query('ROLLBACK') }
    await db.query('BEGIN')
    try {
      await db.query("INSERT INTO gugu_install.releases(version,digest) VALUES ('29991231000000_unknown','x')")
      await assert.rejects(installReleases(query), /does not know/)
    } finally { await db.query('ROLLBACK') }
    await db.query('BEGIN')
    try {
      await db.query('CREATE SCHEMA billing')
      await assert.rejects(installFoundation(query), /not a standalone community/)
    } finally { await db.query('ROLLBACK') }
  } finally { await db.end() }
})
