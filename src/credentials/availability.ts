/**
 * Which storage options actually work on this machine.
 *
 * A table saying "Linux can do this" would be wrong: the same Linux with and
 * without a graphical session is a different machine as far as a keyring is
 * concerned. So the keyring is probed for real, by writing a value and reading
 * it back.
 *
 * The probe runs in a **child process**, and that is the whole point of this
 * module. A locked keyring opens a dialog, the underlying calls are synchronous,
 * and a synchronous call cannot be abandoned from the same thread. In-process
 * the probe could therefore hang forever, taking the server with it. A child
 * process can be killed.
 */

import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { platform } from 'node:os'
import {
  STORE_DESCRIPTIONS,
  PRESENTATION_ORDER,
  type StoreKind,
  type StoreDescription,
} from './store.js'

export interface StoreAvailability extends StoreDescription {
  available: boolean
  /** Why it cannot be used. Only set when available is false. */
  reason?: string
  /** How long the probe took, for diagnostics. Only for the keyring. */
  probeMs?: number
}

/** How long the keyring probe may take before it counts as unusable. */
export const PROBE_TIMEOUT_MS = 5000

export type ProbeResult =
  | { ok: true; writeMs: number; readMs: number }
  | { ok: false; reason: string }

/**
 * Probes the keyring in a child process.
 *
 * Timing out is a normal result, not an error: it is what a locked keyring looks
 * like from the outside, and the answer in both cases is the same, namely that
 * this option cannot be relied on right now.
 */
export function probeKeyring(timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const here = dirname(fileURLToPath(import.meta.url))
    const child = fork(join(here, 'probe-keyring.js'), [], {
      // The child must not inherit stdio: this process speaks the MCP protocol
      // over stdout, and a stray line from a child would corrupt it.
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })

    let settled = false
    const finish = (result: ProbeResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill('SIGKILL')
      resolve(result)
    }

    const timer = setTimeout(() => {
      finish({
        ok: false,
        reason:
          `the keyring did not answer within ${timeoutMs} ms. It is probably locked and waiting ` +
          'for input. Unlock it and try again, or choose a different place to keep the credentials.',
      })
    }, timeoutMs)

    child.on('message', (message) => finish(message as ProbeResult))
    child.on('error', (error) => finish({ ok: false, reason: error.message }))
    child.on('exit', (code) => {
      if (settled) return
      finish({ ok: false, reason: `the probe exited unexpectedly with code ${code}.` })
    })
  })
}

/**
 * Lists every option with whether it works here.
 *
 * All four are always listed. An unavailable one keeps its description and gains
 * a reason, rather than disappearing: a user who wonders why the keyring is not
 * offered deserves an answer instead of a shorter list.
 */
export async function listStores(
  options: { probe?: (timeoutMs?: number) => Promise<ProbeResult>; os?: string } = {},
): Promise<StoreAvailability[]> {
  const probe = options.probe ?? probeKeyring

  const started = Date.now()
  const keyring = await probe()
  const probeMs = Date.now() - started

  return PRESENTATION_ORDER.map((kind) => {
    const entry: StoreAvailability = { ...STORE_DESCRIPTIONS[kind], available: true }
    if (kind === 'keyring') {
      entry.available = keyring.ok
      entry.probeMs = probeMs
      if (!keyring.ok) entry.reason = keyring.reason
    }
    return entry
  })
}

/**
 * The option to preselect.
 *
 * The keyring when it works, because it is the only one that is both convenient
 * and not a file. Otherwise the encrypted file, which works everywhere. Never
 * the plain file: that one should be a deliberate choice, not a default someone
 * ends up with.
 */
export function recommend(stores: StoreAvailability[]): StoreKind {
  return stores.find((s) => s.kind === 'keyring')?.available ? 'keyring' : 'encrypted-file'
}

/** Why the recommendation is what it is, for display next to it. */
export function recommendationReason(stores: StoreAvailability[]): string {
  const keyring = stores.find((s) => s.kind === 'keyring')
  if (keyring?.available) {
    return (
      'Suggested because this machine has a working keyring, and it is the only option that is both ' +
      'convenient and keeps the password out of a file. You can pick any of the others.'
    )
  }
  return (
    'The system keyring is not usable on this machine, so the encrypted file is suggested instead: ' +
    'it works everywhere and keeps the password unreadable without your master password. ' +
    `Reason the keyring is out: ${keyring?.reason ?? 'unknown'}`
  )
}
