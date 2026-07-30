/**
 * Credentials in an unencrypted file.
 *
 * A fully supported option, not a leftover. It is the only one that never
 * prompts for anything and can be written by a script, which is what makes it
 * the choice for automated setups. The price is stated plainly: file permissions
 * are all that protect it.
 *
 * This is also the format the server already reads on startup, so an existing
 * setup keeps working.
 */

import { readFile, writeFile, unlink, mkdir, stat, chmod } from 'node:fs/promises'
import { dirname } from 'node:path'
import { platform } from 'node:os'
import type { CredentialStore, Credentials } from './store.js'
import { credentialsPath, parseEnvFile, permissionWarning } from '../config.js'

export class PlainFileStore implements CredentialStore {
  readonly kind = 'plain-file' as const

  constructor(
    private readonly path: string = credentialsPath(),
    /** Where warnings go. stderr, never stdout, which carries the protocol. */
    private readonly notify: (message: string) => void = () => undefined,
  ) {}

  async load(): Promise<Credentials | undefined> {
    let content: string
    try {
      content = await readFile(this.path, 'utf8')
    } catch {
      return undefined
    }

    if (platform() !== 'win32') {
      try {
        const warning = permissionWarning((await stat(this.path)).mode)
        if (warning) this.notify(`${this.path}: ${warning}`)
      } catch {
        // Failing to stat a file we just read is not worth reporting.
      }
    }

    const values = parseEnvFile(content)
    const user = values.BRIDGE_USER?.trim()
    const pass = values.BRIDGE_PASS
    if (!user || !pass) return undefined
    return { user, pass }
  }

  async save(credentials: Credentials): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })

    // Keep the shape a person can read and edit, since being editable by hand is
    // half the point of this option.
    const content = [
      '# Proton Mail Bridge credentials for proton-mcp.',
      '#',
      '# BRIDGE_PASS is the password the Bridge generates, NOT your Proton account',
      '# password. This file is unencrypted: its permissions are what protect it.',
      `BRIDGE_USER=${credentials.user}`,
      `BRIDGE_PASS=${credentials.pass}`,
      '',
    ].join('\n')

    await writeFile(this.path, content, { mode: 0o600 })
    // writeFile only applies the mode when it creates the file, so an existing
    // one with loose permissions would silently keep them.
    await chmod(this.path, 0o600)
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.path)
    } catch {
      // Already gone is the outcome we wanted.
    }
  }
}
