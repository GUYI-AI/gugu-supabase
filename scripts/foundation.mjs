import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const foundationFile = fileURLToPath(new URL('../supabase/migrations/20261021000000_foundation.sql', import.meta.url))
export const foundationSql = readFileSync(foundationFile, 'utf8')
export const foundationDigest = createHash('sha256').update(foundationSql).digest('hex')

const migrationsDir = fileURLToPath(new URL('../supabase/migrations/', import.meta.url))
// One explicit split of the already-installed #151 release. Keep the old ledger row untouched;
// new installations run the function-only body and both paths finish with the concurrent release.
const workspaceSplit = {
  version: '20261102212500_workspace_listing_scan_budget',
  previousDigest: '5f0c4abef6cd6475d042b6fd1170d91d618edc2f8ec680cbf26eb1ce8ba62253',
  digest: '579cee5b88b834bcfe392d4c3b6058866b5efe35a2313e4f3107454ab4e313b2',
}

/** Releases after the foundation, in file order. All other published files remain immutable. */
export const releases = readdirSync(migrationsDir)
  .filter((file) => /^\d{14}_[a-z0-9_]+\.sql$/.test(file) && file !== '20261021000000_foundation.sql')
  .sort()
  .map((file) => {
    const sql = readFileSync(migrationsDir + file, 'utf8')
    const version = file.slice(0, -4)
    const digest = createHash('sha256').update(sql).digest('hex')
    const release = { version, sql, digest }
    if (version === workspaceSplit.version) {
      if (digest !== workspaceSplit.digest) throw new Error('Workspace release split differs from the reviewed body')
      release.previousDigest = workspaceSplit.previousDigest
    }
    // PostgreSQL ends line comments at CR as well as LF. Normalize before both
    // directive detection and comment removal so a CR cannot hide another statement.
    const normalizedSql = sql.replace(/\r\n?/g, '\n')
    if (normalizedSql.startsWith('-- gugu:transaction off\n')) {
      // A single statement is required: even a multi-statement simple query creates an implicit transaction.
      const statement = normalizedSql.replace(/^--[^\n]*(?:\n|$)/gm, '').trim()
      const match = /^CREATE INDEX CONCURRENTLY IF NOT EXISTS ([a-z_][a-z_0-9]*) ON ([a-z_][a-z_0-9]*)\.[a-z_][a-z_0-9]*\b[^;]+;$/i.exec(statement)
      const validation = /^ALTER TABLE ([a-z_][a-z_0-9]*)\.([a-z_][a-z_0-9]*) VALIDATE CONSTRAINT ([a-z_][a-z_0-9]*);$/i.exec(statement)
      if (match) release.concurrentIndex = match[2] + '.' + match[1]
      else if (validation) release.constraintValidation = { table: (validation[1] + '.' + validation[2]).toLowerCase(), constraint: validation[3].toLowerCase() }
      else throw new Error('Nontransactional release must contain one CREATE INDEX CONCURRENTLY IF NOT EXISTS or ALTER TABLE VALIDATE CONSTRAINT: ' + version)
    }
    return release
  })

