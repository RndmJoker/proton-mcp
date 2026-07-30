import { describe, it, expect } from 'vitest'
import {
  isProtonPublicKey,
  htmlToText,
  truncate,
  estimateTokens,
  estimateTokensForChars,
  parseMessage,
} from '../../src/mime/parse.js'

/** Builds a raw message. Test data only, no real addresses or content. */
function rawMessage(parts: {
  subject?: string
  from?: string
  to?: string
  messageId?: string
  text?: string
  html?: string
  attachments?: Array<{ filename: string; type: string; content: string }>
}): string {
  const boundary = 'boundary-for-tests'
  const head = [
    `Message-ID: ${parts.messageId ?? '<test@example.com>'}`,
    `From: ${parts.from ?? 'Sender <sender@example.com>'}`,
    `To: ${parts.to ?? 'recipient@example.com'}`,
    `Subject: ${parts.subject ?? 'Test'}`,
    'Date: Tue, 29 Jul 2026 18:25:00 +0000',
    'MIME-Version: 1.0',
  ]

  const sections: string[] = []
  if (parts.text) {
    sections.push(
      `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${parts.text}\r\n`,
    )
  }
  if (parts.html) {
    sections.push(`--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${parts.html}\r\n`)
  }
  for (const a of parts.attachments ?? []) {
    sections.push(
      `--${boundary}\r\nContent-Type: ${a.type}\r\n` +
        `Content-Disposition: attachment; filename="${a.filename}"\r\n\r\n${a.content}\r\n`,
    )
  }

  // A message carrying the same content as text and as HTML is
  // multipart/alternative, not multipart/mixed. With mixed both parts would be
  // separate content and belong in the output together, which is exactly what
  // mailparser does. Getting this wrong in test data produces a failure that
  // looks like a bug in the parser.
  const container = parts.text && parts.html ? 'alternative' : 'mixed'
  head.push(`Content-Type: multipart/${container}; boundary="${boundary}"`)
  return `${head.join('\r\n')}\r\n\r\n${sections.join('')}--${boundary}--\r\n`
}

describe('isProtonPublicKey', () => {
  it('recognises the key Proton attaches to every sent message', () => {
    // The shape Proton actually uses, taken from a message sent over the Bridge.
    expect(
      isProtonPublicKey('application/pgp-keys', 'publickey - someone@example.com - 0xC3CFE56C.asc'),
    ).toBe(true)
  })

  it('is case-insensitive about the content type', () => {
    expect(
      isProtonPublicKey('Application/PGP-Keys', 'publickey - a@b.c - 0xabcdef.asc'),
    ).toBe(true)
  })

  it('leaves a genuinely attached key alone', () => {
    // Same content type, but not Proton's generated name. Filtering this would
    // hide a real attachment from the user.
    expect(isProtonPublicKey('application/pgp-keys', 'my-key.asc')).toBe(false)
    expect(isProtonPublicKey('application/pgp-keys', 'pubkey.txt')).toBe(false)
  })

  it('does not match on the name alone', () => {
    expect(isProtonPublicKey('text/plain', 'publickey - a@b.c - 0xabc.asc')).toBe(false)
  })
})

describe('htmlToText', () => {
  it('extracts readable text', () => {
    const text = htmlToText('<html><body><h1>Heading</h1><p>A sentence.</p></body></html>')
    expect(text).toContain('Heading')
    expect(text).toContain('A sentence.')
    expect(text).not.toContain('<p>')
  })

  it('drops scripts and styles instead of showing their source', () => {
    const text = htmlToText(
      '<style>.x{color:red}</style><script>alert(1)</script><p>Content</p>',
    )
    expect(text).toContain('Content')
    expect(text).not.toContain('alert')
    expect(text).not.toContain('color:red')
  })

  it('drops images, because their URLs are useless without fetching them', () => {
    // Fetching would confirm to the sender that the message was read.
    const text = htmlToText('<p>Before</p><img src="https://tracker.example.com/pixel.gif"><p>After</p>')
    expect(text).toContain('Before')
    expect(text).toContain('After')
    expect(text).not.toContain('tracker.example.com')
  })

  it('keeps link targets, so a recipient can judge where a link goes', () => {
    const text = htmlToText('<a href="https://real-target.example.com">Click here</a>')
    expect(text).toContain('real-target.example.com')
  })

  it('collapses runs of blank lines', () => {
    expect(htmlToText('<p>A</p><br><br><br><br><p>B</p>')).not.toMatch(/\n{3,}/)
  })

  it('preserves umlauts', () => {
    expect(htmlToText('<p>Äpfel, Öfen, Über, Straße</p>')).toContain('Äpfel, Öfen, Über, Straße')
  })
})

