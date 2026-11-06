/**
 * The confirmation window (#59): the one place a proposed filter is agreed to,
 * and the one place a filter is agreed to run over the mail already there.
 *
 * It belongs to the extension, not to the Proton page, so a tool that drives
 * the Proton page for an assistant does not reach it, and the background
 * answers only the tab it opened for this proposal. Everything from the
 * proposal is put in as text, never as markup, so a script cannot place
 * anything on this page but its own characters.
 *
 * The button that agrees never has the focus when the window opens, and it
 * comes last, after the one that refuses: a stray Enter or Tab must not agree
 * to anything. Both are locked for a moment whenever the window opens or
 * comes to the front, so a click meant for another window cannot land on
 * them (Tobi, 06.11.2026).
 */

import { browser } from 'wxt/browser'
import { diffLines } from '../../lib/diff.js'
import type { PendingApply, PendingProposal, PendingReorder, PendingSave } from '../../lib/ops.js'

/** How long the buttons stay locked after the window opens or comes to the front. */
const LOCK_MS = 1_500

const app = document.getElementById('app')!
const id = location.hash.slice(1)

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (text !== undefined) node.textContent = text
  if (className) node.className = className
  return node
}

function row(list: HTMLDListElement, term: string, value: string | Node): void {
  const dd = el('dd')
  dd.append(value)
  list.append(el('dt', term), dd)
}

function effectList(proposal: PendingProposal): HTMLUListElement {
  const list = el('ul')
  for (const effect of proposal.effects) list.append(el('li', `It ${effect}.`))
  return list
}

/** The buttons, the result line, and what happens on a click. */
function actions(agree: string, refuse: string, extra: () => { apply?: boolean } = () => ({})): void {
  const box = el('div', undefined, 'actions')
  const no = el('button', refuse)
  const yes = el('button', agree, 'primary')
  const result = el('p')
  result.id = 'result'
  result.setAttribute('role', 'status')
  box.append(no, yes)
  app.append(box, result)

  let decided = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const lock = (): void => {
    if (decided) return
    yes.disabled = true
    no.disabled = true
    clearTimeout(timer)
    timer = setTimeout(() => {
      // A window that did not get the focus stays locked until it does,
      // and then for the same moment again.
      if (decided || !document.hasFocus()) return
      yes.disabled = false
      no.disabled = false
    }, LOCK_MS)
  }
  lock()
  window.addEventListener('blur', lock)
  window.addEventListener('focus', lock)

  const decide = async (accept: boolean): Promise<void> => {
    if (decided) return
    decided = true
    clearTimeout(timer)
    yes.disabled = true
    no.disabled = true
    for (const input of app.querySelectorAll('input')) input.disabled = true
    result.className = ''
    result.textContent = accept ? 'Working...' : 'Closing it...'
    const answer = (await browser.runtime.sendMessage({ type: 'decide', id, accept, ...extra() })) as
      | { ok: boolean; message: string }
      | undefined
    result.textContent = answer?.message ?? 'No answer from the extension. Nothing was changed.'
    result.className = answer?.ok ? 'state-ok' : 'state-bad'
    const close = el('button', 'Close this window')
    close.addEventListener('click', () => window.close())
    box.replaceChildren(close)
  }
  yes.addEventListener('click', () => void decide(true))
  no.addEventListener('click', () => void decide(false))
}

function renderSave(proposal: PendingSave): void {
  const current = proposal.current
  const title = current ? 'Replace a mail filter?' : 'Add a mail filter?'
  document.title = title
  app.append(
    el('h1', title),
    el(
      'p',
      'An assistant proposed this through proton-mcp. Nothing is saved until you choose below, and ' +
        'the filter acts on every message that arrives from then on.',
      'lead',
    ),
  )

  const facts = el('dl')
  row(facts, 'Account', proposal.account)
  row(facts, 'Name', current && current.name !== proposal.name ? `${proposal.name}, renamed from ${current.name}` : proposal.name)
  if (current) row(facts, 'Status', current.enabled ? 'on, and stays on' : 'off, and stays off')
  row(facts, 'Matching mail', effectList(proposal))
  app.append(facts)
  for (const warning of proposal.warnings) app.append(el('p', warning, 'warning'))

  if (current) {
    app.append(el('h2', 'What changes'))
    const diff = el('pre', undefined, 'diff')
    for (const line of diffLines(current.sieve, proposal.sieve)) {
      const prefix = line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '- ' : '  '
      diff.append(el('span', `${prefix}${line.text}`, line.kind))
    }
    app.append(diff)
  }
  app.append(el('h2', current ? 'The whole new script' : 'The whole script'), el('pre', proposal.sieve))

  const agree = current ? 'Replace the filter' : 'Add the filter'
  if (!proposal.applyAllowed) {
    // apply_filter is switched off for assistants: then there is no box
    // either, whatever the proposal says.
    app.append(el('p', 'Applying it to the mail already there is switched off for assistants, so this only saves it.', 'muted'))
    actions(agree, 'Reject')
    return
  }

  // Proton's own dialog has the same box. The assistant can suggest ticking
  // it; what counts is how it stands when you agree.
  const choice = el('p', undefined, 'choice')
  const apply = el('input')
  apply.type = 'checkbox'
  apply.id = 'apply'
  apply.checked = proposal.apply
  const label = el('label', ' Also apply it to the mail already there')
  label.htmlFor = 'apply'
  choice.append(apply, label)
  app.append(
    choice,
    el(
      'p',
      'Proton then runs it over every message already in the account, in the background. On a large ' +
        'mailbox that can take hours, meanwhile Proton applies no other filter, and there is no single step ' +
        'to undo it.' +
        (proposal.apply ? ' The assistant suggested this.' : ''),
      'muted',
    ),
  )
  actions(agree, 'Reject', () => ({ apply: apply.checked }))
}

