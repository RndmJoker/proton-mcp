import { describe, it, expect } from 'vitest'
import {
  parseRecipient,
  parseRecipients,
  buildMessage,
  mintMessageId,
  prefixSubject,
  quote,
  describeRecipients,
  firstLines,
  type Draft,
} from '../../src/mail/compose.js'
import { BridgeError } from '../../src/bridge/errors.js'

const from = { address: 'me@example.com' }

function draft(over: Partial<Draft> = {}): Draft {
  return {
    from,
    to: [{ address: 'you@example.com' }],
    cc: [],
    bcc: [],
    subject: 'Subject',
    text: 'Body',
    messageId: '<one@example.com>',
    ...over,
  }
}

describe('parseRecipient', () => {
  it('takes a bare address and a display name alike', () => {
    expect(parseRecipient('you@example.com')).toEqual({ address: 'you@example.com' })
    expect(parseRecipient('Jane Doe <jane@example.com>')).toEqual({
      name: 'Jane Doe',
      address: 'jane@example.com',
    })
    expect(parseRecipient('"Jane Doe" <jane@example.com>')).toEqual({
      name: 'Jane Doe',
      address: 'jane@example.com',
    })
  })

  it('refuses a line break rather than stripping it', () => {
    // The one that matters. A newline in an address is how an extra header
    // gets into a message, and the extra header a mail could ask for is
    // another recipient, which the confirmation would never have shown.
    expect(() => parseRecipient('you@example.com\nBcc: quiet@example.com')).toThrow(BridgeError)
    expect(() => parseRecipient('you@example.com\r\nBcc: quiet@example.com')).toThrow(/line break/)
  })

  it('refuses what is not an address at all', () => {
    for (const bad of ['', '   ', 'nobody', 'no@domain', 'two @example.com', '@example.com']) {
      expect(() => parseRecipient(bad)).toThrow(BridgeError)
    }
  })

  it('reads a list and keeps the order', () => {
    expect(parseRecipients(['a@example.com', 'b@example.com'])).toEqual([
      { address: 'a@example.com' },
      { address: 'b@example.com' },
    ])
    expect(parseRecipients(undefined)).toEqual([])
  })
})

describe('buildMessage', () => {
  it('produces a message with the headers that were asked for', async () => {
    const raw = (
      await buildMessage(
        draft({
          cc: [{ address: 'copy@example.com' }],
          subject: 'Hallo mit Umlauten: äöü',
          text: 'Grüße',
        }),
      )
    ).toString('utf8')

    expect(raw).toContain('To: you@example.com')
    expect(raw).toContain('Cc: copy@example.com')
    expect(raw).toContain('Message-ID: <one@example.com>')
    // The subject is encoded rather than sent raw, which is what it should be.
    expect(raw).toMatch(/Subject: =\?UTF-8\?/)
  })

  it('refuses a subject containing a line break', async () => {
    await expect(buildMessage(draft({ subject: 'Hello\nBcc: quiet@example.com' }))).rejects.toThrow(
      BridgeError,
    )
  })

  it('refuses a message with no recipient at all', async () => {
    await expect(buildMessage(draft({ to: [], cc: [], bcc: [] }))).rejects.toThrow(BridgeError)
  })

  it('accepts a blind copy as the only recipient', async () => {
    await expect(
      buildMessage(draft({ to: [], bcc: [{ address: 'quiet@example.com' }] })),
    ).resolves.toBeInstanceOf(Buffer)
  })

  it('leaves the blind copies out of a message that goes out', async () => {
    // The header would tell every recipient who was copied in secretly, which
    // is the one thing a blind copy exists to prevent.
    const raw = (
      await buildMessage(draft({ bcc: [{ address: 'quiet@example.com' }] }))
    ).toString('utf8')
    expect(raw).not.toContain('quiet@example.com')
    expect(raw).not.toContain('Bcc')
  })

  it('keeps the blind copies in a message that is only stored', async () => {
    // A draft has to keep them, or the addresses are gone by the time anyone
    // comes back to send it.
    const raw = (
      await buildMessage(draft({ bcc: [{ address: 'quiet@example.com' }] }), { keepBcc: true })
    ).toString('utf8')
    expect(raw).toContain('Bcc: quiet@example.com')
  })

  it('writes the reference headers a reply needs', async () => {
    const raw = (
      await buildMessage(
        draft({ inReplyTo: 'orig@example.com', references: ['<older@example.com>', 'orig@example.com'] }),
      )
    ).toString('utf8')
    // Given with and without brackets, written with them either way.
    expect(raw).toContain('In-Reply-To: <orig@example.com>')
    expect(raw).toContain('<older@example.com>')
  })

  it('carries a whole message along when one is given', async () => {
    const raw = (
      await buildMessage(
        draft({
          attachedMessage: { filename: 'original.eml', raw: Buffer.from('From: a@example.com') },
        }),
      )
    ).toString('utf8')
    expect(raw).toContain('message/rfc822')
    expect(raw).toContain('original.eml')
  })
})

