import { describe, it, expect } from 'vitest'
import { listMessages } from '../../src/mail/messages.js'
import { searchMessages } from '../../src/mail/search.js'
import { formatList } from '../../src/tools/format.js'
import type { Connection, MailboxStatus } from '../../src/bridge/connection.js'

/**
 * Saying which entries of "All Mail" are in the trash.
 *
 * "All Mail" holds every message including the discarded ones, so a listing of
 * it looked identical whether a message was filed or thrown away. What that
 * cost: an assistant reported three drafts waiting in the Drafts mailbox. They
 * were in the trash and Drafts was empty. The `draft` mark is a flag rather than
 * a place and stays on a draft wherever it goes, so "draft" reads as "in
 * Drafts" - a reasonable reading of what was written.
 *
 * Same class as the paging bug and the label semantics before it: output that is
 * true in the narrow technical sense and reliably misunderstood.
 *
 * The cheap variant, which is what the issue asked for: one search of the trash
 * per page rather than resolving the real folder of every entry. That second
 * option is what `findHomeFolder` costs and would mean 25 lookups for the call
 * that is supposed to be the cheap one.
 */

interface Fake {
  uid: number
  id: string
  /** Which mailbox this copy lives in. */
  box: string
}

/**
 * A connection over two mailboxes.
 *
 * "All Mail" holds everything, "Trash" holds the discarded copies, and a search
 * filters by whatever it is given - `or` over message-id headers for the trash
 * lookup, everything otherwise.
 */
function fakeConnection(messages: Fake[], options: { trashOpens?: boolean } = {}) {
  const opened: string[] = []
  const searches: unknown[] = []

  const connection = {
    withMailbox: async (path: string, operation: (c: unknown, s: MailboxStatus) => Promise<unknown>) => {
      opened.push(path)
      if (path === 'Trash' && options.trashOpens === false) {
        throw new Error('the trash cannot be opened')
      }
      const here = messages.filter((m) => m.box === path)
      const status: MailboxStatus = {
        path,
        messages: here.length,
        unseen: 0,
        uidValidity: '1',
        uidNext: 99,
      }
      const client = {
        search: async (query: Record<string, unknown>) => {
          searches.push(query)
          const or = query.or as Array<{ header: { 'message-id': string } }> | undefined
          if (!or) return here.map((m) => m.uid)
          const wanted = new Set(or.map((o) => o.header['message-id']))
          return here.filter((m) => wanted.has(m.id)).map((m) => m.uid)
        },
        fetch: (uids: number[]) => {
          const wanted = here.filter((m) => uids.includes(m.uid))
          return (async function* () {
            for (const m of wanted) {
              yield {
                uid: m.uid,
                size: 100,
                // Drafts, because that is the incident: three of them
                // reported as waiting in Drafts while they sat in the trash.
                flags: new Set(['\\Seen', '\\Draft']),
                envelope: {
                  messageId: m.id,
                  subject: `Subject of ${m.id}`,
                  date: new Date('2026-08-01T10:00:00Z'),
                  from: [{ address: 'sender@example.invalid' }],
                  to: [{ address: 'me@example.invalid' }],
                },
                bodyStructure: { type: 'text/plain' },
              }
            }
          })()
        },
      }
      return operation(client, status)
    },
  } as unknown as Connection

  return { connection, opened, searches }
}

const FILED = '<filed@example.invalid>'
const DISCARDED = '<discarded@example.invalid>'

/** One copy in All Mail for each, and a second copy of one of them in Trash. */
const BOTH: Fake[] = [
  { uid: 1, id: FILED, box: 'All Mail' },
  { uid: 2, id: DISCARDED, box: 'All Mail' },
  { uid: 20, id: DISCARDED, box: 'Trash' },
]

describe('a listing of All Mail says what is in the trash', () => {
  it('marks the discarded message and leaves the other alone', async () => {
    const { connection } = fakeConnection(BOTH)
    const result = await listMessages(connection, 'All Mail', {})
    const marks = new Map(result.headers.map((h) => [h.messageId, h.inTrash ?? false]))
    expect(marks.get(DISCARDED)).toBe(true)
    expect(marks.get(FILED)).toBe(false)
  })

  it('costs one extra search for the page, not one per message', async () => {
    // The whole reason for the cheap variant. Resolving the real folder of every
    // entry is what findHomeFolder does, and a page of 25 would pay 25 lookups.
    const { connection, opened } = fakeConnection(BOTH)
    await listMessages(connection, 'All Mail', {})
    expect(opened.filter((p) => p === 'Trash')).toHaveLength(1)
  })

  it('asks the trash once, with every identifier of the page at once', async () => {
    const { connection, searches } = fakeConnection(BOTH)
    await listMessages(connection, 'All Mail', {})
    const or = searches.find((q) => (q as Record<string, unknown>).or) as
      | { or: Array<{ header: { 'message-id': string } }> }
      | undefined
    expect(or?.or.map((o) => o.header['message-id']).sort()).toEqual([DISCARDED, FILED].sort())
  })

  it('does not look in the trash for any other mailbox', async () => {
    // Every other listing names its mailbox in the first line, so there is
    // nothing to disambiguate and nothing to pay for.
    const { connection, opened } = fakeConnection([{ uid: 1, id: FILED, box: 'INBOX' }])
    await listMessages(connection, 'INBOX', {})
    expect(opened).not.toContain('Trash')
  })

  it('still answers when the trash cannot be opened', async () => {
    // The mark is an addition to a listing. A trash that refuses to open costs
    // the mark, not the answer.
    const { connection } = fakeConnection(BOTH, { trashOpens: false })
    const result = await listMessages(connection, 'All Mail', {})
    expect(result.headers).toHaveLength(2)
    expect(result.headers.every((h) => h.inTrash === undefined)).toBe(true)
  })

  it('marks a search of All Mail the same way', async () => {
    // search_messages defaults to All Mail, so it is the more common case of
    // the two.
    const { connection } = fakeConnection(BOTH)
    const result = await searchMessages(connection, 'All Mail', { text: 'anything' })
    const marks = new Map(result.headers.map((h) => [h.messageId, h.inTrash ?? false]))
    expect(marks.get(DISCARDED)).toBe(true)
    expect(marks.get(FILED)).toBe(false)
  })
})

describe('the mark reaches the answer a model reads', () => {
  /** The block of lines for one entry. The marks sit on its first line. */
  const entryFor = (text: string, id: string): string =>
    text.split('\n\n').find((block) => block.includes(id)) ?? ''

  it('prints "in trash" first, before the flags', async () => {
    // First because it is the only mark that says where a message is rather
    // than what state it is in.
    const { connection } = fakeConnection(BOTH)
    const text = formatList(await listMessages(connection, 'All Mail', {}))
    expect(entryFor(text, DISCARDED)).toContain('[in trash, draft]')
  })

  it('leaves a filed message with its flags alone', async () => {
    // The pair is what makes it readable: [in trash, draft] against [draft].
    const { connection } = fakeConnection(BOTH)
    const text = formatList(await listMessages(connection, 'All Mail', {}))
    const filed = entryFor(text, FILED)
    expect(filed).not.toContain('in trash')
    expect(filed).toContain('[draft]')
  })
})
