import { describe, it, expect } from 'vitest'
import {
  normaliseMessageId,
  presentMessageId,
  findByMessageId,
  ALL_MAIL,
} from '../../src/mail/ids.js'
import { BridgeError } from '../../src/bridge/errors.js'

describe('normaliseMessageId', () => {
  it('adds the angle brackets the IMAP header uses', () => {
    expect(normaliseMessageId('abc@example.com')).toBe('<abc@example.com>')
  })

  it('accepts an id that already has them', () => {
    expect(normaliseMessageId('<abc@example.com>')).toBe('<abc@example.com>')
  })

  it('ignores surrounding whitespace', () => {
    // Callers paste ids from earlier answers, sometimes with a stray space.
    expect(normaliseMessageId('  <abc@example.com>  ')).toBe('<abc@example.com>')
  })

  it('copes with the long base64-style ids Proton generates', () => {
    const protonStyle = 'U6alR9m7DFH1c6hGOE5DNSU-dHc7u0mY7XZ2F0Hdd3zK_RLgFQ==@example.com'
    expect(normaliseMessageId(protonStyle)).toBe(`<${protonStyle}>`)
  })

  it('rejects an empty id with an explanation', () => {
    expect(() => normaliseMessageId('')).toThrow(BridgeError)
    expect(() => normaliseMessageId('   ')).toThrow(BridgeError)
  })

  it('does not strip brackets from the middle of an id', () => {
    expect(normaliseMessageId('a<b>c@example.com')).toBe('<a<b>c@example.com>')
  })
})

describe('ALL_MAIL', () => {
  it('names the mailbox that holds every message', () => {
    // Measured: "All Mail" also contains messages that live in Trash, which
    // makes it the right fallback for a lookup.
    expect(ALL_MAIL).toBe('All Mail')
  })
})

describe('presentMessageId', () => {
  it('gives a message the same name whichever tool named it', () => {
    // A listing reads the IMAP envelope, which repeats the header exactly as
    // written. Reading a message goes through a MIME parser, which adds the
    // brackets RFC 5322 requires. Without this the same message came back
    // under two names, and only one of them was ever findable.
    expect(presentMessageId('abc@example.com')).toBe('<abc@example.com>')
    expect(presentMessageId('<abc@example.com>')).toBe('<abc@example.com>')
  })

  it('leaves an absent identifier absent', () => {
    // A message without one cannot be addressed at all, and "<>" would only
    // move the failure further away from its cause.
    expect(presentMessageId('')).toBe('')
    expect(presentMessageId('   ')).toBe('')
  })
})

/**
 * Looking a message up by its Message-ID.
 *
 * The case these tests exist for was found in a real mailbox: a sender writes
 * the identifier without the angle brackets RFC 5322 requires, and all 17 of
 * its messages were unreachable. Marking a folder as read left one behind with
 * an error that pointed at the caller rather than at the server.
 *
 * Two measured facts about the Bridge underlie the fix, both from 31.07.2026:
 *
 * 1. The IMAP header search is a **substring** comparison. Searching for a
 *    fragment of an identifier returns the message.
 * 2. The envelope repeats the header exactly as written, brackets or not.
 *
 * Together those mean a bracketed search can never find a bare header, and a
 * bare search can find more than it should. The stand-in below reproduces both.
 */
function fakeClient(
  messages: Array<{ uid: number; header: string }>,
  options: { record?: string[] } = {},
) {
  return {
    async search(query: { header: { 'message-id': string } }) {
      const term = query.header['message-id']
      options.record?.push(term)
      return messages.filter((m) => m.header.includes(term)).map((m) => m.uid)
    },
    async fetchOne(uid: string) {
      const found = messages.find((m) => m.uid === Number(uid))
      return found ? { envelope: { messageId: found.header } } : undefined
    },
  } as never
}

describe('findByMessageId', () => {
  it('finds a message written the way the standard requires', async () => {
    const uid = await findByMessageId(
      fakeClient([{ uid: 7, header: '<a@example.com>' }]),
      '<a@example.com>',
    )
    expect(uid).toBe(7)
  })

  it('finds a message whose header carries no brackets', async () => {
    // The reported failure, in one line.
    const uid = await findByMessageId(
      fakeClient([{ uid: 7, header: 'a@example.com' }]),
      '<a@example.com>',
    )
    expect(uid).toBe(7)
  })

  it('costs nothing extra for a message written correctly', async () => {
    const record: string[] = []
    await findByMessageId(
      fakeClient([{ uid: 7, header: '<a@example.com>' }], { record }),
      '<a@example.com>',
    )
    // One search. The second attempt only runs when the first came back empty,
    // so the common case pays nothing for the rare one.
    expect(record).toEqual(['<a@example.com>'])
  })

  it('refuses a message that merely contains the identifier', async () => {
    // What the substring comparison makes possible. Without verification this
    // resolves to uid 9 and marks the wrong message, saying nothing about it.
    const uid = await findByMessageId(
      fakeClient([{ uid: 9, header: '<xyza@example.com>' }]),
      '<a@example.com>',
    )
    expect(uid).toBeUndefined()
  })

  it('picks the right one out of hits that only look alike', async () => {
    const uid = await findByMessageId(
      fakeClient([
        { uid: 9, header: '<xyza@example.com>' },
        { uid: 4, header: 'a@example.com' },
        { uid: 11, header: '<a@example.com.example.org>' },
      ]),
      '<a@example.com>',
    )
    expect(uid).toBe(4)
  })

  it('takes the newest of true duplicates', async () => {
    const uid = await findByMessageId(
      fakeClient([
        { uid: 3, header: 'a@example.com' },
        { uid: 12, header: 'a@example.com' },
      ]),
      '<a@example.com>',
    )
    expect(uid).toBe(12)
  })

  it('answers with nothing when the message is not there', async () => {
    const uid = await findByMessageId(
      fakeClient([{ uid: 7, header: '<b@example.com>' }]),
      '<a@example.com>',
    )
    expect(uid).toBeUndefined()
  })
})
