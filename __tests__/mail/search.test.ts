import { describe, it, expect } from 'vitest'
import { buildQuery, isFullText, searchMessages } from '../../src/mail/search.js'
import { BridgeError } from '../../src/bridge/errors.js'
import type { Connection, MailboxStatus } from '../../src/bridge/connection.js'

describe('buildQuery', () => {
  it('refuses an empty query instead of matching everything', () => {
    // Returning the whole mailbox for an empty search would look like a result
    // but is really list_messages.
    expect(() => buildQuery({})).toThrow(BridgeError)
    expect(() => buildQuery({})).toThrow(/at least one criterion/)
  })

  it('maps free text to TEXT, which covers body and headers', () => {
    expect(buildQuery({ text: 'invoice' })).toEqual({ text: 'invoice' })
  })

  it('maps a subject to a header search', () => {
    expect(buildQuery({ subject: 'invoice' })).toEqual({ header: { subject: 'invoice' } })
  })

  it('maps sender and recipient', () => {
    expect(buildQuery({ from: 'alice@example.com' })).toEqual({ from: 'alice@example.com' })
    expect(buildQuery({ to: 'bob@example.com' })).toEqual({ to: 'bob@example.com' })
  })

  it('maps a date range', () => {
    const since = new Date('2026-07-01')
    const before = new Date('2026-07-31')
    expect(buildQuery({ since, before })).toEqual({ since, before })
  })

  it('distinguishes unread from read rather than treating false as unset', () => {
    expect(buildQuery({ seen: false })).toEqual({ seen: false })
    expect(buildQuery({ seen: true })).toEqual({ seen: true })
  })

  it('maps the size filter', () => {
    expect(buildQuery({ largerThan: 1_048_576 })).toEqual({ larger: 1_048_576 })
  })

  it('combines several criteria', () => {
    const query = buildQuery({ text: 'invoice', from: 'alice@example.com', seen: false })
    expect(query).toEqual({ text: 'invoice', from: 'alice@example.com', seen: false })
  })
})

describe('isFullText', () => {
  it('marks the expensive criterion', () => {
    // Measured: full text takes seconds on a large mailbox, metadata does not.
    expect(isFullText({ text: 'invoice' })).toBe(true)
  })

  it('does not mark cheap criteria', () => {
    expect(isFullText({ subject: 'invoice' })).toBe(false)
    expect(isFullText({ seen: false })).toBe(false)
    expect(isFullText({ from: 'alice@example.com' })).toBe(false)
  })
})

/** Stand-in that answers a search with fixed UIDs. */
function fakeConnection(uids: number[] | false, messageCount = 100): Connection {
  const status: MailboxStatus = {
    path: 'All Mail',
    messages: messageCount,
    unseen: 0,
    uidValidity: '1',
    uidNext: messageCount + 1,
  }
  const client = {
    search: async () => uids,
    fetch: (wanted: number[]) =>
      (async function* () {
        for (const uid of wanted) {
          yield {
            uid,
            size: 1000,
            flags: new Set(['\\Seen']),
            envelope: {
              messageId: `<${uid}@example.com>`,
              subject: `Message ${uid}`,
              date: new Date(2026, 6, (uid % 28) + 1),
            },
            bodyStructure: { type: 'text/plain' },
          }
        }
      })(),
  }
  return {
    withMailbox: async (_p: string, op: (c: unknown, s: MailboxStatus) => Promise<unknown>) =>
      op(client, status),
  } as unknown as Connection
}

