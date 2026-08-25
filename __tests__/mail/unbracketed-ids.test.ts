import { describe, it, expect } from 'vitest'
import { findHomeFolder, setFlags } from '../../src/mail/actions.js'
import { removeLabel } from '../../src/mail/labels.js'
import type { Connection, MailboxStatus, Mailbox } from '../../src/bridge/connection.js'

/**
 * A Message-ID without angle brackets, in the paths that write.
 *
 * RFC 5322 requires the brackets and real mail does not always oblige: measured
 * across a large mailbox, one sender wrote all 17 of its messages without them.
 * The IMAP header search compares as a substring, so a bracketed search can
 * never match a bare header - the bracket has to sit immediately before the
 * identifier.
 *
 * `findByMessageId` was written for exactly that and makes a second attempt
 * without the brackets, verifying every hit of it because a bare search can
 * also match a message that merely contains the identifier. Three other lookups
 * searched the bracketed form alone and took `Math.max` of whatever came back:
 * `findHomeFolder`, which every move, flag change and trash goes through;
 * `removeLabel`, where the line picking the uid is the line that expunges; and
 * `uidOf` in the draft path.
 *
 * So the incident named in the comment above `findByMessageId` - "marking 67
 * messages left that one behind" - happened in a path that did not have the
 * fallback, and did not get it. These tests are about the property that fixes
 * it: every lookup goes through the same function, so there is one place where
 * this behaviour lives.
 *
 * Note what the failure was and was not. The bracketed search cannot match the
 * wrong message, so nothing was ever written to the wrong place. It silently
 * found nothing and then reported something untrue: a label that was applied
 * came back as `wasApplied: false`, and a draft that had not moved came back as
 * "no longer in Drafts".
 */

const MAILBOXES: Mailbox[] = [
  { path: 'INBOX', name: 'INBOX', kind: 'system', selectable: true },
  { path: 'All Mail', name: 'All Mail', kind: 'system', selectable: true },
  { path: 'Labels/Work', name: 'Work', kind: 'label', selectable: true },
]

interface Recorded {
  searches: string[]
  deletes: string[]
  flagged: string[]
}

/**
 * A connection whose one message carries its identifier bare.
 *
 * The search filters by substring and the envelope repeats the header exactly as
 * written, which is what the Bridge does and what makes the case possible.
 */
function fakeConnection(header: string) {
  const recorded: Recorded = { searches: [], deletes: [], flagged: [] }
  const uid = 7

  const connection = {
    listMailboxes: async () => MAILBOXES,
    withMailbox: async (
      path: string,
      operation: (c: unknown, s: MailboxStatus) => Promise<unknown>,
    ) => {
      const status: MailboxStatus = { path, messages: 3, unseen: 0, uidValidity: '1', uidNext: 9 }
      const client = {
        search: async (query: { header?: { 'message-id'?: string } }) => {
          const term = query.header?.['message-id'] ?? ''
          recorded.searches.push(term)
          return header.includes(term) ? [uid] : []
        },
        fetchOne: async (which: string) =>
          Number(which) === uid ? { envelope: { messageId: header } } : undefined,
        messageDelete: async (which: string) => {
          recorded.deletes.push(`${path}:${which}`)
          return true
        },
        messageFlagsAdd: async (which: string, flags: string[]) => {
          recorded.flagged.push(`${path}:${which}:${flags.join(',')}`)
          return true
        },
        messageFlagsRemove: async () => true,
      }
      return operation(client, status)
    },
  } as unknown as Connection

  return { connection, recorded }
}

const BARE = 'unbracketed@example.com'
const ASKED = '<unbracketed@example.com>'

describe('every write path finds a bare identifier', () => {
  it('findHomeFolder resolves it', async () => {
    // The one that carries the most: move_messages, set_flags and
    // trash_messages all go through here.
    const { connection } = fakeConnection(BARE)
    const home = await findHomeFolder(connection, ASKED, 'INBOX')
    expect(home.uid).toBe(7)
    expect(home.path).toBe('INBOX')
  })

  it('removeLabel resolves it rather than reporting the label was not set', async () => {
    // wasApplied: false used to mean two different things - "the label was not
    // there" and "I could not find the message". Only one of them is true here.
    const { connection, recorded } = fakeConnection(BARE)
    const result = await removeLabel(connection, false, ASKED, 'Work')
    expect(result.wasApplied).toBe(true)
    expect(recorded.deletes).toEqual(['Labels/Work:7'])
  })

  it('setFlags marks it instead of leaving it behind', async () => {
    // The reported incident, in one line: 67 messages marked, one left behind.
    const { connection, recorded } = fakeConnection(BARE)
    const result = await setFlags(connection, false, [ASKED], { read: true }, 'INBOX')
    expect(result.failed).toBe(0)
    expect(result.succeeded).toBe(1)
    expect(recorded.flagged).toEqual(['INBOX:7:\\Seen'])
  })

  it('tries the bracketed form first and pays nothing extra when it matches', async () => {
    // The common case must not become slower for the rare one.
    const { connection, recorded } = fakeConnection(ASKED)
    await findHomeFolder(connection, ASKED, 'INBOX')
    expect(recorded.searches).toEqual([ASKED])
  })

  it('does not resolve a message that merely contains the identifier', async () => {
    // What the substring comparison makes possible, and the reason the bare
    // attempt verifies every hit. Without that, this resolves and the wrong
    // message gets written to.
    const { connection } = fakeConnection('<prefix-unbracketed@example.com>')
    const result = await removeLabel(connection, false, ASKED, 'Work')
    expect(result.wasApplied).toBe(false)
  })
})
