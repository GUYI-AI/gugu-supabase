import { describe, expect, it } from 'vitest'
import { objectPath, physicallyMissing, digest } from '../../../scripts/reconcile-missing-attachments.mjs'

describe('physical missing-object evidence', () => {
  const storage = { root: '/fixture', tenant: 'tenant', storageBucket: 'objects', separator: '/' }
  it('uses the exact bucket, logical key and stored version without accepting path traversal', () => {
    expect(objectPath(storage, { bucket_id: 'chat-media', name: 'owner/photo.png', version: 'v1' })).toBe('/fixture/objects/tenant/chat-media/owner/photo.png/v1')
    expect(objectPath({ ...storage, separator: '-$v-' }, { bucket_id: 'chat-media', name: 'owner/photo.png', version: 'v1' })).toBe('/fixture/objects/tenant/chat-media/owner/photo.png-$v-v1')
    for (const name of ['../other', 'owner/../../other', '/absolute', 'owner\\other', 'owner//other']) expect(() => objectPath(storage, { bucket_id: 'chat-media', name, version: 'v1' })).toThrow()
  })
  it('recognizes only ENOENT and propagates permission, I/O and service failures', async () => {
    expect(await physicallyMissing('fixture', async () => ({ isFile: () => true }))).toBe(false)
    expect(await physicallyMissing('fixture', async () => { throw Object.assign(Error('absent'), { code: 'ENOENT' }) })).toBe(true)
    for (const code of ['EACCES', 'EIO', 'ETIMEDOUT']) await expect(physicallyMissing('fixture', async () => { throw Object.assign(Error('unavailable'), { code }) })).rejects.toMatchObject({ code })
    await expect(physicallyMissing('fixture', async () => ({ isFile: () => false }))).rejects.toThrow('regular file')
  })
  it('binds review digests to content rather than JSON field ordering', () => {
    expect(digest({ a: 1, object: { b: 2, a: 1 } })).toBe(digest({ object: { a: 1, b: 2 }, a: 1 }))
    expect(digest({ a: 1 })).not.toBe(digest({ a: 2 }))
  })
})