describe('searchMessages', () => {
  it('reports no matches without failing', async () => {
    const result = await searchMessages(fakeConnection([]), 'All Mail', { text: 'nothing' })
    expect(result.total).toBe(0)
    expect(result.headers).toEqual([])
  })

  it('treats the false that imapflow returns as no matches', async () => {
    // imapflow answers with false rather than an empty array, and `?? []` would
    // let that through as a value.
    const result = await searchMessages(fakeConnection(false), 'All Mail', { text: 'nothing' })
    expect(result.total).toBe(0)
    expect(result.headers).toEqual([])
  })

  it('does not search an empty mailbox at all', async () => {
    // The Bridge quirk around FETCH on empty mailboxes.
    const result = await searchMessages(fakeConnection([1, 2, 3], 0), 'Drafts', { text: 'x' })
    expect(result.total).toBe(0)
  })

  it('reports the total independently of the page', async () => {
    const uids = Array.from({ length: 80 }, (_, i) => i + 1)
    const result = await searchMessages(fakeConnection(uids), 'All Mail', { text: 'x', limit: 10 })
    expect(result.total).toBe(80)
    expect(result.headers).toHaveLength(10)
  })

  it('pages without overlap', async () => {
    const uids = Array.from({ length: 40 }, (_, i) => i + 1)
    const first = await searchMessages(fakeConnection(uids), 'All Mail', { text: 'x', limit: 10, offset: 0 })
    const second = await searchMessages(fakeConnection(uids), 'All Mail', { text: 'x', limit: 10, offset: 10 })
    const overlap = first.headers.filter((a) => second.headers.some((b) => b.messageId === a.messageId))
    expect(overlap).toHaveLength(0)
  })

  it('caps the page size', async () => {
    const uids = Array.from({ length: 500 }, (_, i) => i + 1)
    const result = await searchMessages(fakeConnection(uids), 'All Mail', { text: 'x', limit: 9999 })
    expect(result.headers.length).toBeLessThanOrEqual(100)
  })

  it('measures the elapsed time, so a caller can judge the cost', async () => {
    const result = await searchMessages(fakeConnection([1]), 'All Mail', { text: 'x' })
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(result.fullText).toBe(true)
  })

  it('reports the ordering cost apart from the search itself', async () => {
    // Two different prices: the Bridge walking its database, and this server
    // reading a date per hit. Lumping them together would hide which one hurts.
    const uids = Array.from({ length: 40 }, (_, i) => i + 1)
    const result = await searchMessages(fakeConnection(uids), 'All Mail', { text: 'x', limit: 10 })
    expect(result.ordering.messages).toBe(40)
    expect(result.ordering.elapsedMs).toBeGreaterThanOrEqual(0)
  })

  it('orders hits by date, not by the uid the search returned', async () => {
    // The search hands back ascending uids. Here uid 5 is the oldest message
    // and uid 1 the newest, so anything ordering by uid comes out reversed.
    const dates: Record<number, Date> = {
      1: new Date('2026-07-29T10:00:00Z'),
      2: new Date('2026-07-25T10:00:00Z'),
      3: new Date('2026-07-20T10:00:00Z'),
      4: new Date('2026-07-10T10:00:00Z'),
      5: new Date('2026-01-01T10:00:00Z'),
    }
    const client = {
      search: async () => [1, 2, 3, 4, 5],
      fetch: (wanted: number[]) =>
        (async function* () {
          for (const uid of wanted) {
            yield {
              uid,
              size: 1000,
              flags: new Set(['\\Seen']),
              envelope: {
                messageId: `<${uid}@example.com>`,
                subject: `Message ${uid}`,
                date: dates[uid],
              },
              bodyStructure: { type: 'text/plain' },
            }
          }
        })(),
    }
    const connection = {
      withMailbox: async (_p: string, op: (c: unknown, s: MailboxStatus) => Promise<unknown>) =>
        op(client, { path: 'All Mail', messages: 5, unseen: 0, uidValidity: '1', uidNext: 6 }),
    } as unknown as Connection

    const result = await searchMessages(connection, 'All Mail', { text: 'x', limit: 2 })
    expect(result.headers.map((h) => h.messageId)).toEqual(['<1@example.com>', '<2@example.com>'])
  })

  it('rejects an empty query before touching the mailbox', async () => {
    await expect(searchMessages(fakeConnection([1]), 'All Mail', {})).rejects.toThrow(BridgeError)
  })
})
