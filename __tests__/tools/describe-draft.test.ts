import { describe, it, expect } from 'vitest'
import { describeDraft } from '../../src/tools/drafts.js'
import type { DraftResult } from '../../src/mail/drafts.js'

/**
 * What an assistant is told after writing a draft. Up to 0.4.11 a forward of
 * a message with two attachments was reported as "The original carried 1
 * attachment(s)", naming the file this server had added.
 */

const base: DraftResult = {
  messageId: '<draft@example.com>',
  subject: 'Fwd: Report',
  to: [{ address: 'you@example.com' }],
  cc: [],
  bcc: [],
  uid: 7,
}

describe('describeDraft', () => {
  it('says that the original is attached as one file, and names that file', () => {
    const text = describeDraft(
      { ...base, attachedOriginal: { filename: 'Report.eml', carries: ['daten.json'] } },
      'Forward written',
    )
    expect(text).toContain('The original is attached as one file, Report.eml, so nothing of it is lost.')
    expect(text).not.toMatch(/The original carried/)
  })

  it('names the attachments travelling inside the original', () => {
    const text = describeDraft(
      {
        ...base,
        attachedOriginal: {
          filename: 'Report.eml',
          carries: ['daten.json', 'notiz-\u00fcber-br\u00fccken.txt'],
        },
      },
      'Forward written',
    )
    expect(text).toContain(
      'Inside it travel its own 2 attachment(s): daten.json, notiz-\u00fcber-br\u00fccken.txt.',
    )
  })

  it('says nothing about an original when none is attached', () => {
    const text = describeDraft(base, 'Draft written')
    expect(text).not.toContain('attached as one file')
    expect(text).not.toContain('Inside it travel')
  })
})
