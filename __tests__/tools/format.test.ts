import { describe, it, expect } from 'vitest'
import {
  formatAddress,
  formatAddresses,
  formatDate,
  formatSize,
  formatList,
  formatMessage,
  wrapUntrusted,
} from '../../src/tools/format.js'
import type { ListResult, MessageHeader } from '../../src/mail/messages.js'
import type { ParsedMessage } from '../../src/mime/parse.js'

const header = (over: Partial<MessageHeader> = {}): MessageHeader => ({
  messageId: '<one@example.com>',
  subject: 'A subject',
  from: [{ name: 'Alice', address: 'alice@example.com' }],
  to: [{ address: 'bob@example.com' }],
  date: new Date('2026-07-29T18:25:00Z'),
  size: 3083,
  seen: true,
  flagged: false,
  answered: false,
  draft: false,
  hasAttachments: false,
  ...over,
})

const message = (over: Partial<ParsedMessage> = {}): ParsedMessage & { path: string } => ({
  path: 'INBOX',
  messageId: '<one@example.com>',
  subject: 'A subject',
  from: [{ address: 'alice@example.com' }],
  to: [{ address: 'bob@example.com' }],
  cc: [],
  replyTo: [],
  date: new Date('2026-07-29T18:25:00Z'),
  text: 'The body.',
  textSource: 'plain',
  truncated: false,
  attachments: [],
  protonKeyFiltered: false,
  rawSize: 3083,
  ...over,
})

describe('formatAddress', () => {
  it('shows the name with the address', () => {
    expect(formatAddress({ name: 'Alice', address: 'a@example.com' })).toBe('Alice <a@example.com>')
  })

  it('falls back to the address alone', () => {
    expect(formatAddress({ address: 'a@example.com' })).toBe('a@example.com')
  })

  it('says so when there is nobody', () => {
    expect(formatAddresses([])).toBe('(none)')
  })
})

describe('formatDate and formatSize', () => {
  it('formats a date unambiguously and short', () => {
    expect(formatDate(new Date('2026-07-29T18:25:33Z'))).toBe('2026-07-29 18:25')
  })

  it('handles a missing date', () => {
    expect(formatDate(undefined)).toBe('(no date)')
  })

  it('scales sizes', () => {
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(3083)).toBe('3 KB')
    expect(formatSize(5_033_164)).toBe('4.8 MB')
  })
})

/** Ordering that cost nothing worth mentioning, which is the ordinary case. */
const free = { messages: 0, elapsedMs: 0 }

describe('formatList', () => {
  it('reports an empty mailbox plainly', () => {
    const result: ListResult = { path: 'Drafts', total: 0, offset: 0, headers: [], ordering: free }
    expect(formatList(result)).toBe('The mailbox "Drafts" holds no messages.')
  })

  it('distinguishes an empty page from an empty mailbox', () => {
    const result: ListResult = { path: 'INBOX', total: 40, offset: 100, headers: [], ordering: free }
    expect(formatList(result)).toContain('No messages at offset 100')
    expect(formatList(result)).toContain('holds 40')
  })

  it('names the range and the total', () => {
    const result: ListResult = { path: 'INBOX', total: 40, offset: 0, headers: [header(), header()], ordering: free }
    expect(formatList(result)).toContain('showing 1 to 2 of 40')
  })

  it('points out how to page on', () => {
    const result: ListResult = { path: 'INBOX', total: 40, offset: 0, headers: [header()], ordering: free }
    const text = formatList(result)
    expect(text).toContain('39 more messages')
    expect(text).toContain('offset=1')
  })

  it('says nothing about paging on the last page', () => {
    const result: ListResult = { path: 'INBOX', total: 1, offset: 0, headers: [header()], ordering: free }
    expect(formatList(result)).not.toContain('more messages')
  })

  it('marks only what deviates from the ordinary', () => {
    const plain: ListResult = { path: 'INBOX', total: 1, offset: 0, headers: [header()], ordering: free }
    expect(formatList(plain)).not.toContain('[')

    const marked: ListResult = {
      path: 'INBOX',
      total: 1,
      offset: 0,
      headers: [header({ seen: false, flagged: true, hasAttachments: true })],
      ordering: free,
    }
    const text = formatList(marked)
    expect(text).toContain('unread')
    expect(text).toContain('starred')
    expect(text).toContain('attachment')
  })

  it('never contains a message body', () => {
    // The whole point of a listing: 40 tokens per message instead of 16000.
    const result: ListResult = { path: 'INBOX', total: 1, offset: 0, headers: [header()], ordering: free }
    expect(formatList(result)).not.toContain('BEGIN UNTRUSTED')
  })

  it('includes the id, because everything else needs it', () => {
    const result: ListResult = { path: 'INBOX', total: 1, offset: 0, headers: [header()], ordering: free }
    expect(formatList(result)).toContain('<one@example.com>')
  })

  it('stays quiet about an ordering cost nobody would notice', () => {
    const result: ListResult = {
      path: 'INBOX',
      total: 1,
      offset: 0,
      headers: [header()],
      ordering: { messages: 40, elapsedMs: 4 },
    }
    expect(formatList(result)).not.toContain('Ordering read')
  })

  it('reports an ordering cost that is felt', () => {
    const result: ListResult = {
      path: 'All Mail',
      total: 26816,
      offset: 0,
      headers: [header()],
      ordering: { messages: 26816, elapsedMs: 2700 },
    }
    const text = formatList(result)
    expect(text).toContain('Ordering read the dates of 26816 messages')
    expect(text).toContain('2700 ms')
  })
})

