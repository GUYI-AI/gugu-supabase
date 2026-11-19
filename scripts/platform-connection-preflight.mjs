import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const required = [
  'identity.assistant_panel_snapshot(text)',
  'identity.assistant_panel_resource(text,text,text)',
  'identity.assistant_panel_commit(text,uuid,text,text,bigint,text,jsonb,uuid,text,text,text)',
  'identity.assistant_panel_pending(text,text)',
  'identity.assistant_panel_ack(text,text,uuid,text)',
  'identity.assistant_panel_reject(text,text,uuid,text)',
  'identity.assistant_panel_admit(text,text,bigint)',
]
const fail = code => { throw Object.assign(new Error(code), { code }) }

/** The caller supplies a read-only connection. Only hashes leave PostgreSQL. */
export async function checkConnectionPredecessors(query, expected) {
  if (expected?.version !== 1 || !/^[0-9a-f]{40}$/.test(expected.sourceCommit ?? '')
    || !Array.isArray(expected.functions) || expected.functions.length !== required.length
    || new Set(expected.functions.map(row => row.signature)).size !== required.length
    || expected.functions.some(row => !required.includes(row.signature) || !/^[0-9a-f]{64}$/.test(row.sha256 ?? '')))
    fail('CONNECTION_PREFLIGHT_INVALID_BASELINE')
  const { rows } = await query(`SELECT s.signature,
    CASE WHEN p.oid IS NOT NULL THEN encode(sha256(convert_to(pg_get_functiondef(p.oid), 'UTF8')), 'hex') END AS sha256
    FROM unnest($1::text[]) WITH ORDINALITY s(signature, n)
    LEFT JOIN pg_proc p ON p.oid = to_regprocedure(s.signature)
    ORDER BY s.n`, [expected.functions.map(row => row.signature)])
  if (rows.length !== required.length || new Set(rows.map(row => row.signature)).size !== required.length
    || rows.some(row => !required.includes(row.signature))) fail('CONNECTION_PREFLIGHT_INCOMPLETE_RESPONSE')
  const observed = new Map(rows.map(row => [row.signature, row.sha256]))
  const differences = expected.functions.filter(row => observed.get(row.signature) !== row.sha256)
    .map(row => ({ signature: row.signature, expected: row.sha256, observed: observed.get(row.signature) ?? null }))
  return { version: 1, sourceCommit: expected.sourceCommit, matched: differences.length === 0,
    functions: rows, differences }
}

async function main(args) {
  const options = new Map()
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1]
    if (!['--expected', '--output', '--database-url-env'].includes(key) || !value || options.has(key)) fail('CONNECTION_PREFLIGHT_INVALID_ARGUMENTS')
    options.set(key, value)
  }
  if (!options.has('--output')) fail('CONNECTION_PREFLIGHT_INVALID_ARGUMENTS')
  const envName = options.get('--database-url-env') ?? 'GUGU_INSTALL_TEST_DATABASE_URL'
  if (!/^[A-Z][A-Z0-9_]*$/.test(envName) || !process.env[envName]) fail('CONNECTION_PREFLIGHT_DATABASE_REQUIRED')
  const expectedFile = options.get('--expected') ?? new URL('../ops/platform-connections/legacy-functions.json', import.meta.url)
  const expected = JSON.parse(await readFile(expectedFile, 'utf8'))
  const { default: pg } = await import('pg')
  const db = new pg.Client({ connectionString: process.env[envName], connectionTimeoutMillis: 5_000,
    application_name: 'gugu-connection-preflight', statement_timeout: 2_000 })
  let connected = false
  try {
    await db.connect(); connected = true
    await db.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const report = await checkConnectionPredecessors((sql, values) => db.query(sql, values), expected)
    report.postgres = (await db.query('SHOW server_version')).rows[0].server_version
    await db.query('ROLLBACK')
    await writeFile(resolve(options.get('--output')), JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    process.stdout.write(JSON.stringify({ checked: report.functions.length, matched: report.matched }) + '\n')
    return report.matched ? 0 : 2
  } finally {
    if (connected) await db.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await main(process.argv.slice(2)) }
  catch (error) {
    process.stderr.write((typeof error?.code === 'string' && error.code.startsWith('CONNECTION_PREFLIGHT_') ? error.code : 'CONNECTION_PREFLIGHT_FAILED') + '\n')
    process.exitCode = 1
  }
}
