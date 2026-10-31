import { describe, it, expect, vi } from 'vitest'
import { BridgeError } from '../../src/bridge/errors.js'
import { loadConfig } from '../../src/config.js'

// imapflow answers a STATUS it could not complete with false rather than an
// error. The stand-in below answers exactly that, and nothing else is reached.
vi.mock('imapflow', () => ({
  ImapFlow: class {
    usable = true
    on(): void {}
    async connect(): Promise<void> {}
    async status(): Promise<false> {
      return false
    }
  },
}))

// No certificate is read: nothing listens, and the pin file is never touched.
vi.mock('../../src/bridge/certificate.js', () => ({
  ensurePinned: async () => ({ pem: '', fingerprint256: '' }),
}))

const { Connection } = await import('../../src/bridge/connection.js')

describe('the state of a mailbox', () => {
  it('is reported as unknown, not as empty, when the Bridge did not give it', async () => {
    const connection = new Connection(
      loadConfig({}),
      async () => ({ user: 'nobody@example.com', pass: 'placeholder' }),
      () => {},
    )
    const failure = await connection.status('INBOX').catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(BridgeError)
    expect((failure as BridgeError).message).toMatch(/did not report the state of "INBOX"/)
  })
})
