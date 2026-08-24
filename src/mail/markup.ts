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

/**
 * Attributes each element may carry, on top of the ones allowed everywhere.
 *
 * `role` and `aria-*` are here because leaving them out was a mistake rather
 * than a policy. `role="presentation"` on a layout table is the standard way to
 * write mail: without it a screen reader announces "table, three rows, two
 * columns" for something that only centres a button. The attribute carries no
 * behaviour and can hide nothing; refusing it made messages worse for the
 * people who most need them to be well made.
 *
 * `class` and `id` are permitted for the opposite reason: they do nothing here,
 * since a message may carry no `<style>` block, and some clients hang their own
 * rules on them. There is nothing to protect by refusing them.
 *
 * `bgcolor` and `background` on table elements are old mail HTML that Outlook
 * still needs, and both are colours rather than behaviour.
 */
const PERMITTED_ATTRIBUTES: Record<string, string[]> = {
  '*': ['style', 'title', 'dir', 'lang', 'role', 'class', 'id'],
  a: ['href', 'target', 'rel'],
  img: ['src', 'alt', 'width', 'height', 'border'],
  // height sits beside width rather than being an omission with a reason. A
  // table cell of a given height hides nothing: its content still renders, and
  // the properties that do hide are refused as styles further down.
  table: ['width', 'height', 'border', 'cellpadding', 'cellspacing', 'align', 'bgcolor', 'background'],
  td: ['colspan', 'rowspan', 'align', 'valign', 'width', 'height', 'bgcolor', 'background'],
  th: ['colspan', 'rowspan', 'align', 'valign', 'width', 'height', 'bgcolor', 'background'],
  tr: ['align', 'valign', 'height', 'bgcolor'],
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
  /**
   * `style` is an address inside a CSS value, such as `background: url(...)`.
   * It is its own kind because a reader has no text for it and no way to see it
   * coming: a link shows words, an image shows a frame or its alt text, and a
   * CSS background shows nothing at all while still being fetched.
   */
  kind: 'link' | 'image' | 'style'
  url: string
  /** The text a reader sees for a link, the alt text of an image, or the property and element for a CSS address. */
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
/**
 * Splits a style attribute into declarations without cutting inside `url(...)`.
 *
 * A plain `split(';')` looks right until a data URL turns up:
 * `background: url(data:image/png;base64,AAAA)` becomes `background:
 * url(data:image/png` and `base64,AAAA)`. The first half no longer parses as a
 * url and the second reads as a property named `base64,aaaa)`, which at
 * "standard" is refused for not being on the list and at "extended" is
 * permitted, because there every property is. So the one scheme that is refused
 * by name on both levels travelled through on one of them. Measured on
 * 24.08.2026 while closing the CSS address hole; the two bugs hid each other.
 */
function splitDeclarations(style: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const ch of style) {
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    if (ch === ';' && depth === 0) {
      out.push(current)
      current = ''
      continue
    }
    current += ch
  }
  out.push(current)
  return out
}

/**
 * Every address inside one CSS value.
 *
 * `url(...)` may quote its argument or not, so all three spellings are read.
 * There can be more than one in a value: `background` takes a list, and a
 * shorthand can carry an image beside its colour.
 */
function urlsInValue(value: string): string[] {
  const found: string[] = []
  const pattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(value)) !== null) {
    const address = (match[1] ?? match[2] ?? match[3] ?? '').trim()
    if (address) found.push(address)
  }
  return found
}

