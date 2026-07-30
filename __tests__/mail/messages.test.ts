import { describe, it, expect } from 'vitest'
import { listMessages, MAX_LIST_LIMIT } from '../../src/mail/messages.js'
import type { Connection, MailboxStatus } from '../../src/bridge/connection.js'

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
              date: new Date(m.date),
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
