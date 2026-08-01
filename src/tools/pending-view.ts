/**
 * Turning a held message into what the preview page needs.
 *
 * Its own module rather than a method on either side, because it is the one
 * place where the two halves meet: the sending path knows what a Draft is, the
 * interface knows what it can render, and neither should have to know the
 * other. Putting the translation here keeps `src/web` free of mail types and
 * the sending path free of page structure.
 *
 * Everything the confirmation used to say is assembled here instead, from the
 * same functions that said it. Nothing was dropped in the move: the address
 * list is still every address, the hidden text is still every alt text and
 * title, and the quote is still counted rather than listed for the reason
 * written at summariseQuote.
 */

import {
  composedBody,
  describeAttachments,
  describeUrls,
  hiddenTextOf,
  summariseQuote,
  showRecipient,
  type Draft,
} from '../mail/compose.js'
import { previewOf } from './preview.js'

/** What the page needs, without the parts the interface fills in itself. */
export interface PendingView {
  tool: string
  from: string
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  html?: string
  text?: string
  urls: Array<{ url: string; label: string; kind: 'link' | 'image' }>
  hiddenText: string[]
  attachments: string[]
  quoted?: { links: number; images: number; hiddenText: number }
}

/**
 * The message as it would arrive, quote and all.
 *
 * The preview shows the whole thing rather than only the composed part, which
 * is the opposite of what the confirmation does. Both are right for where they
 * are: the question in the client asks about the part somebody wrote, while
 * this page answers "what does the recipient get", and for a reply that
 * includes the quote.
 */
function bodyFor(draft: Draft): { html?: string; text?: string } {
  if (draft.html !== undefined) {
    return { html: `${draft.html}${draft.quotedHtml ?? ''}` }
  }
  return { text: composedBody(draft) }
}

/** Assembles the view for a message that is waiting, if one is. */
export function pendingView(digest: string): PendingView | undefined {
  const waiting = previewOf(digest)
  if (!waiting) return undefined

  const { draft, tool } = waiting
  const quote = summariseQuote(draft)

  return {
    tool,
    from: showRecipient(draft.from),
    to: draft.to.map(showRecipient),
    cc: draft.cc.map(showRecipient),
    bcc: draft.bcc.map(showRecipient),
    subject: draft.subject,
    ...bodyFor(draft),
    urls: describeUrls(draft).map((u) => ({ url: u.url, label: u.label, kind: u.kind })),
    hiddenText: hiddenTextOf(draft),
    attachments: describeAttachments(draft),
    ...(quote
      ? {
          quoted: {
            links: quote.links,
            images: quote.images,
            hiddenText: quote.hiddenText.length,
          },
        }
      : {}),
  }
}