function readStyle(
  tag: string,
  style: string,
  level: MarkupLevel,
): { problems: MarkupProblem[]; notes: StyleNote[]; urls: MarkupUrl[] } {
  const problems: MarkupProblem[] = []
  const notes: StyleNote[] = []
  const urls: MarkupUrl[] = []

  for (const declaration of splitDeclarations(style)) {
    const [rawName, ...rest] = declaration.split(':')
    const name = (rawName ?? '').trim().toLowerCase()
    const value = rest.join(':').trim()
    if (!name) continue

    // Before anything about the property itself. An address in a CSS value is
    // fetched by the recipient's client exactly like the src of an image, and
    // it is worse in one respect: nothing shows it. `background: url(...)` was
    // permitted at "standard" and reported no address at all, so a tracking
    // pixel travelled in a message whose confirmation listed no addresses.
    //
    // Checked on both levels and for every property, not for a list of the
    // ones known to take a url. `extended` permits every property, so a list
    // would be a hole by construction: `border-image`, `mask`, `cursor`,
    // `list-style` and `content` all take one.
    for (const address of urlsInValue(value)) {
      const problem = urlProblem(tag, `style "${name}"`, address)
      if (problem) {
        problems.push(problem)
        continue
      }
      urls.push({ kind: 'style', url: address, label: `${name} on <${tag}>` })
    }

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
  return { problems, notes, urls }
}

/**
 * `where` names the place an address was found, ready to read: `href`, `src` or
 * a CSS property. It is interpolated into the message, so it says
 * `href="..." on <a>` for an attribute and `background: url(...) in <p>` for a
 * style, rather than forcing one shape onto both.
 */
function urlProblem(tag: string, attribute: string, value: string): MarkupProblem | undefined {
  const trimmed = value.trim()
  const where = attribute.startsWith('style ')
    ? `${attribute}: url(${trimmed.slice(0, 40)}) in <${tag}>`
    : `${attribute}="${trimmed.slice(0, 60)}" on <${tag}>`
  // A relative address has no meaning in a message: there is no page it is
  // relative to, so it would simply be broken wherever it arrived.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return {
      found: where,
      reason:
        'An address in a message has to be complete. A relative one has nothing to be relative ' +
        'to once the message has been delivered. Write the whole address, including https://.',
    }
  }
  const scheme = trimmed.slice(0, trimmed.indexOf(':') + 1).toLowerCase()
  if (!PERMITTED_SCHEMES.includes(scheme)) {
    return {
      found: where,
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
          // aria-* as a family rather than one by one. They describe a document
          // to assistive technology and carry no behaviour, and listing them
          // individually would mean this file goes stale every time the
          // specification grows one.
          if (!allowed.includes(attribute) && !attribute.startsWith('aria-')) {
            problems.push({
              found: `${attribute}="${String(value).slice(0, 30)}" on <${tag}>`,
              reason:
                attribute.startsWith('on')
                  ? 'An event handler has no place in a message. No mail client runs it, and ' +
                    'what it contains would never be seen by anyone confirming the send.'
                  : `<${tag}> may not carry "${attribute}" here. Permitted are style, title, ` +
                    'dir, lang, role, class, id and aria-*, plus what each element needs of its ' +
                    'own. Markup level "extended" widens which style properties may be used, not ' +
                    'which attributes exist.',
            })
            continue
          }
          if (attribute === 'style') {
            const read = readStyle(tag, String(value), level)
            problems.push(...read.problems)
            styleNotes.push(...read.notes)
            urls.push(...read.urls)
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
      oncomment(data) {
        // Not dropped by every reader. Outlook executes conditional comments,
        // so `<!--[if mso]><style>...</style><![endif]-->` is markup there and
        // a comment everywhere else, including in this parser and in the
        // preview. That is exactly the shape the permitted list is built to
        // refuse: a `<style>` block reaches out of its own element and can
        // restyle the whole message.
        //
        // Measured on real mail: three of 151 messages hid a `<style>` block
        // this way and one hid a `<noscript>`. Fifteen unit tests were green
        // while the hole was open, and quote.ts already drops comments from a
        // quote for this reason. The composed part had no such guard.
        //
        // Refused rather than stripped, like everything else outside the list:
        // a message quietly altered is no longer the message anyone agreed to.
        // Checking for `[if mso]` would close these four spellings and leave
        // the next one open, so the form of the hole goes rather than its known
        // shapes.
        //
        // Both levels. `extended` widens which CSS properties may be used, not
        // what may reach out of its own element.
        const excerpt = data.trim().replace(/\s+/g, ' ').slice(0, 60)
        problems.push({
          found: `comment <!--${excerpt}${data.trim().length > 60 ? '...' : ''}-->`,
          reason:
            'A comment is not inert everywhere. Outlook runs conditional comments, so markup ' +
            'inside one is delivered as markup to some recipients and as nothing to others, and ' +
            'neither the confirmation nor the preview can show what the first group sees. Write ' +
            'the message without comments; there is nothing a recipient gains from one.',
        })
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
