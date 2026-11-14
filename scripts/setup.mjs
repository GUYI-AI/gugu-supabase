import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { installFoundation, installReleases } from './foundation.mjs'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const { values } = parseArgs({
  options: { 'project-ref': { type: 'string' }, 'client-dir': { type: 'string' } },
})
const ref = values['project-ref'] || process.env.SUPABASE_PROJECT_REF
const token = process.env.SUPABASE_ACCESS_TOKEN
if (!ref || !/^[a-z0-9-]{8,64}$/.test(ref)) throw new Error('Set SUPABASE_PROJECT_REF to your dedicated empty project')
if (!token) throw new Error('Set SUPABASE_ACCESS_TOKEN locally; never paste it into chat or commit it')
const clientDir = values['client-dir'] ? path.resolve(values['client-dir']) : null
if (clientDir && JSON.parse(readFileSync(path.join(clientDir, 'package.json'), 'utf8')).name !== 'gugu') throw new Error('--client-dir must point to a Gugu source checkout')

async function api(suffix, method = 'GET', body) {
  const response = await fetch('https://api.supabase.com/v1/projects/' + encodeURIComponent(ref) + suffix, {
    method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) throw new Error('Supabase Management API ' + suffix + ' failed: HTTP ' + response.status)
  const text = await response.text()
  return text ? JSON.parse(text) : null
}
async function query(sql, readOnly = false, parameters) {
  const result = await api('/database/query', 'POST', { query: sql, read_only: readOnly, ...(parameters ? { parameters } : {}) })
  if (!Array.isArray(result)) throw new Error('Unexpected Supabase query response; installation is not verified')
  return result
}
async function cli(args) {
  try { return await exec(path.join(root, 'node_modules/.bin/supabase'), args, { cwd: root, maxBuffer: 8 * 1024 * 1024 }) }
  catch (error) { throw new Error('Supabase CLI ' + args[0] + ' failed (exit ' + (error.code ?? 'unknown') + '); credentials were not printed') }
}

await api('')
const result = await installFoundation(query)
console.log(result.installed ? 'Foundation installed and verified.' : 'Matching foundation verified; existing data preserved.')
const upgrade = await installReleases(query)
console.log(upgrade.applied.length ? 'Releases applied: ' + upgrade.applied.join(', ') : 'All ' + upgrade.versions.length + ' releases already installed.')
const currentRest = await api('/postgrest')
const schemas = new Set(String(currentRest.db_schema || 'public').split(',').map((item) => item.trim()).filter(Boolean))
for (const schema of ['public', 'identity', 'chat', 'moments']) schemas.add(schema)
await api('/postgrest', 'PATCH', { db_schema: [...schemas].join(',') })
const publicUrl = 'https://' + ref + '.supabase.co'
// The client signs in with a 6-digit email code; new projects default to 8 digits and link-only templates.
const auth = await api('/config/auth')
const authPatch = { mailer_otp_length: 6 }
const codeLine = '<p>Your Gugu sign-in code: <strong>{{ .Token }}</strong></p>\n'
const templates = ['mailer_templates_magic_link_content', 'mailer_templates_confirmation_content']
  .filter((key) => !String(auth[key] || '').includes('{{ .Token }}'))
// Supabase refuses template edits on free projects that still use the built-in email provider.
if (auth.smtp_host) for (const key of templates) authPatch[key] = codeLine + String(auth[key] || '')
await api('/config/auth', 'PATCH', authPatch)
if (templates.length && !auth.smtp_host) console.warn('WARNING: sign-in emails do not contain the 6-digit code yet. Configure custom SMTP (docs/self-hosting-smtp.md), then run setup again.')
await api('/secrets', 'POST', [{ name: 'GUGU_PUBLIC_SUPABASE_URL', value: publicUrl }])
await cli(['functions', 'deploy', 'server-login', '--project-ref', ref, '--use-api'])
await cli(['functions', 'deploy', 'attachments', '--project-ref', ref, '--use-api'])
await cli(['functions', 'deploy', 'account-deletion', '--project-ref', ref, '--use-api'])
const keys = JSON.parse((await cli(['projects', 'api-keys', '--project-ref', ref, '--output', 'json'])).stdout)
const anon = keys.find((key) => key.name === 'anon' && typeof key.api_key === 'string')?.api_key
if (!anon) throw new Error('Project has no supported public anon key; no client configuration was written')
const service = keys.find((key) => key.name === 'service_role' && typeof key.api_key === 'string')?.api_key
if (!service) throw new Error('Project has no supported server key; attachment GC is not configured')
async function vaultSecret(name, value) {
  const existing = await query('SELECT id FROM vault.secrets WHERE name=$1', true, [name])
  if (existing.length) await query('SELECT vault.update_secret($1::uuid,$2::text)', false, [existing[0].id, value])
  else await query('SELECT vault.create_secret($1::text,$2::text)', false, [value, name])
}
await vaultSecret('attachments_gc_url', publicUrl + '/functions/v1/attachments/gc')
await vaultSecret('attachments_gc_key', service)

if (clientDir) {
  const directory = path.join(clientDir, '.envs')
  mkdirSync(directory, { recursive: true })
  const target = path.join(directory, 'local.env')
  if (existsSync(target)) {
    if (lstatSync(target).isSymbolicLink()) throw new Error('Refusing to replace a symlinked client configuration')
    const backup = target + '.backup-' + Date.now()
    copyFileSync(target, backup)
    chmodSync(backup, 0o600)
  }
  const values = {
    GUGU_SUPABASE_URL: publicUrl, VITE_SUPABASE_URL: publicUrl,
    GUGU_SUPABASE_ANON_KEY: anon, VITE_SUPABASE_ANON_KEY: anon,
    GUGU_CLOUD_COMPUTER_ENABLED: 'false', VITE_GUGU_CLOUD_COMPUTER_ENABLED: 'false',
    GUGU_PLATFORM_MODELS_ENABLED: 'false', VITE_GUGU_PLATFORM_MODELS_ENABLED: 'false',
    GUGU_RELAY_URL: '', VITE_GUGU_RELAY_URL: '',
  }
  const temporary = target + '.new-' + Date.now()
  writeFileSync(temporary, Object.entries(values).map(([key, value]) => key + '=' + value).join('\n') + '\n', { mode: 0o600, flag: 'wx' })
  renameSync(temporary, target)
  console.log('Client .envs/local.env written with public connection values and official services disabled.')
}
console.log('Database and functions configured. Use GUGU_DB_TARGET=local to start the client; configure your own model or CLI.')
