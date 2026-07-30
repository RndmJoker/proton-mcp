import { describe, it, expect } from 'vitest'
import { isTextual, MAX_ATTACHMENT_CHARS } from '../../src/mail/attachments.js'

describe('isTextual', () => {
  it('accepts text types', () => {
    for (const t of ['text/plain', 'text/html', 'text/csv', 'text/markdown']) {
      expect(isTextual(t)).toBe(true)
    }
  })

  it('accepts structured formats that are readable as text', () => {
    for (const t of ['application/json', 'application/xml', 'application/x-yaml']) {
      expect(isTextual(t)).toBe(true)
    }
  })

  it('accepts the +json and +xml suffix conventions', () => {
    expect(isTextual('application/vnd.api+json')).toBe(true)
    expect(isTextual('image/svg+xml')).toBe(true)
  })

  it('rejects binary types, which would be useless as text', () => {
    for (const t of ['application/pdf', 'image/png', 'application/zip', 'audio/mpeg']) {
      expect(isTextual(t)).toBe(false)
    }
  })

  it('is case-insensitive', () => {
    expect(isTextual('TEXT/PLAIN')).toBe(true)
    expect(isTextual('Application/JSON')).toBe(true)
  })
})

describe('MAX_ATTACHMENT_CHARS', () => {
  it('stays within a sane share of a context window', () => {
    // Roughly 12000 tokens. The largest message in a measured sample was
    // 4.8 MB, so an unbounded attachment would be fatal.
    expect(MAX_ATTACHMENT_CHARS).toBeGreaterThan(1000)
    expect(MAX_ATTACHMENT_CHARS).toBeLessThanOrEqual(100_000)
  })
})
