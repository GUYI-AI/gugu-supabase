import { readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const files = readdirSync(new URL('../../supabase/migrations/', import.meta.url))
// This release's reviewed baseline is fixed; future releases need not precede it.
const confirmedPredecessor = '20261106120000'
function checkFeedbackVersions(names: string[]) {
  const versions = new Map<string, string[]>()
  for (const name of names) {
    const version = /^(\d{14})_.*\.sql$/.exec(name)?.[1]
    if (version) versions.set(version, [...(versions.get(version) ?? []), name])
  }
  const feedback = names.filter(name => /_(private_feedback_screenshots|validate_feedback_screenshot_paths|validate_feedback_evidence_storage)\.sql$/.test(name)).sort()
  expect(feedback).toHaveLength(3)
  expect(feedback[0].slice(0, 14) > confirmedPredecessor).toBe(true)
  for (const name of feedback) expect(versions.get(name.slice(0, 14))).toEqual([name])
}

describe('feedback release versions', () => {
  it('uses distinct versions after the confirmed historical predecessor', () => {
    checkFeedbackVersions(files)
  })
  it('continues to pass after a legitimate later release is added', () => {
    expect(() => checkFeedbackVersions([...files, '20261108000000_next_release.sql'])).not.toThrow()
  })
  it('still rejects another migration occupying a feedback release version', () => {
    expect(() => checkFeedbackVersions([...files, '20261107000000_collision.sql'])).toThrow()
  })
})
