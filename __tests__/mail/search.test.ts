import { describe, it, expect } from 'vitest'
import {
  isFullText,
  matchesLocally,
  MAX_COMPARED,
  planSearch,
  quotedPrintable,
  searchMessages,
  textForms,
} from '../../src/mail/search.js'
import { formatSearch } from '../../src/tools/format.js'
import { BridgeError } from '../../src/bridge/errors.js'
import type { Connection, MailboxStatus } from '../../src/bridge/connection.js'
import type { EnvelopeEntry } from '../../src/mail/messages.js'

/** buildQuery returned only the query; the query is the part the Bridge gets. */
const buildQuery = (criteria: Parameters<typeof planSearch>[0]) => planSearch(criteria).query

describe('planSearch', () => {
  it('refuses an empty query instead of matching everything', () => {
    // Returning the whole mailbox for an empty search would look like a result
    // but is really list_messages.
    expect(() => buildQuery({})).toThrow(BridgeError)
    expect(() => buildQuery({})).toThrow(/at least one criterion/)
  })

  it('maps free text to TEXT, which covers body and headers', () => {
    expect(buildQuery({ text: 'invoice' })).toEqual({ text: 'invoice' })
  })

  it('compares the subject here, against the decoded envelope, rather than asking the Bridge', () => {
    // The Bridge compares against the header as stored, encoded. Up to 0.4.11
    // "Mit Anhang" found no subject that carried an umlaut.
    expect(planSearch({ subject: 'invoice' })).toEqual({ query: { all: true }, local: { subject: 'invoice' } })
  })

  it('compares sender and recipient here as well', () => {
    expect(planSearch({ from: 'alice@example.com' }).local).toEqual({ from: 'alice@example.com' })
    expect(planSearch({ to: 'bob@example.com' }).local).toEqual({ to: 'bob@example.com' })
    expect(planSearch({ from: 'alice@example.com', since: new Date('2026-07-01') }).query).toEqual({
      sentSince: new Date('2026-07-01'),
    })
  })

  it('asks for a word outside ASCII in its quoted-printable forms as well', () => {
    const query = buildQuery({ text: '\u00c4pfel' })
    expect(query.or).toEqual([{ text: '\u00c4pfel' }, { text: '=C3=84pfel' }, { text: '=C3=A4pfel' }])
  })

  it('maps a date range onto the sender date, not the delivery date', () => {
    // sentSince and sentBefore rather than since and before. The latter pair is
    // IMAP SINCE and BEFORE, which compare INTERNALDATE - when the server
    // received the message. Everything shown and sorted comes from the envelope,
    // so from the sender's Date header, and INTERNALDATE can be rewritten when a
    // message is copied between mailboxes. Filtering one and displaying the
    // other returned messages whose printed date sat outside the range.
    const since = new Date('2026-07-01')
    const before = new Date('2026-07-31')
    expect(buildQuery({ since, before })).toEqual({ sentSince: since, sentBefore: before })
  })

  it('distinguishes unread from read rather than treating false as unset', () => {
    expect(buildQuery({ seen: false })).toEqual({ seen: false })
    expect(buildQuery({ seen: true })).toEqual({ seen: true })
  })

  it('maps the size filter', () => {
    expect(buildQuery({ largerThan: 1_048_576 })).toEqual({ larger: 1_048_576 })
  })

  it('combines several criteria', () => {
    const planned = planSearch({ text: 'invoice', from: 'alice@example.com', seen: false })
    expect(planned.query).toEqual({ text: 'invoice', seen: false })
    expect(planned.local).toEqual({ from: 'alice@example.com' })
  })
})

describe('quotedPrintable', () => {
  it('writes every byte outside ASCII as =XX, the way such a part carries it', () => {
    expect(quotedPrintable('Br\u00fcckenpfeiler')).toBe('Br=C3=BCckenpfeiler')
  })

  it('escapes the equals sign, which quoted-printable uses for itself', () => {
    expect(quotedPrintable('a=b')).toBe('a=3Db')
  })
})

describe('textForms', () => {
  it('leaves a word in plain ASCII as it is', () => {
    expect(textForms('invoice')).toEqual(['invoice'])
  })

  it('covers the lower case and the capitalised spelling, which lower casing cannot reach once encoded', () => {
    expect(textForms('\u00e4pfel')).toEqual(['\u00e4pfel', '=C3=A4pfel', '=C3=84pfel'])
  })
})

/** An envelope as imapflow hands it over, already decoded. */
const entry = (over: Partial<EnvelopeEntry>): EnvelopeEntry => ({
  uid: 1,
  date: new Date('2026-07-31T09:45:00Z'),
  subject: '',
  from: [],
  to: [],
  ...over,
})

