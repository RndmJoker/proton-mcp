/**
 * Attachments saved to this machine, and taking them away again.
 *
 * Saving means writing what Proton keeps encrypted, decrypted, to a disk. That
 * is worth doing so an assistant can open a PDF or a spreadsheet rather than
 * only say it exists, and it is bounded on every side:
 *
 * - **Only into a directory the user named**, in PROTON_MCP_ATTACHMENT_DIR, and
 *   only through the environment: a setting in the web interface would be
 *   within reach of an assistant, which gets that page's address. Without the
 *   variable nothing is written and the tool says how to set it up.
 * - **Nothing outside it.** A folder is checked after it is resolved, `..` is
 *   refused, and so is a symbolic link anywhere on the way.
 * - **The name comes from the sender** and is reduced to a plain one, with the
 *   rule in mime/filenames.ts. An existing file is never replaced: the file is
 *   created with O_EXCL, which also refuses to follow a link in its place.
 * - **Readable by the user only**, 0600, and folders created here 0700.
 * - **Gone again within the hour.** Decided by Tobi on 2026-11-02: a file lies
 *   unattended for at most one hour, and is deleted when the server stops.
 *   Better the assistant fetches it again than that it lies around for days.
 *   A server that was killed leaves its files to the next one to start.
 *
 * What may be deleted is recorded per process, in this server's own
 * configuration directory rather than in the directory the files go to. Each
 * running server writes only its own record, so two of them never overwrite
 * each other's. Before anything is deleted it is checked to be the very file
 * that was saved: the same inode, size and modification time, a plain file and
 * not a link. A file replaced or changed since is left where it is, because in
 * the directory there may be files that are not ours.
 *
 * A folder created for a file goes again once it is empty, decided by Tobi on
 * 2026-11-02: its name can say what was in it. Recorded like the files, with
 * its inode, and removed with rmdir, which takes an empty folder and nothing
 * else. A folder that was there before is never recorded and never removed.
 */

import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse as parsePath, relative, resolve, sep } from 'node:path'
import { BridgeError } from '../bridge/errors.js'
import { plainFileName } from '../mime/filenames.js'

/** How long a saved file may lie, fixed. */
export const KEEP_MS = 60 * 60 * 1000

/** Proton accepts up to 25 MB per message, so no real attachment is larger. */
export const MAX_SAVE_BYTES = 25 * 1024 * 1024

/** How long past its hour a file of a server that still runs is left to it. */
const GRACE_MS = 10 * 60 * 1000

/** The variable that names the directory. */
export const ATTACHMENT_DIR_VARIABLE = 'PROTON_MCP_ATTACHMENT_DIR'

/** A refusal to save or delete, explained. Reported like any explained failure. */
export class SaveRefused extends BridgeError {
  override name = 'SaveRefused'
}

/** One file this server wrote, with what identifies it as that file. */
export interface SavedEntry {
  path: string
  dev: number
  ino: number
  size: number
  mtimeMs: number
  savedAt: string
  expiresAt: string
}

/** A folder this server created, with what identifies it as that folder. */
export interface CreatedFolder {
  path: string
  dev: number
  ino: number
}

interface SaveRecord {
  pid: number
  startedAt: string
  entries: SavedEntry[]
  /** Folders created for those files. Absent from records written before 2026-11-02. */
  folders?: CreatedFolder[]
}

/** What save hands back. */
export interface SavedFile {
  path: string
  size: number
  contentType: string
  sha256: string
  expiresAt: Date
}

/** What delete did, file by file. */
export interface DeleteReport {
  deleted: string[]
  /** Changed or replaced since it was saved, so left in place. */
  left: string[]
  /** Already gone. */
  missing: string[]
  /** Not a file this server saved, so not touched. */
  unknown: string[]
  /** Folders this server had created and removed again, because they were empty. */
  folders: string[]
}

export interface SavedAttachmentsOptions {
  /** The directory from PROTON_MCP_ATTACHMENT_DIR, if it is set. */
  root: string | undefined
  /** Where the records live. Defaults to this server's configuration directory. */
  recordDir?: string
  now?: () => number
  pid?: number
  /** Whether a process still runs. Replaced in tests. */
  isAlive?: (pid: number) => boolean
}

