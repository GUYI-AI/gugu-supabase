import assert from 'node:assert/strict'
import test from 'node:test'
import { publicIntersection, validateSnapshot } from '../../scripts/ci/application-owner-baseline.mjs'
const good=()=>[
  {object:'database/current',owner:'postgres'},
  {object:'schema/public',owner:'pg_database_owner'},
  {object:'schema/chat',owner:'postgres'},
  {object:'relation/chat.messages',owner:'postgres'},
  {object:'routine:f/chat.send(pg_catalog.text)',owner:'postgres'},
]
test('accepts complete postgres ownership with the bound standard public alias',()=>{
  assert.equal(validateSnapshot(good()).objects,5)
})
for(const name of ['schema/chat','relation/chat.messages','routine:f/chat.send(pg_catalog.text)']) {
  test('rejects non-postgres application owner: '+name,()=>{
    const rows=good();rows.find(x=>x.object===name).owner='supabase_admin'
    assert.throws(()=>validateSnapshot(rows),error=>error.message==='APPLICATION_OWNER_PRIVILEGED_REPAIR_REQUIRED'
      && error.violations[0].object===name)
  })
}
test('production public alias cannot borrow the fixture database-owner exception',()=>{
  const rows=good();rows[0].owner='supabase_admin'
  assert.throws(()=>validateSnapshot(rows),/PRIVILEGED_REPAIR/)
  assert.equal(validateSnapshot(rows,{fixture:true}).objects,5)
  rows[1].owner='postgres'
  assert.throws(()=>validateSnapshot(rows,{fixture:true}),/PRIVILEGED_REPAIR/)
})
test('unknown public/database-owner combinations fail in fixture mode too',()=>{
  const rows=good();rows[0].owner='unreviewed'
  assert.throws(()=>validateSnapshot(rows,{fixture:true}),/PRIVILEGED_REPAIR/)
})
test('refuses empty, incomplete, duplicate, extra-value and malformed snapshots',()=>{
  for(const rows of [[],good().slice(1),[...good(),good()[0]],good().map((x,i)=>i===0?{...x,secret:'value'}:x),
      good().map((x,i)=>i===2?{...x,object:'schema/chat\nspoof'}:x),good().map((x,i)=>i===2?{...x,object:'unknown/chat'}:x)]) {
    assert.throws(()=>validateSnapshot(rows))
  }
})
test('public intersection contains only names present in the community fixture and production owners',()=>{
  const prod=[...good(),{object:'relation/private_only.hidden',owner:'postgres'}]
  const community=good();community[0].owner='supabase_admin'
  assert.deepEqual(publicIntersection(prod,community),good())
})
test('filtering never hides a private ownership violation',()=>{
  const prod=[...good(),{object:'relation/private_only.hidden',owner:'supabase_admin'}]
  assert.throws(()=>publicIntersection(prod,good()),/PRIVILEGED_REPAIR/)
})
