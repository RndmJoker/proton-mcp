/**
 * The servers running on this machine, as the shared interface lists them.
 *
 * Every client session starts its own server, and since 2026-11-05 all of them
 * share one interface. Each server keeps a small file here describing itself,
 * and the interface reads them to show who is running and who is signed in.
 * That is the place where a sign-in held by only one server becomes visible
 * instead of puzzling.
 *
 * What a file holds: process id, version, start time, whether the server is
 * signed in, as which address and where the password is kept, and whether it
 * shows the interface. Never a password, and nothing about mail. The address is
 * the same one the interface shows anyway.
 *
 * The directory sits beside the settings file rather than under
 * `$XDG_RUNTIME_DIR`. MCP clients start servers with a reduced environment that
 * leaves that variable out, and a location every server finds the same way is
 * worth more than a temporary file system. A server that was killed leaves its
 * file behind; any reader skips files whose process is gone, and removes them.
 */

import { mkdirSync, writeFileSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { StoreKind } from './credentials/store.js'
import { settingsPath } from './settings.js'

export interface InstanceRecord {
  pid: number
  version: string
  startedAt: number
  signedIn: boolean
  address?: string
  storeKind?: StoreKind
  servesInterface: boolean
}

/** Where the files live. Overridable for tests, like the settings file. */
export function instancesDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PROTON_MCP_RUNTIME_DIR) return join(env.PROTON_MCP_RUNTIME_DIR, 'instances')
  return join(dirname(settingsPath(env)), 'run', 'instances')
}

/** Whether a process with this id exists. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it exists and belongs to someone else, which still means alive.
    return (error as { code?: string }).code === 'EPERM'
  }
}

/** A change to a record. An undefined value removes that field. */
export type InstanceChange = { [K in keyof InstanceRecord]?: InstanceRecord[K] | undefined }

/** Writes this server's file and keeps it current until removed. */
export function registerInstance(
  initial: InstanceRecord,
  dir = instancesDir(),
): { update: (change: InstanceChange) => void; remove: () => void } {
  let record: InstanceRecord = { ...initial }
  const file = join(dir, `${record.pid}.json`)

  const write = (): void => {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const temporary = `${file}.tmp`
      writeFileSync(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 })
      renameSync(temporary, file)
    } catch {
      // Being missing from the list is a cosmetic problem. It must never stop a
      // server from working.
    }
  }

  write()
  return {
    update: (change) => {
      const next: Record<string, unknown> = { ...record }
      for (const [key, value] of Object.entries(change)) {
        if (value === undefined) delete next[key]
        else next[key] = value
      }
      if (JSON.stringify(next) === JSON.stringify(record)) return
      record = next as unknown as InstanceRecord
      write()
    },
    remove: () => {
      try {
        rmSync(file, { force: true })
      } catch {
        // Left behind; the next reader skips it once the process is gone.
      }
    },
  }
}

/** Every running server, oldest first. Files of finished processes are removed. */
export function listInstances(dir = instancesDir()): InstanceRecord[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }

  const records: InstanceRecord[] = []
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue
    const file = join(dir, name)
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    const record = parsed as Partial<InstanceRecord>
    if (typeof record.pid !== 'number' || typeof record.version !== 'string') continue
    if (!isAlive(record.pid)) {
      try {
        rmSync(file, { force: true })
      } catch {
        // Not ours to worry about.
      }
      continue
    }
    records.push({
      pid: record.pid,
      version: record.version,
      startedAt: typeof record.startedAt === 'number' ? record.startedAt : 0,
      signedIn: record.signedIn === true,
      servesInterface: record.servesInterface === true,
      ...(typeof record.address === 'string' ? { address: record.address } : {}),
      ...(typeof record.storeKind === 'string' ? { storeKind: record.storeKind } : {}),
    })
  }
  return records.sort((a, b) => a.startedAt - b.startedAt)
}
