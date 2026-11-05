import { readFileSync } from 'node:fs'
import test from 'node:test'
import { assertCompleteProjectPublisherSource, assertNoRuntimeSourceRewriting } from './project-publisher-contract.mjs'

const release = (name) => readFileSync(new URL('../../supabase/migrations/' + name, import.meta.url), 'utf8')

test('first-file release declares complete publishers without runtime source rewriting', () => {
  const sql = release('20261029114000_project_first_file_policy.sql')
  assertCompleteProjectPublisherSource(sql)
  assertNoRuntimeSourceRewriting(sql)
})

test('peer release declares the one local publisher and its RPC completely', () => {
  assertCompleteProjectPublisherSource(release('20261030090000_project_files_peer.sql'), ['file_private.publish_revision', 'chat.file_device_publish'])
})