/** Where the records live unless told otherwise. */
export function defaultRecordDir(): string {
  return join(homedir(), '.config', 'proton-mcp', 'saved-attachments')
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it exists, it is merely not ours to signal.
    return (error as { code?: string }).code === 'EPERM'
  }
}

/** A file whose identity no longer matches the record is not ours to delete. */
function deleteIfSame(entry: SavedEntry): 'deleted' | 'left' | 'missing' {
  let info
  try {
    info = lstatSync(entry.path)
  } catch {
    return 'missing'
  }
  const same =
    info.isFile() &&
    info.dev === entry.dev &&
    info.ino === entry.ino &&
    info.size === entry.size &&
    info.mtimeMs === entry.mtimeMs
  if (!same) return 'left'
  try {
    unlinkSync(entry.path)
  } catch {
    // Not deletable, permissions for instance. Left and reported rather than
    // letting one file stop the clearing up of all the others.
    return 'left'
  }
  return 'deleted'
}

/**
 * Removes the folders this server created that are empty now, deepest first,
 * so that a parent can follow its child.
 *
 * rmdir and nothing stronger: whatever someone put into a folder keeps it
 * standing. And only while it is still the folder that was created, the same
 * inode, never a link in its place. Returns what went and what is left to
 * watch; a folder that is gone or no longer ours is neither.
 */
function pruneFolders(folders: readonly CreatedFolder[]): { removed: string[]; kept: CreatedFolder[] } {
  const removed: string[] = []
  const kept: CreatedFolder[] = []
  const deepestFirst = [...folders].sort((a, b) => b.path.split(sep).length - a.path.split(sep).length)
  for (const folder of deepestFirst) {
    let info
    try {
      info = lstatSync(folder.path)
    } catch {
      continue
    }
    if (!info.isDirectory() || info.dev !== folder.dev || info.ino !== folder.ino) continue
    try {
      rmdirSync(folder.path)
      removed.push(folder.path)
    } catch {
      // Not empty, or not removable: watched until this server stops.
      kept.push(folder)
    }
  }
  return { removed, kept }
}

export class SavedAttachments {
  readonly #root: string | undefined
  readonly #recordDir: string
  readonly #now: () => number
  readonly #pid: number
  readonly #isAlive: (pid: number) => boolean
  readonly #startedAt: string
  readonly #timers = new Map<string, NodeJS.Timeout>()
  #entries: SavedEntry[] = []
  #folders: CreatedFolder[] = []

  constructor(options: SavedAttachmentsOptions) {
    this.#root = options.root?.trim() || undefined
    this.#recordDir = options.recordDir ?? defaultRecordDir()
    this.#now = options.now ?? Date.now
    this.#pid = options.pid ?? process.pid
    this.#isAlive = options.isAlive ?? processAlive
    this.#startedAt = new Date(this.#now()).toISOString()
  }

  /** Whether the user set a directory at all. */
  get configured(): boolean {
    return this.#root !== undefined
  }

  /**
   * Throws the explanation when nothing can be saved: no directory set, or one
   * that is not there. Called before a message is fetched, so that nothing is
   * decrypted only to be thrown away.
   */
  assertUsable(): void {
    this.#realRoot()
  }

  /** This process's own record, named so that no two processes share one. */
  get #recordPath(): string {
    return join(this.#recordDir, `${this.#pid}-${Date.parse(this.#startedAt)}.json`)
  }

