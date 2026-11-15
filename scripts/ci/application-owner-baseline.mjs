import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const fail = (code, violations = []) => Object.assign(new Error(code), { violations })
export function validateSnapshot(records, { fixture = false } = {}) {
  if (!Array.isArray(records) || records.length < 3 || records.length > 20000) throw fail('OWNER_SNAPSHOT_INCOMPLETE')
  const found = new Map()
  for (const row of records) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).sort().join(',') !== 'object,owner'
      || typeof row.object !== 'string' || typeof row.owner !== 'string' || !row.owner || row.owner.length > 128
      || row.object.length > 4096 || /[\x00-\x1f\x7f]/.test(row.object + row.owner)
      || !/^(database\/current$|schema\/.+|relation\/.+|routine:[fpaw]\/.+\(.*\)$)/.test(row.object)
      || found.has(row.object)) throw fail('OWNER_SNAPSHOT_FORMAT_REJECTED')
    found.set(row.object, row.owner)
  }
  if (!found.has('database/current') || !found.has('schema/public')
    || !records.some(row => row.object.startsWith('relation/'))
    || !records.some(row => row.object.startsWith('routine:'))) throw fail('OWNER_SNAPSHOT_INCOMPLETE')
  const databaseOwner = found.get('database/current'), publicOwner = found.get('schema/public')
  const fixturePair = fixture && databaseOwner === 'supabase_admin' && publicOwner === 'pg_database_owner'
  const violations = records.filter(row => {
    if (fixturePair && row.object === 'database/current') return false
    if (row.object === 'schema/public' && row.owner === 'pg_database_owner') return !(databaseOwner === 'postgres' || fixturePair)
    return row.owner !== 'postgres'
  })
  if (violations.length) throw fail('APPLICATION_OWNER_PRIVILEGED_REPAIR_REQUIRED', violations)
  return { objects: records.length, publicDatabaseAliasVerified: publicOwner !== 'pg_database_owner' || databaseOwner === 'postgres' || fixturePair }
}

export function publicIntersection(production, community) {
  // Never hide an offending private object by filtering it out of public data.
  validateSnapshot(production)
  validateSnapshot(community, { fixture: true })
  const names = new Set(community.map(row => row.object))
  const result = production.filter(row => names.has(row.object)).map(row => ({ ...row }))
  validateSnapshot(result)
  return result
}

export async function captureFixture(root) {
  root = resolve(root) + '/'
  const owner = JSON.parse(readFileSync(resolve(root, '.local/test-db/owner.json')))
  const project = 'gugucommunitytest' + createHash('sha256').update(root).digest('hex').slice(0,10)
  if (owner.root !== root || owner.project !== project || !Number.isInteger(owner.port)
    || owner.port < 1026 || owner.port > 65535) throw fail('OWNER_FIXTURE_IDENTITY_REQUIRED')
  const binding = execFileSync('docker', ['port', 'supabase_db_' + project, '5432/tcp'], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim()
  if (binding !== '127.0.0.1:' + owner.port) throw fail('OWNER_FIXTURE_LOOPBACK_REQUIRED')
  const pg = createRequire(resolve(root,'package.json'))('pg')
  const db = new pg.Client({ host:'127.0.0.1',port:owner.port,database:'postgres',user:'postgres',password:'postgres',
    application_name:'gugu-owner-ci',connectionTimeoutMillis:3000 })
  try {
    await db.connect()
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='250ms'; SET LOCAL transaction_timeout='10s';")
    const result = await db.query(readFileSync(new URL('./application-owner-catalog.sql',import.meta.url),'utf8'))
    const records = Object.values(result.rows[0])[0]
    validateSnapshot(records,{fixture:true})
    await db.query('COMMIT')
    return records
  } finally { await db.end() }
}

export async function main(args = process.argv.slice(2)) {
  const options = {}
  for (let i=0;i<args.length;i+=2) {
    const key=args[i],value=args[i+1]
    if (!['--snapshot','--fixture-root','--filter-production','--output'].includes(key) || !value || options[key]) throw fail('OWNER_ARGUMENTS_REJECTED')
    options[key]=value
  }
  if (options['--filter-production']) {
    if (!options['--fixture-root'] || !options['--output'] || options['--snapshot']) throw fail('OWNER_ARGUMENTS_REJECTED')
    const production=JSON.parse(readFileSync(options['--filter-production']))
    const community=await captureFixture(options['--fixture-root'])
    const records=publicIntersection(production,community)
    writeFileSync(options['--output'],JSON.stringify(records,null,2)+'\n',{flag:'wx'})
    console.log(JSON.stringify({productionObjects:production.length,communityObjects:community.length,publishedObjects:records.length}))
    return
  }
  if (!options['--snapshot'] || options['--output']) throw fail('OWNER_ARGUMENTS_REJECTED')
  const snapshot=JSON.parse(readFileSync(options['--snapshot']))
  const result={snapshot:validateSnapshot(snapshot)}
  if (options['--fixture-root']) result.candidate=validateSnapshot(await captureFixture(options['--fixture-root']),{fixture:true})
  console.log(JSON.stringify(result))
}
if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try { await main() } catch (error) {
    const code=/^[A-Z_]+$/.test(error.message||'')?error.message:'OWNER_CHECK_INCOMPLETE'
    console.error('::error::'+code+'; non-postgres application objects require the reviewed privileged repair before deployment')
    if (Array.isArray(error.violations)) console.error(JSON.stringify(error.violations.slice(0,20)))
    process.exitCode=1
  }
}
