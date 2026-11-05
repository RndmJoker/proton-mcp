import { describe, it, expect } from 'vitest'
import {
  Permissions,
  PermissionsError,
  levelsFromEnvironment,
  limitsFromEnvironment,
  permitted,
  defaultLevel,
  levelsFor,
  CONTROLLED,
  GROUPS,
  ALWAYS,
} from '../src/permissions.js'
import type { StoredSettings } from '../src/settings.js'

/**
 * What the assistant may do, tool by tool.
 *
 * The properties that matter: the defaults are exactly the behaviour before
 * levels existed, a mistake in the environment stops the start instead of
 * running with permissions nobody chose, the environment and read-only mode
 * cannot be talked out of by the interface, and every bound on sending without
 * asking turns a send into a question rather than into mail that left.
 */

function make(options: { env?: NodeJS.ProcessEnv; settings?: StoredSettings; readOnly?: boolean; now?: number } = {}) {
  let now = options.now ?? Date.parse('2026-11-05T12:00:00')
  const permissions = new Permissions({
    env: options.env ?? {},
    settings: () => options.settings ?? {},
    readOnly: options.readOnly ?? false,
    clock: () => now,
  })
  return { permissions, advance: (ms: number) => (now += ms) }
}

describe('the defaults', () => {
  it('are the behaviour before levels existed: sending asks, everything else acts', () => {
    const { permissions } = make()
    for (const tool of GROUPS.sending) expect(permissions.level(tool)).toBe('ask')
    for (const tool of [...GROUPS.reading, ...GROUPS.filing, ...GROUPS.writing]) {
      expect(permissions.level(tool)).toBe('act')
    }
    expect(permissions.departures()).toEqual([])
  })

  it('let a filter proposal ask, like sending', () => {
    expect(defaultLevel('propose_filter')).toBe('ask')
    expect(levelsFor('propose_filter')).toEqual(['off', 'ask', 'act'])
  })

  it('offer no question to a tool that only reads or files', () => {
    expect(levelsFor('list_messages')).toEqual(['off', 'act'])
    expect(levelsFor('trash_messages')).toEqual(['off', 'act'])
  })

  it('keep the way to the interface and the update check out of reach of any level', () => {
    const { permissions } = make({ settings: { levels: { open_configuration: 'off' } } })
    for (const tool of ALWAYS) {
      expect(CONTROLLED).not.toContain(tool)
      expect(permissions.level(tool)).toBe('act')
    }
  })

  it('name every tool in exactly one group', () => {
    expect(new Set(CONTROLLED).size).toBe(CONTROLLED.length)
  })
})

describe('the environment', () => {
  it('reads tools and groups from the three lists, with commas or spaces', () => {
    const levels = levelsFromEnvironment({
      PROTON_MCP_OFF: 'trash_messages, send_forward',
      PROTON_MCP_ACT_ON_ITS_OWN: 'send_reply filing',
    })
    expect(levels.get('trash_messages')).toBe('off')
    expect(levels.get('send_forward')).toBe('off')
    expect(levels.get('send_reply')).toBe('act')
    expect(levels.get('add_label')).toBe('act')
  })

  it('refuses a name that is neither tool nor group', () => {
    expect(() => levelsFromEnvironment({ PROTON_MCP_OFF: 'send_everything' })).toThrow(PermissionsError)
  })

  it('refuses a level for a tool that is always there, and says why', () => {
    expect(() => levelsFromEnvironment({ PROTON_MCP_OFF: 'open_configuration' })).toThrow(/always available/)
  })

  it('lets a tool named on its own win over its group', () => {
    // "Every sending tool acts on its own, but send_forward asks."
    const levels = levelsFromEnvironment({
      PROTON_MCP_ACT_ON_ITS_OWN: 'sending',
      PROTON_MCP_ASK_FIRST: 'send_forward',
    })
    expect(levels.get('send_message')).toBe('act')
    expect(levels.get('send_forward')).toBe('ask')
  })

  it('refuses the same tool or the same group in two lists, rather than guessing which was meant', () => {
    expect(() =>
      levelsFromEnvironment({ PROTON_MCP_OFF: 'send_message', PROTON_MCP_ACT_ON_ITS_OWN: 'send_message' }),
    ).toThrow(/both/)
    expect(() => levelsFromEnvironment({ PROTON_MCP_OFF: 'filing', PROTON_MCP_ACT_ON_ITS_OWN: 'filing' })).toThrow(
      /both/,
    )
  })

  it('refuses ask first for a tool that cannot ask', () => {
    expect(() => levelsFromEnvironment({ PROTON_MCP_ASK_FIRST: 'trash_messages' })).toThrow(/cannot ask first/)
  })

  it('wins over the interface', () => {
    const { permissions } = make({
      env: { PROTON_MCP_ASK_FIRST: 'send_message' },
      settings: { levels: { send_message: 'act' } },
    })
    expect(permissions.level('send_message')).toBe('ask')
    expect(permissions.source('send_message')).toBe('environment')
  })

  it('reads the bounds, and refuses one that is not usable', () => {
    expect(
      limitsFromEnvironment({
        PROTON_MCP_SEND_ALLOWED: 'boss@example.com, @example.org',
        PROTON_MCP_SEND_MAX_PER_HOUR: '5',
        PROTON_MCP_ACT_UNTIL: '2026-12-31',
      }),
    ).toEqual({ allowed: ['boss@example.com', '@example.org'], maxPerHour: 5, until: '2026-12-31' })
    expect(() => limitsFromEnvironment({ PROTON_MCP_SEND_MAX_PER_HOUR: 'many' })).toThrow(PermissionsError)
    expect(() => limitsFromEnvironment({ PROTON_MCP_ACT_UNTIL: 'next week' })).toThrow(PermissionsError)
  })
})