  /** The directory, resolved, or the reason it cannot be used. */
  #realRoot(): string {
    const root = this.#root
    if (root === undefined) {
      throw new SaveRefused(
        `Saving attachments is not set up. The user has to set ${ATTACHMENT_DIR_VARIABLE} to a ` +
          'directory, in the configuration this MCP server is started with, and restart the client. ' +
          'Files are saved there and nowhere else. Until then an attachment can only be read with ' +
          'get_attachment, and only when it is text.',
      )
    }
    if (!isAbsolute(root)) {
      throw new SaveRefused(`${ATTACHMENT_DIR_VARIABLE} has to be an absolute path, and "${root}" is not.`)
    }
    let real
    try {
      real = realpathSync(root)
    } catch {
      throw new SaveRefused(
        `${ATTACHMENT_DIR_VARIABLE} names "${root}", which does not exist. It is not created ` +
          'here, so that a mistyped path does not quietly become a new place for mail to land.',
      )
    }
    if (!statSync(real).isDirectory()) {
      throw new SaveRefused(`${ATTACHMENT_DIR_VARIABLE} names "${root}", which is not a directory.`)
    }
    return real
  }

  /**
   * The folder to write into, inside the directory and nowhere else.
   *
   * Missing folders are created one level at a time, each checked before the
   * next, so that no folder is ever created through a link pointing out.
   */
  #targetDir(folder: string | undefined): string {
    const real = this.#realRoot()
    if (!folder) return real

    const requested = resolve(isAbsolute(folder) ? folder : join(real, folder))
    // Compared with the directory as given and as resolved: a directory that
    // is itself reached through a link reads differently from either side.
    const inside = [this.#root as string, real]
      .map((base) => relative(base, requested))
      .find((rel) => rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)))
    if (inside === undefined) {
      throw new SaveRefused(
        `"${folder}" is outside the directory set for attachments, ${this.#root}. Files are saved ` +
          'there or in a folder inside it, never anywhere else.',
      )
    }

    let current = real
    for (const part of inside.split(sep).filter(Boolean)) {
      current = join(current, part)
      let info
      try {
        info = lstatSync(current)
      } catch {
        mkdirSync(current, { mode: 0o700 })
        const made = lstatSync(current)
        this.#folders.push({ path: current, dev: made.dev, ino: made.ino })
        continue
      }
      if (info.isSymbolicLink()) {
        throw new SaveRefused(`"${current}" is a symbolic link, and a folder reached through one is refused.`)
      }
      if (!info.isDirectory()) throw new SaveRefused(`"${current}" is not a folder.`)
    }
    return current
  }

  /** Writes the record of this process, atomically, or removes it once empty. */
  #writeRecord(): void {
    if (this.#entries.length === 0 && this.#folders.length === 0) {
      rmSync(this.#recordPath, { force: true })
      return
    }
    mkdirSync(this.#recordDir, { recursive: true, mode: 0o700 })
    const record: SaveRecord = {
      pid: this.#pid,
      startedAt: this.#startedAt,
      entries: this.#entries,
      folders: this.#folders,
    }
    const temporary = `${this.#recordPath}.tmp`
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, this.#recordPath)
  }

  /**
   * Saves one attachment. Synchronous on purpose: the file and its record are
   * written in one step, with nothing in between that could stop halfway.
   */
  save(name: string, content: Buffer, contentType: string, folder?: string): SavedFile {
    if (content.length > MAX_SAVE_BYTES) {
      throw new SaveRefused(
        `The attachment is ${content.length} bytes, more than the ${MAX_SAVE_BYTES} this server saves.`,
      )
    }
    try {
      return this.#write(name, content, contentType, folder)
    } catch (error) {
      // A folder made for a file that never arrived is not left behind.
      this.#settleFolders()
      throw error
    }
  }

  #write(name: string, content: Buffer, contentType: string, folder: string | undefined): SavedFile {
    const directory = this.#targetDir(folder)
    const plain = plainFileName(name, 'attachment')
    const { name: stem, ext } = parsePath(plain)

    for (let n = 1; n <= 100; n++) {
      const path = join(directory, n === 1 ? plain : `${stem} (${n})${ext}`)
      let fd
      try {
        // O_EXCL: never an existing file, and never through a link in its place.
        fd = openSync(
          path,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
          0o600,
        )
      } catch (error) {
        if ((error as { code?: string }).code === 'EEXIST') continue
        throw error
      }
      let ino
      try {
        writeSync(fd, content)
        ino = fstatSync(fd).ino
      } finally {
        closeSync(fd)
      }
      const info = lstatSync(path)
      if (info.ino !== ino) throw new SaveRefused(`"${path}" was replaced while it was being written.`)

      const savedAt = this.#now()
      const expiresAt = savedAt + KEEP_MS
      this.#entries.push({
        path,
        dev: info.dev,
        ino: info.ino,
        size: info.size,
        mtimeMs: info.mtimeMs,
        savedAt: new Date(savedAt).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
      })
      this.#writeRecord()
      // Exactly on the hour rather than on the next sweep. Unref'd, so a
      // waiting deletion never keeps the process alive.
      this.#timers.set(path, setTimeout(() => this.#expire(path), KEEP_MS).unref())

      return {
        path,
        size: info.size,
        contentType,
        sha256: createHash('sha256').update(content).digest('hex'),
        expiresAt: new Date(expiresAt),
      }
    }
    throw new SaveRefused(`There are already a hundred files named like "${plain}" in "${directory}".`)
  }

  /** Deletes one file whose hour is up, if it is still the one that was saved. */
  #expire(path: string): void {
    this.#timers.delete(path)
    const entry = this.#entries.find((e) => e.path === path)
    if (!entry) return
    deleteIfSame(entry)
    this.#entries = this.#entries.filter((e) => e !== entry)
    this.#settleFolders()
  }

  /** Removes the empty ones among the folders created here, and writes the record. */
  #settleFolders(): string[] {
    const { removed, kept } = pruneFolders(this.#folders)
    this.#folders = kept
    this.#writeRecord()
    return removed
  }

  /** The record a path stands for, read the way save wrote it. */
  #entryFor(path: string): SavedEntry | undefined {
    const absolute = resolve(path)
    const exact = this.#entries.find((e) => e.path === absolute)
    if (exact) return exact
    // The same file reached through a link in its folder's path.
    try {
      const real = join(realpathSync(dirname(absolute)), basename(absolute))
      return this.#entries.find((e) => e.path === real)
    } catch {
      return undefined
    }
  }

  /**
   * Deletes what this server saved: everything, or the files named.
   *
   * A path it did not save is not touched, whatever it is.
   */
  delete(paths?: string[]): DeleteReport {
    const report: DeleteReport = { deleted: [], left: [], missing: [], unknown: [], folders: [] }
    const chosen: SavedEntry[] = []
    if (paths === undefined) {
      chosen.push(...this.#entries)
    } else {
      for (const path of paths) {
        const entry = this.#entryFor(path)
        if (entry) chosen.push(entry)
        else report.unknown.push(path)
      }
    }
    for (const entry of chosen) {
      const outcome = deleteIfSame(entry)
      report[outcome === 'deleted' ? 'deleted' : outcome === 'left' ? 'left' : 'missing'].push(entry.path)
      clearTimeout(this.#timers.get(entry.path))
      this.#timers.delete(entry.path)
    }
    this.#entries = this.#entries.filter((e) => !chosen.includes(e))
    report.folders = this.#settleFolders()
    return report
  }

  /**
   * Clears up after other servers: everything of one that no longer runs, and
   * what one that still runs has left lying well past its hour.
   */
  sweepOthers(): void {
    let names: string[]
    try {
      names = readdirSync(this.#recordDir)
    } catch {
      return
    }
    const own = basename(this.#recordPath)
    for (const name of names) {
      if (!name.endsWith('.json') || name === own) continue
      const path = join(this.#recordDir, name)
      let record: SaveRecord
      try {
        record = JSON.parse(readFileSync(path, 'utf8')) as SaveRecord
      } catch {
        continue
      }
      const dead = !this.#isAlive(record.pid)
      const keep: SavedEntry[] = []
      for (const entry of record.entries ?? []) {
        const stale = this.#now() > Date.parse(entry.expiresAt) + GRACE_MS
        if (dead || stale) deleteIfSame(entry)
        else keep.push(entry)
      }
      // The folders of a server that still runs stay its own business: it may
      // be about to save into one of them.
      if (dead) pruneFolders(record.folders ?? [])
      if (keep.length === 0) {
        rmSync(path, { force: true })
      } else if (keep.length !== (record.entries ?? []).length) {
        const temporary = `${path}.tmp`
        writeFileSync(temporary, `${JSON.stringify({ ...record, entries: keep }, null, 2)}\n`, { mode: 0o600 })
        renameSync(temporary, path)
      }
    }
  }

  /** Called once at start: clears up what earlier servers left. */
  start(): void {
    this.sweepOthers()
  }

  /** Called on the way out: deletes everything this server saved. */
  stop(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer)
    this.#timers.clear()
    if (this.#entries.length || this.#folders.length) this.delete()
    rmSync(this.#recordPath, { force: true })
  }

  /** What this server has saved and not yet deleted. */
  get entries(): readonly SavedEntry[] {
    return this.#entries
  }
}
