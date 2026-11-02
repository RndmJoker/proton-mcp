import { describe, it, expect } from 'vitest'
import MailComposer from 'nodemailer/lib/mail-composer/index.js'
import { readParts } from '../../src/mime/parts.js'

/**
 * Built with the real nodemailer and read with the real splitter, because the
 * bytes are the subject: a stand-in would only prove that it agrees with
 * itself.
 */

const ORIGINAL = Buffer.from(
  [
    'From: jane@example.com',
    'To: me@example.com',
    'Subject: Report',
    'Message-ID: <original@example.com>',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'The original body.',
    '',
  ].join('\r\n'),
)

async function build(fields: Record<string, unknown>): Promise<Buffer> {
  const node = new MailComposer({
    from: 'me@example.com',
    to: 'you@example.com',
    subject: 'Subject',
    messageId: '<draft@example.com>',
    ...fields,
  }).compile()
  return new Promise((resolve, reject) =>
    node.build((error, message) => (error ? reject(error) : resolve(message))),
  )
}

describe('readParts', () => {
  it('keeps a forwarded original whole, as the bytes it was', async () => {
    // mailparser descends into it and writes it into the body as a table; the
    // original then exists nowhere as a file.
    const parts = await readParts(
      await build({
        text: 'See below.',
        attachments: [{ filename: 'Report.eml', content: ORIGINAL, contentType: 'message/rfc822' }],
      }),
    )
    expect(parts.text?.trim()).toBe('See below.')
    expect(parts.files).toHaveLength(1)
    expect(parts.files[0]?.contentType).toBe('message/rfc822')
    expect(parts.files[0]?.content.equals(ORIGINAL)).toBe(true)
    // Nothing of the original leaked into the body.
    expect(parts.text).not.toContain('The original body')
  })

  it('leaves a cid reference as it was and keeps the image it points at', async () => {
    // mailparser rewrites the reference into a data: address, which no markup
    // level permits.
    const picture = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3])
    const parts = await readParts(
      await build({
        html: '<p>Hello <img src="cid:pic@example.com" alt="a picture"></p>',
        attachments: [
          { filename: 'pic.png', content: picture, contentType: 'image/png', cid: 'pic@example.com' },
        ],
      }),
    )
    expect(parts.html).toContain('src="cid:pic@example.com"')
    expect(parts.html).not.toContain('data:')
    expect(parts.files).toEqual([
      { filename: 'pic.png', contentType: 'image/png', content: picture, contentId: 'pic@example.com' },
    ])
  })

  it('reads text and markup of a message that carries both', async () => {
    const parts = await readParts(await build({ text: 'Plain version', html: '<p>Marked up</p>' }))
    expect(parts.text?.trim()).toBe('Plain version')
    expect(parts.html).toBe('<p>Marked up</p>')
    expect(parts.files).toEqual([])
  })

  it('carries an ordinary attachment with its name and bytes', async () => {
    const parts = await readParts(
      await build({
        text: 'Attached.',
        attachments: [{ filename: 'notes.txt', content: Buffer.from('some notes'), contentType: 'text/plain' }],
      }),
    )
    expect(parts.text?.trim()).toBe('Attached.')
    expect(parts.files).toEqual([
      { filename: 'notes.txt', contentType: 'text/plain', content: Buffer.from('some notes') },
    ])
  })

  it('decodes the body from the charset it declares', async () => {
    // Written as escapes: the test data is the point, and the file stays ASCII.
    const latin1 = Buffer.from('Gr\u00fc\u00dfe', 'latin1')
    const raw = Buffer.concat([
      Buffer.from(
        'From: me@example.com\r\nTo: you@example.com\r\nSubject: x\r\n' +
          'Content-Type: text/plain; charset=iso-8859-1\r\nContent-Transfer-Encoding: 8bit\r\n\r\n',
      ),
      latin1,
      Buffer.from('\r\n'),
    ])
    expect((await readParts(raw)).text?.trim()).toBe('Gr\u00fc\u00dfe')
  })

  it('leaves out the public key Proton attaches to everything it sends', async () => {
    const parts = await readParts(
      await build({
        text: 'Body',
        attachments: [
          {
            filename: 'publickey - me@example.com - 0x0123ABCD.asc',
            content: Buffer.from('-----BEGIN PGP PUBLIC KEY BLOCK-----'),
            contentType: 'application/pgp-keys',
          },
        ],
      }),
    )
    expect(parts.files).toEqual([])
  })
})
