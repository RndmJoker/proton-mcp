/**
 * Which markup a message may contain, and what has to be shown before it is sent.
 *
 * ## The measurement this is built on
 *
 * The obvious worry about formatted mail is CSS that hides text, and it is the
 * wrong worry. Measured on 31.07.2026 against this server's own conversion:
 * `display:none`, `font-size:0` and white-on-white all appear in the text
 * preview, because the conversion reads the markup and does not apply styling.
 * The preview therefore shows *more* than the recipient will see, which is the
 * harmless direction: a person confirming reads everything.
 *
 * What is dangerous is the other direction, where the preview shows **less**
 * than the recipient reads, and the same measurement found it:
 *
 * | Written | In the preview | What the recipient sees |
 * | :--- | :--- | :--- |
 * | `<img src="..." alt="TEXT">` | **nothing** | the alt text, because clients block remote images by default |
 * | `<span title="TEXT">` | nothing | the title on hover |
 * | `<style>p::before{content:"TEXT"}</style>` | nothing | generated text, in clients that keep style blocks |
 * | `<noscript>`, `<textarea>` | the text | nothing, or something else |
 *
 * The first row is a working way past the confirmation. An assistant that has
 * read a stranger's message could compose an image whose alt text carries the
 * request, and the person confirming would see an empty message. Remote images
 * are blocked by default in Proton and elsewhere, so the alt text is not a
 * fallback, it is what actually arrives.
 *
 * Two conclusions, and they shape everything below:
 *
 * 1. **A list of what is permitted, not a filter for what is not.** `<style>`,
 *    `<script>`, `<noscript>`, `<textarea>` and `<head>` are absent from the
 *    list, so they are refused without anyone having had to think of them. That
 *    is the whole argument for a positive list: what nobody anticipated does not
 *    get through.
 * 2. **Every piece of text a recipient can read is put in front of the person
 *    confirming**, including the ones the preview drops: alt text, titles, and
 *    every address behind a link or an image.
 *
 * The hiding properties are refused as well. Not because they defeat the
 * preview, measured they do not, but because they let a message be delivered
 * looking different from how it was written, and nothing is lost by saying no.
 */

import { Parser } from 'htmlparser2'
import { BridgeError } from '../bridge/errors.js'

/**
 * The elements a message may use.
 *
 * Absent by design and worth naming, because the reason is the measurement
 * above rather than taste: `style`, `script`, `noscript`, `textarea`, `head`,
 * `title`, `meta`, `link`, `iframe`, `object`, `form`, `input`, `button`.
 */
export const PERMITTED_TAGS = new Set([
  'html', 'body',
  'h1', 'h2', 'h3', 'h4', 'p', 'br', 'hr', 'blockquote', 'div', 'span',
  'b', 'strong', 'i', 'em', 'u', 's', 'code', 'pre', 'small', 'sub', 'sup',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption',
  'a', 'img',
])

/** Attributes each element may carry, on top of the ones allowed everywhere. */
const PERMITTED_ATTRIBUTES: Record<string, string[]> = {
  '*': ['style', 'title', 'dir', 'lang'],
  a: ['href', 'target', 'rel'],
  img: ['src', 'alt', 'width', 'height'],
  table: ['width', 'border', 'cellpadding', 'cellspacing', 'align'],
  td: ['colspan', 'rowspan', 'align', 'valign', 'width'],
  th: ['colspan', 'rowspan', 'align', 'valign', 'width'],
  tr: ['align', 'valign'],
  ol: ['start', 'type'],
  blockquote: ['cite'],
}

/** Style properties a message may set. */
export const PERMITTED_STYLES = new Set([
  'color', 'background', 'background-color',
  'font', 'font-family', 'font-size', 'font-style', 'font-weight', 'font-variant',
  'text-align', 'text-decoration', 'text-transform', 'line-height', 'letter-spacing',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
  'border-color', 'border-style', 'border-width', 'border-radius', 'border-collapse',
  'width', 'height', 'max-width', 'vertical-align', 'white-space', 'list-style',
])

/**
 * Properties that take a message out of sight without taking it out of the
 * message. Refused whatever else is written.
 */