describe('matchesLocally', () => {
  const subject = 'MCP-Test 3: Mit Anhang und Umlauten \u00e4\u00f6\u00fc\u00df'

  it('finds a subject with umlauts by words with a space between them', () => {
    expect(matchesLocally(entry({ subject }), { subject: 'Mit Anhang' })).toBe(true)
  })

  it('finds it by the umlauts themselves, whatever the case', () => {
    expect(matchesLocally(entry({ subject }), { subject: '\u00c4\u00d6\u00dc' })).toBe(true)
  })

  it('no longer needs the encoded spelling the Bridge wanted', () => {
    expect(matchesLocally(entry({ subject }), { subject: 'Mit_Anhang' })).toBe(false)
  })

  it('treats a decomposed letter as the same letter', () => {
    expect(matchesLocally(entry({ subject: '\u00fcber' }), { subject: 'u\u0308ber' })).toBe(true)
  })

  it('finds a sender by a display name with an umlaut, and by address', () => {
    const from = [{ name: 'J\u00fcrgen M\u00fcller', address: 'jm@example.com' }]
    expect(matchesLocally(entry({ from }), { from: 'm\u00fcller' })).toBe(true)
    expect(matchesLocally(entry({ from }), { from: 'jm@example' })).toBe(true)
    expect(matchesLocally(entry({ from }), { from: 'someone else' })).toBe(false)
  })

  it('finds a recipient by address', () => {
    const to = [{ address: 'bob@example.com' }]
    expect(matchesLocally(entry({ to }), { to: 'bob@' })).toBe(true)
    expect(matchesLocally(entry({ to }), { to: 'carol@' })).toBe(false)
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

  it('reports a failed search as a failure, not as no matches', async () => {
    // imapflow answers a search that matched nothing with an empty array, and
    // one that failed with false. Up to 0.4.11 both read as "no matches".
    await expect(
      searchMessages(fakeConnection(false), 'All Mail', { text: 'nothing' }),
    ).rejects.toThrow(/The search for messages in "All Mail" failed/)
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

/**
 * A mailbox whose search answers every uid and records what it was asked, with
 * the envelopes imapflow would hand over, already decoded.
 */
function subjectConnection(subjects: string[]) {
  const asked: unknown[] = []
  const uids = subjects.map((_, i) => i + 1)
  const client = {
    search: async (query: unknown) => {
      asked.push(query)
      return uids
    },
    fetch: (wanted: number[]) =>
      (async function* () {
        for (const uid of wanted) {
          yield {
            uid,
            size: 1000,
            flags: new Set(['\\Seen']),
            envelope: {
              messageId: `<${uid}@example.com>`,
              subject: subjects[uid - 1] ?? '',
              date: new Date(Date.UTC(2026, 6, 1) + uid * 60_000),
              from: [{ name: 'Jane Doe', address: 'jane@example.com' }],
              to: [{ address: 'me@example.com' }],
            },
            bodyStructure: { type: 'text/plain' },
          }
        }
      })(),
  }
  const connection = {
    withMailbox: async (_p: string, op: (c: unknown, s: MailboxStatus) => Promise<unknown>) =>
      op(client, { path: 'INBOX', messages: uids.length, unseen: 0, uidValidity: '1', uidNext: uids.length + 1 }),
  } as unknown as Connection
  return { connection, asked }
}

describe('searchMessages with a subject, sender or recipient', () => {
  it('does not hand the subject to the Bridge', async () => {
    const { connection, asked } = subjectConnection(['Rechnung M\u00e4rz', 'Termin'])
    await searchMessages(connection, 'INBOX', { subject: 'Rechnung M\u00e4rz' })
    expect(asked).toEqual([{ all: true }])
  })

  it('finds a subject with umlauts by words with a space between them', async () => {
    const { connection } = subjectConnection([
      'MCP-Test 3: Mit Anhang und Umlauten \u00e4\u00f6\u00fc\u00df',
      'Etwas anderes',
      'Noch einer mit Anhang und Umlauten',
    ])
    const result = await searchMessages(connection, 'INBOX', { subject: 'mit anhang' })
    expect(result.total).toBe(2)
    expect(result.headers.map((h) => h.messageId)).toEqual(['<3@example.com>', '<1@example.com>'])
  })

  it('compares no more than the limit, and says so', async () => {
    const subjects = Array.from({ length: MAX_COMPARED + 5 }, (_, i) => `Message ${i + 1}`)
    const { connection } = subjectConnection(subjects)
    const result = await searchMessages(connection, 'INBOX', { subject: 'Message' })
    expect(result.compared).toEqual({ compared: MAX_COMPARED, of: MAX_COMPARED + 5 })
    expect(result.ordering.messages).toBe(MAX_COMPARED)
    expect(formatSearch(result)).toMatch(/Only the 20000 most recently added of 20005 messages were compared/)
  })

  it('asks the Bridge for a full-text word in its encoded forms as well', async () => {
    const { connection, asked } = subjectConnection(['x'])
    const result = await searchMessages(connection, 'INBOX', { text: 'Br\u00fccke' })
    expect(asked[0]).toEqual({ or: [{ text: 'Br\u00fccke' }, { text: 'Br=C3=BCcke' }] })
    expect(result.encodedForms).toBe(true)
  })
})

describe('formatSearch', () => {
  const empty = {
    path: 'INBOX',
    total: 0,
    offset: 0,
    headers: [],
    elapsedMs: 3,
    ordering: { messages: 0, elapsedMs: 0 },
    encodedForms: false,
  }

  it('names the limit of a full-text search even when nothing was found', () => {
    expect(formatSearch({ ...empty, fullText: true })).toMatch(/parts sent as base64 are not searched/)
  })

  it('says when a word was also looked for in its quoted-printable form', () => {
    expect(formatSearch({ ...empty, fullText: true, encodedForms: true })).toMatch(/quoted-printable form/)
  })

  it('says nothing of full text where none was searched', () => {
    expect(formatSearch({ ...empty, fullText: false })).not.toMatch(/base64/)
  })
})
