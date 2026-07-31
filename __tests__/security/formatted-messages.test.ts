import { describe, it, expect } from 'vitest'
import { buildMessage, readableBody, describeUrls, hiddenTextOf, type Draft } from '../../src/mail/compose.js'
import { digestOf, describeForConfirmation } from '../../src/tools/confirm.js'
import { BridgeError } from '../../src/bridge/errors.js'

/**
 * What a person is shown before a formatted message is sent, and what the
 * confirmation is bound to.
 *
 * Plain text needs none of this, because the message and its preview are the
 * same string. Markup separates the two, and every test here is about closing
 * that gap: a recipient must not be able to read anything the confirmer did
 * not, and a message must not be able to change after it was agreed to.
 */

function draft(over: Partial<Draft> = {}): Draft {
  return {
    from: { address: 'me@example.com' },
    to: [{ address: 'you@example.com' }],
    cc: [],
    bcc: [],
    subject: 'Subject',
    text: 'Body',
    messageId: '<one@example.com>',
    ...over,
  }
}

const withHtml = (html: string, over: Partial<Draft> = {}): Draft =>
  draft({ html, text: readableBody({ ...draft(), html }), ...over })

describe('a formatted message is delivered as formatting', () => {
  it('is sent as html rather than as visible tags', async () => {
    const raw = (await buildMessage(withHtml('<p><b>Fett</b></p>'))).toString('utf8')
    expect(raw).toMatch(/Content-Type:\s*text\/html/i)
  })

  it('carries only one body, because the other half would be dropped', async () => {
    // Measured: Proton keeps the markup and drops the plain text half of a
    // message that has both, so composing both delivers the half nobody saw.
    const raw = (await buildMessage(withHtml('<p>x</p>'))).toString('utf8')
    expect(raw).not.toMatch(/Content-Type:\s*text\/plain/i)
  })

  it('carries an embedded file and the reference to it', async () => {
    const raw = (
      await buildMessage(
        withHtml('<img src="cid:chart@x" alt="a chart">', {
          inlineParts: [
            {
              contentId: 'chart@x',
              filename: 'chart.png',
              contentType: 'image/png',
              content: Buffer.from('not really a png'),
            },
          ],
        }),
      )
    ).toString('utf8')
    expect(raw).toContain('chart.png')
    expect(raw).toMatch(/Content-ID:\s*<chart@x>/i)
  })

  it('refuses markup that points at a file nobody provided', async () => {
    // Otherwise the recipient gets a broken image where the sender saw a
    // picture, and neither of them finds out why.
    await expect(buildMessage(withHtml('<img src="cid:missing@x">'))).rejects.toThrow(/cid:missing@x/)
  })

  it('refuses markup outside the permitted set, before anything is built', async () => {
    await expect(buildMessage(withHtml('<p>fine</p><script>bad()</script>'))).rejects.toThrow(
      BridgeError,
    )
  })
})

describe('the confirmation shows what the body does not', () => {
  it('lists every address in full, links and images alike', () => {
    const shown = describeForConfirmation(
      withHtml(
        '<a href="https://elsewhere.invalid/pay">our invoice portal</a>' +
          '<img src="https://tracker.invalid/p.gif">',
      ),
      'This message',
    )
    expect(shown).toContain('https://elsewhere.invalid/pay')
    expect(shown).toContain('our invoice portal')
    expect(shown).toContain('https://tracker.invalid/p.gif')
  })

  it('shows an alt text, which the body preview leaves out entirely', () => {
    // The measured way past a confirmation: clients block remote images by
    // default, so the alt text is what the recipient actually reads, and the
    // text conversion drops it.
    const html = '<img src="https://example.invalid/x.png" alt="Please transfer 500 euros">'
    expect(readableBody(withHtml(html))).not.toContain('500 euros')

    const shown = describeForConfirmation(withHtml(html), 'This message')
    expect(shown).toContain('500 euros')
    expect(shown).toContain('not in the body above')
  })

  it('shows a title attribute for the same reason', () => {
    const shown = describeForConfirmation(
      withHtml('<span title="read on hover">visible</span>'),
      'This message',
    )
    expect(shown).toContain('read on hover')
  })

  it('names every carried file with its size', () => {
    const shown = describeForConfirmation(
      withHtml('<img src="cid:logo@x">', {
        inlineParts: [
          {
            contentId: 'logo@x',
            filename: 'logo.png',
            contentType: 'image/png',
            content: Buffer.alloc(1234),
          },
        ],
      }),
      'This message',
    )
    expect(shown).toContain('logo.png')
    expect(shown).toContain('1234 bytes')
  })

  it('does not shorten the address list, unlike the body', () => {
    // An address on line thirty is exactly where one would be put in order not
    // to be read, so the list is never cut.
    const links = Array.from(
      { length: 12 },
      (_, i) => `<p>line ${i}</p><a href="https://example.invalid/${i}">link ${i}</a>`,
    ).join('')
    const shown = describeForConfirmation(withHtml(links), 'This message')
    for (let i = 0; i < 12; i += 1) expect(shown).toContain(`https://example.invalid/${i}`)
  })

  it('says nothing extra for a plain text message', () => {
    const shown = describeForConfirmation(draft(), 'This message')
    expect(shown).not.toContain('Every address in this message')
    expect(shown).not.toContain('not in the body above')
  })
})

describe('the confirmation is bound to the markup, not to how it reads', () => {
  it('notices a changed link target behind identical text', () => {
    // The whole reason formatted mail needs its own thought. Both messages read
    // the same to a person skimming; they go to different places.
    const before = withHtml('<a href="https://good.invalid">click here</a>')
    const after = withHtml('<a href="https://evil.invalid">click here</a>')
    expect(readableBody(before).replace(/\[.*?\]/g, '')).toBe(
      readableBody(after).replace(/\[.*?\]/g, ''),
    )
    expect(digestOf(after)).not.toBe(digestOf(before))
  })

  it('notices a changed alt text', () => {
    expect(digestOf(withHtml('<img src="cid:a@x" alt="one">'))).not.toBe(
      digestOf(withHtml('<img src="cid:a@x" alt="two">')),
    )
  })

  it('notices a swapped file behind an unchanged name', () => {
    // A confirmation that covered the file name alone would let the picture be
    // exchanged after it was agreed to.
    const part = (content: string) => ({
      contentId: 'a@x',
      filename: 'same-name.png',
      contentType: 'image/png',
      content: Buffer.from(content),
    })
    const one = withHtml('<img src="cid:a@x">', { inlineParts: [part('first picture')] })
    const two = withHtml('<img src="cid:a@x">', { inlineParts: [part('second picture')] })
    expect(digestOf(two)).not.toBe(digestOf(one))
  })

  it('is the same for the same message', () => {
    expect(digestOf(withHtml('<p>x</p>'))).toBe(digestOf(withHtml('<p>x</p>')))
  })
})

describe('the readable body', () => {
  it('puts a link target beside the text it belongs to', () => {
    // This is what makes the preview worth showing at all, and it is the same
    // conversion this server uses to read a stranger's message.
    expect(readableBody(withHtml('<a href="https://example.invalid/x">click</a>'))).toContain(
      'https://example.invalid/x',
    )
  })

  it('is the text itself when there is no markup', () => {
    expect(readableBody(draft({ text: 'plain' }))).toBe('plain')
  })
})

describe('helpers agree with each other', () => {
  it('reports no addresses and no hidden text for plain messages', () => {
    expect(describeUrls(draft())).toEqual([])
    expect(hiddenTextOf(draft())).toEqual([])
  })
})
