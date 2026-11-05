import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { request as httpRequest } from 'node:http'
import { PreviewServer } from '../../src/web/preview-server.js'
import type { PendingData } from '../../src/web/pending.js'

/**
 * The page of a message waiting for confirmation, shown by the server that holds it.
 *
 * It has to show the message to whoever opens the link, and nothing to anybody
 * else: no other path, no foreign Host, no form, no button.
 */

const DIGEST = 'a'.repeat(64)

const waiting: Omit<PendingData, 'disclaimer'> = {
  tool: 'send_message',
  from: 'me@example.com',
  to: ['you@example.com'],
  cc: [],
  bcc: [],
  subject: 'Hello there',
  text: 'Body of the waiting message',
  urls: [],
  hiddenText: [],
  attachments: [],
  styleNotes: [],
} as unknown as Omit<PendingData, 'disclaimer'>

let preview: PreviewServer

beforeEach(async () => {
  preview = new PreviewServer({ getPending: (digest) => (digest === DIGEST ? waiting : undefined) })
  await preview.start()
})

afterEach(async () => {
  await preview.stop()
})

function get(url: string, host?: string, method = 'GET'): Promise<{ status: number; body: string }> {
  const parsed = new URL(url)
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method,
        headers: { Host: host ?? parsed.host },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', reject)
    req.end()
  })
}

describe('the preview of a waiting message', () => {
  it('shows the message behind its digest', async () => {
    const res = await get(preview.urlFor(DIGEST)!)
    expect(res.status).toBe(200)
    expect(res.body).toContain('Hello there')
    expect(res.body).toContain('There is no button on this page on purpose')
  })

  it('shows an empty page once nothing is waiting under a digest', async () => {
    const res = await get(preview.urlFor('b'.repeat(64))!)
    expect(res.status).toBe(200)
    expect(res.body).toContain('Nothing is waiting to be sent')
  })

  it('refuses a foreign Host, so a rebinding page cannot read it', async () => {
    const res = await get(preview.urlFor(DIGEST)!, 'evil.example.com')
    expect(res.status).toBe(404)
    expect(res.body).not.toContain('Hello there')
  })

  it('serves nothing but previews, and only for GET', async () => {
    const base = new URL(preview.urlFor(DIGEST)!)
    expect((await get(`http://${base.host}/`)).status).toBe(404)
    expect((await get(`http://${base.host}/pending/not-a-digest`)).status).toBe(404)
    expect((await get(preview.urlFor(DIGEST)!, undefined, 'POST')).status).toBe(405)
  })

  it('gives no address while it is not running, or for something that is not a digest', async () => {
    expect(preview.urlFor('nope')).toBeUndefined()
    await preview.stop()
    expect(preview.urlFor(DIGEST)).toBeUndefined()
  })
})