/** query runs a complete SQL request on one connection. No historical ledger is rewritten. */
export async function installFoundation(query) {
  const [state] = await query(`SELECT current_setting('server_version_num')::integer AS version,
    to_regnamespace('identity') IS NOT NULL AS has_identity,
    to_regnamespace('billing') IS NOT NULL AS has_billing,
    to_regclass('gugu_install.releases') IS NOT NULL AS has_ledger,
    to_regclass('auth.users') IS NOT NULL AND to_regclass('storage.objects') IS NOT NULL
      AND to_regclass('realtime.messages') IS NOT NULL AS has_platform`, true)
  if (!state || Number(state.version) < 170000) throw new Error('Gugu foundation requires PostgreSQL 17 or newer')
  if (!state.has_platform) throw new Error('Initialize Supabase Auth, Storage and Realtime before installing the foundation')
  if (state.has_ledger) {
    const rows = await query("SELECT digest FROM gugu_install.releases WHERE version='foundation-v1'", true)
    if (rows.length !== 1 || rows[0].digest !== foundationDigest) throw new Error('Installed foundation differs; use an explicit upgrade, never reset its ledger')
    if (!state.has_identity || state.has_billing) throw new Error('This is not a standalone community foundation')
    return { installed: false, digest: foundationDigest }
  }
  if (state.has_identity || state.has_billing) throw new Error('Use a new dedicated project; this database already contains Gugu or official service schemas')
  await query(`BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('gugu:foundation-install:v1',0));
DO $fresh$ BEGIN
  IF to_regnamespace('identity') IS NOT NULL OR to_regnamespace('billing') IS NOT NULL OR to_regnamespace('chat') IS NOT NULL OR to_regnamespace('gugu_install') IS NOT NULL THEN
    RAISE EXCEPTION 'Foundation requires a fresh dedicated project';
  END IF;
END $fresh$;
${foundationSql}
CREATE SCHEMA gugu_install;
REVOKE ALL ON SCHEMA gugu_install FROM PUBLIC,anon,authenticated;
CREATE TABLE gugu_install.releases(version text PRIMARY KEY,digest text NOT NULL,installed_at timestamptz NOT NULL DEFAULT now());
REVOKE ALL ON gugu_install.releases FROM PUBLIC,anon,authenticated;
INSERT INTO gugu_install.releases(version,digest) VALUES('foundation-v1','${foundationDigest}');
COMMIT;`)
  const [result] = await query("SELECT digest FROM gugu_install.releases WHERE version='foundation-v1'", true)
  if (result?.digest !== foundationDigest) throw new Error('Foundation installation could not be verified')
  return { installed: true, digest: foundationDigest }
}

/** Ordinary releases are transactional; explicitly marked indexes/validations run as single requests.
 * Official installers defer those statements until their community + official transaction has committed.
 */
export async function installReleases(query, { deferConcurrentIndexes = false, deferNontransactional = deferConcurrentIndexes } = {}) {
  const rows = await query("SELECT version,digest FROM gugu_install.releases WHERE version<>'foundation-v1'", true)
  const installed = new Map(rows.map((row) => [row.version, row.digest]))
  for (const version of installed.keys()) {
    if (!releases.some((release) => release.version === version)) throw new Error('Database has release ' + version + ' that this source does not know; use a matching or newer source')
  }
  for (const release of releases) {
    if (installed.has(release.version) && installed.get(release.version) !== release.digest && installed.get(release.version) !== release.previousDigest) throw new Error('Installed release ' + release.version + ' differs from source; publish changes as a new release file')
  }
  const applied = []
  for (const release of releases) {
    if (installed.has(release.version)) continue
    const standalone = release.concurrentIndex || release.constraintValidation
    if (standalone && deferNontransactional) continue
    if (release.concurrentIndex) {
      await verifyConcurrentIndex(query, release, false)
      await query(release.sql)
      await verifyConcurrentIndex(query, release, true)
    }
    if (release.constraintValidation) {
      await query(release.sql)
      const { table, constraint } = release.constraintValidation
      const [state] = await query(`SELECT convalidated FROM pg_constraint WHERE conrelid=to_regclass('${table}') AND conname='${constraint}'`, true)
      if (!state?.convalidated) throw new Error('Constraint was not validated: ' + table + '.' + constraint)
    }
    await query(`BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('gugu:foundation-install:v1',0));
DO $guard$ BEGIN
  IF EXISTS (SELECT 1 FROM gugu_install.releases WHERE version='${release.version}') THEN
    RAISE EXCEPTION 'Release ${release.version} was installed concurrently';
  END IF;
END $guard$;
${standalone ? '' : release.sql}
INSERT INTO gugu_install.releases(version,digest) VALUES('${release.version}','${release.digest}');
COMMIT;`)
    applied.push(release.version)
  }
  return { applied, versions: releases.map((release) => release.version) }
}

async function verifyConcurrentIndex(query, release, required) {
  const [index] = await query(`SELECT indisvalid,indisready FROM pg_index WHERE indexrelid=to_regclass('${release.concurrentIndex}')`, true)
  if (index && (!index.indisvalid || !index.indisready)) {
    throw new Error(`Index ${release.concurrentIndex} is INVALID or not ready; inspect it, then run DROP INDEX CONCURRENTLY ${release.concurrentIndex} outside a transaction and retry the migration`)
  }
  if (required && !index) throw new Error('Concurrent index was not created: ' + release.concurrentIndex)
}
