/**
 * What the script in the Proton page does when the background asks (#59),
 * kept apart from the browser so it can be tested.
 *
 * Reading goes straight to Proton. Every write first asks whether the page is
 * still signed in to the account the change was agreed for, since a page can
 * switch accounts in between, and checks the script once more with the rules
 * of sieve.ts: this is the last step before Proton gets it.
 */

import type { ProtonApi } from './proton-api.js'
import type { ContentOp } from './ops.js'
import { reviewSieve, filterNameProblem, sameScript } from '../../src/filters/sieve.js'

/** Refusals of this step, in the codes the server knows. */
export type ContentRefusal = { ok: false; error: 'wrong-account' | 'not-found' | 'refused'; message: string }

const refused = (message: string): ContentRefusal => ({ ok: false, error: 'refused', message })

export async function runContentOp(api: ProtonApi, op: ContentOp): Promise<unknown> {
  switch (op.op) {
    case 'addresses':
      return api.addresses()
    case 'filters':
      return api.filters()
    case 'check':
      return api.check(op.sieve)
  }

  const addresses = await api.addresses()
  if (!addresses.ok) return addresses
  if (!addresses.value.includes(op.account.toLowerCase())) {
    return { ok: false, error: 'wrong-account', message: 'The Proton page switched to another account.' } satisfies ContentRefusal
  }

  switch (op.op) {
    case 'apply': {
      // Read from Proton itself, right before it runs over existing mail: it
      // has to be the script that was agreed to, not merely one that passes
      // the rules.
      const listed = await api.filters()
      if (!listed.ok) return listed
      const filter = listed.value.find((candidate) => candidate.id === op.filterId)
      if (!filter) return { ok: false, error: 'not-found', message: 'The filter does not exist any more.' } satisfies ContentRefusal
      if (!sameScript(filter.sieve, op.sieve)) return refused('The filter changed since applying it was agreed to.')
      const problems = reviewSieve(filter.sieve).problems
      if (problems.length > 0) return refused(problems.join(' '))
      return api.apply(filter.id)
    }
    case 'order': {
      // Every filter Proton has, each once, and nothing else: a list that
      // left one out would leave its place to Proton.
      const listed = await api.filters()
      if (!listed.ok) return listed
      const stored = new Set(listed.value.map((filter) => filter.id))
      const given = new Set(op.ids)
      if (given.size !== op.ids.length || given.size !== stored.size || [...given].some((id) => !stored.has(id))) {
        return refused('The new order does not hold every filter exactly once.')
      }
      return api.order(op.ids)
    }
    case 'add':
    case 'update': {
      const problems = [filterNameProblem(op.name), ...reviewSieve(op.sieve).problems].filter(
        (problem): problem is string => problem !== undefined,
      )
      if (problems.length > 0) return refused(problems.join(' '))
      return op.op === 'add' ? api.add(op.name, op.sieve) : api.update(op.filter, op.name, op.sieve)
    }
  }
}
