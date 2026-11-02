import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sendMessage } from '../../src/mail/send.js'
import { BridgeError } from '../../src/bridge/errors.js'
import { loadConfig } from '../../src/config.js'
import { closedPort } from '../helpers/closed-port.js'

describe('sending while the Bridge is not running', () => {
  let dir: string

  beforeEach(() => {
    // The pin lives in a directory of its own, never in ~/.config/proton-mcp.
    dir = mkdtempSync(join(tmpdir(), 'proton-mcp-send-'))
    vi.stubEnv('PROTON_MCP_CERT_FILE', join(dir, 'known-certificate.json'))
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true })
  })

  it('is explained rather than reported as an unexpected error', async () => {
    // Sending reads the certificate before the try that explains SMTP failures.
    const port = await closedPort()
    const config = loadConfig({ BRIDGE_IMAP_PORT: String(port), BRIDGE_SMTP_PORT: String(port) })

    const failure = await sendMessage(
      config,
      async () => ({ user: 'nobody@example.com', pass: 'placeholder' }),
      false,
      {
        from: { address: 'me@example.com' },
        to: [{ address: 'you@example.com' }],
        cc: [],
        bcc: [],
        subject: 'Subject',
        text: 'Body',
        messageId: '<one@example.com>',
      },
    ).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(BridgeError)
    expect((failure as BridgeError).remedy).toBe('unreachable')
    expect((failure as BridgeError).message).toMatch(/Nothing is accepting connections/)
  })
})
