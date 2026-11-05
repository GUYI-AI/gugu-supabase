import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

// The text classifier belongs to the client. The edge runtime cannot fetch it at boot, so this repository keeps a copy;
// the copy is only allowed to be the pinned client commit's bytes, so there is one source of truth.
const dir = new URL('../../../supabase/functions/_shared/client-shared/', import.meta.url)
const pin = JSON.parse(readFileSync(new URL('source.json', dir), 'utf8')) as {
  repository: string
  commit: string
  files: Record<string, string>
}

describe('client-shared copies', () => {
  it('pins a full client commit', () => {
    expect(pin.commit).toMatch(/^[0-9a-f]{40}$/)
  })

  it.each(Object.entries(pin.files))('%s is byte-identical to the pinned client source', async (name, path) => {
    const url = `https://raw.githubusercontent.com/${pin.repository}/${pin.commit}/${path}`
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Cannot read the pinned client source: HTTP ${response.status} (${url})`)
    const pinned = Buffer.from(await response.arrayBuffer())
    const copy = readFileSync(new URL(name, dir))
    // Refresh: copy the file from that commit, or move the pin and copy both files together.
    expect(copy.equals(pinned), `${name} differs from ${url}`).toBe(true)
  })
})