const HIDING_STYLES = new Set([
  'display', 'visibility', 'opacity', 'position', 'z-index', 'overflow',
  'clip', 'clip-path', 'transform', 'text-indent', 'float', 'content',
  'max-height', 'min-height', 'mix-blend-mode', 'filter',
])

/** Properties whose value must be a positive size. Zero is a way of hiding. */
const MUST_BE_POSITIVE = new Set(['font-size', 'line-height', 'width', 'height', 'max-width'])

/** A scheme in an href or src. Anything else is refused. */
const PERMITTED_SCHEMES = ['http:', 'https:', 'mailto:', 'cid:']

/** One reason a message was refused. */
export interface MarkupProblem {
  /** What was found, in the caller's own markup. */
  found: string
  /** Why it cannot be sent, and what to do instead. */
  reason: string
}

/** An address the message points at, which a person has to see before sending. */
export interface MarkupUrl {
  kind: 'link' | 'image'
  url: string
  /** The text a reader sees for a link, or the alt text of an image. */
  label: string
}

export interface MarkupReading {
  problems: MarkupProblem[]
  urls: MarkupUrl[]
  /** Text a recipient can read that the text preview leaves out. */
  hiddenText: string[]
  /** Content ids an image refers to, which have to be provided as parts. */
  contentIds: string[]
}

function styleProblems(tag: string, style: string): MarkupProblem[] {
  const problems: MarkupProblem[] = []
  for (const declaration of style.split(';')) {
    const [rawName, ...rest] = declaration.split(':')
    const name = (rawName ?? '').trim().toLowerCase()
    const value = rest.join(':').trim()
    if (!name) continue

    if (HIDING_STYLES.has(name)) {
      problems.push({
        found: `style "${name}" on <${tag}>`,
        reason:
          `"${name}" can put text out of sight while leaving it in the message, so a recipient ` +
          'and the person who confirmed the send would not read the same thing. Style the message ' +
          'with colour, font and spacing instead.',
      })
      continue
    }
    if (!PERMITTED_STYLES.has(name)) {
      problems.push({
        found: `style "${name}" on <${tag}>`,
        reason:
          `"${name}" is not among the properties this server sends. Permitted are colour, ` +
          'background, font, alignment, spacing, borders and size.',
      })
      continue
    }
    if (MUST_BE_POSITIVE.has(name) && /^0(\D|$)|^-/.test(value)) {
      problems.push({
        found: `style "${name}: ${value}" on <${tag}>`,
        reason:
          `A "${name}" of zero or less makes text unreadable without removing it, which is the ` +
          'same as hiding it. Give it a real size or leave it out.',
      })
    }
  }
  return problems
}

function urlProblem(tag: string, attribute: string, value: string): MarkupProblem | undefined {
  const trimmed = value.trim()
  // A relative address has no meaning in a message: there is no page it is
  // relative to, so it would simply be broken wherever it arrived.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return {
      found: `${attribute}="${trimmed}" on <${tag}>`,
      reason:
        'An address in a message has to be complete. A relative one has nothing to be relative ' +
        'to once the message has been delivered. Write the whole address, including https://.',
    }
  }
  const scheme = trimmed.slice(0, trimmed.indexOf(':') + 1).toLowerCase()
  if (!PERMITTED_SCHEMES.includes(scheme)) {
    return {
      found: `${attribute}="${trimmed.slice(0, 40)}" on <${tag}>`,
      reason:
        `"${scheme}" is not an address this server puts in a message. Permitted are ` +
        `${PERMITTED_SCHEMES.join(', ')}. A "data:" address in particular would carry a whole ` +
        'file inside the markup, where nothing lists it as an attachment.',
    }
  }
  return undefined
}

/**
 * Reads a message's markup: what is wrong with it, and what has to be shown.
 *
 * One pass, because the two questions are the same walk over the document and
 * answering them separately is how they drift apart.
 */
