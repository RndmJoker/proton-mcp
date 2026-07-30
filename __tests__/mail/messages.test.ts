import { describe, it, expect } from 'vitest'
import { listMessages, MAX_LIST_LIMIT } from '../../src/mail/messages.js'
import type { Connection, MailboxStatus } from '../../src/bridge/connection.js'
import type { MessageHeader } from '../../src/mail/messages.js'

/**
 * Tests run without a Bridge. The seam is the Connection class:
 * listMessages only uses withMailbox, so a stand-in can hand over recorded IMAP
 * answers.
 */

interface FakeMessage {
  uid: number
  subject: string
  date: string
  seen?: boolean
  size?: number
  attachment?: boolean
}

/** Builds a stand-in that answers like imapflow would for these messages. */
function fakeConnection(messages: FakeMessage[], overrides: Partial<MailboxStatus> = {}): Connection {
  const status: MailboxStatus = {
    path: 'INBOX',
    messages: messages.length,
    unseen: messages.filter((m) => !m.seen).length,
    uidValidity: '109582544',
    uidNext: messages.length + 1,
    ...overrides,
  }

  const client = {
    search: async (query: { seen?: boolean; all?: boolean }) => {
      const wanted = query.seen === false ? messages.filter((m) => !m.seen) : messages
      return wanted.map((m) => m.uid)
    },
    // eslint-disable-next-line require-yield
    fetch: function (uids: number[]) {
      const wanted = messages.filter((m) => uids.includes(m.uid))
      return (async function* () {
        for (const m of wanted) {
          yield {
            uid: m.uid,
            size: m.size ?? 1000,
            flags: new Set(m.seen === false ? [] : ['\\Seen']),
            envelope: {
              messageId: `<${m.uid}@example.com>`,
              subject: m.subject,
              date: m.date ? new Date(m.date) : undefined,
              from: [{ name: 'Sender', address: 'sender@example.com' }],
              to: [{ address: 'recipient@example.com' }],
            },
            bodyStructure: m.attachment
              ? {
                  type: 'multipart/mixed',
                  childNodes: [
                    { type: 'text/plain' },
                    {
                      type: 'application/pdf',
                      disposition: 'attachment',
                      dispositionParameters: { filename: 'invoice.pdf' },
                    },
                  ],
                }
              : { type: 'text/plain' },
          }
        }
      })()
    },
  }

  return {
    withMailbox: async (_path: string, operation: (c: unknown, s: MailboxStatus) => Promise<unknown>) =>
      operation(client, status),
  } as unknown as Connection
}

const many = (count: number): FakeMessage[] =>
  Array.from({ length: count }, (_, i) => ({
    uid: i + 1,
    subject: `Message ${i + 1}`,
    // Ascending UIDs with ascending dates, mirroring arrival order.
    date: `2026-07-${String((i % 28) + 1).padStart(2, '0')}T12:00:00Z`,
  }))

describe('listMessages', () => {
  it('returns nothing for an empty mailbox without fetching', async () => {
    // Crucial: the Bridge answers FETCH on an empty mailbox with
    // "BAD no such message" instead of an empty result.
    const connection = fakeConnection([])
    const result = await listMessages(connection, 'Drafts')
    expect(result.total).toBe(0)
    expect(result.headers).toEqual([])
  })

  it('lists newest first', async () => {
    const connection = fakeConnection([
      { uid: 1, subject: 'Oldest', date: '2026-07-01T10:00:00Z' },
      { uid: 2, subject: 'Middle', date: '2026-07-15T10:00:00Z' },
      { uid: 3, subject: 'Newest', date: '2026-07-29T10:00:00Z' },
    ])
    const result = await listMessages(connection, 'INBOX')
    expect(result.headers.map((h) => h.subject)).toEqual(['Newest', 'Middle', 'Oldest'])
  })

  it('honours the limit', async () => {
    const result = await listMessages(fakeConnection(many(50)), 'INBOX', { limit: 10 })
    expect(result.headers).toHaveLength(10)
    expect(result.total).toBe(50)
  })

  it('caps the limit, so no caller can ask for the whole mailbox at once', async () => {
    const result = await listMessages(fakeConnection(many(300)), 'INBOX', { limit: 9999 })
    expect(result.headers).toHaveLength(MAX_LIST_LIMIT)
  })

  it('pages via offset without overlap', async () => {
    const connection = fakeConnection(many(30))
    const first = await listMessages(connection, 'INBOX', { limit: 10, offset: 0 })
    const second = await listMessages(connection, 'INBOX', { limit: 10, offset: 10 })
    const overlap = first.headers.filter((a) =>
      second.headers.some((b) => b.messageId === a.messageId),
    )
    expect(overlap).toHaveLength(0)
    expect(second.offset).toBe(10)
  })

  it('returns an empty page beyond the end, keeping the total', async () => {
    const result = await listMessages(fakeConnection(many(5)), 'INBOX', { offset: 100 })
    expect(result.headers).toEqual([])
    expect(result.total).toBe(5)
  })

  it('filters to unread on request', async () => {
    const connection = fakeConnection([
      { uid: 1, subject: 'Read', date: '2026-07-01T10:00:00Z', seen: true },
      { uid: 2, subject: 'Unread', date: '2026-07-02T10:00:00Z', seen: false },
    ])
    const result = await listMessages(connection, 'INBOX', { unreadOnly: true })
    expect(result.headers.map((h) => h.subject)).toEqual(['Unread'])
  })

  it('recognises real attachments', async () => {
    const connection = fakeConnection([
      { uid: 1, subject: 'Plain', date: '2026-07-01T10:00:00Z' },
      { uid: 2, subject: 'With file', date: '2026-07-02T10:00:00Z', attachment: true },
    ])
    const result = await listMessages(connection, 'INBOX')
    const withFile = result.headers.find((h) => h.subject === 'With file')
    const plain = result.headers.find((h) => h.subject === 'Plain')
    expect(withFile?.hasAttachments).toBe(true)
    expect(plain?.hasAttachments).toBe(false)
  })

  it('does not count Proton\'s public key as an attachment', async () => {
    // Otherwise every sent message would look like it carried a file.
    const client = {
      search: async () => [1],
      fetch: () =>
        (async function* () {
          yield {
            uid: 1,
            size: 3083,
            flags: new Set(['\\Seen']),
            envelope: { messageId: '<1@example.com>', subject: 'Sent', date: new Date() },
            bodyStructure: {
              type: 'multipart/mixed',
              childNodes: [
                { type: 'text/plain' },
                {
                  type: 'application/pgp-keys',
                  disposition: 'attachment',
                  dispositionParameters: { filename: 'publickey - a@b.c - 0xABC123.asc' },
                },
              ],
            },
          }
        })(),
    }
    const connection = {
      withMailbox: async (_p: string, op: (c: unknown, s: MailboxStatus) => Promise<unknown>) =>
        op(client, { path: 'Sent', messages: 1, unseen: 0, uidValidity: '1', uidNext: 2 }),
    } as unknown as Connection

    const result = await listMessages(connection, 'Sent')
    expect(result.headers[0]?.hasAttachments).toBe(false)
  })

  it('never returns a body', async () => {
    const result = await listMessages(fakeConnection(many(3)), 'INBOX')
    for (const h of result.headers) {
      expect(Object.keys(h)).not.toContain('text')
    }
  })
})

