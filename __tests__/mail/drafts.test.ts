import { describe, it, expect } from 'vitest'
import { createDraft, updateDraft, replyDraft, forwardDraft, DRAFTS } from '../../src/mail/drafts.js'
import { BridgeError } from '../../src/bridge/errors.js'
import type { Connection, MailboxStatus } from '../../src/bridge/connection.js'

/**
 * Without a Bridge these tests prove what is written, what is refused, and
 * where. For this module the "where" carries the weight: replacing a draft
 * expunges the old version, and an expunge aimed at the wrong mailbox deletes
 * mail.
 */

const ME = 'me@example.com'

interface Recorded {
  appends: Array<{ mailbox: string; flags: string[]; raw: string }>
  deletes: Array<{ uid: string; mailbox: string }>
  opened: string[]
}

interface FakeOptions {
  /** Flags of the draft that is already there. */
  existingFlags?: string[]
  /** Nothing in Drafts at all. */
  empty?: boolean
  /** The message a reply or a forward is built from. */
  source?: string
}

const SOURCE = [
  'Message-ID: <original@example.com>',
  'References: <first@example.com> <second@example.com>',
  'In-Reply-To: <second@example.com>',
  'From: Jane Doe <jane@example.com>',
  'To: me@example.com, other@example.com',
  'Cc: watcher@example.com',
  'Subject: Bericht',
  'Date: Fri, 31 Jul 2026 09:00:00 +0000',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Der eigentliche Text.',
].join('\r\n')

function fakeConnection(options: FakeOptions = {}) {
  const recorded: Recorded = { appends: [], deletes: [], opened: [] }
  const source = options.source ?? SOURCE

  const connection = {
    listMailboxes: async () => [
      { path: 'INBOX', name: 'INBOX', kind: 'system', selectable: true },
      { path: DRAFTS, name: DRAFTS, kind: 'system', selectable: true },
      { path: 'All Mail', name: 'All Mail', kind: 'system', selectable: true },
    ],
    status: async (path: string) => ({
      path,
      messages: options.empty ? 0 : 3,
      unseen: 0,
      uidValidity: '1',
      uidNext: 9,
    }),
    withMailbox: async (
      path: string,
      operation: (c: unknown, s: MailboxStatus) => Promise<unknown>,
    ) => {
      recorded.opened.push(path)
      const status: MailboxStatus = {
        path,
        messages: options.empty ? 0 : 3,
        unseen: 0,
        uidValidity: '1',
        uidNext: 9,
      }
      const client = {
        search: async () => (options.empty ? [] : [4]),
        fetchOne: async (_uid: string, query: Record<string, unknown>) => {
          if (query.flags) return { flags: new Set(options.existingFlags ?? ['\\Draft', '\\Seen']) }
          if (query.source) return { source: Buffer.from(source) }
          if (query.headers) return { headers: Buffer.from(source.split('\r\n\r\n')[0] ?? '') }
          return undefined
        },
        append: async (mailbox: string, raw: Buffer, flags: string[]) => {
          recorded.appends.push({ mailbox, flags, raw: raw.toString('utf8') })
          return { destination: mailbox, path: mailbox, uid: 11, uidValidity: '1', seq: 1 }
        },
        messageDelete: async (uid: string) => {
          recorded.deletes.push({ uid, mailbox: path })
          return true
        },
      }
      return operation(client, status)
    },
  } as unknown as Connection

  return { connection, recorded }
}

describe('createDraft', () => {
  it('writes into Drafts with the draft flag', async () => {
    const { connection, recorded } = fakeConnection()
    const draft = await createDraft(connection, false, ME, {
      to: ['you@example.com'],
      subject: 'Hallo',
      text: 'Text',
    })
    expect(recorded.appends).toHaveLength(1)
    expect(recorded.appends[0]?.mailbox).toBe(DRAFTS)
    expect(recorded.appends[0]?.flags).toContain('\\Draft')
    expect(draft.messageId).toMatch(/^<.+@example\.com>$/)
  })

  it('keeps the blind copies, which a stored draft has to', async () => {
    const { connection, recorded } = fakeConnection()
    await createDraft(connection, false, ME, {
      to: ['you@example.com'],
      bcc: ['quiet@example.com'],
      text: 'Text',
    })
    expect(recorded.appends[0]?.raw).toContain('Bcc: quiet@example.com')
  })

  it('refuses a recipient carrying a line break', async () => {
    const { connection, recorded } = fakeConnection()
    await expect(
      createDraft(connection, false, ME, { to: ['you@example.com\nBcc: quiet@example.com'] }),
    ).rejects.toThrow(BridgeError)
    expect(recorded.appends).toEqual([])
  })

  it('writes nothing while the server is read-only', async () => {
    const { connection, recorded } = fakeConnection()
    await expect(
      createDraft(connection, true, ME, { to: ['you@example.com'] }),
    ).rejects.toThrow(/read-only/)
    expect(recorded.appends).toEqual([])
    expect(recorded.opened).toEqual([])
  })

  it('never touches a mailbox other than Drafts', async () => {
    const { connection, recorded } = fakeConnection()
    await createDraft(connection, false, ME, { to: ['you@example.com'] })
    expect(recorded.opened.every((p) => p === DRAFTS)).toBe(true)
  })
})

