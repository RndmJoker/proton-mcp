/**
 * The extension's popup (#59): how things stand, and what the extension did.
 *
 * The first place to look when the server says the extension is not active:
 * it shows whether the connector runs, and if not, the reason Chrome or the
 * connector gave. Below that, what waits for Proton, the extension's own
 * switches for acting without its window, and the last changes, each with
 * whether you confirmed it or the assistant was allowed to act on its own.
 */

import { browser } from 'wxt/browser'
import { NO_SWITCHES, type Change, type Switches } from '../../lib/ops.js'

interface Waiting {
  id: string
  action: 'save' | 'apply' | 'reorder'
  name: string
  since: number
  attempts: number
  lastError?: string
}

interface Status {
  host: { state: 'starting' | 'connected' | 'error' | 'disconnected'; message?: string; at: number }
  tabs: number
  queue: Waiting[]
  changes: Change[]
  switches?: Switches
}

interface Notice {
  ok: boolean
  message: string
}

const ACTION_TEXT: Record<Waiting['action'], string> = {
  save: 'Save',
  apply: 'Apply to the mail already there',
  reorder: 'Change',
}

const SWITCH_TEXT: Record<keyof Switches, string> = {
  save: 'Save a filter, new or replacing one',
  apply: 'Apply a filter to the mail already there',
  reorder: 'Change the order of the filters',
}

const app = document.getElementById('app')!

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (text !== undefined) node.textContent = text
  if (className) node.className = className
  return node
}

const HOST_TEXT: Record<Status['host']['state'], string> = {
  connected: 'The connector runs. The server can reach this extension.',
  starting: 'The connector is starting.',
  error: 'The connector gave up.',
  disconnected: 'The connector is not running.',
}

const OUTCOME_TEXT: Record<Change['outcome'], string> = {
  added: 'added',
  replaced: 'replaced',
  applied: 'applied to the mail already there',
  reordered: 'saved as the new order',
  queued: 'queued, Proton was busy',
  cancelled: 'cancelled',
  rejected: 'rejected',
  failed: 'failed',
}

/**
 * The switches for acting without the window. Both have to allow it: the
 * tool's level in proton-mcp and the switch here. Off, the default, the
 * window always shows, whatever the server sends, so a program that got
 * hold of the connector's secret cannot skip it (Tobi, 06.11.2026).
 */
function renderSwitches(switches: Switches): void {
  app.append(
    el('h2', 'Without the window'),
    el(
      'p',
      'An assistant may do these without this window only where both allow it: the level of the tool in ' +
        "proton-mcp's settings, and the switch here. Off, this extension always asks in its window first.",
      'muted',
    ),
  )
  const box = el('div', undefined, 'switches')
  for (const key of Object.keys(SWITCH_TEXT) as (keyof Switches)[]) {
    const line = el('p', undefined, 'choice')
    const input = el('input')
    input.type = 'checkbox'
    input.id = `switch-${key}`
    input.checked = switches[key]
    const label = el('label', ` ${SWITCH_TEXT[key]}`)
    label.htmlFor = input.id
    input.addEventListener('change', async () => {
      for (const other of box.querySelectorAll('input')) other.disabled = true
      const next = { ...switches, [key]: input.checked }
      const answer = (await browser.runtime.sendMessage({ type: 'switches', switches: next })) as { ok?: boolean } | undefined
      void render(answer?.ok ? undefined : { ok: false, message: 'The switch could not be saved.' })
    })
    line.append(input, label)
    box.append(line)
  }
  app.append(box)
}

async function render(notice?: Notice): Promise<void> {
  const status = (await browser.runtime.sendMessage({ type: 'status' })) as Status
  app.replaceChildren(el('h1', 'Proton MCP Helper'))

  const ok = status.host.state === 'connected'
  app.append(el('p', HOST_TEXT[status.host.state], ok ? 'state-ok' : 'state-bad'))
  if (status.host.message) app.append(el('p', status.host.message, 'muted'))
  if (!ok) {
    app.append(
      el(
        'p',
        'If the connector is not set up yet, run this in a terminal, then reconnect: ' +
          'npx -y @rndmjoker/proton-mcp@latest setup-browser',
        'muted',
      ),
    )
  }
  app.append(
    el(
      'p',
      status.tabs === 0
        ? 'No Proton page is open. Open https://mail.proton.me and sign in.'
        : `${status.tabs} Proton page${status.tabs === 1 ? '' : 's'} open.`,
      status.tabs === 0 ? 'state-bad' : 'muted',
    ),
  )

  const reconnect = el('button', 'Start the connector again')
  reconnect.addEventListener('click', async () => {
    reconnect.disabled = true
    await browser.runtime.sendMessage({ type: 'reconnect' })
    setTimeout(() => void render(), 600)
  })
  const actions = el('div', undefined, 'actions')
  actions.append(reconnect)
  app.append(actions)

  if (notice) {
    const line = el('p', notice.message, notice.ok ? 'state-ok notice' : 'state-bad notice')
    line.setAttribute('role', 'status')
    app.append(line)
  }

  if (status.queue.length > 0) {
    app.append(
      el('h2', 'Waiting for Proton'),
      el(
        'p',
        'Proton is still applying an earlier filter, which on a large mailbox can take hours. Each waits until ' +
          'Proton takes it, tried again at growing intervals of up to 15 minutes, for as long as Chrome stays ' +
          'open. Restarting Chrome or this extension drops it, noted below.',
        'muted',
      ),
    )
    const waiting = el('ul')
    for (const entry of status.queue) {
      const item = el(
        'li',
        `${ACTION_TEXT[entry.action]} "${entry.name}", since ${new Date(entry.since).toLocaleTimeString()}, ` +
          `${entry.attempts} attempt${entry.attempts === 1 ? '' : 's'}` +
          (entry.lastError ? ` (${entry.lastError})` : '') +
          ' ',
      )
      const cancel = el('button', 'Cancel')
      cancel.addEventListener('click', async () => {
        cancel.disabled = true
        const answer = (await browser.runtime.sendMessage({ type: 'cancel', id: entry.id })) as Notice | undefined
        void render(answer ?? { ok: false, message: 'No answer from the extension.' })
      })
      item.append(cancel)
      waiting.append(item)
    }
    app.append(waiting)
  }

  renderSwitches(status.switches ?? NO_SWITCHES)

  app.append(el('h2', 'Last changes'))
  if (status.changes.length === 0) {
    app.append(el('p', 'None yet.', 'muted'))
    return
  }
  const list = el('ul')
  for (const change of status.changes.slice(0, 15)) {
    const when = new Date(change.at).toLocaleString()
    // Who decided: you in the window or the popup, or the assistant on its own.
    const how =
      change.outcome === 'rejected' || change.outcome === 'cancelled'
        ? ' by you'
        : change.outcome === 'queued' || change.outcome === 'failed'
          ? change.how === 'confirmed' ? ', after your yes' : ', without asking'
          : change.how === 'confirmed' ? ', after your yes' : ' without asking'
    const text = `${when}: "${change.name}" ${OUTCOME_TEXT[change.outcome]}${how}`
    list.append(el('li', change.detail ? `${text} (${change.detail})` : text))
  }
  app.append(list)
}

void render()
