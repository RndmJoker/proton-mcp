import { describe, it, expect } from 'vitest'
import {
  moveMessages,
  setFlags,
  trashMessages,
  findHomeFolder,
  assertMoveTarget,
  MAX_BATCH,
} from '../../src/mail/actions.js'
import { BridgeError } from '../../src/bridge/errors.js'
import type { Connection, MailboxStatus, Mailbox } from '../../src/bridge/connection.js'

/**
 * These tests run without a Bridge, so what they can prove is what the code
 * sends, what it refuses to send, and how it reads an answer. For this module
 * the last one carries the weight: measured against the Bridge, a refused MOVE
 * is a falsy return value rather than an error, so an implementation that only
 * catches exceptions reports success for something that never happened.
 */

const MAILBOXES: Mailbox[] = [
  { path: 'INBOX', name: 'INBOX', kind: 'system', selectable: true },
  { path: 'Archive', name: 'Archive', kind: 'system', selectable: true },
  { path: 'Trash', name: 'Trash', kind: 'system', selectable: true },
  { path: 'All Mail', name: 'All Mail', kind: 'system', selectable: true },
  { path: 'Starred', name: 'Starred', kind: 'system', selectable: true },
  { path: 'Folders', name: 'Folders', kind: 'folder', selectable: false },
  { path: 'Folders/Test', name: 'Test', kind: 'folder', selectable: true },
  { path: 'Folders/Other', name: 'Other', kind: 'folder', selectable: true },
  { path: 'Labels', name: 'Labels', kind: 'label', selectable: false },
  { path: 'Labels/Test1', name: 'Test1', kind: 'label', selectable: true },
]

interface Recorded {
  moves: Array<{ uid: string; from: string; to: string }>
  flagsAdded: Array<{ uid: string; flags: string[]; mailbox: string }>
  flagsRemoved: Array<{ uid: string; flags: string[]; mailbox: string }>
  opened: string[]
  /** Any call that would remove a message for good. Must stay empty. */
  deletes: string[]
}

interface FakeOptions {
  /** Which mailbox holds the message, and under which uid. */
  home?: { path: string; uid: number }
  /** Makes messageMove answer the way a refused move does. */
  refuseMove?: boolean
  mailboxes?: Mailbox[]
}

function fakeConnection(options: FakeOptions = {}) {
  const recorded: Recorded = {
    moves: [],
    flagsAdded: [],
    flagsRemoved: [],
    opened: [],
    deletes: [],
  }
  const home = options.home ?? { path: 'Folders/Test', uid: 7 }
  const mailboxes = options.mailboxes ?? MAILBOXES

  const connection = {
    listMailboxes: async () => mailboxes,
    withMailbox: async (
      path: string,
      operation: (c: unknown, s: MailboxStatus) => Promise<unknown>,
    ) => {
      recorded.opened.push(path)
      const status: MailboxStatus = { path, messages: 5, unseen: 0, uidValidity: '1', uidNext: 99 }
      const client = {
        search: async () => (path === home.path ? [home.uid] : []),
        messageMove: async (uid: string, destination: string) => {
          if (options.refuseMove) return false
          recorded.moves.push({ uid, from: path, to: destination })
          return { path, destination, uidValidity: '1', uidMap: {} }
        },
        messageFlagsAdd: async (uid: string, flags: string[]) => {
          recorded.flagsAdded.push({ uid, flags, mailbox: path })
          return true
        },
        messageFlagsRemove: async (uid: string, flags: string[]) => {
          recorded.flagsRemoved.push({ uid, flags, mailbox: path })
          return true
        },
        messageDelete: async (uid: string) => {
          recorded.deletes.push(uid)
          return true
        },
      }
      return operation(client, status)
    },
  } as unknown as Connection

  return { connection, recorded }
}

