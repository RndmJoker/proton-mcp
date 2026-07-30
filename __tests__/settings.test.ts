import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadSettings, saveSettings, settingsPath, isPort } from '../src/settings.js'
import { portsSetExplicitly } from '../src/config.js'

/**
 * The one setting the interface may change.
 *
 * A broken settings file must never stop the server from starting: these are
 * conveniences, and the environment plus the defaults always suffice.
 */

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'proton-mcp-settings-'))
  path = join(dir, 'settings.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('isPort', () => {
  it('accepts the usable range only', () => {
    expect(isPort(1)).toBe(true)
    expect(isPort(1143)).toBe(true)
    expect(isPort(65535)).toBe(true)
    expect(isPort(0)).toBe(false)
    expect(isPort(65536)).toBe(false)
    expect(isPort(-1)).toBe(false)
    expect(isPort(1143.5)).toBe(false)
    expect(isPort('1143')).toBe(false)
    expect(isPort(null)).toBe(false)
    expect(isPort(undefined)).toBe(false)
  })
})

describe('loadSettings', () => {
  it('returns nothing when there is no file', async () => {
    expect(await loadSettings(path)).toEqual({})
  })

  it('reads what was written', async () => {
    await saveSettings({ imapPort: 2143, smtpPort: 2025 }, path)
    expect(await loadSettings(path)).toEqual({ imapPort: 2143, smtpPort: 2025 })
  })

  it('ignores a file that is not json', async () => {
    // Refusing to start over a convenience file would be a poor trade.
    writeFileSync(path, 'not json at all')
    expect(await loadSettings(path)).toEqual({})
  })

  it('ignores json that is not an object', async () => {
    writeFileSync(path, '"just a string"')
    expect(await loadSettings(path)).toEqual({})
    writeFileSync(path, 'null')
    expect(await loadSettings(path)).toEqual({})
  })

  it('drops a bad value without discarding a good one', async () => {
    writeFileSync(path, JSON.stringify({ imapPort: 2143, smtpPort: 99999 }))
    expect(await loadSettings(path)).toEqual({ imapPort: 2143 })
  })

  it('ignores entries it does not know', async () => {
    writeFileSync(path, JSON.stringify({ imapPort: 2143, bridgeHost: 'somewhere.example.com' }))
    const settings = await loadSettings(path)
    // The host is deliberately not settable: a stored one would be a way to
    // send the Bridge password to another machine.
    expect(settings).toEqual({ imapPort: 2143 })
    expect('bridgeHost' in settings).toBe(false)
  })
})

describe('saveSettings', () => {
  it('creates missing directories', async () => {
    const deep = join(dir, 'a', 'b', 'settings.json')
    await saveSettings({ imapPort: 1143 }, deep)
    expect(existsSync(deep)).toBe(true)
  })

  it('writes so only the owner can read it', async () => {
    // Port numbers are not secret, but a directory of mixed permissions is how
    // the file that does matter ends up readable one day.
    await saveSettings({ imapPort: 1143 }, path)
    expect(statSync(path).mode & 0o077).toBe(0)
  })
})

describe('settingsPath', () => {
  it('can be pointed elsewhere', () => {
    expect(settingsPath({ PROTON_MCP_SETTINGS_FILE: '/tmp/s.json' })).toBe('/tmp/s.json')
  })

  it('otherwise lives with the rest of the configuration', () => {
    expect(settingsPath({})).toContain(join('.config', 'proton-mcp'))
  })
})

describe('portsSetExplicitly', () => {
  it('reports a port the user set', () => {
    expect(portsSetExplicitly({ BRIDGE_IMAP_PORT: '2143' })).toEqual({
      imapPort: true,
      smtpPort: false,
    })
  })

  it('treats blank as unset', () => {
    expect(portsSetExplicitly({ BRIDGE_IMAP_PORT: '  ', BRIDGE_SMTP_PORT: '' })).toEqual({
      imapPort: false,
      smtpPort: false,
    })
  })

  it('reports nothing set on an empty environment', () => {
    expect(portsSetExplicitly({})).toEqual({ imapPort: false, smtpPort: false })
  })
})
