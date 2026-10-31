import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Connection, determineKind, isLocal } from '../../src/bridge/connection.js'
import { BridgeError } from '../../src/bridge/errors.js'
import { loadConfig } from '../../src/config.js'
import { closedPort } from '../helpers/closed-port.js'

describe('determineKind', () => {
  it('recognises system mailboxes', () => {
    for (const p of ['INBOX', 'Sent', 'Drafts', 'Archive', 'Spam', 'Trash', 'All Mail', 'Starred']) {
      expect(determineKind(p)).toBe('system')
    }
  })

  it('recognises user folders including nesting', () => {
    expect(determineKind('Folders')).toBe('folder')
    expect(determineKind('Folders/Receipts')).toBe('folder')
    expect(determineKind('Folders/Receipts/Invoices')).toBe('folder')
  })

  it('recognises labels', () => {
    expect(determineKind('Labels')).toBe('label')
    expect(determineKind('Labels/Important')).toBe('label')
  })

  it('is not fooled by names that merely start alike', () => {
    // A system mailbox called "Foldersomething" would not be a user folder.
    expect(determineKind('Foldersomething')).toBe('system')
    expect(determineKind('Labelsomething')).toBe('system')
  })
})

describe('isLocal', () => {
  it('recognises the addresses that keep traffic on this machine', () => {
    expect(isLocal('127.0.0.1')).toBe(true)
    expect(isLocal('::1')).toBe(true)
    expect(isLocal('localhost')).toBe(true)
  })

  it('treats everything else as not local', () => {
    // This decides whether certificate verification stays on.
    expect(isLocal('192.168.1.10')).toBe(false)
    expect(isLocal('bridge.example.com')).toBe(false)
    expect(isLocal('127.0.0.2')).toBe(false)
  })
})

describe('a Bridge that is not running', () => {
  let dir: string

  beforeEach(() => {
    // The pin lives in a directory of its own, never in ~/.config/proton-mcp.
    dir = mkdtempSync(join(tmpdir(), 'proton-mcp-connection-'))
    vi.stubEnv('PROTON_MCP_CERT_FILE', join(dir, 'known-certificate.json'))
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true })
  })

  it('is explained rather than reported as an unexpected error', async () => {
    // The certificate is read before anything else reaches the Bridge, so this
    // is where a Bridge that is not running shows up. Up to 0.4.11 the socket
    // error went out as it was.
    const port = await closedPort()
    const config = loadConfig({ BRIDGE_IMAP_PORT: String(port) })
    const connection = new Connection(
      config,
      async () => ({ user: 'nobody@example.com', pass: 'placeholder' }),
      () => {},
    )

    const failure = await connection.listMailboxes().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(BridgeError)
    expect((failure as BridgeError).remedy).toBe('unreachable')
    expect((failure as BridgeError).message).toMatch(
      new RegExp(`Nothing is accepting connections on 127\\.0\\.0\\.1:${port}`),
    )
  })
})
