import { describe, it, expect, vi } from 'vitest'

/**
 * The keyring library decides by the environment which store it uses, so the
 * D-Bus address has to be in place before it is loaded (#54). Both modules are
 * stand-ins here, which records the order and keeps the real library, and with
 * it the real keyring, out of this test.
 */

const calls = vi.hoisted(() => [] as string[])

vi.mock('../../src/credentials/session-bus.js', () => ({
  prepareSessionBus: () => {
    calls.push('address')
    return 'secret-service'
  },
}))
vi.mock('@napi-rs/keyring', () => {
  calls.push('library')
  return { Entry: class {} }
})

import { _resetKeyringModule, loadKeyringModule } from '../../src/credentials/keyring.js'

describe('loadKeyringModule', () => {
  it('supplies the D-Bus address before the library is loaded', async () => {
    _resetKeyringModule()
    expect(await loadKeyringModule()).toBeDefined()
    expect(calls).toEqual(['address', 'library'])
  })
})
