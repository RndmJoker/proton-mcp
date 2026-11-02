import { describe, it, expect } from 'vitest'
import { describeDeleted, describeSaved } from '../../src/tools/saved.js'

/**
 * What an assistant reads after saving or deleting. Tobi asked on 2026-11-02
 * that it learns of the hour and that it has to copy a file it needs longer.
 */

const saved = {
  path: '/tmp/session/report.pdf',
  size: 1_786_543,
  contentType: 'application/pdf',
  sha256: 'ab'.repeat(32),
  expiresAt: new Date('2026-11-02T13:00:00Z'),
}

describe('describeSaved', () => {
  it('names the path, the type, the size and the checksum', () => {
    const text = describeSaved(saved)
    expect(text).toContain('Saved to /tmp/session/report.pdf')
    expect(text).toContain('application/pdf')
    expect(text).toContain('1786543 bytes')
    expect(text).toContain(`SHA-256: ${'ab'.repeat(32)}`)
  })

  it('says when the file goes, and to copy it if it is needed longer', () => {
    const text = describeSaved(saved)
    expect(text).toMatch(/deleted 1 hour\(s\) after saving, at 13:00 UTC, and when this server stops/)
    expect(text).toMatch(/Copy it if it is needed for longer or somewhere else/)
  })

  it('says that the content comes from a third party', () => {
    expect(describeSaved(saved)).toMatch(/comes from a third party/)
  })
})

describe('describeDeleted', () => {
  it('lists what was deleted, left, gone and not ours apart', () => {
    const text = describeDeleted({
      deleted: ['/d/a.pdf'],
      left: ['/d/b.pdf'],
      missing: ['/d/c.pdf'],
      unknown: ['/d/mine.txt'],
      folders: ['/d/report'],
    })
    expect(text).toMatch(/Deleted 1 file\(s\):\n {2}\/d\/a\.pdf/)
    expect(text).toMatch(/left in place:\n {2}\/d\/b\.pdf/)
    expect(text).toMatch(/Already gone:\n {2}\/d\/c\.pdf/)
    expect(text).toMatch(/Not saved by this server, so not touched:\n {2}\/d\/mine\.txt/)
    expect(text).toMatch(/Removed 1 empty folder\(s\) this server had created:\n {2}\/d\/report/)
  })

  it('says so when there is nothing to delete', () => {
    expect(describeDeleted({ deleted: [], left: [], missing: [], unknown: [], folders: [] })).toMatch(
      /no saved attachments/,
    )
  })
})
