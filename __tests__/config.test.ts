import { describe, it, expect } from 'vitest'
import {
  loadConfig,
  ConfigError,
  parseEnvFile,
  permissionWarning,
  credentialsPath,
  credentialsFromEnvironment,
} from '../src/config.js'
import { join } from 'node:path'
import { homedir } from 'node:os'

const valid = { BRIDGE_USER: 'someone@example.com', BRIDGE_PASS: 'secret' }
/** Tests must not depend on whatever credentials file exists on this machine. */
const noFile = { skipFile: true as const }
/**
 * Reading the fixture would print a permission warning: git does not preserve
 * file modes beyond the executable bit, so the file is 644 after a checkout.
 * The warning is correct, and it has its own test below. Here it would only be
 * noise in the output.
 */
const quiet = { onWarning: () => undefined }

describe('loadConfig', () => {
  it('uses the defaults when nothing is set', () => {
    const c = loadConfig({})
    expect(c.host).toBe('127.0.0.1')
    expect(c.imapPort).toBe(1143)
    expect(c.smtpPort).toBe(1025)
    expect(c.webPort).toBe(7345)
    expect(c.readOnly).toBe(false)
  })

  it('accepts different ports, because they are configurable in the Bridge', () => {
    const c = loadConfig({ BRIDGE_IMAP_PORT: '1144', BRIDGE_SMTP_PORT: '1026', PROTON_MCP_WEB_PORT: '8000' })
    expect(c.imapPort).toBe(1144)
    expect(c.smtpPort).toBe(1026)
    expect(c.webPort).toBe(8000)
  })

  it('enables read-only mode only for exactly "true"', () => {
    expect(loadConfig({ PROTON_MCP_READ_ONLY: 'true' }).readOnly).toBe(true)
    expect(loadConfig({ PROTON_MCP_READ_ONLY: 'yes' }).readOnly).toBe(false)
    expect(loadConfig({ PROTON_MCP_READ_ONLY: '1' }).readOnly).toBe(false)
  })

  it('does not fail over missing credentials', () => {
    // They can arrive through the web interface at any time, so their absence is
    // not a configuration error and must not stop the server from starting.
    expect(() => loadConfig({})).not.toThrow()
  })

  it('rejects unusable port values', () => {
    for (const p of ['abc', '0', '-1', '70000', '11.5']) {
      expect(() => loadConfig({ BRIDGE_IMAP_PORT: p })).toThrow(ConfigError)
    }
  })

  it('falls back to the default on an empty port value instead of throwing', () => {
    expect(loadConfig({ BRIDGE_IMAP_PORT: '' }).imapPort).toBe(1143)
  })
})

describe('credentialsFromEnvironment', () => {
  it('returns nothing when neither value is set', () => {
    expect(credentialsFromEnvironment({})).toBeUndefined()
  })

  it('returns nothing when only one of the two is set', () => {
    // Half a set of credentials cannot be used and would only produce a
    // confusing login failure later.
    expect(credentialsFromEnvironment({ BRIDGE_USER: 'a@b.c' })).toBeUndefined()
    expect(credentialsFromEnvironment({ BRIDGE_PASS: 'x' })).toBeUndefined()
  })

  it('returns both when both are set', () => {
    expect(credentialsFromEnvironment({ BRIDGE_USER: 'a@b.c', BRIDGE_PASS: 'x' })).toEqual({
      user: 'a@b.c',
      pass: 'x',
    })
  })

  it('trims the address but never the password', () => {
    // A password may legitimately begin or end with a space.
    const c = credentialsFromEnvironment({ BRIDGE_USER: '  a@b.c  ', BRIDGE_PASS: ' x ' })
    expect(c?.user).toBe('a@b.c')
    expect(c?.pass).toBe(' x ')
  })

  it('ignores a blank address', () => {
    expect(credentialsFromEnvironment({ BRIDGE_USER: '   ', BRIDGE_PASS: 'x' })).toBeUndefined()
  })
})

describe('credentialsPath', () => {
  it('defaults to a path under the user config directory', () => {
    expect(credentialsPath({})).toBe(join(homedir(), '.config', 'proton-mcp', 'env'))
  })

  it('can be overridden, which the tests rely on', () => {
    expect(credentialsPath({ PROTON_MCP_ENV_FILE: '/tmp/x' })).toBe('/tmp/x')
  })
})

describe('parseEnvFile', () => {
  it('reads simple assignments', () => {
    expect(parseEnvFile('A=1\nB=two')).toEqual({ A: '1', B: 'two' })
  })

  it('ignores comments and blank lines', () => {
    expect(parseEnvFile('# a comment\n\nA=1\n   \n# another\nB=2')).toEqual({ A: '1', B: '2' })
  })

  it('copes with Windows line endings', () => {
    expect(parseEnvFile('A=1\r\nB=2\r\n')).toEqual({ A: '1', B: '2' })
  })

  it('keeps equals signs inside a value', () => {
    // Bridge passwords are generated and may contain anything.
    expect(parseEnvFile('BRIDGE_PASS=abc=def==')).toEqual({ BRIDGE_PASS: 'abc=def==' })
  })

  it('strips one layer of surrounding quotes', () => {
    expect(parseEnvFile('A="quoted"\nB=\'single\'')).toEqual({ A: 'quoted', B: 'single' })
  })

  it('does not strip quotes that only appear on one side', () => {
    expect(parseEnvFile('A="half')).toEqual({ A: '"half' })
  })

  it('ignores lines without a key', () => {
    expect(parseEnvFile('=value\nA=1')).toEqual({ A: '1' })
  })
})

describe('permissionWarning', () => {
  it('says nothing for a file only the owner can read', () => {
    expect(permissionWarning(0o600)).toBeUndefined()
    expect(permissionWarning(0o400)).toBeUndefined()
  })

  it('warns when the group or others can read it', () => {
    expect(permissionWarning(0o640)).toContain('readable by other users')
    expect(permissionWarning(0o644)).toContain('chmod 600')
    expect(permissionWarning(0o604)).toBeDefined()
  })

  it('reports the offending mode in octal', () => {
    expect(permissionWarning(0o644)).toContain('644')
  })
})