describe('updateDraft', () => {
  it('writes the new version before removing the old one', async () => {
    // That order matters. The other way round, a failed append would leave the
    // mailbox with neither version.
    const { connection, recorded } = fakeConnection()
    await updateDraft(connection, false, ME, '<one@example.com>', { subject: 'Neu' })
    expect(recorded.appends).toHaveLength(1)
    expect(recorded.deletes).toEqual([{ uid: '4', mailbox: DRAFTS }])
  })

  it('expunges only inside Drafts', async () => {
    const { connection, recorded } = fakeConnection()
    await updateDraft(connection, false, ME, '<one@example.com>', { subject: 'Neu' })
    for (const d of recorded.deletes) expect(d.mailbox).toBe(DRAFTS)
  })

  it('refuses a message that does not carry the draft flag', async () => {
    // The second guard. Without it this would delete an ordinary message that
    // happens to be sitting in Drafts.
    const { connection, recorded } = fakeConnection({ existingFlags: ['\\Seen'] })
    await expect(
      updateDraft(connection, false, ME, '<one@example.com>', { subject: 'Neu' }),
    ).rejects.toThrow(/does not carry the draft flag/)
    expect(recorded.deletes).toEqual([])
    expect(recorded.appends).toEqual([])
  })

  it('says so when there is no such draft, rather than writing a new one', async () => {
    const { connection, recorded } = fakeConnection({ empty: true })
    await expect(
      updateDraft(connection, false, ME, '<one@example.com>', { subject: 'Neu' }),
    ).rejects.toThrow(/No draft with the id/)
    expect(recorded.appends).toEqual([])
  })

  it('carries over what was not named', async () => {
    const { connection, recorded } = fakeConnection()
    await updateDraft(connection, false, ME, '<original@example.com>', { subject: 'Neu' })
    const written = recorded.appends[0]?.raw ?? ''
    // The recipients of the stored version survive a change of subject.
    expect(written).toContain('me@example.com')
    expect(written).toContain('other@example.com')
  })

  it('keeps the identifier the caller already has', async () => {
    const { connection } = fakeConnection()
    const draft = await updateDraft(connection, false, ME, '<one@example.com>', { text: 'x' })
    expect(draft.messageId).toBe('<one@example.com>')
  })

  it('deletes nothing while the server is read-only', async () => {
    const { connection, recorded } = fakeConnection()
    await expect(
      updateDraft(connection, true, ME, '<one@example.com>', { text: 'x' }),
    ).rejects.toThrow(/read-only/)
    expect(recorded.deletes).toEqual([])
    expect(recorded.opened).toEqual([])
  })
})

describe('replyDraft', () => {
  it('carries the reference headers, which is the whole point', async () => {
    // A reply without In-Reply-To and References starts a new conversation that
    // merely shares a subject, and every mail reader shows it as one.
    const { connection, recorded } = fakeConnection()
    await replyDraft(connection, false, ME, '<original@example.com>', 'Meine Antwort')
    const written = recorded.appends[0]?.raw ?? ''
    expect(written).toContain('In-Reply-To: <original@example.com>')
    expect(written).toContain('<first@example.com>')
    expect(written).toContain('<second@example.com>')
  })

  it('replies to the sender and leaves the others out', async () => {
    const { connection, recorded } = fakeConnection()
    const draft = await replyDraft(connection, false, ME, '<original@example.com>', 'Antwort')
    expect(draft.to.map((t) => t.address)).toEqual(['jane@example.com'])
    expect(draft.cc).toEqual([])
    expect(recorded.appends[0]?.raw).toContain('Subject: Re: Bericht')
  })

  it('puts the others in copy when asked, but never ourselves', async () => {
    const { connection } = fakeConnection()
    const draft = await replyDraft(connection, false, ME, '<original@example.com>', 'Antwort', {
      all: true,
    })
    const cc = draft.cc.map((c) => c.address)
    expect(cc).toContain('other@example.com')
    expect(cc).toContain('watcher@example.com')
    expect(cc).not.toContain(ME)
  })

  it('quotes the original below the new text', async () => {
    const { connection, recorded } = fakeConnection()
    await replyDraft(connection, false, ME, '<original@example.com>', 'Meine Antwort')
    const written = recorded.appends[0]?.raw ?? ''
    expect(written).toContain('Meine Antwort')
    expect(written).toContain('> Der eigentliche Text.')
  })

  it('refuses when the only address on the message is our own', async () => {
    const onlyMe = SOURCE.replace('From: Jane Doe <jane@example.com>', `From: ${ME}`)
      .replace('To: me@example.com, other@example.com', `To: ${ME}`)
      .replace('Cc: watcher@example.com', `Cc: ${ME}`)
    const { connection } = fakeConnection({ source: onlyMe })
    await expect(
      replyDraft(connection, false, ME, '<original@example.com>', 'Antwort'),
    ).rejects.toThrow(/nobody to reply to/)
  })

  it('writes nothing while the server is read-only', async () => {
    const { connection, recorded } = fakeConnection()
    await expect(
      replyDraft(connection, true, ME, '<original@example.com>', 'Antwort'),
    ).rejects.toThrow(/read-only/)
    expect(recorded.appends).toEqual([])
  })
})

