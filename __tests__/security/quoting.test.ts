import { describe, it, expect } from 'vitest'
import { buildReplyDraft, buildForwardDraft } from '../../src/mail/drafts.js'
import { quoteAsHtml, escapeHtml, readableBody } from '../../src/mail/compose.js'
import { readMarkup } from '../../src/mail/markup.js'
import type { Connection, MailboxStatus } from '../../src/bridge/connection.js'

/**
 * Quoting a stranger's message inside one of our own.
 *
 * This is the sharpest edge in formatted mail, and it is easy to miss. A reply
 * carries the original along, so whatever the original was made of would end up
 * inside a message sent under this account's name. If that were its markup, two
 * bad things follow: replying to ordinary mail would fail, because real mail is
 * full of elements this server refuses to send, and a link in the quote could
 * show one thing and go somewhere else without anybody having written it.
 *
 * So the quote is built from the original's **text**, always, and escaped. These
 * tests are what makes that a property rather than an intention.
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
    // Real mail is full of style blocks. If quoting carried the original's
    // markup, replying to most messages would simply fail.
    const draft = await buildReplyDraft(
      fakeConnection(HOSTILE),
      ME,
      '<original@example.com>',
      '<p>My answer.</p>',
      { html: '<p>My answer.</p>' },
    )
    expect(draft.html).toBeDefined()
    expect(readMarkup(draft.html!).problems).toEqual([])
  })

  it('carries none of the original markup into the reply', async () => {
    const draft = await buildReplyDraft(
      fakeConnection(HOSTILE),
      ME,
      '<original@example.com>',
      'x',
      { html: '<p>My answer.</p>' },
    )
    const html = draft.html ?? ''
    for (const forbidden of ['<script', '<style', 'onclick=', 'display:none']) {
      expect(html).not.toContain(forbidden)
    }
  })

  it('keeps the original readable, with its link targets in plain sight', async () => {
    // A phishing message quoted in a reply arrives with its addresses visible,
    // because the quote comes from the same conversion used to read mail.
    const draft = await buildReplyDraft(
      fakeConnection(HOSTILE),
      ME,
      '<original@example.com>',
      'x',
      { html: '<p>My answer.</p>' },
    )
    expect(draft.html).toContain('Ordinary looking text.')
    expect(draft.html).toContain('phishing.invalid/pay')
  })

  it('turns the original into text rather than into markup, even for the addresses', async () => {
    // The addresses of the original appear as characters in the quote, not as
    // links, so nothing in a quote is clickable that the sender did not write.
    const draft = await buildReplyDraft(
      fakeConnection(HOSTILE),
      ME,
      '<original@example.com>',
      'x',
      { html: '<p>My answer.</p>' },
    )
    const urls = readMarkup(draft.html ?? '').urls
    expect(urls.map((u) => u.url)).not.toContain('https://phishing.invalid/pay')
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
    expect(draft.html).toContain('&lt;script&gt;')
    expect(readMarkup(draft.html ?? '').problems).toEqual([])
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
  it('quotes the original as text inside a formatted forward', async () => {
    const draft = await buildForwardDraft(
      fakeConnection(HOSTILE),
      ME,
      '<original@example.com>',
      ['third@example.com'],
      '',
      { html: '<p>For your information.</p>' },
    )
    expect(draft.html).toContain('Forwarded message')
    expect(draft.html).not.toContain('<script')
    expect(readMarkup(draft.html ?? '').problems).toEqual([])
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
