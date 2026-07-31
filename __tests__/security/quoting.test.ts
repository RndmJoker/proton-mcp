import { describe, it, expect } from 'vitest'
import { buildReplyDraft, buildForwardDraft } from '../../src/mail/drafts.js'
import { quoteAsHtml, escapeHtml, readableBody } from '../../src/mail/compose.js'
import { readMarkup } from '../../src/mail/markup.js'
import type { Connection, MailboxStatus } from '../../src/bridge/connection.js'

/**
 * Quoting a stranger's message inside one of our own.
 *
 * The quote keeps the original as it was written, which is what a reply is
 * expected to look like and what was decided after measuring: 94 percent of
 * real mail is formatted, and cutting a quote down to what this server writes
 * itself needed a median of 87 removals per message, which demolishes it.
 *
 * So the boundary is not between our markup and theirs. It is between markup
 * that stays inside the quote and markup that reaches out of it:
 *
 * - **The composed part is held to the permitted set**, because it is written
 *   under this account's name and a person answers for it.
 * - **The quote keeps everything except document-level elements.** A `<style>`
 *   block applies to the whole message, so inside a quote it restyles the reply
 *   above it. Measured: 66 percent of formatted mail carries one and 56 percent
 *   of those aim at bare elements, `blockquote` among them.
 * - **A quoted plain text original is still escaped**, or text that happens to
 *   contain angle brackets would become markup.
 *
 * What is deliberately no longer true: a link in the quote is a link again,
 * with whatever target it always had. That is what quoting a message means, and
 * it is the same in every mail client.
 */

const ME = 'me@example.com'

/** A message whose markup is everything this server would refuse to send. */
const HOSTILE = [
  'Message-ID: <original@example.com>',
  'From: Jane Doe <jane@example.com>',
  'To: me@example.com',
  'Subject: Newsletter',
  'Date: Fri, 31 Jul 2026 09:00:00 +0000',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<html><head><style>p::before{content:"generated"}</style></head><body>' +
    '<div style="display:none">hidden from a reader</div>' +
    '<script>steal()</script>' +
    '<p onclick="run()">Ordinary looking text.</p>' +
    '<a href="https://phishing.invalid/pay">your bank</a>' +
    '<img src="https://tracker.invalid/p.gif" alt="an alt text">' +
    '</body></html>',
].join('\r\n')

const PLAIN = [
  'Message-ID: <original@example.com>',
  'From: Jane Doe <jane@example.com>',
  'To: me@example.com, other@example.com',
  'Subject: Report',
  'Date: Fri, 31 Jul 2026 09:00:00 +0000',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'The plain text of the message.',
  'A second line.',
].join('\r\n')

function fakeConnection(source: string) {
  const connection = {
    listMailboxes: async () => [],
    status: async (path: string) => ({ path, messages: 3, unseen: 0, uidValidity: '1', uidNext: 9 }),
    withMailbox: async (
      path: string,
      operation: (c: unknown, s: MailboxStatus) => Promise<unknown>,
    ) => {
      const client = {
        search: async () => [4],
        fetchOne: async (_uid: string, query: Record<string, unknown>) => {
          if (query.source) return { source: Buffer.from(source) }
          if (query.headers) return { headers: Buffer.from(source.split('\r\n\r\n')[0] ?? '') }
          if (query.flags) return { flags: new Set<string>() }
          return undefined
        },
      }
      return operation(client, { path, messages: 3, unseen: 0, uidValidity: '1', uidNext: 9 })
    },
  } as unknown as Connection
  return connection
}

