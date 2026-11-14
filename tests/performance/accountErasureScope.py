"""Manual synthetic predicate/index benchmark, not an end-to-end erasure test.

Requires Docker and the public Supabase PostgreSQL 17 image. Creates only its
own labelled, network-isolated 1-CPU/1-GiB container and removes it on exit.
Set GUGU_BENCH_DOCKER to select a Docker executable; no remote DB URL is used.
"""
import json,os,subprocess,time,secrets,statistics
from pathlib import Path
D=os.environ.get('GUGU_BENCH_DOCKER','docker');N='gugu-erasure-components-'+str(os.getpid());root=Path(__file__).resolve().parents[2]/'supabase/migrations'
started=False

def call(args,data=None,timeout=90,check=True):
 p=subprocess.run(args,input=data,capture_output=True,timeout=timeout)
 if check and p.returncode:raise RuntimeError('component_command_failed')
 return p

def sql(q):return call([D,'exec','-i',N,'psql','-XqAt','-v','ON_ERROR_STOP=1','-U','supabase_admin','-d','postgres'],q.encode()).stdout.decode().strip()

def plan(q):
 d=json.loads(sql('BEGIN;EXPLAIN (ANALYZE,BUFFERS,WAL,FORMAT JSON) '+q+'ROLLBACK;'))[0]
 def types(p):return [p['Node Type']]+[t for c in p.get('Plans',[]) for t in types(c)]
 return {'execution_ms':d['Execution Time'],'nodes':types(d['Plan']),'wal_bytes':d['Plan'].get('WAL Bytes',0)}