describe('truncate', () => {
  it('leaves short text untouched', () => {
    const r = truncate('short', 100)
    expect(r.text).toBe('short')
    expect(r.truncated).toBe(false)
    expect(r.nextOffset).toBeUndefined()
  })

  it('shortens and says how to continue', () => {
    // Cutting silently would let the model treat a partial message as complete.
    const r = truncate('x'.repeat(500), 100)
    expect(r.truncated).toBe(true)
    expect(r.text).toContain('400 of 500 characters not shown')
    expect(r.text).toContain('textOffset=100')
    expect(r.nextOffset).toBe(100)
  })

  it('names a plausible token count instead of NaN', () => {
    const r = truncate('x'.repeat(500), 100)
    expect(r.text).toMatch(/roughly \d+ tokens/)
    expect(r.text).not.toContain('NaN')
  })

  it('reports the total length whether it shortens or not', () => {
    expect(truncate('x'.repeat(500), 100).totalChars).toBe(500)
    expect(truncate('short', 100).totalChars).toBe(5)
  })

  it('prefers to cut at a line break', () => {
    const text = 'a'.repeat(60) + '\n\n' + 'b'.repeat(200)
    const r = truncate(text, 100)
    expect(r.text.startsWith('a'.repeat(60))).toBe(true)
    expect(r.text.split('[...')[0]).not.toContain('b')
  })

  it('says where a continuation starts', () => {
    const r = truncate('x'.repeat(500), 100, 100)
    expect(r.text).toContain('continuing at character 100 of 500')
  })

  it('marks the last part as final by omitting the next offset', () => {
    const r = truncate('x'.repeat(500), 100, 400)
    expect(r.nextOffset).toBeUndefined()
    expect(r.text).not.toContain('to continue reading')
    expect(r.text).toContain('continuing at character 400')
  })

  it('reassembles into the original text without gaps or repeats', () => {
    // The point of the whole mechanism: an agent that reads every part has to
    // end up with the complete message. A cut at a line break must not swallow
    // the break itself.
    const original = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1}: ` + 'word '.repeat(12)).join('\n\n')
    const budget = 300

    let offset: number | undefined = 0
    let assembled = ''
    let rounds = 0
    while (offset !== undefined && rounds < 100) {
      const part: ReturnType<typeof truncate> = truncate(original, budget, offset)
      // Strip the notes the excerpt adds around the actual content. The exact
      // number of newlines matters: the excerpt joins its parts with a blank
      // line, so a cut that ends on a newline produces three in a row, of which
      // only two are separators. A greedy \n* here would swallow content and
      // make a correct implementation look broken.
      const body = part.text
        .replace(/^\[\.\.\. continuing at character \d+ of \d+ \.\.\.\]\n\n?/, '')
        .replace(/\n\n\[\.\.\. \d+ of \d+ characters not shown[^\]]*\]$/, '')
      assembled += body
      offset = part.nextOffset
      rounds++
    }

    expect(rounds).toBeGreaterThan(3)
    expect(assembled).toBe(original)
  })

  it('copes with an offset beyond the end', () => {
    const r = truncate('short', 100, 9999)
    expect(r.nextOffset).toBeUndefined()
    expect(r.totalChars).toBe(5)
  })

  it('treats a negative offset as the start', () => {
    expect(truncate('x'.repeat(500), 100, -50).text).not.toContain('continuing at character')
  })
})

describe('token estimates', () => {
  it('counts four characters per token', () => {
    expect(estimateTokensForChars(400)).toBe(100)
    expect(estimateTokens('x'.repeat(400))).toBe(100)
  })

  it('rounds up, so a budget is never underestimated', () => {
    expect(estimateTokensForChars(1)).toBe(1)
    expect(estimateTokensForChars(5)).toBe(2)
  })
})

describe('parseMessage', () => {
  it('reads headers and plain text', async () => {
    const m = await parseMessage(
      rawMessage({
        subject: 'A subject',
        from: 'Alice <alice@example.com>',
        to: 'bob@example.com',
        messageId: '<abc@example.com>',
        text: 'Body text.',
      }),
    )
    expect(m.subject).toBe('A subject')
    expect(m.from[0]).toEqual({ name: 'Alice', address: 'alice@example.com' })
    expect(m.to[0]?.address).toBe('bob@example.com')
    expect(m.messageId).toBe('<abc@example.com>')
    expect(m.text).toBe('Body text.')
    expect(m.textSource).toBe('plain')
  })

  it('converts HTML when there is no plain text part', async () => {
    // The measured case: Proton strips the plain text part from HTML messages.
    const m = await parseMessage(rawMessage({ html: '<p>Only HTML here.</p>' }))
    expect(m.textSource).toBe('html')
    expect(m.text).toContain('Only HTML here.')
  })

  it('prefers the plain text part when both are present', async () => {
    const m = await parseMessage(
      rawMessage({ text: 'Plain version.', html: '<p>HTML version.</p>' }),
    )
    expect(m.textSource).toBe('plain')
    expect(m.text).toBe('Plain version.')
  })

  it('reports a message without a body instead of inventing one', async () => {
    const m = await parseMessage(rawMessage({}))
    expect(m.textSource).toBe('none')
    expect(m.text).toBe('')
  })

  it('filters out Proton\'s public key and says that it did', async () => {
    const m = await parseMessage(
      rawMessage({
        text: 'Hello.',
        attachments: [
          { filename: 'publickey - sender@example.com - 0xABCDEF.asc', type: 'application/pgp-keys', content: 'key' },
        ],
      }),
    )
    expect(m.attachments).toHaveLength(0)
    expect(m.protonKeyFiltered).toBe(true)
  })

  it('numbers real attachments consecutively despite the filtered key', async () => {
    // The indices have to match what a caller sees, otherwise get_attachment
    // would read the wrong file.
    const m = await parseMessage(
      rawMessage({
        text: 'Hello.',
        attachments: [
          { filename: 'first.txt', type: 'text/plain', content: 'one' },
          { filename: 'publickey - a@b.c - 0x1.asc', type: 'application/pgp-keys', content: 'key' },
          { filename: 'second.json', type: 'application/json', content: '{}' },
        ],
      }),
    )
    expect(m.attachments.map((a) => a.filename)).toEqual(['first.txt', 'second.json'])
    expect(m.attachments.map((a) => a.index)).toEqual([0, 1])
    expect(m.protonKeyFiltered).toBe(true)
  })

  it('applies the character budget', async () => {
    const m = await parseMessage(rawMessage({ text: 'y'.repeat(5000) }), { maxTextChars: 200 })
    expect(m.truncated).toBe(true)
    expect(m.text.length).toBeLessThan(1000)
  })

  it('does not shorten without a budget', async () => {
    const m = await parseMessage(rawMessage({ text: 'y'.repeat(5000) }))
    expect(m.truncated).toBe(false)
    expect(m.nextTextOffset).toBeUndefined()
  })

  it('reports where to continue a long body', async () => {
    const m = await parseMessage(rawMessage({ text: 'y'.repeat(5000) }), { maxTextChars: 200 })
    expect(m.truncated).toBe(true)
    expect(m.nextTextOffset).toBe(200)
    expect(m.totalTextChars).toBe(5000)
  })

  it('continues from an offset', async () => {
    const m = await parseMessage(rawMessage({ text: 'y'.repeat(5000) }), {
      maxTextChars: 200,
      textOffset: 200,
    })
    expect(m.text).toContain('continuing at character 200')
  })

  it('records the raw size', async () => {
    const raw = rawMessage({ text: 'Hello.' })
    const m = await parseMessage(raw)
    expect(m.rawSize).toBe(Buffer.byteLength(raw))
  })
})
