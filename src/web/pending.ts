/**
 * The page that shows a message waiting to be sent.
 *
 * The one place in this interface that shows mail, and the exception is
 * deliberate rather than a drift: this is the message the user is being asked
 * to approve, it has not been sent yet, and they wrote it. Refusing to show it
 * here would mean asking somebody to agree to something they are not allowed to
 * read.
 *
 * **The answer is not given here.** There is no confirm button on this page and
 * there must never be one. The access token for this interface reaches the
 * assistant through `open_configuration`, so a button here could be pressed by
 * the thing being supervised. The question is answered through the client,
 * where it goes through a person.
 *
 * ## Rendering somebody else's markup
 *
 * A reply carries the quoted original byte for byte, which is arbitrary markup
 * from a stranger. It is shown in a sandboxed frame with no permissions at all:
 * no script, no forms, no same-origin access, so it cannot read the page around
 * it, restyle it, or navigate it away. The page's own policy still applies
 * inside, which is what keeps remote images from loading.
 *
 * That last part is worth stating on the page rather than leaving as a
 * surprise, because a message full of images will look emptier here than it
 * will in the recipient's mail client.
 */

import { layout, escapeHtml, type DisclaimerState } from './layout.js'

export interface PendingUrl {
  url: string
  label: string
  kind: 'link' | 'image' | 'style'
}

export interface PendingData {
  token: string
  disclaimer: DisclaimerState
  /** Which tool asked, so the page says what would actually happen. */
  tool: string
  from: string
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  /** The message as the recipient would receive it, markup and all. */
  html?: string
  /** The plain text body, for a message that carries no markup. */
  text?: string
  /** Every address in the composed part, never shortened. */
  urls: PendingUrl[]
  /** Text a recipient can read that the body does not show. */
  hiddenText: string[]
  attachments: string[]
  /** Present for a reply or a forward. Counted, not listed. */
  quoted?: { links: number; images: number; hiddenText: number }
  /**
   * Properties used beyond the ordinary set, when the wider markup level was
   * chosen. Empty for almost every message.
   */
  styleNotes: Array<{ property: string; value: string; element: string; hides: boolean }>
}

/** A row of recipients, or nothing when that field is empty. */
function recipientRow(label: string, addresses: string[]): string {
  if (addresses.length === 0) return ''
  return `<tr><th>${escapeHtml(label)}</th><td>${addresses
    .map((a) => `<code>${escapeHtml(a)}</code>`)
    .join('<br>')}</td></tr>`
}

/**
 * The message itself, in a frame that can do nothing.
 *
 * `sandbox` with no values at all is the maximally restrictive form: it denies
 * scripts, forms, popups, navigation and same-origin access in one word. The
 * content is passed through `srcdoc` rather than served from a path, so this
 * server still serves no document it did not generate.
 */
function preview(data: PendingData): string {
  if (data.html) {
    return `<iframe class="preview" sandbox srcdoc="${escapeHtml(data.html)}"
        title="The message as it will be received"></iframe>
  <p class="hint">Shown as the recipient's mail client would lay it out. Images from the internet
  are not loaded here, so a message that uses them looks emptier on this page than it will in a
  mail client. Their addresses are listed below.</p>`
  }
  return `<pre class="preview-text">${escapeHtml(data.text ?? '')}</pre>
  <p class="hint">This message carries no markup, so this is exactly what arrives.</p>`
}

function urlTable(urls: PendingUrl[]): string {
  if (urls.length === 0) {
    return '<div class="card"><p class="hint">This message contains no addresses at all.</p></div>'
  }
  const rows = urls
    .map(
      (u) => `<tr>
      <td><code>${escapeHtml(u.url)}</code></td>
      <td>${u.kind === 'style' ? 'CSS' : u.kind}</td>
      <td>${u.label ? escapeHtml(u.label) : '<span class="hint">no text</span>'}</td>
    </tr>`,
    )
    .join('\n')

  return `<div class="card">
<table class="wide">
  <tr><th>Address</th><th>Kind</th><th>Shown as</th></tr>
  ${rows}
</table>
<p class="hint"><strong>A link's text and its address are two different things.</strong> Read the
addresses, not the words they hide behind. That difference is the shape of every phishing message
ever written, and it is the reason this list is never shortened.</p>
</div>`
}

/**
 * What the message does beyond ordinary formatting.
 *
 * The counterpart to the warning in the confirmation, and the reason that
 * warning can be short: it says "go and look", and this is what there is to
 * look at. Every property, its value, and the element it sat on, with the ones
 * that really take something out of sight marked as such.
 *
 * Sorted so those come first. Somebody who reads three rows and stops should
 * have read the three that matter.
 */
