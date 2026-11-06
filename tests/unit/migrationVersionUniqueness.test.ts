import { readdirSync } from 'node:fs'
import { expect, it } from 'vitest'

it('assigns the pending feedback releases distinct versions after their predecessor', () => {
  const versions = new Map<string, string[]>()
  const files = readdirSync(new URL('../../supabase/migrations/', import.meta.url))
  for (const name of files) {
    const version = /^(\d{14})_.*\.sql$/.exec(name)?.[1]
    if (version) versions.set(version, [...(versions.get(version) ?? []), name])
  }
  const feedback = files.filter(name => /_(private_feedback_screenshots|validate_feedback_screenshot_paths|validate_feedback_evidence_storage)\.sql$/.test(name)).sort()
  expect(feedback).toHaveLength(3)
  const predecessor = files.filter(name => !feedback.includes(name)).map(name => name.slice(0, 14)).sort().at(-1)!
  expect(feedback[0].slice(0, 14) > predecessor).toBe(true)
  for (const name of feedback) expect(versions.get(name.slice(0, 14))).toEqual([name])
})
