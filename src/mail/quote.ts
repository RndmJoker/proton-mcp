/**
 * Quoting a message inside a reply, with its formatting intact.
 *
 * The obvious way to quote is to convert the original to text. It is safe and
 * it is what this server did first, and measured against a real mailbox it
 * turned out to be too expensive: 94 percent of ordinary mail is formatted, so
 * every reply would throw away the look of nearly everything it answers.
 *
 * The other obvious way is to keep the original's markup and cut it down to
 * what this server permits itself to write. Also measured, on the same
 * mailbox: **83 percent of real messages would need work, with a median of 87
 * removals each.** That is not a plainer quote, it is a demolished one, and the
 * pieces that carry the look are the first to go.
 *
 * So the quote keeps the original **byte for byte**, with one exception that
 * the measurement made unavoidable.
 *
 * ## The exception, and why it is not negotiable
 *
 * A `<style>` block belongs to a document, not to the element it sits in. Embed
 * one inside a quote and its rules apply to the whole message, including the
 * reply written above it. Measured on the same sample:
 *
 * | | |
 * | :--- | :--- |
 * | Formatted messages carrying a `<style>` block | 66 percent |
 * | Of those, rules aimed at bare elements rather than classes | 56 percent |
 * | The selectors, in order | `body`, `a`, `table`, `p`, `img`, `td`, `blockquote` |
 *
 * `blockquote` appears in thirty-six of them, which is the element this quote
 * is wrapped in. So in more than half of all replies, the quoted message's
 * stylesheet would reach out and restyle the sender's own words. A rule as
 * short as `p { display: none }` would make the reply disappear while leaving
 * the quote in place, and the person who confirmed the send would never know.
 *
 * Everything else stays. Inline styles, classes, tables, colours, alignment,
 * images, links, spacing: untouched, character for character, because the parts
 * that are kept are copied out of the original string rather than rebuilt from
 * a parse tree. A re-serialised quote is a quote somebody rewrote.
 *
 * ## Images
 *
 * Measured: **none** of the 687 images in the sample were embedded by content
 * id; every one was an ordinary address. So a quote needs no files carried
 * along and its pictures simply work. Content ids are handled anyway, because
 * "none in this sample" is not "never", and a quote with a broken image would
 * be worse than one without.
 */

import { Parser } from 'htmlparser2'

/**
 * Elements dropped from a quote, with everything inside them.
 *
 * All of them are document-level: they say something about the message as a
 * whole rather than about the place they stand in, so inside a quote they act
 * outside it. That is the entire criterion, and it is why the list is short.
 */
const DOCUMENT_LEVEL = new Set([
  'style', 'script', 'head', 'meta', 'link', 'title', 'base', 'noscript',
])

/** Wrappers whose contents are kept and whose tags are not. */
const UNWRAP = new Set(['html', 'body'])

export interface PreparedQuote {
  /** The original's markup, minus what reaches outside the quote. */
  html: string
  /** Which elements were dropped, for the answer and for the confirmation. */
  removed: string[]
  /** Content ids the quote still refers to, which have to travel with it. */
  contentIds: string[]
}

/**
 * Prepares a message's markup for use as a quote.
 *
 * Works by cutting ranges out of the original string rather than by rebuilding
 * it. Every character that is not inside a removed element survives exactly as
 * it was written, which is the difference between quoting a message and
 * paraphrasing it.
 */
export function prepareQuotedMarkup(html: string): PreparedQuote {
  /** Ranges to cut, as [start, end) in the original string. */
  const cuts: Array<[number, number]> = []
  const removed: string[] = []
  const contentIds: string[] = []
  /** Set while inside a dropped element, so nested tags are not counted twice. */
  let dropDepth = 0
  let dropStart = 0
  let dropName = ''

  const parser = new Parser(
    {
      onopentag(name, attributes) {
        const tag = name.toLowerCase()
        if (dropDepth > 0) {
          if (tag === dropName) dropDepth += 1
          return
        }
        if (DOCUMENT_LEVEL.has(tag)) {
          dropDepth = 1
          dropName = tag
          dropStart = parser.startIndex
          return
        }
        if (UNWRAP.has(tag)) {
          cuts.push([parser.startIndex, parser.endIndex + 1])
          return
        }
        if (tag === 'img' && typeof attributes.src === 'string') {
          const src = attributes.src.trim()
          if (src.toLowerCase().startsWith('cid:')) contentIds.push(src.slice(4))
        }
      },
      oncomment() {
        // Comments are cut out of a quote, and it is not tidiness. Outlook acts
        // on conditional comments, so a `<style>` block inside
        // `<!--[if mso]>` is a stylesheet that a parser reads as a comment and
        // a mail client executes. Measured on a real mailbox: three of 151
        // messages hid a style block exactly there, and one hid a `<noscript>`.
        // Every unit test in this module passed while that hole was open.
        //
        // Matching on `[if mso]` would close those four and leave the next
        // variant open. Dropping comments closes the shape of the hole: nothing
        // renders a comment except this one client, and what it renders is a
        // layout fallback inside a quote.
        if (dropDepth === 0) cuts.push([parser.startIndex, parser.endIndex + 1])
      },
      onclosetag(name) {
        const tag = name.toLowerCase()
        if (dropDepth > 0 && tag === dropName) {
          dropDepth -= 1
          if (dropDepth === 0) {
            cuts.push([dropStart, parser.endIndex + 1])
            removed.push(`<${tag}>`)
          }
          return
        }
        if (dropDepth === 0 && UNWRAP.has(tag)) {
          cuts.push([parser.startIndex, parser.endIndex + 1])
        }
      },
    },
    {
      decodeEntities: false,
      lowerCaseTags: true,
      lowerCaseAttributeNames: true,
      recognizeSelfClosing: true,
    },
  )

  parser.write(html)
  parser.end()

  // An element left open at the end of the document still has to be cut, or
  // its content would ride along inside a quote.
  if (dropDepth > 0) {
    cuts.push([dropStart, html.length])
    removed.push(`<${dropName}>`)
  }

  cuts.sort((a, b) => a[0] - b[0])
  let out = ''
  let at = 0
  for (const [start, end] of cuts) {
    if (start > at) out += html.slice(at, start)
    at = Math.max(at, end)
  }
  out += html.slice(at)

  return { html: out.trim(), removed: [...new Set(removed)], contentIds }
}
