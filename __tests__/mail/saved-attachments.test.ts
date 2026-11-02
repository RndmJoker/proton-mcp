import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KEEP_MS, MAX_SAVE_BYTES, SavedAttachments, SaveRefused } from '../../src/mail/saved-attachments.js'

/**
 * Saving writes decrypted mail to a disk, into a directory that may hold other
 * files too. Each test pins one part of the boundary.
 */

let base: string
let root: string
let records: string
let outside: string

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'proton-mcp-saved-'))
  root = join(base, 'root')
  records = join(base, 'records')
  outside = join(base, 'outside')
  mkdirSync(root)
  mkdirSync(outside)
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(base, { recursive: true, force: true })
})

const store = (over: Partial<ConstructorParameters<typeof SavedAttachments>[0]> = {}) =>
  new SavedAttachments({ root, recordDir: records, ...over })

const CONTENT = Buffer.from('%PDF-1.7 not really a pdf')

describe('where a file may go', () => {
  it('explains how to set it up when no directory is set', () => {
    expect(() => store({ root: undefined }).assertUsable()).toThrow(/PROTON_MCP_ATTACHMENT_DIR/)
    expect(() => store({ root: undefined }).save('a.pdf', CONTENT, 'application/pdf')).toThrow(SaveRefused)
  })

  it('refuses a directory given as a relative path', () => {
    expect(() => store({ root: 'relative/dir' }).assertUsable()).toThrow(/absolute path/)
  })

  it('does not create a directory that is not there', () => {
    const missing = join(base, 'missing')
    expect(() => store({ root: missing }).assertUsable()).toThrow(/does not exist/)
    expect(existsSync(missing)).toBe(false)
  })

  it('saves into the directory', () => {
    const saved = store().save('report.pdf', CONTENT, 'application/pdf')
    expect(saved.path).toBe(join(root, 'report.pdf'))
    expect(readFileSync(saved.path)).toEqual(CONTENT)
  })

  it('saves into a folder inside it, created as needed', () => {
    const saved = store().save('report.pdf', CONTENT, 'application/pdf', 'session/files')
    expect(saved.path).toBe(join(root, 'session', 'files', 'report.pdf'))
    expect(statSync(join(root, 'session')).mode & 0o777).toBe(0o700)
  })

  it('takes a folder given as an absolute path inside the directory', () => {
    const saved = store().save('report.pdf', CONTENT, 'application/pdf', join(root, 'abs'))
    expect(saved.path).toBe(join(root, 'abs', 'report.pdf'))
  })

  it('refuses a folder outside the directory, however it is written', () => {
    expect(() => store().save('a.pdf', CONTENT, 'application/pdf', outside)).toThrow(/outside the directory/)
    expect(() => store().save('a.pdf', CONTENT, 'application/pdf', '../outside')).toThrow(/outside the directory/)
    expect(readdirSync(outside)).toEqual([])
  })

  it('refuses a folder reached through a symbolic link, and creates nothing on the far side', () => {
    symlinkSync(outside, join(root, 'link'))
    expect(() => store().save('a.pdf', CONTENT, 'application/pdf', 'link/sub')).toThrow(/symbolic link/)
    expect(readdirSync(outside)).toEqual([])
  })

  it('reduces the name the sender chose to a plain one', () => {
    const saved = store().save('../../evil.sh', CONTENT, 'text/x-sh')
    expect(saved.path.startsWith(`${root}/`)).toBe(true)
    expect(saved.path).not.toContain('/../')
  })
})

describe('what is written', () => {
  it('is readable by the user only', () => {
    const saved = store().save('report.pdf', CONTENT, 'application/pdf')
    expect(statSync(saved.path).mode & 0o777).toBe(0o600)
  })

  it('reports the size and the checksum of what was written', () => {
    const saved = store().save('report.pdf', CONTENT, 'application/pdf')
    expect(saved.size).toBe(CONTENT.length)
    expect(saved.sha256).toBe(createHash('sha256').update(CONTENT).digest('hex'))
  })

  it('never replaces an existing file', () => {
    writeFileSync(join(root, 'report.pdf'), 'mine')
    const saved = store().save('report.pdf', CONTENT, 'application/pdf')
    expect(saved.path).toBe(join(root, 'report (2).pdf'))
    expect(readFileSync(join(root, 'report.pdf'), 'utf8')).toBe('mine')
  })

  it('never writes through a link standing where the file would go', () => {
    const target = join(outside, 'victim')
    writeFileSync(target, 'precious')
    symlinkSync(target, join(root, 'report.pdf'))
    const saved = store().save('report.pdf', CONTENT, 'application/pdf')
    expect(saved.path).toBe(join(root, 'report (2).pdf'))
    expect(readFileSync(target, 'utf8')).toBe('precious')
  })

  it('refuses more than the limit and writes nothing', () => {
    const big = Buffer.alloc(MAX_SAVE_BYTES + 1)
    expect(() => store().save('big.bin', big, 'application/octet-stream')).toThrow(/more than/)
    expect(readdirSync(root)).toEqual([])
  })
})