function styleTable(notes: PendingData['styleNotes']): string {
  if (notes.length === 0) return ''

  const sorted = [...notes].sort((a, b) => Number(b.hides) - Number(a.hides))
  const rows = sorted
    .map(
      (n) => `<tr>
      <td><code>${escapeHtml(n.property)}</code></td>
      <td><code>${escapeHtml(n.value)}</code></td>
      <td><code>&lt;${escapeHtml(n.element)}&gt;</code></td>
      <td>${n.hides ? '<strong>hides content</strong>' : 'layout only'}</td>
    </tr>`,
    )
    .join('\n')

  const hiding = notes.filter((n) => n.hides).length

  return `<h2>Formatting beyond the ordinary set (${notes.length})</h2>
<div class="card">
${
  hiding > 0
    ? `<p><strong>${hiding} of these put something out of sight.</strong> The preview above shows
      what a recipient sees; anything hidden is missing from it and from the text of this message
      as well. Read the rows marked below and decide whether that is what was meant.</p>`
    : `<p>None of these hides anything by itself. They are the properties that <em>can</em>, which
      is why they are listed: a button needs <code>display: inline-block</code>, and the same
      property with the value <code>none</code> would make text disappear.</p>`
}
<table class="wide">
  <tr><th>Property</th><th>Value</th><th>On</th><th>Effect</th></tr>
  ${rows}
</table>
<p class="hint">These were permitted because the message asked for markup level "extended". At
"standard" they would have been refused with a reason instead.</p>
</div>`
}

export function pendingPage(data: PendingData): string {
  const what =
    data.tool === 'send_reply'
      ? 'This reply'
      : data.tool === 'send_forward'
        ? 'This forward'
        : 'This message'

  const hidden = data.hiddenText.length
    ? `<h2>Text the body does not show (${data.hiddenText.length})</h2>
<div class="card">
<ul>${data.hiddenText.map((t) => `<li><code>${escapeHtml(t)}</code></li>`).join('')}</ul>
<p class="hint">Alt texts and titles. Measured: mail clients block remote images by default, so an
image's alt text is frequently what the recipient actually reads, and it appears nowhere in the
body above.</p>
</div>`
    : ''

  const files = data.attachments.length
    ? `<h2>Carried with it (${data.attachments.length})</h2>
<div class="card"><ul>${data.attachments
        .map((f) => `<li>${escapeHtml(f)}</li>`)
        .join('')}</ul></div>`
    : ''

  const quoted = data.quoted
    ? `<h2>The quoted message</h2>
<div class="card">
<p>Below your part, the message being answered is quoted as it was written, with
${data.quoted.links} link(s), ${data.quoted.images} image(s) and ${data.quoted.hiddenText} alt
text(s) of its own.</p>
<p class="hint">Those are counted rather than listed: they arrived in your mailbox already, and
listing thirty of them would bury the ones this message adds, which are the ones you are answering
for. They are visible in the preview above.</p>
</div>`
    : ''

  return layout({
    title: 'Waiting to be sent',
    section: 'none',
    token: data.token,
    disclaimer: data.disclaimer,
    body: `<h1>${escapeHtml(what)} is waiting for your answer</h1>
<p class="lead">Nothing has been sent. Read it here, then answer the question in your assistant.
<strong>There is no button on this page on purpose</strong>: the answer goes through your client,
where it goes through you.</p>

<div class="card"><table>
<tr><th>From</th><td><code>${escapeHtml(data.from)}</code></td></tr>
${recipientRow('To', data.to)}
${recipientRow('Cc', data.cc)}
${recipientRow('Bcc', data.bcc)}
<tr><th>Subject</th><td>${escapeHtml(data.subject || '(no subject)')}</td></tr>
</table></div>

<h2>The message</h2>
<div class="card">${preview(data)}</div>

<h2>Every address in it (${data.urls.length})</h2>
${urlTable(data.urls)}

${styleTable(data.styleNotes)}
${hidden}
${files}
${quoted}`,
  })
}

/** Shown when a preview is asked for that is no longer waiting. */
export function noPendingPage(token: string, disclaimer: DisclaimerState): string {
  return layout({
    title: 'Nothing waiting',
    section: 'none',
    token,
    disclaimer,
    body: `<h1>Nothing is waiting to be sent</h1>
<p class="lead">Either the question was already answered, or it was asked long enough ago that the
message is no longer held.</p>
<p>Messages waiting for an answer are kept in memory only, never written to disk, and dropped as
soon as the answer arrives whichever way it went. That is why this page is empty rather than
showing you what used to be here.</p>
<p class="hint">If you were expecting a message, ask your assistant to try again.</p>`,
  })
}
