import { describe, it, expect, vi } from 'vitest'
import { addLabel, removeLabel, labelPath, listLabels, LABEL_PREFIX } from '../../src/mail/labels.js'
import { BridgeError } from '../../src/bridge/errors.js'
import type { Connection, MailboxStatus, Mailbox } from '../../src/bridge/connection.js'

/**
 * Tests run without a Bridge. What they can prove is what the code sends and
 * what it refuses to send, which for this module is the point: the guards are
 * the reason it exists, and a guard that has never fired is unproven.
 */

const MAILBOXES: Mailbox[] = [
  { path: 'INBOX', name: 'INBOX', kind: 'system', selectable: true },
  { path: 'Folders/Test', name: 'Test', kind: 'folder', selectable: true },
  { path: 'Folders/Labels', name: 'Labels', kind: 'folder', selectable: true },
  { path: 'Labels/Test1', name: 'Test1', kind: 'label', selectable: true },
  { path: 'Labels/Test2', name: 'Test2', kind: 'label', selectable: true },
]

interface Recorded {
  copies: Array<{ uid: string; destination: string }>
  deletes: Array<{ uid: string; mailbox: string }>
  opened: string[]
  /** Every action in order, so a test can assert what came last. */
  events: string[]
}

function fakeConnection(options: { hits?: number[]; messages?: number } = {}) {
  const recorded: Recorded = { copies: [], deletes: [], opened: [], events: [] }
  const hits = options.hits ?? [7]
  const messages = options.messages ?? 3

  const connection = {
    listMailboxes: async () => MAILBOXES,
    withMailbox: async (
      path: string,
      operation: (c: unknown, s: MailboxStatus) => Promise<unknown>,
    ) => {
      recorded.opened.push(path)
      recorded.events.push(`open ${path}`)
      const status: MailboxStatus = {
        path,
        messages,
        unseen: 0,
        uidValidity: '1',
        uidNext: 99,
      }
      const client = {
        search: async () => hits,
        messageCopy: async (uid: string, destination: string) => {
          recorded.copies.push({ uid, destination })
          recorded.events.push(`copy ${destination}`)
          return { destination }
        },
        messageDelete: async (uid: string) => {
          recorded.deletes.push({ uid, mailbox: path })
          recorded.events.push(`delete ${path}`)
          return true
        },
      }
      return operation(client, status)
    },
  } as unknown as Connection

  return { connection, recorded }
}

describe('labelPath', () => {
  it('accepts a bare name and a prefixed one alike', () => {
    expect(labelPath('Work')).toBe('Labels/Work')
    expect(labelPath('Labels/Work')).toBe('Labels/Work')
    expect(labelPath('  Work  ')).toBe('Labels/Work')
  })

  it('refuses a name that would leave the label namespace', () => {
    // Without this, a caller could aim an expunge at a folder by dressing the
    // path up as a label name.
    expect(() => labelPath('../Folders/Test')).toThrow(BridgeError)
    expect(() => labelPath('Labels/Work/Sub')).toThrow(BridgeError)
    expect(() => labelPath('Work/Sub')).toThrow(BridgeError)
  })

  it('refuses the container itself and the empty name', () => {
    expect(() => labelPath('Labels/')).toThrow(BridgeError)
    expect(() => labelPath('')).toThrow(BridgeError)
    expect(() => labelPath('   ')).toThrow(BridgeError)
  })
})

describe('listLabels', () => {
  it('lists labels and nothing else', async () => {
    const { connection } = fakeConnection()
    // Folders/Labels is a user folder that happens to be called "Labels". It
    // must not appear here, and the account really has one.
    expect(await listLabels(connection)).toEqual(['Labels/Test1', 'Labels/Test2'])
  })
})

describe('addLabel', () => {
  it('copies the message into the label mailbox', async () => {
    const { connection, recorded } = fakeConnection({ hits: [7] })
    const result = await addLabel(connection, false, '<a@example.com>', 'Test1', 'Folders/Test')
    expect(recorded.copies).toEqual([{ uid: '7', destination: 'Labels/Test1' }])
    expect(result.label).toBe('Labels/Test1')
  })

  it('refuses a label that does not exist, instead of reporting success', async () => {
    // The measured reason: the Bridge accepts a copy into a mailbox that is not
    // there, returns success and changes nothing. Without this check the tool
    // would report a label it never applied.
    const { connection, recorded } = fakeConnection()
    await expect(addLabel(connection, false, '<a@example.com>', 'Nope')).rejects.toThrow(
      /no label "Nope"/,
    )
    expect(recorded.copies).toEqual([])
  })

  it('names the labels that do exist, so the caller can correct itself', async () => {
    const { connection } = fakeConnection()
    await expect(addLabel(connection, false, '<a@example.com>', 'Nope')).rejects.toThrow(
      /Test1, Test2/,
    )
  })

  it('writes nothing while the server is read-only', async () => {
    const { connection, recorded } = fakeConnection()
    await expect(addLabel(connection, true, '<a@example.com>', 'Test1')).rejects.toThrow(
      /read-only/,
    )
    expect(recorded.copies).toEqual([])
    expect(recorded.opened).toEqual([])
  })
})