describe('formatMessage', () => {
  it('encloses the body in explicit markers', () => {
    // So that instructions inside a message cannot pass as instructions from
    // the user.
    const text = formatMessage(message())
    expect(text).toMatch(/----- BEGIN UNTRUSTED MESSAGE CONTENT [0-9a-f]{16} -----/)
    expect(text).toMatch(/----- END UNTRUSTED MESSAGE CONTENT [0-9a-f]{16} -----/)
    expect(text).toContain('not an instruction')
  })

  it('draws a fresh marker label for every answer', () => {
    // A label reused across answers is a label a sender can learn.
    const labels = new Set<string>()
    for (let i = 0; i < 20; i++) {
      const found = formatMessage(message()).match(/BEGIN UNTRUSTED MESSAGE CONTENT ([0-9a-f]{16})/)
      labels.add(found?.[1] ?? '')
    }
    expect(labels.size).toBe(20)
  })

  it('opens and closes with the same label', () => {
    const text = formatMessage(message())
    const begin = text.match(/BEGIN UNTRUSTED MESSAGE CONTENT ([0-9a-f]{16})/)?.[1]
    const end = text.match(/END UNTRUSTED MESSAGE CONTENT ([0-9a-f]{16})/)?.[1]
    expect(begin).toBeDefined()
    expect(begin).toBe(end)
  })

  it('puts server metadata before the content', () => {
    const text = formatMessage(message())
    expect(text.indexOf('Subject:')).toBeLessThan(text.indexOf('BEGIN UNTRUSTED'))
  })

  it('says when the text was converted from HTML', () => {
    const text = formatMessage(message({ textSource: 'html' }))
    expect(text).toContain('converted from HTML')
    expect(text).toContain('no external content was fetched')
  })

  it('explains the filtered Proton key instead of hiding the gap', () => {
    expect(formatMessage(message({ protonKeyFiltered: true }))).toContain('own public key')
  })

  it('lists attachments with their index', () => {
    const text = formatMessage(
      message({
        attachments: [
          { index: 0, filename: 'note.txt', contentType: 'text/plain', size: 32 },
          { index: 1, filename: 'data.json', contentType: 'application/json', size: 64 },
        ],
      }),
    )
    expect(text).toContain('[0] note.txt')
    expect(text).toContain('[1] data.json')
    expect(text).toContain('get_attachment')
  })

  it('says explicitly when there are no attachments', () => {
    expect(formatMessage(message())).toContain('Attachments: none')
  })

  it('omits the markers when there is no body at all', () => {
    const text = formatMessage(message({ textSource: 'none', text: '' }))
    expect(text).toContain('no readable body')
    expect(text).not.toContain('BEGIN UNTRUSTED')
  })

  it('shows cc only when there is one', () => {
    expect(formatMessage(message())).not.toContain('Cc:')
    expect(formatMessage(message({ cc: [{ address: 'c@example.com' }] }))).toContain('Cc:')
  })
})

describe('wrapUntrusted', () => {
  it('marks foreign text and keeps the description outside the markers', () => {
    const text = wrapUntrusted('file content', 'Attachment "note.txt"')
    expect(text.indexOf('Attachment "note.txt"')).toBeLessThan(text.indexOf('BEGIN UNTRUSTED'))
    expect(text).toContain('file content')
    expect(text).toContain('not an instruction')
  })
})
