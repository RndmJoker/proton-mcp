/**
 * Moving filters in the order Proton runs them (#59), shared by the server and
 * the extension. Nothing from Node in here.
 *
 * Proton runs every filter on every incoming message, top to bottom. A filter
 * that matches does not stop the ones after it; only stop and discard end the
 * run. A message lives in one folder, so when several filters file it into
 * folders, the last one wins, while labels add up. So the order decides where
 * mail ends up, and moving a filter can change that for every message it and
 * the filters it passes have in common.
 *
 * Proton takes a new order as the complete list of ids. Assistants describe
 * moves instead, one or several, each a filter and the position it should
 * end up at, applied one after the other. Asked for by Tobi on 06.11.2026.
 */

export interface FilterMove {
  id: string
  /** Where the filter ends up, counted from 1 as list_filters shows the order. */
  position: number
}

/** A move that cannot be made. The message says why. */
export class OrderError extends Error {}

/** The most moves taken in one go. */
export const MAX_MOVES = 50

/**
 * The order after the moves, each applied to the result of the one before.
 * Throws OrderError for a filter that does not exist, a position outside the
 * list, or a filter moved twice, which would leave its place to chance.
 */
export function applyMoves(order: readonly string[], moves: readonly FilterMove[]): string[] {
  if (moves.length === 0) throw new OrderError('No move was given.')
  if (moves.length > MAX_MOVES) throw new OrderError(`At most ${MAX_MOVES} moves are taken at once.`)
  const result = [...order]
  const seen = new Set<string>()
  for (const move of moves) {
    if (seen.has(move.id)) throw new OrderError(`The filter ${move.id} is moved twice. Move each filter once.`)
    seen.add(move.id)
    const from = result.indexOf(move.id)
    if (from < 0) throw new OrderError(`There is no filter with the id ${move.id}. Call list_filters for the current ones.`)
    if (!Number.isInteger(move.position) || move.position < 1 || move.position > result.length) {
      throw new OrderError(`Position ${move.position} is outside the order, which runs from 1 to ${result.length}.`)
    }
    result.splice(from, 1)
    result.splice(move.position - 1, 0, move.id)
  }
  return result
}

/**
 * The filters whose place relative to this one changed: before the move they
 * ran on one side of it, after the move on the other. For each of them, the
 * outcome for a message both match can now be different.
 */
export function passed(before: readonly string[], after: readonly string[], id: string): string[] {
  const was = before.indexOf(id)
  const is = after.indexOf(id)
  return after.filter((other) => other !== id && before.indexOf(other) < was !== after.indexOf(other) < is)
}

/** True when both lists hold the same ids in the same order. */
export function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

/** A filter whose place changed relative to others, and on which side of them it now runs. */
export interface MovedFilter {
  id: string
  /** Positions counted from 1. */
  from: number
  to: number
  /** The filters it used to run after and now runs before. */
  before: string[]
  /** The filters it used to run before and now runs after: against these it now has the last word. */
  after: string[]
}

/**
 * The filters that were asked to move and now stand in a new place relative
 * to at least one other, even when their position number did not change:
 * moved to the front and pushed back by a later move, a filter can end on its
 * old number with a different neighbour order. The ones that only shifted
 * because another moved past them are not listed; they appear in the lists of
 * the one that did.
 */
export function movedFilters(before: readonly string[], after: readonly string[], ids: readonly string[]): MovedFilter[] {
  const moved: MovedFilter[] = []
  for (const id of new Set(ids)) {
    const others = passed(before, after, id)
    if (others.length === 0) continue
    const at = after.indexOf(id)
    moved.push({
      id,
      from: before.indexOf(id) + 1,
      to: at + 1,
      before: others.filter((other) => after.indexOf(other) > at),
      after: others.filter((other) => after.indexOf(other) < at),
    })
  }
  return moved
}

/**
 * Where a move touches a filter that does something an assistant may not set
 * up, such as filing into Trash: the order decides which folder wins, so the
 * person agreeing should look twice there. One line per such filter and move.
 */
export function orderWarnings(
  moved: readonly MovedFilter[],
  refusedOf: (id: string) => string[],
  nameOf: (id: string) => string,
): string[] {
  const warnings: string[] = []
  for (const move of moved) {
    for (const other of [move.id, ...move.before, ...move.after]) {
      const refused = refusedOf(other)
      if (refused.length === 0) continue
      const warning =
        `"${nameOf(other)}" does what an assistant may not set up (${refused.join(', ')}), ` +
        `and its place relative to "${nameOf(move.id)}" changes.`
      if (!warnings.includes(warning)) warnings.push(warning)
    }
  }
  return warnings
}
