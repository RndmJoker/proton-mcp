/**
 * Sets up the connector Chrome starts for the browser extension (#59):
 *
 *   npx -y @rndmjoker/proton-mcp@latest setup-browser
 *   npx -y @rndmjoker/proton-mcp@latest setup-browser --remove
 *
 * What it writes, all of it for the current user only:
 *
 * - the secret both ends of the socket prove they know, readable by the user
 *   alone, kept when the setup runs again so a running connector keeps working;
 * - a copy of the connector's five files under ~/.config/proton-mcp/browser/host,
 *   because an npx cache can be cleared or replaced at any time and Chrome
 *   needs a path that stays;
 * - a launcher that starts that copy with the Node this setup runs under,
 *   since Chrome's environment may not find Node on its own;
 * - the manifest that tells Chrome which program the extension may start,
 *   naming the extension's fixed id as the only one allowed;
 * - on Windows, the registry entry that points Chrome at that manifest.
 *
 * Nothing here needs administrator rights, and nothing outside the user's own
 * directories and, on Windows, the user's own part of the registry is touched.
 */

import { mkdirSync, writeFileSync, copyFileSync, chmodSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { dirname, join, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOST_NAME, EXTENSION_ID } from './messages.js'
import { browserPaths, UnsupportedPlatform, type BrowserPaths } from './paths.js'
import { readSecret } from './channel.js'

/** The files the connector needs, copied together because they import each other and nothing else. */
export const HOST_FILES = ['connector.js', 'host.js', 'messages.js', 'paths.js', 'channel.js'] as const

export interface SetupOptions {
  paths?: BrowserPaths
  /** The system to set up for when no paths are given. Only for tests. */
  platform?: string
  /** The Node the launcher starts the connector with. */
  node?: string
  /** Where the compiled connector files are. */
  sourceDir?: string
  remove?: boolean
  write?: (text: string) => void
  /** Runs reg.exe on Windows. Replaced in tests. */
  registry?: (args: string[]) => void
}

/** Quotes a path for a POSIX shell script: single quotes, with any single quote closed and escaped. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function launcherText(paths: BrowserPaths, node: string): string {
  if (paths.platform === 'win32') {
    // Chrome runs a .cmd through cmd.exe and passes the origin and the parent
    // window as arguments, which %* hands on. cmd.exe reads a batch file in
    // the console's code page, so it switches to UTF-8 first for paths with
    // letters like the umlauts in a user name, and a percent sign in a path
    // is doubled so cmd.exe does not read it as a variable. Not measured on
    // Windows yet.
    const quoted = (value: string): string => `"${value.replace(/%/g, '%%')}"`
    return (
      '@echo off\r\n' +
      'rem Written by proton-mcp setup-browser. Chrome starts this for the extension.\r\n' +
      'chcp 65001 >nul\r\n' +
      `${quoted(node)} ${quoted(paths.hostScript)} %*\r\n`
    )
  }
  return (
    '#!/bin/sh\n' +
    '# Written by proton-mcp setup-browser. Chrome starts this for the extension.\n' +
    `exec ${shellQuote(node)} ${shellQuote(paths.hostScript)} "$@"\n`
  )
}

function manifestText(paths: BrowserPaths): string {
  return `${JSON.stringify(
    {
      name: HOST_NAME,
      description: 'Connector for the Proton MCP Helper extension',
      path: paths.launcher,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
    },
    null,
    2,
  )}\n`
}

function defaultRegistry(args: string[]): void {
  // By its full path: a bare name is looked up in the current directory first.
  const reg = win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe')
  execFileSync(reg, args, { stdio: 'ignore', windowsHide: true })
}

/** Writes everything, or with remove takes it all away again. Returns the exit code. */
export function setupBrowser(options: SetupOptions = {}): number {
  const write = options.write ?? ((text: string) => process.stdout.write(text))
  let paths: BrowserPaths
  try {
    paths = options.paths ?? browserPaths(options.platform !== undefined ? { platform: options.platform } : {})
  } catch (error) {
    if (error instanceof UnsupportedPlatform) {
      write(`${error.message}\n`)
      return 1
    }
    throw error
  }
  const registry = options.registry ?? defaultRegistry

  if (options.remove) {
    rmSync(paths.manifestFile, { force: true })
    rmSync(paths.hostDir, { recursive: true, force: true })
    rmSync(paths.secretFile, { force: true })
    if (paths.registryKey) {
      try {
        registry(['delete', paths.registryKey, '/f'])
      } catch {
        // Not there to begin with.
      }
    }
    write(
      'The connector for the browser extension is removed: its manifest, its copy and its secret.\n' +
        'Remove the extension itself in chrome://extensions.\n',
    )
    return 0
  }

  const node = options.node ?? process.execPath
  const sourceDir = options.sourceDir ?? dirname(fileURLToPath(import.meta.url))
  const missing = HOST_FILES.filter((file) => !existsSync(join(sourceDir, file)))
  if (missing.length > 0) {
    write(`The connector's files are missing from ${sourceDir}: ${missing.join(', ')}. Build the server first.\n`)
    return 1
  }

  mkdirSync(paths.browserDir, { recursive: true, mode: 0o700 })
  mkdirSync(paths.hostDir, { recursive: true, mode: 0o700 })
  if (paths.platform !== 'win32') {
    chmodSync(paths.browserDir, 0o700)
    chmodSync(paths.hostDir, 0o700)
  }

  // Kept when it exists: a connector Chrome already started read it once and
  // would refuse every connection after a change, until the extension reloads.
  const keptSecret = readSecret(paths.secretFile) !== undefined
  if (!keptSecret) {
    writeFileSync(paths.secretFile, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 })
  }
  if (paths.platform !== 'win32') chmodSync(paths.secretFile, 0o600)

  for (const file of HOST_FILES) copyFileSync(join(sourceDir, file), join(paths.hostDir, file))
  // The copies are ES modules and need to be read as such without the package around them.
  writeFileSync(join(paths.hostDir, 'package.json'), '{ "type": "module", "private": true }\n')

  writeFileSync(paths.launcher, launcherText(paths, node), { mode: 0o700 })
  if (paths.platform !== 'win32') chmodSync(paths.launcher, 0o700)

  mkdirSync(dirname(paths.manifestFile), { recursive: true })
  // Readable by the user alone: whoever can change "path" in it decides what
  // Chrome starts as this user.
  writeFileSync(paths.manifestFile, manifestText(paths), { mode: 0o600 })
  if (paths.platform !== 'win32') chmodSync(paths.manifestFile, 0o600)
  if (paths.registryKey) {
    registry(['add', paths.registryKey, '/ve', '/t', 'REG_SZ', '/d', paths.manifestFile, '/f'])
  }

  write(
    [
      'The connector for the browser extension is set up.',
      '',
      `  Connector: ${paths.launcher}`,
      `  Node:      ${node}`,
      `  Manifest:  ${paths.manifestFile}`,
      ...(paths.registryKey ? [`  Registry:  ${paths.registryKey}`] : []),
      `  Secret:    ${paths.secretFile}${keptSecret ? ' (kept)' : ' (new)'}`,
      `  Socket:    ${paths.socket}`,
      '',
      'Next:',
      '  1. Load the extension in Chrome: open chrome://extensions, switch on Developer mode,',
      '     choose "Load unpacked" and pick the unpacked folder of the extension from the release.',
      `     Its id has to be ${EXTENSION_ID}.`,
      '     If it was loaded before, click its reload arrow instead.',
      '  2. Reload any open Proton tab once, or open https://mail.proton.me and sign in.',
      '  3. Ask your assistant to list your filters.',
      '',
      'If Node moves, for example after an upgrade under another path, run this again.',
      'To take all of it away: the same command with --remove.',
      '',
    ].join('\n'),
  )
  return 0
}

/** Reads the manifest back, for the diagnosis and the tests. */
export function readManifest(paths: BrowserPaths): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(paths.manifestFile, 'utf8')) as Record<string, unknown>
  } catch {
    return undefined
  }
}