describe('forwardDraft', () => {
  it('writes a forward with the prefix and the quoted original', async () => {
    const { connection, recorded } = fakeConnection()
    const draft = await forwardDraft(
      connection,
      false,
      ME,
      '<original@example.com>',
      ['third@example.com'],
      'Zur Kenntnis',
    )
    expect(draft.subject).toBe('Fwd: Bericht')
    const written = recorded.appends[0]?.raw ?? ''
    expect(written).toContain('Forwarded message')
    expect(written).toContain('Zur Kenntnis')
  })

  it('does not carry the thread headers of the original', async () => {
    // A forward is a new conversation. Carrying In-Reply-To would file it under
    // the original thread in the recipient's reader, which is wrong.
    const { connection, recorded } = fakeConnection()
    await forwardDraft(connection, false, ME, '<original@example.com>', ['third@example.com'], '')
    expect(recorded.appends[0]?.raw).not.toContain('In-Reply-To:')
  })

  it('refuses a forward with no recipient', async () => {
    const { connection } = fakeConnection()
    await expect(
      forwardDraft(connection, false, ME, '<original@example.com>', [], ''),
    ).rejects.toThrow(BridgeError)
  })

  it('writes nothing while the server is read-only', async () => {
    const { connection, recorded } = fakeConnection()
    await expect(
      forwardDraft(connection, true, ME, '<original@example.com>', ['third@example.com'], ''),
    ).rejects.toThrow(/read-only/)
    expect(recorded.appends).toEqual([])
  })
})

describe('the mailbox guard cannot be reached around', () => {
  it('refuses when a mailbox reports a path other than the one that was opened', async () => {
    // Contrived on purpose, and it earned its place: without it, removing the
    // guard broke no test at all, because every stand-in politely reported the
    // mailbox it had been asked for. The guard exists for the case where that
    // is not true, so that is what has to be tested.
    const deleted: string[] = []
    const connection = {
      listMailboxes: async () => [],
      status: async (path: string) => ({
        path,
        messages: 3,
        unseen: 0,
        uidValidity: '1',
        uidNext: 9,
      }),
      withMailbox: async (
        _path: string,
        operation: (c: unknown, s: MailboxStatus) => Promise<unknown>,
      ) => {
        const client = {
          search: async () => [4],
          fetchOne: async () => ({ flags: new Set(['\\Draft']) }),
          append: async (mailbox: string) => ({ destination: mailbox, path: mailbox, uid: 11 }),
          messageDelete: async (uid: string) => {
            deleted.push(uid)
            return true
          },
        }
        // Claims to be the inbox although "Drafts" was asked for.
        return operation(client, {
          path: 'INBOX',
          messages: 3,
          unseen: 0,
          uidValidity: '1',
          uidNext: 9,
        })
      },
    } as unknown as Connection

    await expect(
      createDraft(connection, false, ME, { to: ['you@example.com'], text: 'x' }),
    ).rejects.toThrow(/Refusing to operate on "INBOX"/)
    expect(deleted).toEqual([])
  })
})

describe('this module cannot send', () => {
  it('opens no mailbox other than Drafts and the one the original is in', async () => {
    const { connection, recorded } = fakeConnection()
    await createDraft(connection, false, ME, { to: ['you@example.com'] })
    await updateDraft(connection, false, ME, '<one@example.com>', { text: 'x' })
    await replyDraft(connection, false, ME, '<original@example.com>', 'x')
    // Nothing here reaches for SMTP, and nothing writes outside Drafts.
    expect(recorded.appends.every((a) => a.mailbox === DRAFTS)).toBe(true)
    expect(recorded.deletes.every((d) => d.mailbox === DRAFTS)).toBe(true)
  })
})
