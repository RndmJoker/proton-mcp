/**
 * File names taken from a message, made safe to hand on.
 *
 * A name in a message was chosen by whoever wrote it. It ends up as the name of
 * an attachment this server builds, and with save_attachment as a name on this
 * machine's disk, so the same rule serves both.
 *
 * Letters and digits of every script stay. An attachment name may carry them
 * (RFC 2231), and a name with underscores where its umlauts were helps nobody:
 * up to 0.4.11 a forwarded original named after a German subject lost every
 * one of them. Everything else becomes an underscore: path separators, the
 * characters Windows forbids in a name, control characters, and formatting
 * characters such as U+202E, which can make "txt.exe" read as "exe.txt".
 */

/** Everything that is not a letter, a mark, a digit or one of a few separators. */
const OUTSIDE_PLAIN = /[^\p{L}\p{M}\p{N} ._()-]/gu

/** Names Windows reserves for devices, with or without an extension. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** An extension worth keeping when a name has to be shortened. */
const EXTENSION = /\.[\p{L}\p{N}]{1,10}$/u

/** Drops the dots and spaces Windows strips without asking, and hidden-file dots. */
const trimEdges = (name: string): string => name.replace(/^[. ]+/, '').replace(/[. ]+$/, '')

/**
 * Shortens to a number of characters, not UTF-16 units, so a letter outside the
 * basic plane is never cut in half. The extension survives when there is one.
 */
function shorten(name: string, maxLength: number): string {
  const chars = Array.from(name)
  if (chars.length <= maxLength) return name

  const extension = EXTENSION.exec(name)?.[0] ?? ''
  const extensionChars = Array.from(extension)
  const base = chars.slice(0, chars.length - extensionChars.length)
  const room = maxLength - extensionChars.length
  // Cutting can leave a dot or a space at the new end, which trimEdges would
  // have removed had it been there before.
  return trimEdges(base.slice(0, Math.max(room, 1)).join('')) + extension
}

/**
 * Reduces a name to a plain file name.
 *
 * Never empty and never a path: the result has no separator, does not start
 * with a dot and is not a device name on Windows. `fallback` is used when
 * nothing usable is left, and has to be plain itself.
 */
export function plainFileName(name: string, fallback: string, maxLength = 100): string {
  let result = trimEdges(name.normalize('NFC').replace(OUTSIDE_PLAIN, '_'))
  if (!result) result = fallback
  if (RESERVED.test(result)) result = `_${result}`
  return shorten(result, maxLength)
}

/** The name a forwarded original travels under, built from its subject. */
export function forwardedFileName(subject: string | undefined): string {
  return `${plainFileName(subject ?? '', 'message', 60)}.eml`
}
