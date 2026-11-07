/**
 * The extension's script in the Proton page (#59).
 *
 * It listens to this extension's background and to nothing else: no message
 * from the page, no event the page can raise. The page's own code runs in a
 * separate world and cannot call into this one. What it does when asked is
 * call Proton's interface from inside the page, with the page's own session
 * (lib/proton-api.ts), and before every write it checks the account and the
 * script once more (lib/content-ops.ts).
 */

import { defineContentScript } from 'wxt/utils/define-content-script'
import { browser } from 'wxt/browser'
import { ProtonApi } from '../lib/proton-api.js'
import { parseContentOp } from '../lib/ops.js'
import { runContentOp } from '../lib/content-ops.js'

export default defineContentScript({
  matches: ['https://mail.proton.me/*', 'https://account.proton.me/*'],
  runAt: 'document_idle',
  main() {
    const api = new ProtonApi({
      fetch: (input, init) => window.fetch(input, init),
      location: window.location,
      storage: window.localStorage,
    })

    browser.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
      // From this extension's background only: a message from a page of the
      // extension comes with a tab, one from the background without.
      if (sender.id !== browser.runtime.id || sender.tab !== undefined) return undefined
      const op = parseContentOp(raw)
      if (!op) return undefined
      void runContentOp(api, op).then(sendResponse, (error: unknown) =>
        sendResponse({ ok: false, error: 'internal', message: String(error) }),
      )
      return true
    })
  },
})
