import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * What gets published, and what must not travel with it.
 *
 * These are the mistakes that are invisible until a stranger installs the
 * package: a scoped package that defaults to private and refuses the first
 * publish, a file list that quietly grows, a protocol name that turns into a
 * registry path. None of them fails a build, and none of them is noticed by
 * anyone who only ever runs the server from this directory.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  name: string
  bin: Record<string, string>
  files: string[]
  license: string
  publishConfig?: { access?: string; provenance?: boolean }
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
}

describe('the published package', () => {
  it('lives under a namespace', () => {
    // Scoped so that other servers can sit beside it later, and because the
    // name of a mail tool that is not Proton's should say whose it is.
    expect(pkg.name).toBe('@rndmjoker/proton-mcp')
  })

  it('declares itself public', () => {
    // A scoped package is private by default. Without this the very first
    // publish is refused, which is a confusing way to learn about scopes.
    expect(pkg.publishConfig?.access).toBe('public')
  })

  it('asks for provenance', () => {
    // A signed statement of which commit produced the tarball. Worth more for
    // something that handles credentials than it costs.
    expect(pkg.publishConfig?.provenance).toBe(true)
  })

  it('keeps the command short', () => {
    // The scope belongs to the registry, not to the command line. Installed
    // globally this is `proton-mcp`, not `@rndmjoker/proton-mcp`.
    expect(Object.keys(pkg.bin)).toEqual(['proton-mcp'])
  })

  it('ships the build and nothing else', () => {
    // Sources, tests and configuration have no business in an installed
    // package. The list is asserted rather than merely non-empty because it is
    // the kind of thing that grows by one entry at a time.
    expect(pkg.files.sort()).toEqual(['LICENSE', 'README.md', 'dist'])
  })

  it('carries a permissive licence itself', () => {
    expect(pkg.license).toBe('MIT')
  })

  it('keeps the test tooling out of the dependencies', () => {
    // A vulnerability in a test runner must not reach somebody who installed
    // this to read their mail. The audit job relies on the same separation.
    for (const name of ['vitest', 'typescript', '@vitest/coverage-v8']) {
      expect(pkg.dependencies[name]).toBeUndefined()
      expect(pkg.devDependencies[name]).toBeDefined()
    }
  })
})

describe('the name the server calls itself', () => {
  const source = readFileSync(join(root, 'src/server.ts'), 'utf8')

  it('is not taken from the package name', () => {
    // The scope is an ownership statement for a registry. In a protocol
    // handshake and at the front of every line on stderr it is only noise, and
    // a client would display it to the user.
    expect(source).toContain("const NAME = 'proton-mcp'")
    expect(source).not.toContain('const NAME = pkg.name')
  })

  it('still takes the version from package.json', () => {
    // The one thing that must never be written down twice.
    expect(source).toContain('const VERSION = pkg.version')
  })
})
