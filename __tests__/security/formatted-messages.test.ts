import { describe, it, expect } from 'vitest'
import { buildMessage, readableBody, describeUrls, hiddenTextOf, type Draft } from '../../src/mail/compose.js'
import { digestOf, describeForConfirmation } from '../../src/tools/confirm.js'
import { holdForPreview, _reset as resetPreviews } from '../../src/tools/preview.js'
import { pendingView } from '../../src/tools/pending-view.js'
import { pendingPage } from '../../src/web/pending.js'
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

/**
 * The page a confirmation points at, for a given message.
 *
 * The evidence used to be in the confirmation text and is now here. These tests
 * moved with it rather than being deleted: what a recipient can read and the
 * confirmer cannot is the same question wherever it is answered.
 */
function previewFor(message: Draft, tool = 'send_message'): string {
  resetPreviews()
  const digest = digestOf(message)
  holdForPreview(digest, message, tool)
  const view = pendingView(digest)
  if (!view) throw new Error('the message was not held')
  return pendingPage({ ...view, token: 'test-token', disclaimer: 'plain' })
}

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

describe('the preview shows what the body does not', () => {
  it('lists every address in full, links and images alike', () => {
    const shown = previewFor(
      withHtml(
        '<a href="https://elsewhere.invalid/pay">our invoice portal</a>' +
          '<img src="https://tracker.invalid/p.gif">',
      ),
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

    const shown = previewFor(withHtml(html))
    expect(shown).toContain('500 euros')
    expect(shown).toContain('Text the body does not show')
  })

  it('shows a title attribute for the same reason', () => {
    const shown = previewFor(withHtml('<span title="read on hover">visible</span>'))
    expect(shown).toContain('read on hover')
  })

  it('names every carried file with its size', () => {
    const shown = previewFor(
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
    )
    expect(shown).toContain('logo.png')
    expect(shown).toContain('1234 bytes')
  })

  it('does not shorten the address list', () => {
    // An address on line thirty is exactly where one would be put in order not
    // to be read, so the list is never cut. The page has room for it, which is
    // the whole reason the evidence lives here now.
    const links = Array.from(
      { length: 12 },
      (_, i) => `<p>line ${i}</p><a href="https://example.invalid/${i}">link ${i}</a>`,
    ).join('')
    const shown = previewFor(withHtml(links))
    for (let i = 0; i < 12; i += 1) expect(shown).toContain(`https://example.invalid/${i}`)
  })

  it('renders the message in a frame that can do nothing', () => {
    // A reply carries a stranger's markup byte for byte. Sandboxed with no
    // values at all: no script, no forms, no same-origin access.
    const shown = previewFor(withHtml('<p>Hello</p>'))
    expect(shown).toMatch(/<iframe[^>]*\bsandbox\b/)
    expect(shown).not.toMatch(/<iframe[^>]*sandbox="[^"]*allow-(scripts|same-origin)/)
  })

  it('carries no button, because the token reaches the assistant', () => {
    // open_configuration hands the address to the model. A control here could
    // be operated by the thing being supervised, so the answer goes through
    // the client instead.
    const shown = previewFor(withHtml('<p>Hello</p>'))
    const main = shown.split('<main>')[1] ?? ''
    expect(main).not.toContain('<button')
    expect(main).not.toContain('<form')
  })
})

