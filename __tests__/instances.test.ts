import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerInstance, listInstances, isAlive, instancesDir } from '../src/instances.js'

/**
 * The list of running servers the shared interface shows.
 *
 * What matters: a server appears with what the overview needs and nothing more,
 * its entry follows its sign-in, and a server that was killed does not linger
 * in the list as though it were still running.
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'proton-mcp-instances-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const base = {
  pid: process.pid,
  version: '0.0.0-test',
  startedAt: 1000,
  signedIn: false,
  servesInterface: false,
}

describe('the list of running servers', () => {
  it('lists a registered server and forgets it when it is removed', () => {
    const entry = registerInstance(base, dir)
    expect(listInstances(dir)).toEqual([base])
    entry.remove()
    expect(listInstances(dir)).toEqual([])
  })

  it('follows a sign-in and a sign-out', () => {
    const entry = registerInstance(base, dir)
    entry.update({ signedIn: true, address: 'someone@example.com', storeKind: 'keyring' })
    expect(listInstances(dir)[0]).toMatchObject({ signedIn: true, address: 'someone@example.com', storeKind: 'keyring' })
    entry.update({ signedIn: false, address: undefined, storeKind: undefined })
    const after = listInstances(dir)[0]!
    expect(after.signedIn).toBe(false)
    expect(after).not.toHaveProperty('address')
    expect(after).not.toHaveProperty('storeKind')
  })

  it('holds no password, whatever it is given', () => {
    const entry = registerInstance(base, dir)
    entry.update({ signedIn: true, address: 'someone@example.com' })
    const raw = readdirSync(dir).map((name) => name)
    expect(raw).toEqual([`${process.pid}.json`])
    expect(JSON.stringify(listInstances(dir))).not.toMatch(/pass/i)
  })

  it('skips and removes the file of a process that is gone', () => {
    // A server that was killed leaves its file behind. The list must not show
    // it as running, and must clean up after it.
    const gone = 2 ** 22 + 12345
    expect(isAlive(gone)).toBe(false)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${gone}.json`), JSON.stringify({ ...base, pid: gone }))
    expect(listInstances(dir)).toEqual([])
    expect(readdirSync(dir)).toEqual([])
  })

  it('ignores files that are not entries', () => {
    writeFileSync(join(dir, 'notes.txt'), 'x')
    writeFileSync(join(dir, `${process.pid}.json`), 'not json')
    expect(listInstances(dir)).toEqual([])
  })

  it('lives beside the settings file unless told otherwise', () => {
    expect(instancesDir({ PROTON_MCP_SETTINGS_FILE: '/x/y/settings.json' })).toBe('/x/y/run/instances')
    expect(instancesDir({ PROTON_MCP_RUNTIME_DIR: '/r' })).toBe('/r/instances')
  })
})
