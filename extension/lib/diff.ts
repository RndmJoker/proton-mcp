/**
 * The difference between the stored script and the proposed one, line by line,
 * for the confirmation window (#59).
 *
 * A change replaces a filter's whole script, and an assistant writes it out in
 * full. A line it dropped is as important as a line it added, and neither is
 * easy to spot in two long scripts side by side, so the window shows both
 * marked. A plain longest-common-subsequence over lines: scripts are a few
 * hundred lines at most.
 */

export type DiffLine = { kind: 'same' | 'added' | 'removed'; text: string }

/** Above this many cells the table would be too large, and every line is shown as changed. */
const MAX_CELLS = 4_000_000

function lines(text: string): string[] {
  const split = text.replace(/\r\n?/g, '\n').split('\n')
  if (split.length > 0 && split[split.length - 1] === '') split.pop()
  return split
}

export function diffLines(before: string, after: string): DiffLine[] {
  const a = lines(before)
  const b = lines(after)
  if ((a.length + 1) * (b.length + 1) > MAX_CELLS) {
    return [
      ...a.map((text): DiffLine => ({ kind: 'removed', text })),
      ...b.map((text): DiffLine => ({ kind: 'added', text })),
    ]
  }
  const width = b.length + 1
  const table = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!)
    }
  }
  const result: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      result.push({ kind: 'same', text: a[i]! })
      i++
      j++
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      result.push({ kind: 'removed', text: a[i]! })
      i++
    } else {
      result.push({ kind: 'added', text: b[j]! })
      j++
    }
  }
  while (i < a.length) result.push({ kind: 'removed', text: a[i++]! })
  while (j < b.length) result.push({ kind: 'added', text: b[j++]! })
  return result
}
