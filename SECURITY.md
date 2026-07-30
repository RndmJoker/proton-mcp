# Security policy

## Reporting a problem

**Do not open a public issue for a security problem.** Use
[private vulnerability reporting](https://github.com/RndmJoker/proton-mcp/security/advisories/new)
instead. It is visible only to the maintainer until a fix exists.

Please include what you would put in a bug report: what happens, how to
reproduce it, and what you expected. Never include credentials, tokens or mail
content, not even redacted. If a reproduction needs a message, write one
yourself rather than sending a real one.

There is no bounty and no guaranteed response time. This is a spare-time
project.

## Why this matters more than for most tools

This server decrypts a mailbox and hands parts of it to a language model that
can call tools. Two consequences follow.

**Every message is text written by a stranger.** Sender, subject, body,
attachment names and headers all arrive from outside and end up in the model's
context. A message can therefore try to instruct the model. This is not a
hypothetical: it is the normal case this design has to survive.

**A bug here is remote access to somebody's mailbox.** Not a leaked setting, not
a defaced page. That is the scale to judge a finding by.

## What is in scope

- the confirmation before anything is sent, and any way around it
- the recipient list shown in that confirmation differing from what is sent
- the web interface: the access token, the Host and Origin checks, CSRF
- credential handling: the encrypted file, the system keyring, the environment
- the certificate pinned on first connect, and how it is verified afterwards
- anything that writes decrypted mail content to disk
- the activity record, if it ever holds more than tool name, time, duration and
  outcome
- dependency problems that actually reach a user of this package

Problems in the Proton Mail Bridge itself belong to
[Proton](https://github.com/ProtonMail/proton-bridge), not here. If you are
unsure which side a problem sits on, report it here and say so.

## Known and accepted

These are documented properties, not vulnerabilities:

- **A connection exposes the whole account structure.** Folders and labels
  belong to the Proton account, not to the address that signed in. Connecting a
  secondary address still reveals every folder name, and a name like
  `Folders/Banking/Revolut` gives away a bank on its own. Only a separate Proton
  account really separates this. The readme says so.
- **The access token for the web interface can appear in the conversation.** The
  `open_configuration` tool hands it out on request. It grants access to a page
  on loopback that shows configuration and state, never message content, it is
  worthless from another machine, and it changes on every restart. The
  alternative, making users hunt through logs, would mean nobody uses the
  interface at all.
- **The server does not try to detect prompt injection.** It marks mail content
  as data and converts HTML to text, but it does not strip suspicious
  instructions. A filter like that would suggest a safety it cannot deliver. The
  real boundary is that sending always asks a human first.
- **Certificate pinning trusts the first connection.** The Bridge certificate is
  self-signed and exists only in its vault, so there is nothing to verify it
  against on first contact. Every later connection is checked against what was
  pinned.

A report that one of these exists is not a finding. A report that one of them
can be reached in a way the documentation does not describe very much is.
