import { describe, it, expect, beforeEach } from 'vitest'
import * as activity from '../src/activity.js'
import { track, _reset as resetInFlight } from '../src/in-flight.js'

/**
 * The record behind the status page.
 *
 * Two things matter: that a running call is visible while it runs, and that
 * nothing beyond the tool name is ever kept. The second is a security property,
 * not a nicety: a record of what was searched for would turn a configuration
 * page into a log of someone's mail habits.
 */

beforeEach(() => {
  activity._reset()
  resetInFlight()
})

describe('activity record', () => {
  it('shows a call while it is running and moves it to history after', () => {
    const id = activity.begin('search_messages', 1000)
    expect(activity.inProgress()).toEqual([{ id: 1, tool: 'search_messages', startedAt: 1000 }])
    expect(activity.recent()).toEqual([])

    activity.finish(id, 'ok', 3500)
    expect(activity.inProgress()).toEqual([])
    expect(activity.recent()).toEqual([
      { tool: 'search_messages', startedAt: 1000, durationMs: 2500, outcome: 'ok' },
    ])
  })

  it('records a failure as such', () => {
    activity.finish(activity.begin('get_message', 100), 'failed', 200)
    expect(activity.recent()[0]?.outcome).toBe('failed')
  })

  it('keeps concurrent calls apart', () => {
    const first = activity.begin('list_messages', 100)
    const second = activity.begin('list_messages', 200)
    expect(activity.inProgress()).toHaveLength(2)
    activity.finish(second, 'ok', 250)
    expect(activity.inProgress()).toEqual([{ id: first, tool: 'list_messages', startedAt: 100 }])
  })

  it('lists what is running oldest first', () => {
    // The call worth worrying about is the one that has been going longest.
    activity.begin('a', 300)
    activity.begin('b', 100)
    activity.begin('c', 200)
    expect(activity.inProgress().map((c) => c.tool)).toEqual(['b', 'c', 'a'])
  })

  it('lists history newest first', () => {
    activity.finish(activity.begin('first', 100), 'ok', 150)
    activity.finish(activity.begin('second', 200), 'ok', 250)
    expect(activity.recent().map((c) => c.tool)).toEqual(['second', 'first'])
  })

  it('drops the oldest entries past the limit', () => {
    for (let i = 0; i < activity.HISTORY_LIMIT + 10; i++) {
      activity.finish(activity.begin(`tool-${i}`, i), 'ok', i + 1)
    }
    const kept = activity.recent()
    expect(kept).toHaveLength(activity.HISTORY_LIMIT)
    // Newest survived, oldest fell off.
    expect(kept[0]?.tool).toBe(`tool-${activity.HISTORY_LIMIT + 9}`)
    expect(kept.some((c) => c.tool === 'tool-0')).toBe(false)
  })

  it('ignores an unknown handle instead of throwing', () => {
    // A double finish must not take a tool call down with it.
    expect(() => activity.finish(999, 'ok')).not.toThrow()
    const id = activity.begin('x')
    activity.finish(id, 'ok')
    expect(() => activity.finish(id, 'ok')).not.toThrow()
    expect(activity.recent()).toHaveLength(1)
  })

  it('remembers when the first call arrived', () => {
    expect(activity.firstCall()).toBeUndefined()
    activity.begin('first', 5000)
    activity.begin('second', 9000)
    expect(activity.firstCall()).toBe(5000)
  })

  it('never stores anything but the tool name', () => {
    // The guard against this page becoming a log of mail habits. If arguments
    // are ever passed through, this fails.
    activity.finish(activity.begin('search_messages', 1), 'ok', 2)
    const entry = activity.recent()[0]
    expect(Object.keys(entry ?? {}).sort()).toEqual([
      'durationMs',
      'outcome',
      'startedAt',
      'tool',
    ])
  })
})

describe('track feeding the record', () => {
  it('records a successful call under its tool name', async () => {
    await track(async () => 'done', 'list_folders')
    expect(activity.recent()).toMatchObject([{ tool: 'list_folders', outcome: 'ok' }])
  })

  it('records a failed call and still rethrows', async () => {
    const boom = new Error('no')
    await expect(track(() => Promise.reject(boom), 'get_message')).rejects.toBe(boom)
    expect(activity.recent()).toMatchObject([{ tool: 'get_message', outcome: 'failed' }])
  })

  it('shows the call as running while it runs', async () => {
    let seen: string[] = []
    await track(async () => {
      seen = activity.inProgress().map((c) => c.tool)
    }, 'search_messages')
    expect(seen).toEqual(['search_messages'])
    // And not afterwards.
    expect(activity.inProgress()).toEqual([])
  })

  it('records nothing when no name is given', async () => {
    // Existing callers that only want the shutdown bookkeeping stay unrecorded
    // rather than showing up as an empty row.
    await track(async () => 'done')
    expect(activity.recent()).toEqual([])
  })
})