export function readMarkup(html: string): MarkupReading {
  const problems: MarkupProblem[] = []
  const urls: MarkupUrl[] = []
  const hiddenText: string[] = []
  const contentIds: string[] = []

  // A link's text arrives as separate events between its tags, so it is
  // collected while the link is open.
  let openLink: { url: string; text: string } | undefined

  const parser = new Parser(
    {
      onopentag(name, attributes) {
        const tag = name.toLowerCase()
        if (!PERMITTED_TAGS.has(tag)) {
          problems.push({
            found: `<${tag}>`,
            reason:
              `<${tag}> is not among the elements this server sends. Permitted are headings, ` +
              'paragraphs, line breaks, rules, quotes, emphasis, lists, tables, links and images.',
          })
          return
        }

        const allowed = [...(PERMITTED_ATTRIBUTES['*'] ?? []), ...(PERMITTED_ATTRIBUTES[tag] ?? [])]
        for (const [rawAttribute, value] of Object.entries(attributes)) {
          const attribute = rawAttribute.toLowerCase()
          if (!allowed.includes(attribute)) {
            problems.push({
              found: `${attribute}="${String(value).slice(0, 30)}" on <${tag}>`,
              reason:
                attribute.startsWith('on')
                  ? 'An event handler has no place in a message. No mail client runs it, and ' +
                    'what it contains would never be seen by anyone confirming the send.'
                  : `<${tag}> may not carry "${attribute}" here.`,
            })
            continue
          }
          if (attribute === 'style') problems.push(...styleProblems(tag, String(value)))
          if (attribute === 'href' || attribute === 'src') {
            const problem = urlProblem(tag, attribute, String(value))
            if (problem) problems.push(problem)
          }
          // A title is read on hover and never appears in the text preview.
          if (attribute === 'title' && String(value).trim()) {
            hiddenText.push(`title of <${tag}>: ${String(value).trim()}`)
          }
        }

        if (tag === 'a' && typeof attributes.href === 'string') {
          openLink = { url: attributes.href.trim(), text: '' }
        }
        if (tag === 'img' && typeof attributes.src === 'string') {
          const src = attributes.src.trim()
          const alt = typeof attributes.alt === 'string' ? attributes.alt.trim() : ''
          urls.push({ kind: 'image', url: src, label: alt })
          if (src.toLowerCase().startsWith('cid:')) contentIds.push(src.slice(4))
          // The measurement that made this file necessary: an alt text is what
          // the recipient reads whenever the image is not loaded, and clients
          // do not load remote images by default. It is absent from the preview.
          if (alt) hiddenText.push(`alt text of an image: ${alt}`)
        }
      },
      ontext(text) {
        if (openLink) openLink.text += text
      },
      onclosetag(name) {
        if (name.toLowerCase() === 'a' && openLink) {
          urls.push({ kind: 'link', url: openLink.url, label: openLink.text.trim() })
          openLink = undefined
        }
      },
      oncomment() {
        // Dropped by every reader and by the preview alike, so it hides nothing
        // and is not worth refusing over.
      },
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true },
  )

  parser.write(html)
  parser.end()

  if (openLink) urls.push({ kind: 'link', url: openLink.url, label: openLink.text.trim() })

  return { problems, urls, hiddenText, contentIds }
}

/**
 * Refuses markup this server will not send.
 *
 * Refused rather than repaired, deliberately. Stripping what is not permitted
 * would mean the message that goes out is not the message that was written, and
 * nobody would find out: not the caller, whose formatting quietly vanishes, and
 * not the person confirming, who has nothing to compare against.
 */
export function assertSendableMarkup(html: string): MarkupReading {
  const reading = readMarkup(html)
  if (reading.problems.length === 0) return reading

  const listed = reading.problems
    .slice(0, 8)
    .map((p) => `  - ${p.found}\n    ${p.reason}`)
    .join('\n')
  const more =
    reading.problems.length > 8 ? `\n  ...and ${reading.problems.length - 8} more.` : ''

  throw new BridgeError(
    `This markup cannot be sent, so nothing was written or sent.\n\n${listed}${more}\n\n` +
      'Markup is refused rather than cleaned up: a message that was quietly altered is no longer ' +
      'the message anyone agreed to.',
  )
}
