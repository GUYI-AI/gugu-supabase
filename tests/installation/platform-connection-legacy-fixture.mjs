import { randomUUID } from 'node:crypto'

/** Disposable-database fixture only; never contacts an identity or provider service. */
export async function connectionLegacyResponseFixture(db) {
  const owner = randomUUID(), assistant = randomUUID(), operation = randomUUID(), device = randomUUID(), instance = randomUUID()
  await db.query(`INSERT INTO auth.users(id,instance_id,aud,role,email,raw_app_meta_data,raw_user_meta_data,
    confirmation_token,recovery_token,email_change_token_new,email_change,created_at,updated_at)
    VALUES($1,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',$2,
    '{"provider":"email","providers":["email"]}','{}','','','','',now(),now())`, [owner, `${owner}@connection-install.invalid`])
  await db.query("INSERT INTO identity.users(id,type,display_name) VALUES($1,'human','Connection install fixture') ON CONFLICT DO NOTHING", [owner])
  await db.query("INSERT INTO identity.gugu_devices(device_id,user_id,label,hostname,platform) VALUES($1,$2,'fixture','fixture','linux')", [device,owner])
  await db.query("INSERT INTO identity.users(id,type,display_name,owner_user_id,device_id) VALUES($1,'agent','Fixture',$2,$3)", [assistant,owner,device])
  await db.query(`INSERT INTO identity.agent_provision_operations(id,owner_user_id,device_id,kind,payload_hash,blueprint,phase)
    VALUES($1,$2,$3,'single','fixture','{}','completed')`, [operation,owner,device])
  await db.query(`INSERT INTO identity.agent_provisions(id,owner_user_id,operation_id,member_key,device_id,display_name,agent_type,
    inherit_memory,history_import_required,payload_hash,agent_user_id,provisioned_agent_user_id,phase)
    VALUES($1,$2,$3,'assistant',$4,'Fixture','claude-code',false,false,'fixture',$5::text,$5::text::uuid,'completed')`,
  [randomUUID(),owner,operation,device,assistant])
  await db.query('INSERT INTO identity.runtime_instances(instance_id,device_id,owner_user_id) VALUES($1,$2,$3)', [instance,device,owner])
  const change = (await db.query(`INSERT INTO identity.assistant_panel_changes(operation_id,assistant_user_id,owner_user_id,
    domain,resource_key,device_id,source,operation,expected_item_revision,request_hash,payload,status)
    VALUES($1,$2,$3,'personality','profile',$4,'panel','save',0,repeat('f',64),'{"data":{"text":"fixture"}}','pending') RETURNING revision`,
  [randomUUID(),assistant,owner,device])).rows[0]
  await db.query(`INSERT INTO identity.assistant_panel_items(assistant_user_id,owner_user_id,domain,resource_key,revision,data)
    VALUES($1,$2,'control','__head__',$3,'{}'),($1,$2,'personality','profile',$3,'{"text":"fixture"}'),
      ($1,$2,'memory','memo',$3,'{"title":"Fixture","path":"memo.md"}')`, [assistant,owner,change.revision])
  const capture = async () => {
    await db.query("SELECT set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: owner, role: 'authenticated' })])
    await db.query('SET ROLE authenticated')
    try {
      const admission = (await db.query('SELECT identity.assistant_panel_admit($1,$2,$3)::text AS bytes', [assistant,instance,change.revision])).rows[0].bytes
      const snapshot = (await db.query('SELECT identity.assistant_panel_snapshot($1)::text AS bytes', [assistant])).rows[0].bytes
      const resource = (await db.query("SELECT identity.assistant_panel_resource($1,'personality','profile')::text AS bytes", [assistant])).rows[0].bytes
      const pending = (await db.query('SELECT identity.assistant_panel_pending($1,$2)::text AS bytes', [assistant,instance])).rows[0].bytes
      return { admission, snapshot, resource, pending }
    } finally { await db.query('RESET ROLE') }
  }
  const cleanup = async () => {
    await db.query('DELETE FROM identity.agent_provision_operations WHERE id=$1', [operation])
    await db.query('DELETE FROM identity.users WHERE id=$1', [assistant])
    await db.query('DELETE FROM auth.users WHERE id=$1', [owner])
  }
  return { capture, cleanup, identities:{owner,assistant,device,instance} }
}