try:
 assert call([D,'inspect',N],check=False).returncode!=0
 env=dict(os.environ);env['POSTGRES_PASSWORD']=secrets.token_urlsafe(32)
 p=subprocess.run([D,'run','-d','--name',N,'--label','gugu.task=erasure-components','--network','none','--cpus','1','--memory','1024m','-e','POSTGRES_PASSWORD','public.ecr.aws/supabase/postgres:17.6.1.134','-c','shared_preload_libraries=pg_stat_statements'],env=env,capture_output=True,timeout=45)
 assert p.returncode==0;started=True
 for _ in range(60):
  if call([D,'exec',N,'pg_isready','-q','-U','supabase_admin'],check=False).returncode==0:break
  time.sleep(1)
 sql("CREATE SCHEMA chat;CREATE SCHEMA identity;CREATE TABLE chat.messages(id bigint PRIMARY KEY,chat_id text,to_user_ids text[],deleted_for_user_ids jsonb NOT NULL DEFAULT '[]',content text);CREATE TABLE identity.gugu_device_commands(id bigint PRIMARY KEY,user_id uuid,type text,payload jsonb);CREATE INDEX commands_user ON identity.gugu_device_commands(user_id);")
 sql("INSERT INTO chat.messages SELECT n,'synthetic-room',CASE WHEN n%100<14 THEN ARRAY['synthetic-'||(n%1000)] ELSE '{}'::text[] END,CASE WHEN n%9000=0 THEN '[\"synthetic-reader\"]'::jsonb ELSE '[]'::jsonb END,repeat('fixture',40) FROM generate_series(1,765886)n;INSERT INTO identity.gugu_device_commands SELECT n,'11111111-1111-4111-8111-111111111111','agent.deliver',jsonb_build_object('agent_user_id','synthetic-'||(n%1000),'sender_user_id','synthetic-sender','reply_to_sender_user_id','synthetic-peer','to_user_ids',jsonb_build_array('synthetic-reader'),'content',repeat('fixture',40)) FROM generate_series(1,154740)n;ANALYZE chat.messages;ANALYZE identity.gugu_device_commands;")
 qmsg="UPDATE chat.messages SET to_user_ids=to_user_ids WHERE cardinality(to_user_ids)>0 AND to_user_ids&&ARRAY['absent-user'];"
 qdel="UPDATE chat.messages SET deleted_for_user_ids=deleted_for_user_ids WHERE deleted_for_user_ids<>'[]'::jsonb AND deleted_for_user_ids<>'{}'::jsonb AND deleted_for_user_ids ?|ARRAY['absent-user'];"
 qcmd="SELECT id FROM identity.gugu_device_commands WHERE user_id='22222222-2222-4222-8222-222222222222' OR payload->>'agent_user_id'=ANY(ARRAY['absent-user']) OR payload->>'sender_user_id'=ANY(ARRAY['absent-user']) OR payload->>'reply_to_sender_user_id'=ANY(ARRAY['absent-user']) OR (jsonb_typeof(payload->'to_user_ids')='array' AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(payload->'to_user_ids')r WHERE r=ANY(ARRAY['absent-user'])));"
 writes={
 'plain_messages':"INSERT INTO chat.messages SELECT 2000000+n,'synthetic-room','{}'::text[],'[]'::jsonb,repeat('fixture',40) FROM generate_series(1,5000)n;",
 'directed_messages':"INSERT INTO chat.messages SELECT 2000000+n,'synthetic-room',ARRAY['synthetic-a','synthetic-b'],'[]'::jsonb,repeat('fixture',40) FROM generate_series(1,5000)n;",
 'redactions':"UPDATE chat.messages SET deleted_for_user_ids='[\"synthetic-reader\"]' WHERE id BETWEEN 1 AND 5000;",
 'commands':"INSERT INTO identity.gugu_device_commands SELECT 2000000+n,'11111111-1111-4111-8111-111111111111','agent.deliver',jsonb_build_object('agent_user_id','synthetic-a','sender_user_id','synthetic-sender','to_user_ids',jsonb_build_array('synthetic-reader'),'content',repeat('fixture',40)) FROM generate_series(1,5000)n;"}
 def write_samples():
  samples={key:[] for key in writes}
  for _ in range(5):
   for key,value in writes.items():
    # Remove aborted fixture entries before the next sample. Keep full-page
    # image conditions consistent; this is a component cost, not app throughput.
    sql('VACUUM ANALYZE chat.messages;VACUUM ANALYZE identity.gugu_device_commands;CHECKPOINT;')
    samples[key].append(plan(value))
  return samples
 load_before=os.getloadavg();before_writes=write_samples()
 result={'scope':'synthetic component plans, not end-to-end erasure','rows':{'messages':765886,'commands':154740},'before':{'recipients':plan(qmsg),'redactions':plan(qdel),'commands':plan(qcmd)}}
 sql((root/'20261115004000_account_erasure_reference_projection.sql').read_text())
 for name in ['20261115004100_message_recipient_erasure_index.sql','20261115004200_message_redaction_erasure_index.sql','20261115004300_command_reference_erasure_index.sql']:sql((root/name).read_text())
 sql('ANALYZE chat.messages;ANALYZE identity.gugu_device_commands;')
 qindexed="SELECT id FROM identity.gugu_device_commands WHERE (user_id='22222222-2222-4222-8222-222222222222' OR account_erasure_private.command_reference_user_ids(payload)&&ARRAY['absent-user']) AND (user_id='22222222-2222-4222-8222-222222222222' OR payload->>'agent_user_id'=ANY(ARRAY['absent-user']) OR payload->>'sender_user_id'=ANY(ARRAY['absent-user']) OR payload->>'reply_to_sender_user_id'=ANY(ARRAY['absent-user']) OR (jsonb_typeof(payload->'to_user_ids')='array' AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(payload->'to_user_ids')r WHERE r=ANY(ARRAY['absent-user']))));"
 result['after']={'recipients':plan(qmsg),'redactions':plan(qdel),'commands':plan(qindexed)}
 after_writes=write_samples()
 result['write_5000_rows']={'before':before_writes,'after':after_writes}
 result['write_medians']={key:{
  phase:{field:statistics.median(row[field] for row in values[key]) for field in ['execution_ms','wal_bytes']}
  for phase,values in [('before',before_writes),('after',after_writes)]} for key in writes}
 result['background_load']={'before':load_before,'after':os.getloadavg()}
 result['index_bytes']=json.loads(sql("SELECT jsonb_object_agg(indexrelid::regclass::text,pg_relation_size(indexrelid)) FROM pg_index WHERE indexrelid::regclass::text LIKE '%erasure%';"))
 result['ok']=True
 print(json.dumps(result))
except BaseException:
 print(json.dumps({'ok':False,'component_benchmark_failed':True}));raise SystemExit(1)
finally:
 if started:
  p=call([D,'inspect','--format','{{index .Config.Labels "gugu.task"}}',N],check=False)
  if p.stdout.strip()==b'erasure-components':
   call([D,'stop','--time','20',N],check=False);call([D,'rm','-v',N],check=False)
   print(json.dumps({'isolated_container_removed':call([D,'inspect',N],check=False).returncode!=0}))
