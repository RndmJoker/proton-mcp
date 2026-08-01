import { describe, it, expect } from 'vitest'
import { isNewer, latestVersion, PACKAGE } from '../../src/tools/updates.js'

/**
 * Asking whether a newer version exists.
 *
 * The tests that matter here are not about version arithmetic. They are about
 * the one property this tool spends: every other part of this server talks to
 * `127.0.0.1` and nothing else, and the readme leads with that. So what is
 * checked is that the exception stays as small as it was described: one host,
 * one package, nothing sent, and a failure that is an answer rather than a
 * fault.
 */

describe('comparing versions', () => {
  it('orders ordinary releases', () => {
    expect(isNewer('0.4.5', '0.4.4')).toBe(true)
    expect(isNewer('0.4.4', '0.4.4')).toBe(false)
    expect(isNewer('0.4.4', '0.4.5')).toBe(false)
    expect(isNewer('1.0.0', '0.9.9')).toBe(true)
  })

  it('compares numbers rather than text', () => {
    // The mistake this catches: "0.10.0" sorts before "0.9.0" as a string, so
    // the tenth minor release would look older than the ninth and nobody would
    // ever be told about it again.
    expect(isNewer('0.10.0', '0.9.0')).toBe(true)
    expect(isNewer('0.9.0', '0.10.0')).toBe(false)
  })

  it('treats a prerelease as older than the release it precedes', () => {
    expect(isNewer('0.4.4', '0.4.4-beta.1')).toBe(true)
    expect(isNewer('0.4.4-beta.1', '0.4.4')).toBe(false)
  })

  it('does not fall over on something that is not a version', () => {
    expect(() => isNewer('', '0.4.4')).not.toThrow()
    expect(() => isNewer('nonsense', '0.4.4')).not.toThrow()
  })
})

describe('the one outgoing request this server makes', () => {
  it('asks exactly one host for exactly one package', async () => {
    let asked: string | undefined
    await latestVersion((async (url: string) => {
      asked = String(url)
      return new Response(JSON.stringify({ version: '9.9.9' }), { status: 200 })
    }) as never)

    expect(asked).toBeDefined()
    const parsed = new URL(asked!)
    expect(parsed.protocol).toBe('https:')
    expect(parsed.hostname).toBe('registry.npmjs.org')
    expect(decodeURIComponent(parsed.pathname)).toBe(`/${PACKAGE}/latest`)
  })

  it('sends nothing but a request for that package', async () => {
    let init: RequestInit | undefined
    await latestVersion((async (_url: string, options: RequestInit) => {
      init = options
      return new Response(JSON.stringify({ version: '9.9.9' }), { status: 200 })
    }) as never)

    // No body, no method that carries one, and nothing that could describe the
    // user or their mailbox.
    expect(init?.body).toBeUndefined()
    expect(init?.method ?? 'GET').toBe('GET')
    expect(JSON.stringify(init?.headers ?? {})).not.toMatch(/proton|mail|user|token/i)
  })

  it('reports being unable to look, rather than failing', async () => {
    // Offline, a proxy, a registry that is down. None of that is a fault in
    // this server, and answering as though it were would send somebody
    // debugging the wrong thing.
    const offline = await latestVersion((async () => {
      throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org')
    }) as never)
    expect(offline.unreachable).toContain('ENOTFOUND')
    expect(offline.latest).toBeUndefined()
  })

  it('treats a refusal from the registry the same way', async () => {
    const refused = await latestVersion((async () =>
      new Response('nope', { status: 503 })) as never)
    expect(refused.unreachable).toContain('503')
    expect(refused.latest).toBeUndefined()
  })

  it('does not believe an answer without a version in it', async () => {
    const odd = await latestVersion((async () =>
      new Response(JSON.stringify({ nothing: true }), { status: 200 })) as never)
    expect(odd.latest).toBeUndefined()
    expect(odd.unreachable).toBeDefined()
  })

  it('gives up rather than holding a tool call open', async () => {
    // A registry that accepts the connection and then says nothing must not
    // leave the caller waiting.
    const started = Date.now()
    const result = await latestVersion(
      (async (_url: string, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })) as never,
      50,
    )
    expect(result.unreachable).toBeDefined()
    expect(Date.now() - started).toBeLessThan(2000)
  })
})