describe('mintMessageId', () => {
  it('is unique and uses the sender domain', () => {
    const a = mintMessageId('me@example.com')
    const b = mintMessageId('me@example.com')
    expect(a).not.toBe(b)
    expect(a).toMatch(/^<[0-9a-f-]+@example\.com>$/)
  })
})

describe('prefixSubject', () => {
  it('adds a prefix once, in either language', () => {
    expect(prefixSubject('Bericht', 'Re')).toBe('Re: Bericht')
    expect(prefixSubject('Re: Bericht', 'Re')).toBe('Re: Bericht')
    expect(prefixSubject('AW: Bericht', 'Re')).toBe('AW: Bericht')
    expect(prefixSubject('Bericht', 'Fwd')).toBe('Fwd: Bericht')
    expect(prefixSubject('Fw: Bericht', 'Fwd')).toBe('Fw: Bericht')
  })

  it('says something rather than nothing for an empty subject', () => {
    expect(prefixSubject('', 'Re')).toBe('Re: (no subject)')
  })
})

describe('quote', () => {
  it('marks every line and names who wrote it', () => {
    const text = quote({
      from: [{ name: 'Jane', address: 'jane@example.com' }],
      date: new Date('2026-07-31T09:00:00Z'),
      subject: 'Bericht',
      text: 'one\ntwo',
    })
    expect(text).toContain('Jane <jane@example.com> wrote:')
    expect(text).toContain('> one')
    expect(text).toContain('> two')
  })

  it('shortens a very long original', () => {
    const text = quote(
      { from: [], date: undefined, subject: '', text: 'x'.repeat(9000) },
      100,
    )
    expect(text).toContain('[...]')
    expect(text.length).toBeLessThan(500)
  })
})

describe('describeRecipients', () => {
  it('separates To, Cc and Bcc and says what a blind copy means', () => {
    const text = describeRecipients({
      to: [{ address: 'a@example.com' }],
      cc: [{ address: 'b@example.com' }],
      bcc: [{ address: 'c@example.com' }],
    })
    expect(text).toContain('To:  a@example.com')
    expect(text).toContain('Cc:  b@example.com')
    expect(text).toContain('Bcc: c@example.com')
    expect(text).toContain('hidden from the other recipients')
  })

  it('leaves out the lines that have nothing in them', () => {
    const text = describeRecipients({ to: [{ address: 'a@example.com' }], cc: [], bcc: [] })
    expect(text).not.toContain('Cc:')
    expect(text).not.toContain('Bcc:')
  })
})

describe('firstLines', () => {
  it('shortens by lines and by characters', () => {
    expect(firstLines('a\nb\nc\nd', 2)).toBe('a\nb')
    expect(firstLines('x'.repeat(1000), 8, 50)).toHaveLength(53)
  })

  it('says so rather than showing nothing for an empty body', () => {
    expect(firstLines('   ')).toBe('(the message has no text)')
  })
})
