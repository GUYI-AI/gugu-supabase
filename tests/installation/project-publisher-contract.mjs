import assert from 'node:assert/strict'

export function assertCompleteProjectPublisherSource(sql, names = ['file_private.publish_revision_by', 'chat.file_device_publish', 'chat.file_version_handoff_publish']) {
  for (const name of names) {
    assert.match(sql, new RegExp('CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+' + name.replace('.', '\\.') + '\\s*\\(', 'i'))
  }
}

export function assertNoRuntimeSourceRewriting(sql) {
  assert.doesNotMatch(sql, /\bpg_get_functiondef\s*\(|^\s*EXECUTE\b/im, 'release must contain complete publisher definitions')
}

export async function assertAllocatedProjectPublisher(query) {
  const signature = 'file_private.publish_revision(uuid,text,text,text,text,text,bigint,text,text,integer,uuid)'
  const [publisher] = await query(`SELECT prosrc AS body,prosecdef AS definer,
    has_function_privilege('anon',oid,'EXECUTE') AS anon
    FROM pg_proc WHERE oid='${signature}'::regprocedure`)
  assert.match(publisher.body, /RETURNING\s+filename\s+INTO\s+p_filename/i, 'revision must retain the directory-allocated name')
  assert.equal(publisher.definer, true)
  assert.equal(publisher.anon, false)
}

// A project chat has no host: no installed function may read a chat's file host, hand bytes to one, or pick one
// account's setting for a whole chat. plpgsql binds names late, so a stale body would otherwise fail only when called.
export async function assertNoChatFileHost(query) {
  const stale = await query(`SELECT n.nspname||'.'||p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname IN ('chat','file_private','identity') AND (p.prosrc ~ 'file_project_policies|file_version_handoff|file_storage_policy\\(|publish_revision_by')
    ORDER BY 1`)
  assert.deepEqual(stale, [])
  assert.equal((await query("SELECT to_regclass('chat.file_project_policies') AS t"))[0].t, null)
  assert.equal((await query("SELECT to_regclass('chat.file_version_handoffs') AS t"))[0].t, null)
}