describe('assertMoveTarget', () => {
  it('accepts a folder and a system mailbox', () => {
    expect(assertMoveTarget('Folders/Test', MAILBOXES)).toBe('Folders/Test')
    expect(assertMoveTarget('  Archive  ', MAILBOXES)).toBe('Archive')
  })

  it('refuses a label and says which tool does that job', () => {
    // Measured: a move into a label applies the label and leaves the message in
    // its folder. A tool called "move" must not quietly do something else.
    expect(() => assertMoveTarget('Labels/Test1', MAILBOXES)).toThrow(/add_label/)
    expect(() => assertMoveTarget('Labels', MAILBOXES)).toThrow(BridgeError)
  })

  it('refuses the two views, which are not places', () => {
    expect(() => assertMoveTarget('All Mail', MAILBOXES)).toThrow(BridgeError)
    expect(() => assertMoveTarget('Starred', MAILBOXES)).toThrow(/set_flags/)
  })

  it('refuses a mailbox that does not exist', () => {
    expect(() => assertMoveTarget('Folders/Nope', MAILBOXES)).toThrow(/no mailbox "Folders\/Nope"/)
  })

  it('does not name the folders that do exist', () => {
    // Folder names are personal data: one can name a bank or an employer. They
    // go out through list_folders when asked for, not as a side effect of a
    // failed call.
    try {
      assertMoveTarget('Folders/Nope', MAILBOXES)
      throw new Error('should have thrown')
    } catch (error) {
      const text = (error as Error).message
      expect(text).not.toContain('Folders/Test')
      expect(text).not.toContain('Folders/Other')
      expect(text).toContain('list_folders')
    }
  })

  it('refuses the container the folders live in', () => {
    expect(() => assertMoveTarget('Folders', MAILBOXES)).toThrow(/container/)
  })
})

describe('findHomeFolder', () => {
  it('never looks in a place a move cannot be issued from', async () => {
    // The heart of it: resolveMessageId falls back to "All Mail", and a MOVE
    // out of All Mail returns false and changes nothing. Labels have their own
    // uids and are not folders either.
    const { connection, recorded } = fakeConnection({ home: { path: 'Folders/Other', uid: 3 } })
    const found = await findHomeFolder(connection, '<a@example.com>')
    expect(found.path).toBe('Folders/Other')
    expect(recorded.opened).not.toContain('All Mail')
    expect(recorded.opened).not.toContain('Starred')
    expect(recorded.opened.some((p) => p.startsWith('Labels/'))).toBe(false)
  })

  it('uses the hint first and stops there', async () => {
    const { connection, recorded } = fakeConnection({ home: { path: 'Folders/Test', uid: 7 } })
    await findHomeFolder(connection, '<a@example.com>', 'Folders/Test')
    expect(recorded.opened).toEqual(['Folders/Test'])
  })

  it('ignores a hint that names a label or a view', async () => {
    const { connection, recorded } = fakeConnection({ home: { path: 'Folders/Test', uid: 7 } })
    await findHomeFolder(connection, '<a@example.com>', 'All Mail')
    expect(recorded.opened).not.toContain('All Mail')
  })

  it('says so when no folder holds the message', async () => {
    const { connection } = fakeConnection({ home: { path: 'nowhere', uid: 1 } })
    await expect(findHomeFolder(connection, '<a@example.com>')).rejects.toThrow(/No folder holds/)
  })
})

