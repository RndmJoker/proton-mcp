import { describe, it, expect } from 'vitest'
import { prepareQuotedMarkup } from '../../src/mail/quote.js'

/**
 * Quoting a message with its formatting intact.
 *
 * Two things have to be true at once and they pull against each other. The
 * quote must look like the original, or replying to formatted mail is a
 * downgrade; and nothing in it may reach out and change the reply written above
 * it, or a sender no longer controls how their own words appear.
 *
 * The line between the two is narrow and measured rather than chosen: only
 * document-level elements are dropped. Everything else survives character for
 * character.
 */

describe('what survives', () => {
  it('keeps inline styles, colours and structure exactly as written', () => {
    const html =
      '<table width="600" style="background-color:#003366"><tr>' +
      '<td style="padding:24px; font-family:Georgia,serif"><b>Bold</b> and <i>italic</i></td>' +
      '</tr></table>'
    expect(prepareQuotedMarkup(html).html).toBe(html)
  })

  it('keeps attributes this server would never write itself', () => {
    // A quote is not something we are composing, so the permitted set for our
    // own markup does not apply to it. class and role are the two most common
    // things in real mail, and stripping them would change the layout.
    const html = '<div class="wrapper" role="presentation" data-block-id="7">x</div>'
    expect(prepareQuotedMarkup(html).html).toBe(html)
  })

  it('keeps images, links and their addresses untouched', () => {
    const html =
      '<a href="https://example.invalid/x" style="color:#c00">click</a>' +
      '<img src="https://example.invalid/p.png" alt="a picture" width="40">'
    expect(prepareQuotedMarkup(html).html).toBe(html)
  })

  it('changes nothing at all when there is nothing to remove', () => {
    const html = '<p>Just a paragraph with an &amp; entity and a &lt;bracket&gt;.</p>'
    const prepared = prepareQuotedMarkup(html)
    expect(prepared.html).toBe(html)
    expect(prepared.removed).toEqual([])
  })
})

describe('what is removed, and only that', () => {
  it('drops a style block, because it would restyle the reply above it', () => {
    // Measured on a real mailbox: 66 percent of formatted mail carries one,
    // and 56 percent of those aim at bare elements such as p, body, a and
    // blockquote. More than half of all replies would have their own text
    // restyled by the message they answer.
    const prepared = prepareQuotedMarkup(
      '<style>p{display:none}</style><p style="color:red">visible</p>',
    )
    expect(prepared.html).toBe('<p style="color:red">visible</p>')
    expect(prepared.removed).toEqual(['<style>'])
  })

  it('drops the head with everything in it', () => {
    const prepared = prepareQuotedMarkup(
      '<html><head><meta charset="utf-8"><title>T</title><style>a{}</style></head>' +
        '<body><p>kept</p></body></html>',
    )
    expect(prepared.html).toBe('<p>kept</p>')
    expect(prepared.removed).toContain('<head>')
  })

  it('drops the document-level elements that have content', () => {
    for (const tag of ['script', 'noscript', 'title']) {
      const prepared = prepareQuotedMarkup(`<${tag}>gone</${tag}><p>kept</p>`)
      expect(prepared.html).toBe('<p>kept</p>')
      expect(prepared.removed).toEqual([`<${tag}>`])
    }
  })

  it('drops the ones that are a tag and nothing else', () => {
    // meta, link and base carry no content: whatever follows them is not
    // inside them, so only the tag itself goes.
    for (const tag of ['meta', 'link', 'base']) {
      const prepared = prepareQuotedMarkup(`<${tag} href="x"><p>kept</p>`)
      expect(prepared.html).toBe('<p>kept</p>')
      expect(prepared.removed).toEqual([`<${tag}>`])
    }
  })

  it('unwraps html and body without touching what is inside them', () => {
    const prepared = prepareQuotedMarkup('<html><body><p>x</p><div>y</div></body></html>')
    expect(prepared.html).toBe('<p>x</p><div>y</div>')
  })

  it('drops a style block that was never closed', () => {
    // A truncated message is a real thing, and an unclosed style block would
    // otherwise take the rest of the quote with it into the reply.
    const prepared = prepareQuotedMarkup('<p>before</p><style>body{display:none}')
    expect(prepared.html).toBe('<p>before</p>')
    expect(prepared.removed).toEqual(['<style>'])
  })

  it('drops nested occurrences without losing what follows', () => {
    const prepared = prepareQuotedMarkup(
      '<div><style>a{}</style><p>one</p></div><style>b{}</style><p>two</p>',
    )
    expect(prepared.html).toBe('<div><p>one</p></div><p>two</p>')
  })
})

describe('the rules that would escape a quote', () => {
  it('leaves nothing behind that targets an element by name', () => {
    // The property being tested is the point of the module: after preparation
    // there is no stylesheet left, so no rule can apply outside the quote.
    const hostile =
      '<style>body{background:#000} p{display:none} blockquote{visibility:hidden}</style>' +
      '<p>the original text</p>'
    const prepared = prepareQuotedMarkup(hostile)
    expect(prepared.html).not.toContain('display:none')
    expect(prepared.html).not.toContain('<style')
    expect(prepared.html).toContain('the original text')
  })

  it('keeps a style attribute, which cannot reach past its own element', () => {
    // The distinction the whole module rests on: an attribute styles one
    // element, a block styles a document.
    const html = '<p style="display:none">only this paragraph</p>'
    expect(prepareQuotedMarkup(html).html).toBe(html)
  })
})

describe('embedded images', () => {
  it('reports the content ids a quote still needs', () => {
    const prepared = prepareQuotedMarkup('<img src="cid:logo@firma"><img src="cid:chart@firma">')
    expect(prepared.contentIds).toEqual(['logo@firma', 'chart@firma'])
  })

  it('reports none for ordinary addresses, which is the usual case', () => {
    // Measured: none of the 687 images in a real sample used a content id.
    expect(prepareQuotedMarkup('<img src="https://example.invalid/p.png">').contentIds).toEqual([])
  })
})

describe('conditional comments, which a parser reads and a client executes', () => {
  it('drops a style block hidden inside an Outlook conditional', () => {
    // Found in a real mailbox rather than in this file. htmlparser2 sees the
    // whole thing as a comment, so nothing fired for the style inside it, and
    // the raw text survived into the quote. Outlook acts on it.
    const prepared = prepareQuotedMarkup(
      '<!--[if mso]><style>p{display:none}</style><![endif]--><p>kept</p>',
    )
    expect(prepared.html).not.toContain('<style')
    expect(prepared.html).not.toContain('display:none')
    expect(prepared.html).toContain('kept')
  })

  it('drops the downlevel-revealed form as well', () => {
    const prepared = prepareQuotedMarkup(
      '<!--[if gte mso 9]><noscript>hidden</noscript><![endif]--><p>kept</p>',
    )
    expect(prepared.html).not.toContain('<noscript')
    expect(prepared.html).toBe('<p>kept</p>')
  })

  it('drops an ordinary comment too, which costs nothing', () => {
    expect(prepareQuotedMarkup('<p>a</p><!-- a note --><p>b</p>').html).toBe('<p>a</p><p>b</p>')
  })
})
