import { describe, it, expect } from 'vitest'
import { readMarkup, assertSendableMarkup, PERMITTED_TAGS } from '../../src/mail/markup.js'
import { BridgeError } from '../../src/bridge/errors.js'
import { htmlToText } from '../../src/mime/parse.js'

/**
 * A list of what is permitted only works if the things it leaves out really do
 * not get through, so most of this file is the refusals.
 *
 * The ordering worth keeping in mind while reading: what makes a message
 * dangerous is not text the recipient cannot see. It is text the recipient CAN
 * see that never reached the person confirming the send. Measured against this
 * server's own conversion, CSS hiding fails at that, and an image's alt text
 * succeeds at it. So the tests that matter most are the ones about alt text,
 * titles and style blocks.
 */

const problems = (html: string): string[] => readMarkup(html).problems.map((p) => p.found)

describe('what the text preview leaves out', () => {
  it('surfaces an image alt text, which the preview does not', () => {
    // The one that made this module necessary. Clients block remote images by
    // default, so the alt text is not a fallback, it is what arrives. The
    // preview shows nothing at all for it.
    const alt = 'Please transfer 500 euros'
    expect(htmlToText(`<img src="https://example.invalid/x.png" alt="${alt}">`)).not.toContain(alt)

    const reading = readMarkup(`<img src="https://example.invalid/x.png" alt="${alt}">`)
    expect(reading.hiddenText.join(' ')).toContain(alt)
    expect(reading.problems).toEqual([])
  })

  it('surfaces a title attribute, which the preview also drops', () => {
    expect(htmlToText('<span title="read on hover">visible</span>')).not.toContain('read on hover')
    expect(readMarkup('<span title="read on hover">x</span>').hiddenText.join(' ')).toContain(
      'read on hover',
    )
  })

  it('refuses the elements whose content the preview and a client disagree about', () => {
    // None of these are special-cased. They are simply not on the list, which
    // is the whole argument for a list of what is allowed.
    for (const tag of ['style', 'script', 'noscript', 'textarea', 'head', 'iframe', 'form']) {
      expect(problems(`<${tag}>x</${tag}>`)).toContain(`<${tag}>`)
    }
  })

  it('leaves comments alone, because nothing renders them either', () => {
    expect(readMarkup('<p>x</p><!-- a note -->').problems).toEqual([])
  })
})

describe('links and images have to be visible before they are sent', () => {
  it('reports a link with its text and its target apart', () => {
    // The shape of every phishing message: one string read, another followed.
    const reading = readMarkup('<a href="https://elsewhere.invalid/pay">our invoice portal</a>')
    expect(reading.urls).toEqual([
      { kind: 'link', url: 'https://elsewhere.invalid/pay', label: 'our invoice portal' },
    ])
  })

  it('reports every image with its address and its alt text', () => {
    const reading = readMarkup(
      '<img src="cid:logo@x" alt="a logo"><img src="https://example.invalid/p.gif" alt="">',
    )
    expect(reading.urls).toEqual([
      { kind: 'image', url: 'cid:logo@x', label: 'a logo' },
      { kind: 'image', url: 'https://example.invalid/p.gif', label: '' },
    ])
    expect(reading.contentIds).toEqual(['logo@x'])
  })

  it('allows an image from a URL without complaint', () => {
    // Decided: the boundary is that no address is hidden, not that remote
    // images are forbidden. Sending the same message repeatedly should not put
    // a copy of the image in every recipient's mailbox.
    expect(readMarkup('<img src="https://example.invalid/x.png">').problems).toEqual([])
  })

  it('refuses an address that is not complete', () => {
    expect(problems('<a href="/pfad">x</a>')).toHaveLength(1)
    expect(problems('<img src="bild.png">')).toHaveLength(1)
  })

  it('refuses a scheme that would carry a file inside the markup', () => {
    // A data: address is an attachment that nothing lists as an attachment.
    expect(problems('<img src="data:image/png;base64,iVBORw0KGgo=">')).toHaveLength(1)
    expect(problems('<a href="javascript:alert(1)">x</a>')).toHaveLength(1)
    expect(problems('<a href="file:///etc/passwd">x</a>')).toHaveLength(1)
  })

  it('allows the schemes a message really uses', () => {
    for (const url of ['https://example.invalid/a', 'http://example.invalid/a', 'mailto:a@b.invalid']) {
      expect(readMarkup(`<a href="${url}">x</a>`).problems).toEqual([])
    }
  })
})

