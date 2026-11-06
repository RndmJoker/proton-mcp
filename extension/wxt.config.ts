/**
 * Build configuration of the browser extension (#59).
 *
 * The permissions are as few as the work allows:
 *
 * - nativeMessaging, to start the connector that carries requests from the server;
 * - storage, for the proposal waiting in the confirmation window and the list
 *   of past changes;
 * - alarms, to try a queued write again a minute later even when the
 *   background went to sleep in between;
 * - the two Proton addresses where the filters are, and no other site.
 *
 * There is deliberately no externally_connectable. Without it no web page can
 * send this extension a message, which is half of "orders from the server and
 * from nothing else". The other half is in the connector.
 *
 * The key fixes the extension's id, so the connector's manifest can name it as
 * the only extension allowed to start the connector. It is the public half of a
 * key pair whose private half was discarded when it was made: an unpacked
 * extension or a zip needs only this.
 */

import { defineConfig } from 'wxt'
import { readFileSync } from 'node:fs'

const server = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }

export default defineConfig({
  // The extension carries the server's version, which its own package.json
  // does not hold, so the zip is named here rather than by WXT's default.
  zip: { artifactTemplate: `proton-mcp-helper-${server.version}-{{browser}}.zip` },
  manifest: {
    name: 'Proton MCP Helper',
    description:
      'Works in the signed-in Proton page for the proton-mcp server, for now on mail filters. Every change waits for your yes.',
    version: server.version,
    minimum_chrome_version: '116',
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqnHPw9/scOh99eUli3fI/nWI+nS/lDGWSiLZkTbM0D0VeT8V/jsh6HkkGS+N9pUlP29RJiNuB2/HqLH7Vq4CY6IZXr5mgVeFIJ5bbkMNO/ba7YVK+n3pvCYsT2BWX1XFJV5WlgnCRVknWUW2ss9poeTmywcgd4bwpRzTAle9auI8wX/614wKJQKi4RxAa8c/6IeV3XIuGKuRjR4yNyz8B7TkXXbAj1pKhGMeJQxW58JG4OIuZOHDawuajf+BI2dEWHPLCfnBaVXwi0NGSSvA+EaIZ/Xk9fKVGdyv75vmNrJ6tkykjwcIVlcziKXiratcH7nqDdQk8WJR2s4EC6hWdQIDAQAB',
    permissions: ['nativeMessaging', 'storage', 'alarms'],
    host_permissions: ['https://mail.proton.me/*', 'https://account.proton.me/*'],
    action: { default_title: 'Proton MCP Helper' },
  },
})
