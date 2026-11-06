import { describe, it, expect } from 'vitest'
import { applyMoves, passed, sameOrder, movedFilters, orderWarnings, OrderError, MAX_MOVES } from '../../src/filters/order.js'

/**
 * Moving filters in Proton's order (#59). Proton runs every filter on every
 * message and the last folder wins, so a move changes outcomes only against
 * the filters it passes. That is what the confirmation shows and warns about.
 */

const ORDER = ['a', 'b', 'c', 'd', 'e']

describe('moves', () => {
  it('put a filter where it was asked, counted from 1', () => {
    expect(applyMoves(ORDER, [{ id: 'e', position: 1 }])).toEqual(['e', 'a', 'b', 'c', 'd'])
    expect(applyMoves(ORDER, [{ id: 'a', position: 5 }])).toEqual(['b', 'c', 'd', 'e', 'a'])
  })

  it('are made one after the other, each on the result of the one before', () => {
    expect(applyMoves(ORDER, [{ id: 'e', position: 1 }, { id: 'a', position: 5 }])).toEqual(['e', 'b', 'c', 'd', 'a'])
  })

  it('refuse an unknown filter, a place outside the order, a filter moved twice, none and too many', () => {
    expect(() => applyMoves(ORDER, [{ id: 'x', position: 1 }])).toThrow(OrderError)
    expect(() => applyMoves(ORDER, [{ id: 'a', position: 6 }])).toThrow('from 1 to 5')
    expect(() => applyMoves(ORDER, [{ id: 'a', position: 0 }])).toThrow(OrderError)
    expect(() => applyMoves(ORDER, [{ id: 'a', position: 2 }, { id: 'a', position: 3 }])).toThrow('moved twice')
    expect(() => applyMoves(ORDER, [])).toThrow(OrderError)
    expect(() => applyMoves(ORDER, Array.from({ length: MAX_MOVES + 1 }, () => ({ id: 'a', position: 1 })))).toThrow(OrderError)
  })
})

describe('what a move passes', () => {
  it('lists the filters now on the other side', () => {
    const after = applyMoves(ORDER, [{ id: 'd', position: 2 }])
    expect(passed(ORDER, after, 'd')).toEqual(['b', 'c'])
    expect(sameOrder(ORDER, after)).toBe(false)
    expect(sameOrder(ORDER, [...ORDER])).toBe(true)
  })

  it('reports only the filters asked to move, not the ones that shifted by a place', () => {
    const after = applyMoves(ORDER, [{ id: 'd', position: 2 }])
    expect(movedFilters(ORDER, after, ['d'])).toEqual([{ id: 'd', from: 4, to: 2, before: ['b', 'c'], after: [] }])
  })

  it('warns where a moved or passed filter does more than file and flag', () => {
    const after = applyMoves(ORDER, [{ id: 'd', position: 2 }])
    const warnings = orderWarnings(
      movedFilters(ORDER, after, ['d']),
      (id) => (id === 'c' ? ['filing into Trash'] : []),
      (id) => id.toUpperCase(),
    )
    expect(warnings).toEqual(['"C" does more than file and flag (filing into Trash), and its place relative to "D" changes.'])
  })
})

describe('found in the review of 06.11.2026', () => {
  it('lists a filter that ends on its old number with a new neighbour order', () => {
    const before = ['A', 'B', 'C']
    const after = applyMoves(before, [{ id: 'B', position: 1 }, { id: 'C', position: 1 }])
    expect(after).toEqual(['C', 'B', 'A'])
    const moved = movedFilters(before, after, ['B', 'C'])
    expect(moved.map((move) => move.id)).toEqual(['B', 'C'])
    expect(moved[0]).toEqual({ id: 'B', from: 2, to: 2, before: ['A'], after: ['C'] })
  })

  it('tells before from after for each filter passed', () => {
    const before = ['A', 'B', 'X', 'C']
    const after = applyMoves(before, [{ id: 'X', position: 1 }, { id: 'C', position: 1 }])
    expect(after).toEqual(['C', 'X', 'A', 'B'])
    const x = movedFilters(before, after, ['X']).find((move) => move.id === 'X')
    expect(x).toEqual({ id: 'X', from: 3, to: 2, before: ['A', 'B'], after: ['C'] })
  })
})