describe('the interface', () => {
  it('sets levels the environment left open', () => {
    const { permissions } = make({ settings: { levels: { send_message: 'act', trash_messages: 'off' } } })
    expect(permissions.level('send_message')).toBe('act')
    expect(permissions.level('trash_messages')).toBe('off')
    expect(permissions.source('trash_messages')).toBe('interface')
    expect(permissions.departures().map((d) => d.tool).sort()).toEqual(['send_message', 'trash_messages'])
  })

  it('cannot give a tool a level it does not offer', () => {
    // A hand-edited file asking a reading tool to ask first gets the default.
    const { permissions } = make({ settings: { levels: { list_messages: 'ask' } } })
    expect(permissions.level('list_messages')).toBe('act')
  })
})

describe('read-only mode', () => {
  it('switches off every tool that changes something, and only those', () => {
    const { permissions } = make({ readOnly: true })
    for (const tool of [...GROUPS.filing, ...GROUPS.writing, ...GROUPS.sending, ...GROUPS.filters]) {
      expect(permissions.level(tool)).toBe('off')
    }
    for (const tool of GROUPS.reading) expect(permissions.level(tool)).toBe('act')
  })

  it('wins over the environment and the interface', () => {
    const { permissions } = make({
      readOnly: true,
      env: { PROTON_MCP_ACT_ON_ITS_OWN: 'send_message' },
      settings: { levels: { send_reply: 'act' } },
    })
    expect(permissions.level('send_message')).toBe('off')
    expect(permissions.level('send_reply')).toBe('off')
    expect(permissions.source('send_message')).toBe('read-only')
  })
})

describe('permitted recipients', () => {
  it('match a whole address or a whole domain, in any case', () => {
    expect(permitted('Boss@Example.com', ['boss@example.com'])).toBe(true)
    expect(permitted('anyone@example.org', ['@example.org'])).toBe(true)
    expect(permitted('anyone@EXAMPLE.ORG', ['@example.org'])).toBe(true)
  })

  it('do not match a part of an address or a subdomain', () => {
    expect(permitted('boss@example.com.evil.example', ['boss@example.com'])).toBe(false)
    expect(permitted('someone@sub.example.org', ['@example.org'])).toBe(false)
    expect(permitted('xboss@example.com', ['boss@example.com'])).toBe(false)
  })
})

describe('the bounds on sending without asking', () => {
  it('hold nothing back while none is set', () => {
    const { permissions } = make()
    expect(permissions.holdBack(['anyone@example.com'])).toBeUndefined()
  })

  it('hold back a send to anyone not on the list, and say who', () => {
    const { permissions } = make({ settings: { limits: { allowed: ['@example.com'] } } })
    expect(permissions.holdBack(['a@example.com'])).toBeUndefined()
    expect(permissions.holdBack(['a@example.com', 'stranger@elsewhere.example'])?.reason).toContain(
      'stranger@elsewhere.example',
    )
  })

  it('hold back once the hourly number is reached, and let go an hour later', () => {
    const { permissions, advance } = make({ settings: { limits: { maxPerHour: 2 } } })
    permissions.recordSent()
    permissions.recordSent()
    expect(permissions.holdBack(['a@example.com'])?.reason).toContain('within the hour')
    advance(3_600_001)
    expect(permissions.holdBack(['a@example.com'])).toBeUndefined()
  })

  it('hold back after the last day, and not on it', () => {
    const onTheDay = make({ settings: { limits: { until: '2026-11-05' } }, now: Date.parse('2026-11-05T23:00:00') })
    expect(onTheDay.permissions.holdBack(['a@example.com'])).toBeUndefined()
    const after = make({ settings: { limits: { until: '2026-11-05' } }, now: Date.parse('2026-11-06T00:30:00') })
    expect(after.permissions.holdBack(['a@example.com'])?.reason).toContain('ended after 2026-11-05')
  })

  it('take each bound from the environment when set there', () => {
    const { permissions } = make({
      env: { PROTON_MCP_SEND_MAX_PER_HOUR: '3' },
      settings: { limits: { maxPerHour: 50, allowed: ['@example.com'] } },
    })
    expect(permissions.limits()).toEqual({ maxPerHour: 3, allowed: ['@example.com'] })
    expect(permissions.limitsFixed()).toEqual({ allowed: false, maxPerHour: true, until: false })
  })
})
