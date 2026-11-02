import { describe, it, expect } from 'vitest'
import { describeForConfirmation } from '../../src/tools/confirm.js'
import { carriesQuote, FORWARD_HEADER, type Draft } from '../../src/mail/compose.js'

/**
 * The line of the send confirmation that counts what a message carries. Up to
 * 0.4.11 it read "It carries 1 carried file(s)", and it named a quote only
 * while the quote was held apart from the body, so never for a stored draft
 * and never for a plain text reply.
 */

function draft(over: Partial<Draft> = {}): Draft {
  return {
    from: { address: 'me@example.com' },
    to: [{ address: 'you@example.com' }],
    cc: [],
    bcc: [],
    subject: 'Subject',
    text: 'Body',
    messageId: '<one@example.com>',
    ...over,
  }
}

describe('the count line', () => {
  it('counts files without repeating itself', () => {
    const shown = describeForConfirmation(
      draft({ attachedMessage: { filename: 'Report.eml', raw: Buffer.from('From: a@example.com') } }),
      'This message',
    )
    expect(shown).toContain('It carries 1 file(s)')
    expect(shown).not.toContain('carried file')
  })
})

describe('carriesQuote', () => {
  it('sees a quote that is still held apart from the body', () => {
    expect(carriesQuote(draft({ html: '<p>Mine</p>', quotedHtml: '<blockquote>Theirs</blockquote>' }))).toBe(true)
  })

  it('sees the forward header in a stored draft', () => {
    expect(carriesQuote(draft({ storedHtml: `<p>See below.</p><p>${FORWARD_HEADER}<br>From: jane@example.com</p>` }))).toBe(true)
  })

  it('sees a blockquote in a stored draft, which is how Proton quotes', () => {
    expect(carriesQuote(draft({ storedHtml: '<p>Thanks</p><blockquote class="protonmail_quote">Hi</blockquote>' }))).toBe(true)
  })

  it('sees the forward header in a plain text message', () => {
    expect(carriesQuote(draft({ text: `See below.\n\n${FORWARD_HEADER}\nFrom: jane@example.com` }))).toBe(true)
  })

  it('sees the "wrote:" line of a plain text reply, followed by quoted lines', () => {
    expect(carriesQuote(draft({ text: 'Thanks\n\nOn 2026-07-31 09:00, Jane wrote:\n> Hi' }))).toBe(true)
  })

  it('does not take a sentence ending in "wrote:" for a quote', () => {
    expect(carriesQuote(draft({ text: 'On Monday I wrote:\nthe report is late.' }))).toBe(false)
  })

  it('finds nothing in a stored draft without a quote', () => {
    expect(carriesQuote(draft({ storedHtml: '<p>Just a note.</p>' }))).toBe(false)
  })

  it('reaches the confirmation for a stored draft', () => {
    const shown = describeForConfirmation(
      draft({ storedHtml: `<p>See below.</p><p>${FORWARD_HEADER}<br>From: jane@example.com</p>` }),
      'This draft',
    )
    expect(shown).toContain('a quoted message')
  })
})