describe('deleting', () => {
  it('deletes everything this server saved', () => {
    const s = store()
    const a = s.save('a.pdf', CONTENT, 'application/pdf')
    const b = s.save('b.pdf', CONTENT, 'application/pdf')
    const report = s.delete()
    expect(report.deleted.sort()).toEqual([a.path, b.path].sort())
    expect(existsSync(a.path) || existsSync(b.path)).toBe(false)
  })

  it('deletes only the paths named', () => {
    const s = store()
    const a = s.save('a.pdf', CONTENT, 'application/pdf')
    const b = s.save('b.pdf', CONTENT, 'application/pdf')
    expect(s.delete([a.path]).deleted).toEqual([a.path])
    expect(existsSync(b.path)).toBe(true)
  })

  it('never touches a file it did not save', () => {
    const foreign = join(root, 'mine.txt')
    writeFileSync(foreign, 'not yours')
    const s = store()
    s.save('a.pdf', CONTENT, 'application/pdf')
    expect(s.delete([foreign]).unknown).toEqual([foreign])
    s.delete()
    expect(readFileSync(foreign, 'utf8')).toBe('not yours')
  })

  it('leaves a file that was changed since it was saved', () => {
    const s = store()
    const saved = s.save('a.pdf', CONTENT, 'application/pdf')
    writeFileSync(saved.path, 'edited by someone')
    expect(s.delete().left).toEqual([saved.path])
    expect(readFileSync(saved.path, 'utf8')).toBe('edited by someone')
  })

  it('leaves a file that was replaced by another of the same name', () => {
    const s = store()
    const saved = s.save('a.pdf', CONTENT, 'application/pdf')
    rmSync(saved.path)
    writeFileSync(saved.path, CONTENT)
    expect(s.delete().left).toEqual([saved.path])
    expect(existsSync(saved.path)).toBe(true)
  })
})

describe('clearing up on its own', () => {
  it('deletes a file once its hour is up', () => {
    vi.useFakeTimers()
    const s = store()
    const saved = s.save('a.pdf', CONTENT, 'application/pdf')
    vi.advanceTimersByTime(KEEP_MS - 1000)
    expect(existsSync(saved.path)).toBe(true)
    vi.advanceTimersByTime(1000)
    expect(existsSync(saved.path)).toBe(false)
  })

  it('says when that will be', () => {
    const now = Date.parse('2026-11-02T12:00:00Z')
    const saved = store({ now: () => now }).save('a.pdf', CONTENT, 'application/pdf')
    expect(saved.expiresAt.toISOString()).toBe('2026-11-02T13:00:00.000Z')
  })

  it('deletes what it saved when it stops, and nothing else', () => {
    const foreign = join(root, 'mine.txt')
    writeFileSync(foreign, 'not yours')
    const s = store()
    const saved = s.save('a.pdf', CONTENT, 'application/pdf')
    s.stop()
    expect(existsSync(saved.path)).toBe(false)
    expect(existsSync(foreign)).toBe(true)
    expect(existsSync(records) ? readdirSync(records) : []).toEqual([])
  })

  it('clears up after a server that no longer runs', () => {
    const killed = store({ pid: 4242, isAlive: () => false })
    const saved = killed.save('a.pdf', CONTENT, 'application/pdf')
    // Killed: no stop(), so its file and its record stay behind.
    store({ pid: 4343, isAlive: () => false }).start()
    expect(existsSync(saved.path)).toBe(false)
    expect(readdirSync(records)).toEqual([])
  })

  it('leaves a server that still runs its files within their hour', () => {
    const running = store({ pid: 4242, isAlive: () => true })
    const saved = running.save('a.pdf', CONTENT, 'application/pdf')
    store({ pid: 4343, isAlive: () => true }).start()
    expect(existsSync(saved.path)).toBe(true)
  })

  it('takes away what a running server left well past its hour', () => {
    const start = Date.parse('2026-11-02T12:00:00Z')
    const running = store({ pid: 4242, isAlive: () => true, now: () => start })
    const saved = running.save('a.pdf', CONTENT, 'application/pdf')
    store({ pid: 4343, isAlive: () => true, now: () => start + KEEP_MS + 11 * 60_000 }).start()
    expect(existsSync(saved.path)).toBe(false)
  })
})
