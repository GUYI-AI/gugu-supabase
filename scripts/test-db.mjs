import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareAuthAuditFixtureIndex } from './auth-audit-fixture-index.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const project = 'gugucommunitytest' + createHash('sha256').update(root).digest('hex').slice(0, 10)
const network = project + '-loopback'
const directory = path.join(root, '.local/test-db')
const marker = path.join(directory, 'owner.json')
const cli = path.join(root, 'node_modules/.bin/supabase')
const action = process.argv[2]
if (!['start', 'stop'].includes(action)) throw new Error('Usage: node scripts/test-db.mjs start|stop')

if (action === 'stop') {
  if (!existsSync(marker)) { console.log('No test database owned by this checkout.'); process.exit(0) }
  const owner = JSON.parse(readFileSync(marker, 'utf8'))
  if (owner.root !== root || owner.project !== project) throw new Error('Test database ownership differs; refusing to stop it')
  execFileSync(cli, ['stop', '--workdir', directory, '--project-id', project, '--no-backup'], { stdio: 'inherit' })
  const metadata = JSON.parse(execFileSync('docker', ['network', 'inspect', network], { encoding: 'utf8' }))[0]
  if (metadata.Labels?.['org.gugu.test-checkout'] !== project) throw new Error('Network ownership differs; refusing cleanup')
  execFileSync('docker', ['network', 'rm', network], { stdio: 'inherit' })
  rmSync(directory, { recursive: true })
} else {
  if (existsSync(directory)) throw new Error('Test directory already exists; stop this checkout\'s fixture first')
  const port = Number(process.env.GUGU_TEST_DB_PORT || '54322')
  const emailOtp = process.env.GUGU_TEST_EMAIL_OTP === '1'
  if (!Number.isInteger(port) || port < 1026 || port > 65535) throw new Error('Invalid GUGU_TEST_DB_PORT')
  const existing = execFileSync('docker', ['ps', '-a', '--filter', 'name=^supabase_db_' + project + '$', '--format', '{{.ID}}'], { encoding: 'utf8' }).trim()
  if (existing) throw new Error('A container already uses this fixture identity; refusing to adopt it')
  await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', () => reject(new Error('Test database port is already occupied')))
    server.listen(port, '127.0.0.1', () => server.close(resolve))
  })
  mkdirSync(path.join(directory, 'supabase/migrations'), { recursive: true })
  writeFileSync(marker, JSON.stringify({ root, project, port }) + '\n', { mode: 0o600, flag: 'wx' })
  if (emailOtp) {
    mkdirSync(path.join(directory, 'supabase/templates'), { recursive: true })
    writeFileSync(path.join(directory, 'supabase/templates/otp.html'), '<p>Code: {{ .Token }}</p>\n')
  }
  execFileSync('docker', ['network', 'create', '--label', 'org.gugu.test-checkout=' + project,
    '--opt', 'com.docker.network.bridge.host_binding_ipv4=127.0.0.1', network], { stdio: 'inherit' })
  writeFileSync(path.join(directory, 'supabase/config.toml'), `project_id = "${project}"
[api]
enabled = true
port = ${port - 1}
schemas = ["public", "graphql_public"]
[db]
port = ${port}
shadow_port = ${port - 2}
major_version = 17
[db.seed]
enabled = false
[studio]
enabled = false
[analytics]
enabled = false
[auth]
enabled = true
${emailOtp ? `[auth.email.template.magic_link]
subject = "Local deletion verification"
content_path = "./supabase/templates/otp.html"
` : ''}
[storage]
enabled = true
[realtime]
enabled = true
[inbucket]
enabled = ${emailOtp}
${emailOtp ? `port = ${port + 1}
smtp_port = ${port + 2}
pop3_port = ${port + 3}` : ''}
`)
  // Storage and Realtime initialize their real platform schemas before the Gugu baseline.
  const excluded = ['analytics', 'edge-runtime', 'functions', 'imgproxy', 'meta', 'studio', 'vector', ...emailOtp ? [] : ['inbucket']]
  execFileSync(cli, ['start', '--workdir', directory, '--network-id', network, '--exclude', excluded.join(',')], { stdio: 'inherit' })
  const binding = execFileSync('docker', ['port', 'supabase_db_' + project, '5432/tcp'], { encoding: 'utf8' }).trim()
  if (binding !== '127.0.0.1:' + port) throw new Error('Fixture database is not bound exclusively to loopback; stop this fixture before continuing')
  const apiBinding = execFileSync('docker', ['port', 'supabase_kong_' + project, '8000/tcp'], { encoding: 'utf8' }).trim()
  if (apiBinding !== '127.0.0.1:' + (port - 1)) throw new Error('Fixture API is not bound exclusively to loopback; stop this fixture before continuing')
  prepareAuthAuditFixtureIndex(root)
  console.log(`Fixture ready: set GUGU_INSTALL_TEST_DATABASE_URL and GUGU_INTEGRATION_DATABASE_URL to postgresql://postgres:postgres@127.0.0.1:${port}/postgres?sslmode=disable`)
}
