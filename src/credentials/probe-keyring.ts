/**
 * Probes the system keyring, meant to be run as a child process.
 *
 * It lives in its own process for one reason: a locked keyring opens a dialog
 * and the underlying calls are synchronous, so the probe may never return.
 * A hanging process can be killed, a hanging call cannot.
 *
 * The result goes back over IPC. Nothing is written to stdout or stderr, because
 * the parent speaks the MCP protocol over stdout.
 */

import { KeyringStore, loadKeyringModule } from './keyring.js'
import type { ProbeResult } from './availability.js'

const SERVICE = 'proton-mcp-selftest'
const ACCOUNT = 'availability-probe'

function report(result: ProbeResult): void {
  process.send?.(result)
  // Exit right away. A keyring binding may keep handles open that would
  // otherwise hold the process alive.
  process.exit(0)
}

async function main(): Promise<void> {
  const module = await loadKeyringModule()
  if (!module) {
    report({
      ok: false,
      reason:
        'the optional dependency @napi-rs/keyring is not installed, or has no prebuilt binary for ' +
        'this platform.',
    })
    return
  }

  // A separate service name, so the probe never touches the real entry.
  const store = new KeyringStore(SERVICE, ACCOUNT)
  const value = { user: 'probe', pass: `probe-${process.pid}` }

  try {
    const t0 = process.hrtime.bigint()
    await store.save(value)
    const writeMs = Number(process.hrtime.bigint() - t0) / 1e6

    const t1 = process.hrtime.bigint()
    const readBack = await store.load()
    const readMs = Number(process.hrtime.bigint() - t1) / 1e6

    // Clean up before reporting, so a failure below cannot leave the entry
    // behind.
    await store.clear()

    if (readBack?.pass !== value.pass) {
      report({
        ok: false,
        reason: 'the keyring accepted a value but returned something else when read back.',
      })
      return
    }

    report({ ok: true, writeMs, readMs })
  } catch (error) {
    report({ ok: false, reason: (error as Error)?.message ?? String(error) })
  }
}

void main()