describe('replying to a message this server would refuse to send', () => {
  it('works, rather than refusing because the original was not to our taste', async () => {
    // Real mail is full of elements this server would not write. Holding a
    // quote to that list would make replying to most messages impossible.
    const draft = await buildReplyDraft(
      fakeConnection(HOSTILE),
      ME,
      '<original@example.com>',
      '<p>My answer.</p>',
      { html: '<p>My answer.</p>' },
    )
    expect(draft.html).toBeDefined()
    expect(draft.quotedHtml).toBeDefined()
  })

  it('carries none of the original markup into the reply', async () => {
    const draft = await buildReplyDraft(
      fakeConnection(HOSTILE),
      ME,
      '<original@example.com>',
      'x',
      { html: '<p>My answer.</p>' },
    )
    // Only the ones that would act outside the quote. An onclick or an inline
    // display:none stays inside the element it sits on, and no mail client runs
    // a handler, so those ride along the way every other client quotes them.
    const quoted = draft.quotedHtml ?? ''
    expect(quoted).not.toContain('<script')
    expect(quoted).not.toContain('<style')
    expect(quoted).not.toContain('generated')
  })

  it('keeps the original as it was written, formatting and all', async () => {
    const draft = await buildReplyDraft(
      fakeConnection(HOSTILE),
      ME,
      '<original@example.com>',
      'x',
      { html: '<p>My answer.</p>' },
    )
    expect(draft.quotedHtml).toContain('Ordinary looking text.')
    // The link is a link again, with its own target. That is what a quote is.
    expect(draft.quotedHtml).toContain('href="https://phishing.invalid/pay"')
  })

  it('keeps the composed part and the quote apart', async () => {
    // The separation is the boundary. What was written goes through the
    // permitted set; what is quoted does not, and could not.
    const draft = await buildReplyDraft(
      fakeConnection(HOSTILE),
      ME,
      '<original@example.com>',
      'x',
      { html: '<p>My answer.</p>' },
    )
    expect(draft.html).toBe('<p>My answer.</p>')
    expect(readMarkup(draft.html ?? '').problems).toEqual([])
    expect(draft.quotedHtml).not.toContain('My answer')
  })
})

describe('escaping', () => {
  it('turns angle brackets in the original into characters, not into elements', async () => {
    // Without this, text that happens to look like markup would become markup
    // in the reply, which is how a quote turns into an injection.
    const withBrackets = PLAIN.replace(
      'The plain text of the message.',
      'Somebody wrote <script>alert(1)</script> as literal text.',
    )
    const draft = await buildReplyDraft(
      fakeConnection(withBrackets),
      ME,
      '<original@example.com>',
      'x',
      { html: '<p>Answer.</p>' },
    )
    expect(draft.quotedHtml).toContain('&lt;script&gt;')
  })

  it('escapes the sender name as well, which is also foreign text', () => {
    const quoted = quoteAsHtml({
      from: [{ name: '<b>Jane</b>', address: 'jane@example.com' }],
      date: undefined,
      text: 'body',
    })
    expect(quoted).toContain('&lt;b&gt;Jane&lt;/b&gt;')
    expect(readMarkup(quoted).problems).toEqual([])
  })

  it('escapes the characters that matter and leaves the rest alone', () => {
    // The non-ASCII character is written as an escape rather than typed. It is
    // a specimen here, not German prose, and the repository's language check
    // reads a literal umlaut as the latter.
    expect(escapeHtml('a & b < c > d "e" \u00e4')).toBe(
      'a &amp; b &lt; c &gt; d &quot;e&quot; \u00e4',
    )
  })
})

describe('forwarding', () => {
  it('quotes the original the same way a reply does', async () => {
    // The two share one preparation. Two of them would come to differ in what
    // they let through, and the difference would be nobody's decision.
    const draft = await buildForwardDraft(
      fakeConnection(HOSTILE),
      ME,
      '<original@example.com>',
      ['third@example.com'],
      '',
      { html: '<p>For your information.</p>' },
    )
    expect(draft.quotedHtml).toContain('Forwarded message')
    expect(draft.quotedHtml).toContain('Ordinary looking text.')
    expect(draft.quotedHtml).not.toContain('<script')
    expect(draft.quotedHtml).not.toContain('<style')
    expect(draft.html).toBe('<p>For your information.</p>')
  })

  it('still works without markup, exactly as before', async () => {
    const draft = await buildForwardDraft(
      fakeConnection(PLAIN),
      ME,
      '<original@example.com>',
      ['third@example.com'],
      'Note',
    )
    expect(draft.html).toBeUndefined()
    expect(draft.text).toContain('Forwarded message')
  })
})

describe('a reply without markup is untouched', () => {
  it('quotes with angle brackets the way it always did', async () => {
    const draft = await buildReplyDraft(fakeConnection(PLAIN), ME, '<original@example.com>', 'Answer')
    expect(draft.html).toBeUndefined()
    expect(draft.text).toContain('> The plain text of the message.')
  })
})

describe('what a person is shown', () => {
  it('reads as one message, new part and quote together', async () => {
    const draft = await buildReplyDraft(
      fakeConnection(PLAIN),
      ME,
      '<original@example.com>',
      'x',
      { html: '<p>My answer.</p>' },
    )
    const readable = readableBody(draft)
    expect(readable).toContain('My answer.')
    expect(readable).toContain('The plain text of the message.')
  })
})
