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
  // height sits beside width rather than being an omission with a reason. A
  // table cell of a given height hides nothing: its content still renders, and
  // the properties that do hide are refused as styles further down.
  table: ['width', 'height', 'border', 'cellpadding', 'cellspacing', 'align'],
  td: ['colspan', 'rowspan', 'align', 'valign', 'width', 'height'],
  th: ['colspan', 'rowspan', 'align', 'valign', 'width', 'height'],
  tr: ['align', 'valign', 'height'],
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
 * Properties that can take content out of sight without taking it out of the
 * message.
 *
 * These used to be refused outright. That was too blunt in both directions.
 * `display: inline-block` is what makes a link fill its own padding, which is
 * what makes a button clickable, and it hides nothing; `float` is ordinary
 * layout that mail has used for twenty years. Refusing the property rather than
 * the value cost every message a usable button and bought nothing, because a
 * confirmation that reads markup without applying it showed the hidden text
 * anyway.
 *
 * What changed is that the preview now renders. Text hidden by CSS really does
 * disappear from it, so the answer is no longer to refuse the property but to
 * say plainly that it was used, where, and how often, and to let the person
 * decide.
 */
export const RISKY_STYLES = new Set([
  'display', 'visibility', 'opacity', 'position', 'z-index', 'overflow',
  'clip', 'clip-path', 'transform', 'text-indent', 'content',
  'max-height', 'min-height', 'mix-blend-mode', 'filter',
])

/** Values of those properties that actually take something out of sight. */
function hidesContent(name: string, value: string): boolean {
  const v = value.trim().toLowerCase()
  switch (name) {
    case 'display':
      return v === 'none'
    case 'visibility':
      return v === 'hidden' || v === 'collapse'
    case 'opacity':
      return Number.parseFloat(v) < 0.1
    case 'max-height':
    case 'min-height':
      return /^0(\D|$)/.test(v)
    case 'text-indent':
      return v.startsWith('-')
    case 'position':
      return v === 'absolute' || v === 'fixed'
    case 'overflow':
      return v === 'hidden'
    case 'filter':
      return /opacity\s*\(\s*0?(\.0*[0-9])?\s*\)/.test(v)
    default:
      // clip, clip-path, transform, z-index, content, mix-blend-mode: whether
      // they hide anything depends on values this server has no business
      // interpreting. Treated as worth mentioning rather than as proven.
      return false
  }
}

/** Properties whose value being zero or less takes content out of sight. */
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

/**
 * How much markup a message may carry.
 *
 * Chosen per call by whoever is composing, with `standard` as the default that
 * applies when nobody says otherwise. The point of naming them rather than
 * listing properties is that a caller has to decide something it can explain,
 * and that the answer travels into the confirmation where a person sees it.
 */
export type MarkupLevel =
  /**
   * Colour, font, spacing, borders, size, alignment. Everything an ordinary
   * formatted message uses, and nothing that can put text out of sight.
   * Anything else is refused with a reason.
   */
  | 'standard'
  /**
   * Every CSS property, including the ones that can hide content. Nothing is
   * refused for being a style; what is used is reported instead, and the
   * confirmation says so in as many words.
   */
  | 'extended'

/** One use of a property worth telling the person about before they agree. */
export interface StyleNote {
  property: string
  value: string
  /** The element it sat on, so the preview can say where. */
  element: string
  /** True when this value really does take something out of sight. */
  hides: boolean
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
  /**
   * Properties used that are worth telling the person about.
   *
   * Empty for a message that stays inside the ordinary set, which is almost
   * every message. Anything in here means the confirmation says so and the
   * preview lists it.
   */
  styleNotes: StyleNote[]
}

/**
 * Reads one style attribute.
 *
 * At `standard` a property outside the ordinary set is refused with a reason,
 * which is what it always did. At `extended` nothing is refused for being a
 * style; every property outside that set is written down instead, together with
 * whether its value really takes something out of sight.
 *
 * The distinction between "unusual" and "hides something" is the whole point.
 * `display: inline-block` is a button; `display: none` is a disappearance. One
 * property, two very different things to tell somebody.
 */
function readStyle(
  tag: string,
  style: string,
  level: MarkupLevel,
): { problems: MarkupProblem[]; notes: StyleNote[] } {
  const problems: MarkupProblem[] = []
  const notes: StyleNote[] = []

  for (const declaration of style.split(';')) {
    const [rawName, ...rest] = declaration.split(':')
    const name = (rawName ?? '').trim().toLowerCase()
    const value = rest.join(':').trim()
    if (!name) continue

    const ordinary =
      PERMITTED_STYLES.has(name) && !(MUST_BE_POSITIVE.has(name) && /^0(\D|$)|^-/.test(value))
    if (ordinary) continue

    if (level === 'extended') {
      notes.push({
        property: name,
        value,
        element: tag,
        hides:
          hidesContent(name, value) ||
          (MUST_BE_POSITIVE.has(name) && /^0(\D|$)|^-/.test(value)),
      })
      continue
    }

    if (RISKY_STYLES.has(name)) {
      problems.push({
        found: `style "${name}" on <${tag}>`,
        reason:
          `"${name}" can put text out of sight while leaving it in the message. It is available ` +
          'with markup level "extended", which shows the person confirming exactly what was used ' +
          'and where. Use it only when there is no other way.',
      })
      continue
    }
    if (!PERMITTED_STYLES.has(name)) {
      problems.push({
        found: `style "${name}" on <${tag}>`,
        reason:
          `"${name}" is not among the properties sent at markup level "standard". Permitted are ` +
          'colour, background, font, alignment, spacing, borders and size. Everything else is ' +
          'available at level "extended", which tells the person confirming what was used.',
      })
      continue
    }
    problems.push({
      found: `style "${name}: ${value}" on <${tag}>`,
      reason:
        `A "${name}" of zero or less makes text unreadable without removing it, which is the ` +
        'same as hiding it. Give it a real size, or use markup level "extended", which says ' +
        'plainly that it was done.',
    })
  }
  return { problems, notes }
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
export function readMarkup(html: string, level: MarkupLevel = 'standard'): MarkupReading {
  const problems: MarkupProblem[] = []
  const urls: MarkupUrl[] = []
  const hiddenText: string[] = []
  const contentIds: string[] = []
  const styleNotes: StyleNote[] = []

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
          if (attribute === 'style') {
            const read = readStyle(tag, String(value), level)
            problems.push(...read.problems)
            styleNotes.push(...read.notes)
          }
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

  return { problems, urls, hiddenText, contentIds, styleNotes }
}

/**
 * Refuses markup this server will not send.
 *
 * Refused rather than repaired, deliberately. Stripping what is not permitted
 * would mean the message that goes out is not the message that was written, and
 * nobody would find out: not the caller, whose formatting quietly vanishes, and
 * not the person confirming, who has nothing to compare against.
 */
export function assertSendableMarkup(html: string, level: MarkupLevel = 'standard'): MarkupReading {
  const reading = readMarkup(html, level)
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
