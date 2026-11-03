/**
 * Tool: manage_filters
 *
 * Answers a request about Proton Mail filters, which this server cannot reach.
 *
 * The Bridge carries mail over IMAP and SMTP and nothing else: no filters, no
 * forwarding, no account settings. Proton's own web app manages filters through
 * an interface it has not opened to other programs, and reaching it would mean
 * signing in with the account password and holding a session that can do
 * whatever the web app can. That is not something a mail tool should hold, least
 * of all one that reads text written by strangers.
 *
 * Without this tool an assistant asked to "make a rule" finds nothing and
 * guesses: it files the existing messages by hand, which does nothing for the
 * next one, or it claims a capability that is not there. So the tool gives the
 * honest answer and the way that does work: Proton's settings page, in a browser
 * tool the user turned on, with the user agreeing to each change.
 *
 * What the answer asks of the assistant, to ask first, to show the whole script
 * and to leave the destructive actions to the user, is advice and not a
 * boundary. The boundary is that this server touches nothing, and that the
 * change happens in a browser the user controls. The advice is written as firmly
 * as it is because a filter keeps acting on every message that arrives, long
 * after the conversation that made it.
 */

import * as z from 'zod'
import type { McpServer, CallToolResult } from '@modelcontextprotocol/server'
import { track } from '../in-flight.js'

/** Where Proton lists every filter of the signed-in account. */
export const FILTER_PAGE = 'https://account.proton.me/u/0/mail/filters'

/** Proton's own description of the part of Sieve it accepts. */
export const SIEVE_GUIDE = 'https://proton.me/support/sieve-advanced-custom-filters'

export const DESCRIPTION =
  'Proton Mail filters, the rules that sort incoming mail, cannot be read or changed through ' +
  'this server, because Proton offers no interface for them to other programs. Call this ' +
  'whenever the user asks about filters, rules, sorting incoming mail automatically or Sieve. ' +
  "The answer explains the way that works instead, through Proton's settings page in a " +
  'browser and only with the user agreeing to each change.'

/**
 * The answer, the same every time.
 *
 * The menu labels are the ones Proton's web app shows in English. The account's
 * language can change them, which the answer says, so an assistant looking at a
 * German page is not left searching for a word that is not there.
 */
export const ANSWER = [
  'Filters cannot be read or changed through this server. The Proton Mail Bridge carries mail ' +
    "over IMAP and SMTP and nothing else, and the interface Proton's own web app uses for " +
    "filters is not open to other programs. Nothing about the user's filters is known here.",
  '',
  "What works instead, with the user's agreement:",
  '',
  `1. Ask the user first whether you may look at their filters at ${FILTER_PAGE}, where every ` +
    'rule is listed. A different number after /u/ is fine: Proton redirects to the signed-in ' +
    'account. This needs a browser tool the user has turned on, such as Claude in Chrome. ' +
    'Without one, say so and go to step 6.',
  `2. Read Proton's Sieve documentation before writing a rule: ${SIEVE_GUIDE}. The page is ` +
    'public, so any browser or web tool can open it. Proton supports only part of Sieve and has ' +
    'no redirect; anything outside that part is refused or, in places, silently does nothing.',
  '3. Work in Sieve, not in the form. To change a rule, open the arrow next to its Edit button ' +
    'and choose Edit Sieve; a rule that already is a Sieve filter shows Edit Sieve directly. For ' +
    'a new rule, use Add sieve filter. The labels follow the language of the account. Saving ' +
    'through Edit Sieve can turn a rule made in the simple form into a Sieve filter that the ' +
    'form no longer opens, so say so before saving one of those.',
  '4. Show the user the complete script before saving, and save only after they agree to it. A ' +
    'filter keeps acting on every message that arrives, long after this conversation, so a rule ' +
    'nobody read is a change nobody agreed to.',
  '5. Some actions are for the user to ask for, and only then: discard and expire delete mail, ' +
    'reject turns mail away so it never arrives, vacation sends replies from the user\'s address ' +
    'without asking anyone, and filing into Trash or Spam hides mail. Keep the spam check Proton ' +
    'places at the top of every script. Deleting or turning off a filter is the user\'s decision ' +
    'as well.',
  '6. Without a browser tool, write the script, explain what it does, and let the user paste it ' +
    'into Add sieve filter or Edit Sieve themselves.',
  '',
  "Messages that already exist are a separate matter. Sort them with this server's own tools, " +
    'search_messages to find them and move_messages or add_label to file them, or point the user ' +
    'to Apply to existing messages in the same menu, which runs a saved filter over the mailbox.',
].join('\n')

export function registerFilterTool(server: McpServer): void {
  server.registerTool(
    'manage_filters',
    {
      title: 'Work on mail filters',
      description: DESCRIPTION,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      track(async () => {
        const answer: CallToolResult = { content: [{ type: 'text', text: ANSWER }] }
        return answer
      }, 'manage_filters'),
  )
}
