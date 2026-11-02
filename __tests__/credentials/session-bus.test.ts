import { describe, it, expect } from 'vitest'
import { KERNEL_KEYRING_NOTE, prepareSessionBus } from '../../src/credentials/session-bus.js'
import { listStores } from '../../src/credentials/availability.js'

/**
 * Which store "System keyring" is on Linux depends on DBUS_SESSION_BUS_ADDRESS,
 * and MCP clients leave it out by default. Measured on 2026-11-02: without it
 * the library writes to the kernel's keyring, with it to the desktop's, and
 * neither process sees what the other wrote. Every case here passes its own
 * environment, so no test changes the one it runs in.
 */

const sockets = (...paths: string[]) => (path: string) => paths.includes(path)

describe('prepareSessionBus', () => {
  it('leaves other systems alone', () => {
    const env: NodeJS.ProcessEnv = {}
    expect(prepareSessionBus({ env, platform: 'darwin', isSocket: () => true })).toBe('platform')
    expect(prepareSessionBus({ env, platform: 'win32', isSocket: () => true })).toBe('platform')
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBeUndefined()
  })

  it('supplies the session bus from XDG_RUNTIME_DIR when the address is missing', () => {
    const env: NodeJS.ProcessEnv = { XDG_RUNTIME_DIR: '/run/user/1000' }
    const backend = prepareSessionBus({
      env,
      platform: 'linux',
      uid: 1000,
      isSocket: sockets('/run/user/1000/bus'),
    })
    expect(backend).toBe('secret-service')
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=/run/user/1000/bus')
  })

  it('finds the bus under /run/user without XDG_RUNTIME_DIR, as an MCP client starts it', () => {
    // HOME, LOGNAME, PATH, SHELL, TERM and USER: what the SDK passes on.
    const env: NodeJS.ProcessEnv = { HOME: '/home/someone', PATH: '/usr/bin', USER: 'someone' }
    const backend = prepareSessionBus({
      env,
      platform: 'linux',
      uid: 1000,
      isSocket: sockets('/run/user/1000/bus'),
    })
    expect(backend).toBe('secret-service')
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=/run/user/1000/bus')
  })

  it('says kernel when there is no bus to find, and sets nothing', () => {
    const env: NodeJS.ProcessEnv = { XDG_RUNTIME_DIR: '/run/user/1000' }
    expect(prepareSessionBus({ env, platform: 'linux', uid: 1000, isSocket: () => false })).toBe('kernel')
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBeUndefined()
  })

  it('keeps an address that was given, and does not look for another', () => {
    const env: NodeJS.ProcessEnv = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/somewhere/bus' }
    const looked: string[] = []
    const backend = prepareSessionBus({
      env,
      platform: 'linux',
      uid: 1000,
      isSocket: (path) => {
        looked.push(path)
        return path === '/somewhere/bus'
      },
    })
    expect(backend).toBe('secret-service')
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=/somewhere/bus')
    expect(looked).toEqual(['/somewhere/bus'])
  })

  it('says kernel for a given address whose socket is not there', () => {
    // What the library does then, as measured: it falls back to the kernel.
    const env: NodeJS.ProcessEnv = { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent/bus' }
    expect(prepareSessionBus({ env, platform: 'linux', uid: 1000, isSocket: () => false })).toBe('kernel')
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=/nonexistent/bus')
  })

  it('takes an address it cannot check as given', () => {
    const env: NodeJS.ProcessEnv = { DBUS_SESSION_BUS_ADDRESS: 'unix:abstract=/tmp/dbus-abc,guid=1' }
    expect(prepareSessionBus({ env, platform: 'linux', uid: 1000, isSocket: () => false })).toBe(
      'secret-service',
    )
  })

  it('reads the path out of an address with more than one part', () => {
    const env: NodeJS.ProcessEnv = { DBUS_SESSION_BUS_ADDRESS: 'unix:guid=1,path=/run/user/1000/bus' }
    expect(
      prepareSessionBus({ env, platform: 'linux', uid: 1000, isSocket: sockets('/run/user/1000/bus') }),
    ).toBe('secret-service')
  })
})

describe('the keyring option when the kernel holds it', () => {
  const working = async () => ({ ok: true as const, writeMs: 1, readMs: 1 })

  it('says so on the sign-in page, because the probe works there too', async () => {
    const stores = await listStores({ probe: working, backend: () => 'kernel' })
    const keyring = stores.find((s) => s.kind === 'keyring')
    expect(keyring?.available).toBe(true)
    expect(keyring?.note).toBe(KERNEL_KEYRING_NOTE)
    expect(KERNEL_KEYRING_NOTE).toContain('gone after a restart')
  })

  it('adds nothing for the desktop keyring', async () => {
    const stores = await listStores({ probe: working, backend: () => 'secret-service' })
    expect(stores.find((s) => s.kind === 'keyring')?.note).toBeUndefined()
  })

  it('adds nothing to a keyring that does not work at all', async () => {
    const stores = await listStores({
      probe: async () => ({ ok: false, reason: 'no service' }),
      backend: () => 'kernel',
    })
    const keyring = stores.find((s) => s.kind === 'keyring')
    expect(keyring?.reason).toBe('no service')
    expect(keyring?.note).toBeUndefined()
  })
})