/**
 * Ordering across page boundaries.
 *
 * The tests above cannot reach this: `many()` hands out ascending UIDs together
 * with ascending dates, which is the one arrangement where UID order and date
 * order agree. Every case here deliberately breaks that correlation, because
 * that is what a mailbox does the moment a message is moved into it.
 *
 * Verified by restoring the previous implementation and running these against
 * it: the first and the third fail, the others pass. That is worth writing down
 * rather than claiming all of them catch the bug. Nothing was ever lost or
 * duplicated, and the undated case happens to come out right as long as
 * everything fits on one page. They guard the behaviour, they do not prove the
 * fix.
 */
describe('listMessages ordering', () => {
  /** Four messages in arrival order, plus an old one moved in afterwards. */
  const moved: FakeMessage[] = [
    { uid: 1, subject: 'A 07-10', date: '2026-07-10T10:00:00Z' },
    { uid: 2, subject: 'B 07-20', date: '2026-07-20T10:00:00Z' },
    { uid: 3, subject: 'C 07-25', date: '2026-07-25T10:00:00Z' },
    { uid: 4, subject: 'D 07-29', date: '2026-07-29T10:00:00Z' },
    { uid: 5, subject: 'MOVED 01-01', date: '2026-01-01T10:00:00Z' },
  ]

  /** Reads every page and returns the entries in the order a caller sees them. */
  async function readAllPages(messages: FakeMessage[], pageSize: number): Promise<MessageHeader[]> {
    const connection = fakeConnection(messages)
    const seen: MessageHeader[] = []
    for (let offset = 0; offset < messages.length; offset += pageSize) {
      const page = await listMessages(connection, 'INBOX', { limit: pageSize, offset })
      seen.push(...page.headers)
    }
    return seen
  }

  it('keeps the order across page boundaries when a message was moved in', async () => {
    const seen = await readAllPages(moved, 2)
    expect(seen.map((h) => h.subject)).toEqual([
      'D 07-29',
      'C 07-25',
      'B 07-20',
      'A 07-10',
      'MOVED 01-01',
    ])
  })

  it('loses and duplicates nothing while doing so', async () => {
    const seen = await readAllPages(moved, 2)
    const ids = seen.map((h) => h.messageId)
    expect(ids).toHaveLength(moved.length)
    expect(new Set(ids).size).toBe(moved.length)
  })

  it('orders identical dates by uid, so paging cannot repeat or skip one', async () => {
    // A script sending in a loop produces this, and without a tiebreaker the
    // order between them would be whatever the sort happened to do that run.
    const sameSecond: FakeMessage[] = [
      { uid: 1, subject: 'first', date: '2026-07-29T10:00:00Z' },
      { uid: 2, subject: 'second', date: '2026-07-29T10:00:00Z' },
      { uid: 3, subject: 'third', date: '2026-07-29T10:00:00Z' },
      { uid: 4, subject: 'fourth', date: '2026-07-29T10:00:00Z' },
    ]
    const seen = await readAllPages(sameSecond, 2)
    expect(seen.map((h) => h.subject)).toEqual(['fourth', 'third', 'second', 'first'])
    expect(new Set(seen.map((h) => h.messageId)).size).toBe(4)
  })

  it('sorts messages without a date to the end rather than anywhere', async () => {
    const connection = fakeConnection([
      { uid: 1, subject: 'dated', date: '2026-07-10T10:00:00Z' },
      { uid: 2, subject: 'undated', date: '' },
      { uid: 3, subject: 'newer', date: '2026-07-29T10:00:00Z' },
    ])
    const result = await listMessages(connection, 'INBOX')
    expect(result.headers.map((h) => h.subject)).toEqual(['newer', 'dated', 'undated'])
  })

  it('reports what the ordering cost, so the price is visible rather than guessed', async () => {
    const result = await listMessages(fakeConnection(many(30)), 'INBOX', { limit: 10 })
    expect(result.ordering.messages).toBe(30)
    expect(result.ordering.elapsedMs).toBeGreaterThanOrEqual(0)
  })
})