describe('styling', () => {
  it('allows what makes a message look like something', () => {
    const html =
      '<p style="color:#336699; background-color:#fff; font-family:sans-serif; font-size:14px; ' +
      'font-weight:bold; text-align:center; padding:8px; border:1px solid #ccc">x</p>'
    expect(readMarkup(html).problems).toEqual([])
  })

  it('refuses the properties that take text out of sight', () => {
    for (const style of [
      'display:none',
      'visibility:hidden',
      'opacity:0',
      'position:absolute',
      'text-indent:-9999px',
      'overflow:hidden',
      'max-height:0',
    ]) {
      expect(problems(`<div style="${style}">x</div>`)).toHaveLength(1)
    }
  })

  it('refuses a size of zero, which hides without a hiding property', () => {
    for (const style of ['font-size:0', 'font-size:0px', 'line-height:0', 'width:0', 'height:-5px']) {
      expect(problems(`<span style="${style}">x</span>`)).toHaveLength(1)
    }
  })

  it('allows a real size', () => {
    expect(readMarkup('<span style="font-size:14px; line-height:1.4; width:100px">x</span>').problems)
      .toEqual([])
  })

  it('refuses a property nobody listed', () => {
    expect(problems('<p style="animation:blink 1s infinite">x</p>')).toHaveLength(1)
  })
})

describe('attributes', () => {
  it('refuses an event handler', () => {
    const reading = readMarkup('<p onclick="doSomething()">x</p>')
    expect(reading.problems).toHaveLength(1)
    expect(reading.problems[0]?.reason).toMatch(/event handler/)
  })

  it('refuses an attribute an element may not carry', () => {
    expect(problems('<p href="https://example.invalid">x</p>')).toHaveLength(1)
    expect(problems('<div src="https://example.invalid/x.png">y</div>')).toHaveLength(1)
  })

  it('allows what a table and a link really need', () => {
    const html =
      '<table width="600" border="1"><tr><td colspan="2" align="left">x</td></tr></table>' +
      '<a href="https://example.invalid" target="_blank" rel="noreferrer">y</a>'
    expect(readMarkup(html).problems).toEqual([])
  })
})

describe('assertSendableMarkup', () => {
  it('lets an ordinary formatted message through', () => {
    const html =
      '<html><body><h1>Report</h1><p><b>Bold</b> and <a href="https://example.invalid">a link</a>.</p>' +
      '<ul><li>One</li><li>Two</li></ul><img src="cid:chart@x" alt="a chart"></body></html>'
    const reading = assertSendableMarkup(html)
    expect(reading.urls).toHaveLength(2)
    expect(reading.contentIds).toEqual(['chart@x'])
  })

  it('refuses rather than repairs, and says what and why', () => {
    try {
      assertSendableMarkup('<p>fine</p><script>bad()</script>')
      throw new Error('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(BridgeError)
      const text = (error as Error).message
      expect(text).toContain('<script>')
      expect(text).toContain('rather than cleaned up')
    }
  })

  it('reports several problems at once instead of one per attempt', () => {
    const message = (() => {
      try {
        assertSendableMarkup('<script>a</script><p style="display:none" onclick="b()">c</p>')
        return ''
      } catch (error) {
        return (error as Error).message
      }
    })()
    expect(message).toContain('<script>')
    expect(message).toContain('display')
    expect(message).toContain('onclick')
  })
})

describe('the list itself', () => {
  it('leaves out the elements that must not be in it', () => {
    for (const tag of ['style', 'script', 'noscript', 'textarea', 'head', 'title', 'meta', 'link',
      'iframe', 'object', 'embed', 'form', 'input', 'button', 'base', 'svg']) {
      expect(PERMITTED_TAGS.has(tag)).toBe(false)
    }
  })

  it('contains what a formatted message is actually made of', () => {
    for (const tag of ['h1', 'p', 'br', 'b', 'i', 'ul', 'li', 'table', 'tr', 'td', 'a', 'img']) {
      expect(PERMITTED_TAGS.has(tag)).toBe(true)
    }
  })
})
