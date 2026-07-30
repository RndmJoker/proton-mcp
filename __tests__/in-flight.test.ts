import { describe, it, expect, beforeEach } from 'vitest'
import { track, waitForIdle, inFlightCount, _reset } from '../src/in-flight.js'

const wait = (ms: number) => new Promise((next) => setTimeout(next, ms))

describe('in-flight bookkeeping', () => {
  beforeEach(() => _reset())

  it('counts a running call and releases it again', async () => {
    expect(inFlightCount()).toBe(0)
    const running = track(async () => {
      expect(inFlightCount()).toBe(1)
      return 'done'
    })
    expect(await running).toBe('done')
    expect(inFlightCount()).toBe(0)
  })

  it('releases the counter even when the call fails', async () => {
    // Otherwise a single failure would keep the server from shutting down.
    await expect(track(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(inFlightCount()).toBe(0)
  })

  it('returns immediately when nothing is running', async () => {
    expect(await waitForIdle(50)).toBe(true)
  })

  it('waits until the running call has finished', async () => {
    let finished = false
    const running = track(async () => { await wait(60); finished = true })
    expect(await waitForIdle(2000)).toBe(true)
    expect(finished).toBe(true)
    await running
  })

  it('waits for several concurrent calls', async () => {
    const running = [30, 60, 90].map((ms) => track(() => wait(ms)))
    expect(await waitForIdle(2000)).toBe(true)
    expect(inFlightCount()).toBe(0)
    await Promise.all(running)
  })

  it('gives up after the deadline instead of hanging forever', async () => {
    const running = track(() => wait(500))
    // false means something was still running. The caller can record that.
    expect(await waitForIdle(50)).toBe(false)
    await running
  })
})