function renderApply(proposal: PendingApply): void {
  const filter = proposal.filter
  const title = 'Apply a filter to the mail already there?'
  document.title = title
  app.append(
    el('h1', title),
    el(
      'p',
      'An assistant asked for this through proton-mcp. Nothing changes until you choose below.',
      'lead',
    ),
  )
  const facts = el('dl')
  row(facts, 'Account', proposal.account)
  row(facts, 'Name', filter.name || '(no name)')
  row(facts, 'Status', filter.enabled ? 'on' : 'off, and applying it once does not switch it on')
  row(facts, 'Matching mail', effectList(proposal))
  app.append(facts)
  for (const warning of proposal.warnings) app.append(el('p', warning, 'warning'))
  app.append(
    el(
      'p',
      'Proton runs it over every message already in the account, in the background. On a large mailbox ' +
        'that can take hours, nothing reports when it is done, meanwhile Proton applies no other filter, and ' +
        'there is no single step to undo it.',
      'warning',
    ),
    el('h2', 'The whole script'),
    el('pre', filter.sieve),
  )
  actions('Apply to the mail already there', 'Cancel')
}

function renderReorder(proposal: PendingReorder): void {
  const nameOf = (id: string): string => proposal.names[id] || '(no name)'
  const title = 'Change the order of your filters?'
  document.title = title
  app.append(
    el('h1', title),
    el('p', 'An assistant asked for this through proton-mcp. Nothing changes until you choose below.', 'lead'),
  )
  const facts = el('dl')
  row(facts, 'Account', proposal.account)
  app.append(facts, el('h2', 'What moves'))
  const moves = el('ul')
  const names = (ids: string[]): string => ids.map((id) => JSON.stringify(nameOf(id))).join(', ')
  for (const move of proposal.moved) {
    const text =
      `${JSON.stringify(nameOf(move.id))} from ${move.from} to ${move.to}` +
      (move.before.length > 0 ? `, now before ${names(move.before)}` : '') +
      (move.after.length > 0 ? `, now after ${names(move.after)}` : '') +
      '.'
    moves.append(el('li', text))
  }
  app.append(
    moves,
    el(
      'p',
      'Every filter runs on each incoming message, and a matching one does not stop the others; only stop ' +
        'and discard do. When several file a message into folders, the last one wins, labels add up. So the ' +
        'order decides where mail ends up.',
      'muted',
    ),
  )
  for (const warning of proposal.warnings) app.append(el('p', warning, 'warning'))
  app.append(el('h2', 'The new order'))
  const order = el('ol')
  const moved = new Set(proposal.moved.map((move) => move.id))
  for (const id of proposal.after) {
    const item = el('li', nameOf(id))
    if (moved.has(id)) {
      item.className = 'moved'
      item.append(el('span', `  (was ${proposal.before.indexOf(id) + 1})`, 'muted'))
    }
    order.append(item)
  }
  app.append(order)
  actions('Save the new order', 'Cancel')
}

async function main(): Promise<void> {
  const proposal = (await browser.runtime.sendMessage({ type: 'proposal', id })) as PendingProposal | undefined
  app.replaceChildren()
  if (!proposal) {
    app.append(
      el('h1', 'Nothing to confirm'),
      el(
        'p',
        'This proposal is not open here: it was answered already, it lapsed after 30 minutes, Chrome ' +
          'restarted in between, or this is not the window the extension opened for it. Nothing was changed.',
        'lead',
      ),
    )
    return
  }
  if (proposal.kind === 'apply') renderApply(proposal)
  else if (proposal.kind === 'reorder') renderReorder(proposal)
  else renderSave(proposal)
  app.focus()
}

void main()
