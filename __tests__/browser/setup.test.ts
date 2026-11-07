import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setupBrowser, readManifest, HOST_FILES } from '../../src/browser/setup.js'
import { browserPaths, type BrowserPaths } from '../../src/browser/paths.js'
import { readSecret } from '../../src/browser/channel.js'
import { diagnose } from '../../src/browser/client.js'
import { EXTENSION_ID, HOST_NAME } from '../../src/browser/messages.js'

/**
 * The setup of the connector Chrome starts for the extension (#59). What matters:
 * Chrome is allowed to start it for the one extension and no other, the secret
 * is the user's alone, and a second run keeps a running connector working.
 */

let dir: string
let source: string
let paths: BrowserPaths
let output: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pmcp-setup-'))
  // A safety net under every test here: a call that forgets its paths falls
  // back to the home directory, and that must never be the real one. A test
  // in the first version of this file did exactly that and wrote into it.
  vi.stubEnv('HOME', join(dir, 'fallback-home'))
  vi.stubEnv('USERPROFILE', join(dir, 'fallback-home'))
  source = join(dir, 'dist-browser')
  mkdirSync(source)
  for (const file of HOST_FILES) writeFileSync(join(source, file), `// ${file}\n`)
  paths = browserPaths({ home: join(dir, 'home'), env: {}, platform: 'linux' })
  output = ''
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

const run = (extra: Parameters<typeof setupBrowser>[0] = {}) =>
  setupBrowser({ paths, node: '/opt/node/bin/node', sourceDir: source, write: (text) => (output += text), ...extra })

describe('setting up', () => {
  it('lets Chrome start the connector for this extension and no other', () => {
    expect(run()).toBe(0)
    const manifest = readManifest(paths)
    expect(manifest).toEqual({
      name: HOST_NAME,
      description: 'Connector for the Proton MCP Helper extension',
      path: paths.launcher,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
    })
  })

  it('keeps the secret readable by the user alone, and the launcher runnable by the user alone', () => {
    run()
    expect(statSync(paths.secretFile).mode & 0o777).toBe(0o600)
    expect(statSync(paths.launcher).mode & 0o777).toBe(0o700)
    expect(statSync(paths.browserDir).mode & 0o777).toBe(0o700)
    // The manifest names the launcher; nobody else needs to read it, let alone change it.
    expect(statSync(paths.manifestFile).mode & 0o777).toBe(0o600)
    expect(readSecret(paths.secretFile)).toBeDefined()
  })

  it('starts the copy of the connector with the Node it was set up with', () => {
    run()
    expect(readFileSync(paths.launcher, 'utf8')).toContain(`exec '/opt/node/bin/node' '${paths.hostScript}' "$@"`)
    for (const file of HOST_FILES) expect(existsSync(join(paths.hostDir, file))).toBe(true)
    expect(JSON.parse(readFileSync(join(paths.hostDir, 'package.json'), 'utf8'))).toMatchObject({ type: 'module' })
  })

  it('quotes a path with a quote in it so the shell cannot read it as something else', () => {
    run({ node: "/opt/it's/node" })
    expect(readFileSync(paths.launcher, 'utf8')).toContain(`exec '/opt/it'\\''s/node'`)
  })

  it('keeps the secret on a second run, so a connector Chrome already started keeps working', () => {
    run()
    const first = readFileSync(paths.secretFile, 'utf8')
    output = ''
    run()
    expect(readFileSync(paths.secretFile, 'utf8')).toBe(first)
    expect(output).toContain('(kept)')
  })

  it('leaves the diagnosis nothing to complain about once it ran', () => {
    run({ node: process.execPath })
    expect(diagnose(paths, true).reason).toBe('extension-not-connected')
  })

  it('stops and says so when the connector was not built', () => {
    rmSync(join(source, 'host.js'))
    expect(run()).toBe(1)
    expect(output).toContain('host.js')
    expect(existsSync(paths.manifestFile)).toBe(false)
  })
})