describe('moveMessages', () => {
  it('moves from the folder the message is in', async () => {
    const { connection, recorded } = fakeConnection({ home: { path: 'Folders/Test', uid: 7 } })
    const result = await moveMessages(connection, false, ['<a@example.com>'], 'Archive')
    expect(recorded.moves).toEqual([{ uid: '7', from: 'Folders/Test', to: 'Archive' }])
    expect(result.succeeded).toBe(1)
    expect(result.failed).toBe(0)
  })

  it('treats a falsy answer as a failure, not as success', async () => {
    // This is the test that fails when the return value is ignored. Measured
    // twice against the Bridge: a move into a mailbox that is not there, and a
    // move out of "All Mail", both answer false and change nothing.
    const { connection } = fakeConnection({ refuseMove: true })
    const result = await moveMessages(connection, false, ['<a@example.com>'], 'Archive')
    expect(result.succeeded).toBe(0)
    expect(result.failed).toBe(1)
    expect(result.outcomes[0]?.ok).toBe(false)
    expect(result.outcomes[0]?.reason).toMatch(/refused/)
  })

  it('reports a message that is already there without moving it', async () => {
    const { connection, recorded } = fakeConnection({ home: { path: 'Archive', uid: 2 } })
    const result = await moveMessages(connection, false, ['<a@example.com>'], 'Archive')
    expect(recorded.moves).toEqual([])
    expect(result.succeeded).toBe(1)
    expect(result.outcomes[0]?.reason).toMatch(/already there/)
  })

  it('carries on after one message fails and accounts for every one', async () => {
    const { connection } = fakeConnection({ home: { path: 'Folders/Test', uid: 7 } })
    const result = await moveMessages(
      connection,
      false,
      ['<a@example.com>', '', '<c@example.com>'],
      'Archive',
    )
    expect(result.outcomes).toHaveLength(3)
    expect(result.succeeded).toBe(2)
    expect(result.failed).toBe(1)
  })

  it('refuses more than the batch limit', async () => {
    const { connection } = fakeConnection()
    const many = Array.from({ length: MAX_BATCH + 1 }, (_, i) => `<${i}@example.com>`)
    await expect(moveMessages(connection, false, many, 'Archive')).rejects.toThrow(
      new RegExp(String(MAX_BATCH)),
    )
  })

  it('refuses an empty list rather than reporting a successful nothing', async () => {
    const { connection } = fakeConnection()
    await expect(moveMessages(connection, false, [], 'Archive')).rejects.toThrow(BridgeError)
  })

  it('writes nothing while the server is read-only', async () => {
    const { connection, recorded } = fakeConnection()
    await expect(moveMessages(connection, true, ['<a@example.com>'], 'Archive')).rejects.toThrow(
      /read-only/,
    )
    expect(recorded.moves).toEqual([])
    expect(recorded.opened).toEqual([])
  })

  it('checks the destination before touching a single message', async () => {
    const { connection, recorded } = fakeConnection()
    await expect(
      moveMessages(connection, false, ['<a@example.com>'], 'Folders/Nope'),
    ).rejects.toThrow(BridgeError)
    expect(recorded.opened).toEqual([])
  })
})

describe('setFlags', () => {
  it('marks as read in the mailbox the message is in', async () => {
    const { connection, recorded } = fakeConnection({ home: { path: 'Folders/Test', uid: 7 } })
    await setFlags(connection, false, ['<a@example.com>'], { read: true })
    expect(recorded.flagsAdded).toEqual([
      { uid: '7', flags: ['\\Seen'], mailbox: 'Folders/Test' },
    ])
    expect(recorded.flagsRemoved).toEqual([])
  })

  it('clears the flags it is asked to clear', async () => {
    const { connection, recorded } = fakeConnection()
    await setFlags(connection, false, ['<a@example.com>'], { read: false, starred: false })
    expect(recorded.flagsAdded).toEqual([])
    expect(recorded.flagsRemoved[0]?.flags).toEqual(['\\Seen', '\\Flagged'])
  })

  it('refuses a call that asks for no change at all', async () => {
    const { connection } = fakeConnection()
    await expect(setFlags(connection, false, ['<a@example.com>'], {})).rejects.toThrow(BridgeError)
  })

  it('writes nothing while the server is read-only', async () => {
    const { connection, recorded } = fakeConnection()
    await expect(
      setFlags(connection, true, ['<a@example.com>'], { read: true }),
    ).rejects.toThrow(/read-only/)
    expect(recorded.flagsAdded).toEqual([])
    expect(recorded.opened).toEqual([])
  })
})

describe('trashMessages', () => {
  it('moves to the trash and never deletes', async () => {
    const { connection, recorded } = fakeConnection({ home: { path: 'Folders/Test', uid: 7 } })
    const result = await trashMessages(connection, false, ['<a@example.com>'])
    expect(recorded.moves).toEqual([{ uid: '7', from: 'Folders/Test', to: 'Trash' }])
    expect(result.target).toBe('Trash')
  })

  it('writes nothing while the server is read-only', async () => {
    const { connection } = fakeConnection()
    await expect(trashMessages(connection, true, ['<a@example.com>'])).rejects.toThrow(/read-only/)
  })
})

describe('nothing in this module deletes', () => {
  it('leaves no path that expunges a message', async () => {
    // Deliberately broad. Trash is a move, and there is no tool that empties
    // it, so an expunge appearing anywhere in here is a defect by definition.
    const { connection, recorded } = fakeConnection({ home: { path: 'Folders/Test', uid: 7 } })
    await moveMessages(connection, false, ['<a@example.com>'], 'Archive')
    await trashMessages(connection, false, ['<a@example.com>'])
    await setFlags(connection, false, ['<a@example.com>'], { read: true, starred: true })
    expect(recorded.deletes).toEqual([])
  })
})