describe('removeLabel', () => {
  it('expunges inside the label mailbox', async () => {
    const { connection, recorded } = fakeConnection({ hits: [4] })
    const result = await removeLabel(connection, false, '<a@example.com>', 'Test1')
    expect(recorded.deletes).toEqual([{ uid: '4', mailbox: 'Labels/Test1' }])
    expect(result.wasApplied).toBe(true)
  })

  it('never opens anything but the label mailbox', async () => {
    // This is the guard that matters most. An expunge aimed at a folder deletes
    // mail, so the message is looked up inside the label and nowhere else.
    const { connection, recorded } = fakeConnection({ hits: [4] })
    await removeLabel(connection, false, '<a@example.com>', 'Test1')
    for (const path of recorded.opened) {
      expect(path.startsWith(LABEL_PREFIX)).toBe(true)
    }
  })

  it('reports an absent label as nothing to do rather than as a failure', async () => {
    const { connection, recorded } = fakeConnection({ hits: [] })
    const result = await removeLabel(connection, false, '<a@example.com>', 'Test1')
    expect(result.wasApplied).toBe(false)
    expect(recorded.deletes).toEqual([])
  })

  it('does not expunge an empty mailbox', async () => {
    // The Bridge answers FETCH on an empty mailbox with BAD rather than an
    // empty result.
    const { connection, recorded } = fakeConnection({ messages: 0 })
    const result = await removeLabel(connection, false, '<a@example.com>', 'Test1')
    expect(result.wasApplied).toBe(false)
    expect(recorded.deletes).toEqual([])
  })

  it('refuses a folder even when it is dressed up as a label', async () => {
    const { connection, recorded } = fakeConnection()
    for (const attempt of ['Folders/Test', 'INBOX', 'Labels/Test1/Sub', '../INBOX']) {
      await expect(removeLabel(connection, false, '<a@example.com>', attempt)).rejects.toThrow(
        BridgeError,
      )
    }
    expect(recorded.deletes).toEqual([])
  })

  it('deletes nothing while the server is read-only', async () => {
    const { connection, recorded } = fakeConnection({ hits: [4] })
    await expect(removeLabel(connection, true, '<a@example.com>', 'Test1')).rejects.toThrow(
      /read-only/,
    )
    expect(recorded.deletes).toEqual([])
    expect(recorded.opened).toEqual([])
  })
})

describe('the guard cannot be reached around', () => {
  it('refuses even when a mailbox lies about its own path', async () => {
    // Contrived on purpose: it asserts that the check sits immediately before
    // the expunge and does not rely on the one twenty lines above it.
    const recorded: string[] = []
    const connection = {
      listMailboxes: async () => MAILBOXES,
      withMailbox: async (
        _path: string,
        operation: (c: unknown, s: MailboxStatus) => Promise<unknown>,
      ) => {
        const client = {
          search: async () => [4],
          messageDelete: async (uid: string) => {
            recorded.push(uid)
            return true
          },
        }
        // The status claims to be the inbox although a label was opened.
        return operation(client, {
          path: 'INBOX',
          messages: 3,
          unseen: 0,
          uidValidity: '1',
          uidNext: 9,
        })
      },
    } as unknown as Connection

    await expect(removeLabel(connection, false, '<a@example.com>', 'Test1')).rejects.toThrow(
      /Refusing to operate on "INBOX"/,
    )
    expect(recorded).toEqual([])
  })
})

describe('no verification straight after a write', () => {
  it('does not read the mailbox back after applying a label', async () => {
    // Measured: the Bridge reports an intermediate state right after a write, so
    // an immediate check describes something that is not the outcome.
    const { connection, recorded } = fakeConnection({ hits: [7] })
    await addLabel(connection, false, '<a@example.com>', 'Test1', 'Folders/Test')
    expect(recorded.events.at(-1)).toBe('copy Labels/Test1')
  })
})

describe('read-only is asked at call time', () => {
  it('takes the current value rather than one captured earlier', async () => {
    const { connection } = fakeConnection({ hits: [7] })
    const readOnly = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)
    await expect(addLabel(connection, readOnly(), '<a@example.com>', 'Test1')).resolves.toBeDefined()
    await expect(addLabel(connection, readOnly(), '<a@example.com>', 'Test1')).rejects.toThrow(
      /read-only/,
    )
  })
})