describe('removing', () => {
  it('takes away the manifest, the copy and the secret', () => {
    run()
    expect(run({ remove: true })).toBe(0)
    expect(existsSync(paths.manifestFile)).toBe(false)
    expect(existsSync(paths.hostDir)).toBe(false)
    expect(existsSync(paths.secretFile)).toBe(false)
    expect(diagnose(paths, true).reason).toBe('not-set-up')
  })
})

describe('other systems', () => {
  it('puts the manifest where Chrome on macOS looks for it', () => {
    paths = browserPaths({ home: join(dir, 'mac'), env: {}, platform: 'darwin' })
    run()
    expect(paths.manifestFile).toContain(join('Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts'))
    expect(readManifest(paths)?.path).toBe(paths.launcher)
  })

  it('registers the manifest on Windows, and removes the entry again', () => {
    // The Windows paths are written with backslashes and do not exist on this
    // machine, so only the launcher text and the registry calls are checked.
    const calls: string[][] = []
    const windows = browserPaths({ home: 'C:\\Users\\a', env: {}, platform: 'win32', user: 'a' })
    expect(windows.registryKey).toBeDefined()
    const registry = (args: string[]) => calls.push(args)
    const local = { ...windows, browserDir: join(dir, 'w'), hostDir: join(dir, 'w', 'host'), secretFile: join(dir, 'w', 'secret'), launcher: join(dir, 'w', 'host', 'launch.cmd'), manifestFile: join(dir, 'w', 'm.json'), hostScript: 'C:\\Users\\a\\.config\\proton-mcp\\browser\\host\\host.js' }
    setupBrowser({ paths: local, node: 'C:\\Program Files\\nodejs\\node.exe', sourceDir: source, registry, write: () => undefined })
    expect(calls[0]).toEqual(['add', windows.registryKey, '/ve', '/t', 'REG_SZ', '/d', local.manifestFile, '/f'])
    expect(readFileSync(local.launcher, 'utf8')).toContain('"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\a\\.config\\proton-mcp\\browser\\host\\host.js" %*')
    setupBrowser({ paths: local, remove: true, registry, write: () => undefined })
    expect(calls[1]).toEqual(['delete', windows.registryKey, '/f'])
  })

  it('writes a launcher for Windows that reads umlauts and percent signs in paths as they are', () => {
    // cmd.exe reads a batch file in the console's code page and takes %...%
    // as a variable. Found in the review of 06.11.2026; not measured on
    // Windows yet.
    const user = `J${String.fromCodePoint(0xfc)}rgen` // with a u with diaeresis
    const windows = browserPaths({ home: `C:\\Users\\${user}`, env: {}, platform: 'win32', user })
    const local = { ...windows, browserDir: join(dir, 'w'), hostDir: join(dir, 'w', 'host'), secretFile: join(dir, 'w', 'secret'), launcher: join(dir, 'w', 'host', 'launch.cmd'), manifestFile: join(dir, 'w', 'm.json'), hostScript: `C:\\Users\\${user}\\100%\\host\\connector.js` }
    setupBrowser({ paths: local, node: 'C:\\Tools\\node%PATH%\\node.exe', sourceDir: source, registry: () => undefined, write: () => undefined })
    const text = readFileSync(local.launcher, 'utf8')
    const lines = text.split('\r\n')
    expect(lines.indexOf('chcp 65001 >nul')).toBeGreaterThan(-1)
    expect(lines.indexOf('chcp 65001 >nul')).toBeLessThan(lines.findIndex((line) => line.includes('node.exe')))
    expect(text).toContain(`"C:\\Tools\\node%%PATH%%\\node.exe" "C:\\Users\\${user}\\100%%\\host\\connector.js" %*`)
  })

  it('says plainly when the system is not supported, and writes nothing', () => {
    expect(setupBrowser({ platform: 'freebsd', sourceDir: source, write: (text) => (output += text) })).toBe(1)
    expect(output).toContain('not on freebsd')
    expect(existsSync(join(dir, 'fallback-home'))).toBe(false)
  })
})
