import { describe, it, expect } from 'vitest'
import { normaliseMessageId, ALL_MAIL } from '../../src/mail/ids.js'
import { BridgeError } from '../../src/bridge/errors.js'

describe('normaliseMessageId', () => {
  it('adds the angle brackets the IMAP header uses', () => {
    expect(normaliseMessageId('abc@example.com')).toBe('<abc@example.com>')
  })

  it('accepts an id that already has them', () => {
    expect(normaliseMessageId('<abc@example.com>')).toBe('<abc@example.com>')
  })

  it('ignores surrounding whitespace', () => {
    // Callers paste ids from earlier answers, sometimes with a stray space.
    expect(normaliseMessageId('  <abc@example.com>  ')).toBe('<abc@example.com>')
  })

  it('copes with the long base64-style ids Proton generates', () => {
    const protonStyle = 'U6alR9m7DFH1c6hGOE5DNSU-dHc7u0mY7XZ2F0Hdd3zK_RLgFQ==@example.com'
    expect(normaliseMessageId(protonStyle)).toBe(`<${protonStyle}>`)
  })

  it('rejects an empty id with an explanation', () => {
    expect(() => normaliseMessageId('')).toThrow(BridgeError)
    expect(() => normaliseMessageId('   ')).toThrow(BridgeError)
  })

  it('does not strip brackets from the middle of an id', () => {
    expect(normaliseMessageId('a<b>c@example.com')).toBe('<a<b>c@example.com>')
  })
})

describe('ALL_MAIL', () => {
  it('names the mailbox that holds every message', () => {
    // Measured: "All Mail" also contains messages that live in Trash, which
    // makes it the right fallback for a lookup.
    expect(ALL_MAIL).toBe('All Mail')
  })
})