describe('the confirmation itself stays short', () => {
  /**
   * Why this is a security test rather than a cosmetic one.
   *
   * Measured before the change: 11 lines for a plain text message, 24 for a
   * formatted one, 74 for a newsletter-shaped one. Past a certain length the
   * client's dialog could not be answered at all, because the button sat below
   * the bottom of the window. A confirmation nobody can answer does not protect
   * anything.
   */
  const previewLink = 'http://127.0.0.1:7345/pending/abc'

  it('names every recipient, which is the one thing never summarised', () => {
    const many = draft({
      to: [{ address: 'a@example.com' }, { address: 'b@example.com' }],
      cc: [{ address: 'c@example.com' }],
      bcc: [{ address: 'd@example.com' }],
    })
    const shown = describeForConfirmation(many, 'This message', previewLink)
    for (const who of ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com']) {
      expect(shown).toContain(who)
    }
  })

  it('carries no message content at all', () => {
    const shown = describeForConfirmation(
      withHtml('<p>Secret plans</p><a href="https://elsewhere.invalid/pay">portal</a>'),
      'This message',
      previewLink,
    )
    expect(shown).not.toContain('Secret plans')
    expect(shown).not.toContain('elsewhere.invalid')
    expect(shown).toContain(previewLink)
  })

  it('stays short even for a message stuffed with links', () => {
    const links = Array.from(
      { length: 40 },
      (_, i) => `<a href="https://example.invalid/very/long/path/number/${i}">link ${i}</a>`,
    ).join('')
    const shown = describeForConfirmation(withHtml(links), 'This message', previewLink)
    // The dialog has to stay answerable whatever the message carries.
    expect(shown.split('\n').length).toBeLessThan(16)
  })

  it('says what the message carries, as counts', () => {
    const shown = describeForConfirmation(
      withHtml('<a href="https://a.invalid/1">one</a><img src="https://a.invalid/2" alt="hidden">'),
      'This message',
      previewLink,
    )
    expect(shown).toMatch(/2 address\(es\)/)
    expect(shown).toMatch(/1 piece\(s\) of text the body does not show/)
  })

  it('says so plainly when there is nowhere to read it', () => {
    // No interface running. A question asked with less behind it than usual
    // should say as much rather than quietly offer less.
    const shown = describeForConfirmation(withHtml('<p>Hello</p>'), 'This message')
    expect(shown).toContain('cannot be shown in full')
    expect(shown).not.toContain('http://')
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

describe('a quoted message in the preview', () => {
  it('is counted rather than listed', () => {
    // Measured on a real mailbox: four images per message on average and up to
    // thirty links. Listing a quote's addresses would bury the ones the sender
    // is answering for under ones that arrived in the mailbox anyway.
    const message = withHtml('<p>My answer.</p>', {
      quotedHtml:
        '<blockquote><a href="https://a.invalid">one</a><a href="https://b.invalid">two</a>' +
        '<img src="https://c.invalid/p.png"></blockquote>',
    })
    const shown = previewFor(message, 'send_reply')
    expect(shown).toContain('2 link(s), 1 image(s)')
    // Not in the address table. It is visible inside the rendered frame, which
    // is where a quote belongs: readable, not itemised.
    expect(shown.split('<h2>Every address in it')[1] ?? '').not.toContain('https://a.invalid')
  })

  it('still lists every address of the part that was written', () => {
    const message = withHtml('<p><a href="https://mine.invalid">mine</a></p>', {
      quotedHtml: '<blockquote><a href="https://theirs.invalid">theirs</a></blockquote>',
    })
    const shown = previewFor(message, 'send_reply')
    const table = shown.split('<h2>Every address in it')[1] ?? ''
    expect(table).toContain('https://mine.invalid')
    expect(table).not.toContain('https://theirs.invalid')
  })

  it('renders your part and the quote together, as the recipient gets them', () => {
    // The opposite of what the confirmation does, and both are right for where
    // they are: the question asks about the part somebody wrote, the page
    // answers what arrives.
    const message = withHtml('<p>My answer.</p>', {
      quotedHtml: '<blockquote>Their words</blockquote>',
    })
    const shown = previewFor(message, 'send_reply')
    expect(shown).toContain('My answer.')
    expect(shown).toContain('Their words')
  })

  it('is covered by the digest, because it is part of what goes out', () => {
    const one = withHtml('<p>x</p>', { quotedHtml: '<blockquote>first</blockquote>' })
    const two = withHtml('<p>x</p>', { quotedHtml: '<blockquote>second</blockquote>' })
    expect(digestOf(two)).not.toBe(digestOf(one))
  })
})
