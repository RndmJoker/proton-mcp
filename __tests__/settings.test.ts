import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, statSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadSettings,
  saveSettings,
  settingsPath,
  isPort,
  sanitise,
  updateSettings,
  watchSettings,
} from '../src/settings.js'
import { readdirSync } from 'node:fs'
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

  it('hides the unofficial notice only for a literal true', async () => {
    writeFileSync(path, JSON.stringify({ noticeDismissed: true }))
    expect(await loadSettings(path)).toEqual({ noticeDismissed: true })

    // Anything else leaves a legal statement where it is. A hand-edited file
    // saying "true" as a string should not count as having read it.
    for (const value of ['true', 1, {}, 'yes']) {
      writeFileSync(path, JSON.stringify({ noticeDismissed: value }))
      expect(await loadSettings(path)).toEqual({})
    }
  })

  it('keeps the notice and the ports in the same file', async () => {
    // saveSettings replaces the file, so anything that writes one of these has
    // to write both. Losing the ports by dismissing a paragraph would be a
    // quiet way to break the connection.
    writeFileSync(path, JSON.stringify({ imapPort: 2143, noticeDismissed: true }))
    expect(await loadSettings(path)).toEqual({ imapPort: 2143, noticeDismissed: true })
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

describe('the settings shared by every running server', () => {
  it('keeps the PIN, the levels, the bounds and the copy when they have the right shape', () => {
    const kept = sanitise({
      pin: { salt: 's', hash: 'h' },
      credentialsGeneration: 3,
      levels: { send_message: 'act', trash_messages: 'off' },
      limits: { allowed: ['@example.com', 'a@b.example'], maxPerHour: 10, until: '2026-12-31' },
      record: { address: 'archive@example.com', mode: 'bcc' },
    })
    expect(kept).toEqual({
      pin: { salt: 's', hash: 'h' },
      credentialsGeneration: 3,
      levels: { send_message: 'act', trash_messages: 'off' },
      limits: { allowed: ['@example.com', 'a@b.example'], maxPerHour: 10, until: '2026-12-31' },
      record: { address: 'archive@example.com', mode: 'bcc' },
    })
  })

  it('drops what has the wrong shape, one value at a time', () => {
    const kept = sanitise({
      pin: { salt: '', hash: 'h' },
      credentialsGeneration: -1,
      levels: { send_message: 'always', 'Not A Tool': 'act', trash_messages: 'ask' },
      limits: { allowed: 'everyone', maxPerHour: 0, until: 'tomorrow' },
      record: { address: 'archive@example.com', mode: 'to' },
    })
    expect(kept).toEqual({ levels: { trash_messages: 'ask' } })
  })

  it('leaves no temporary file behind after writing', async () => {
    await saveSettings({ imapPort: 1143 }, path)
    expect(readdirSync(dir)).toEqual(['settings.json'])
  })

  it('changes one setting without undoing another written meanwhile', async () => {
    // Another server writes the ports; this one sets the PIN afterwards. Writing
    // a copy held in memory would quietly drop the ports again.
    await saveSettings({ imapPort: 2143 }, path)
    await updateSettings((current) => ({ ...current, pin: { salt: 's', hash: 'h' } }), path)
    expect(await loadSettings(path)).toEqual({ imapPort: 2143, pin: { salt: 's', hash: 'h' } })
  })

  it('tells a watcher when another writer changes the file', async () => {
    const seen: Array<number | undefined> = []
    const stop = watchSettings((settings) => seen.push(settings.credentialsGeneration), path, 20)
    try {
      await saveSettings({ credentialsGeneration: 7 }, path)
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(seen).toContain(7)
    } finally {
      stop()
    }
  })
})
