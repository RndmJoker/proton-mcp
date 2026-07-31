/**
 * The frame every page of the local interface sits in.
 *
 * Split out of pages.ts when the single status page became a set of sections:
 * the styles, the navigation and the outer document are the same everywhere, and
 * they were the larger half of that file.
 *
 * **There is no JavaScript here, and none anywhere in this interface.** The
 * Content-Security-Policy forbids it, and that is not a limitation worked
 * around: a page that cannot run script cannot be made to do anything by markup
 * that finds its way in. So navigation is links, switches are form controls, and
 * anything that looks interactive is CSS. See security.ts for the rest of the
 * policy.
 *
 * The look follows Proton's own interfaces closely enough to feel related and
 * uses none of their assets. No logo, no wordmark, no icon of theirs: those are
 * trademarks, and every page says in as many words that this is not their
 * project.
 */

/** Escapes text for use in HTML. Applied to everything, without exception. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * The sections, in the order they appear.
 *
 * The top level is the service, which is why there is a group holding a single
 * entry today: Proton Drive is meant to sit beside Proton Mail later, and a
 * structure introduced at that point would move everything the user had learned.
 */
export type Section =
  | 'overview'
  | 'mailboxes'
  | 'bridge'
  | 'credentials'
  | 'activity'
  /** Pages outside the navigation: sign-in, unlock, rejection. */
  | 'none'

interface NavEntry {
  section: Section
  path: string
  label: string
  icon: string
}

interface NavGroup {
  heading?: string
  entries: NavEntry[]
}

/*
 * Icons are inline SVG rather than files.
 *
 * Not a style choice: the CSP allows no external resource of any kind, and a
 * served file would be a path this server has to resolve. Inline markup is
 * neither. They are drawn from a single 24-unit grid with one stroke width, so
 * they sit level with the text beside them.
 */
const ICONS = {
  overview:
    '<path d="M4 5h6v6H4zM14 5h6v6h-6zM4 15h6v4H4zM14 15h6v4h-6z"/>',
  mailboxes: '<path d="M3 7l2-2h5l2 2h9v12H3z"/>',
  bridge: '<path d="M7 8V5m10 3V5M5 8h14v4a7 7 0 0 1-14 0z"/><path d="M12 19v2"/>',
  credentials:
    '<circle cx="9" cy="12" r="4"/><path d="M13 12h8M18 12v4"/>',
  activity: '<path d="M3 12h4l3 7 4-14 3 7h4"/>',
} as const

function icon(name: keyof typeof ICONS): string {
  return (
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`
  )
}

/** Which entries exist. Their availability is decided by the caller. */
function navigation(): NavGroup[] {
  return [
    {
      entries: [{ section: 'overview', path: '/', label: 'Overview', icon: icon('overview') }],
    },
    {
      heading: 'Proton Mail',
      entries: [
        {
          section: 'mailboxes',
          path: '/mailboxes',
          label: 'Folders and labels',
          icon: icon('mailboxes'),
        },
      ],
    },
    {
      heading: 'Setup',
      entries: [
        { section: 'bridge', path: '/bridge', label: 'Bridge', icon: icon('bridge') },
        {
          section: 'credentials',
          path: '/credentials',
          label: 'Credentials',
          icon: icon('credentials'),
        },
        { section: 'activity', path: '/activity', label: 'Activity', icon: icon('activity') },
      ],
    },
  ]
}

/**
 * The stylesheet.
 *
 * Both colour schemes are defined rather than one: Proton's own interfaces
 * follow the system setting, and a configuration page that glares white at
 * somebody working in the dark is the kind of detail that makes a tool feel
 * unfinished. `prefers-color-scheme` needs no script and no stored preference.
 */
const STYLES = `
  :root {
    --violet: #6d4aff;
    --violet-strong: #5b35f0;
    --violet-soft: #efeaff;
    --rail: #1b1340;
    --rail-text: #d8d2f5;
    --rail-active: rgba(255,255,255,0.13);
    --text: #22143f;
    --muted: #6b6483;
    --line: #e3e0ee;
    --surface: #ffffff;
    --page: #f5f4fa;
    --code: #efedf6;
    --warn-bg: #fff8e6;
    --warn-line: #e8c56b;
    --warn-text: #7a5a12;
    --bad-bg: #fdeaea;
    --bad-line: #e08585;
    --bad-text: #8f2d2d;
    --good-bg: #eaf7ef;
    --good-line: #7fc899;
    --good-text: #2f6b46;
    --shadow: 0 1px 2px rgba(27,19,64,0.06), 0 1px 3px rgba(27,19,64,0.04);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --violet: #8a6dff;
      --violet-strong: #9b83ff;
      --violet-soft: #2a2145;
      --rail: #151122;
      --rail-text: #b9b2d6;
      --rail-active: rgba(255,255,255,0.09);
      --text: #e7e3f4;
      --muted: #a09ab8;
      --line: #322d45;
      --surface: #1e1b2b;
      --page: #14121d;
      --code: #2a2639;
      --warn-bg: #2e2717;
      --warn-line: #7a6224;
      --warn-text: #e6c878;
      --bad-bg: #331c1c;
      --bad-line: #7d3b3b;
      --bad-text: #f0a3a3;
      --good-bg: #17291f;
      --good-line: #3c6b4d;
      --good-text: #8fd3aa;
      --shadow: 0 1px 2px rgba(0,0,0,0.3);
    }
  }

  * { box-sizing: border-box; }
  html { color-scheme: light dark; }
  body {
    margin: 0;
    min-height: 100vh;
    background: var(--page);
    color: var(--text);
    font: 15px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }

  /* The frame: a fixed rail beside a column that scrolls on its own. */
  .frame { display: flex; min-height: 100vh; }

  .rail {
    flex: 0 0 244px;
    background: var(--rail);
    color: var(--rail-text);
    padding: 20px 14px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .brand { padding: 4px 10px 18px; }
  .brand b { display: block; color: #fff; font-size: 17px; font-weight: 600; letter-spacing: 0.01em; }
  .brand .unofficial {
    display: inline-block;
    margin-top: 7px;
    padding: 2px 8px;
    border: 1px solid rgba(255,255,255,0.35);
    border-radius: 999px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.07em;
  }
  .rail .group { margin-top: 16px; }
  .rail .group-name {
    margin: 0 0 6px;
    padding: 0 10px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: rgba(255,255,255,0.42);
  }
  .rail a {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border-radius: 8px;
    color: var(--rail-text);
    text-decoration: none;
    font-size: 14px;
  }
  .rail a:hover { background: rgba(255,255,255,0.07); color: #fff; }
  .rail a[aria-current] { background: var(--rail-active); color: #fff; font-weight: 600; }
  .rail svg { width: 18px; height: 18px; flex: 0 0 18px; opacity: 0.85; }
  .rail a[aria-current] svg { opacity: 1; }
  .rail .foot {
    margin-top: auto;
    padding: 14px 10px 0;
    font-size: 12px;
    line-height: 1.5;
    color: rgba(255,255,255,0.42);
  }

  .content { flex: 1 1 auto; min-width: 0; }
  main { max-width: 780px; margin: 0 auto; padding: 36px 32px 56px; }

  h1 { font-size: 25px; line-height: 1.25; margin: 0 0 6px; letter-spacing: -0.01em; }
  h2 { font-size: 15px; margin: 34px 0 10px; letter-spacing: 0.01em; }
  h3 { font-size: 15px; margin: 0; }
  p { margin: 8px 0; }
  .lead { color: var(--muted); margin: 0 0 22px; }

  .card {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 12px;
    padding: 20px 22px;
    margin: 12px 0;
    box-shadow: var(--shadow);
  }
  .card > :first-child { margin-top: 0; }
  .card > :last-child { margin-bottom: 0; }

  .disclaimer {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    background: var(--warn-bg);
    border: 1px solid var(--warn-line);
    color: var(--warn-text);
    border-radius: 12px;
    padding: 12px 16px;
    margin: 0 0 22px;
    font-size: 13px;
  }
  .disclaimer p { margin: 0; flex: 1 1 auto; }
  .disclaimer strong { color: inherit; }
  .disclaimer form { flex: 0 0 auto; }
  button.dismiss {
    margin: -2px -4px 0 0;
    padding: 0;
    width: 24px;
    height: 24px;
    background: none;
    border: 0;
    border-radius: 6px;
    color: inherit;
    opacity: 0.65;
    font-size: 19px;
    line-height: 1;
  }
  button.dismiss:hover { background: rgba(0,0,0,0.07); opacity: 1; }

  label { display: block; margin: 16px 0 4px; font-weight: 600; font-size: 13px; }
  input[type=text], input[type=password] {
    width: 100%;
    padding: 10px 12px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--surface);
    color: var(--text);
    font: inherit;
  }
  input:focus-visible {
    outline: 2px solid var(--violet);
    outline-offset: 1px;
    border-color: var(--violet);
  }
  button {
    margin-top: 18px;
    background: var(--violet);
    color: #fff;
    border: 0;
    border-radius: 8px;
    padding: 10px 18px;
    font: inherit;
    font-weight: 600;
    cursor: pointer;
  }
  button:hover { background: var(--violet-strong); }
  button:focus-visible { outline: 2px solid var(--violet); outline-offset: 2px; }
  /*
   * Actions that destroy something do not get the colour of the action you are
   * meant to take. Deleting the credentials file and signing out both belong
   * here: they are the right answer sometimes, never the obvious one.
   */
  button.danger {
    background: var(--surface);
    color: var(--bad-text);
    border: 1px solid var(--bad-line);
  }
  button.danger:hover { background: var(--bad-bg); }

  .hint { color: var(--muted); font-size: 13px; margin-top: 6px; }
  /*
   * The storage options.
   *
   * Each is a label wrapping a real radio, so the whole card is the click
   * target while keyboard and assistive technology get the ordinary control.
   * The selected state is drawn from :checked rather than from a class the
   * server decided, which is what lets the choice change without a round trip.
   */
  .option {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    border: 1px solid var(--line);
    border-radius: 10px;
    padding: 14px 16px;
    margin: 10px 0;
    background: var(--surface);
    cursor: pointer;
  }
  .option:hover { border-color: var(--muted); }
  .option.unavailable { opacity: 0.62; cursor: not-allowed; }
  .option input[type=radio] { margin: 5px 0 0; width: 17px; height: 17px; accent-color: var(--violet); }
  .option-body { flex: 1 1 auto; min-width: 0; }
  .option:has(input:checked) { border-color: var(--violet); box-shadow: 0 0 0 1px var(--violet); }
  .option:has(input:focus-visible) { outline: 2px solid var(--violet); outline-offset: 2px; }
  .option header { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
  .option h3 { font-weight: 600; }

  /*
   * The two blocks that follow the selection.
   *
   * :has() on the form rather than a sibling selector, so the markup can stay in
   * the order a person reads it instead of the order CSS needs. Supported by
   * every current browser; where it is not, the @supports rule below shows both
   * blocks rather than hiding a field somebody needs to fill in. An interface
   * that silently omits the master password field would be unusable in a way
   * nobody could diagnose.
   */
  .master-fields, .warning-layer { display: none; }
  form.sign-in:has(#store-encrypted-file:checked) .master-fields { display: block; }
  form.sign-in:has(#store-plain-file:checked):has(#warning-seen:not(:checked)) .warning-layer {
    display: flex;
  }
  @supports not selector(:has(*)) {
    .master-fields { display: block; }
  }

  /* Visually gone, still a control: the checkbox the warning's button toggles. */
  .offscreen {
    position: absolute;
    width: 1px; height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .warning-layer {
    position: fixed;
    inset: 0;
    z-index: 10;
    align-items: center;
    justify-content: center;
    background: rgba(20,15,45,0.55);
  }
  /*
   * Clicking beside the box closes it too, which is what a dialog does. An
   * empty label rather than a handler, since there is no script here; it sits
   * beside the box rather than around it, because a label closes on any click
   * inside itself and the box has to stay usable.
   */
  /* margin: 0 undoes the general label rule, which would otherwise inset it by
   * 16px at the top and leave a strip the click does not reach. */
  .warning-backdrop { position: absolute; inset: 0; margin: 0; cursor: default; }
  .warning-box {
    position: relative;
    background: var(--surface);
    border: 1px solid var(--warn-line);
    border-top: 4px solid var(--warn-line);
    border-radius: 12px;
    padding: 22px 24px;
    /* Margin rather than padding on the layer, so the backdrop reaches the
     * very edge and a click anywhere outside the box closes it. */
    margin: 20px;
    max-width: 460px;
    max-height: calc(100vh - 40px);
    overflow-y: auto;
    box-shadow: 0 12px 40px rgba(20,15,45,0.35);
  }
  .warning-box h3 { margin: 0 0 10px; font-size: 17px; }
  .warning-box p { font-size: 14px; }
  .warning-close {
    display: inline-block;
    margin: 18px 0 0;
    padding: 10px 18px;
    border-radius: 8px;
    background: var(--violet);
    color: #fff;
    font-weight: 600;
    font-size: 14px;
    cursor: pointer;
  }
  .warning-close:hover { background: var(--violet-strong); }

  .tag {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 999px;
    border: 1px solid var(--line);
    color: var(--muted);
    white-space: nowrap;
  }
  .tag.exposure-none, .tag.exposure-os-protected {
    background: var(--good-bg); border-color: var(--good-line); color: var(--good-text);
  }
  .tag.exposure-encrypted {
    background: var(--warn-bg); border-color: var(--warn-line); color: var(--warn-text);
  }
  .tag.exposure-plaintext {
    background: var(--bad-bg); border-color: var(--bad-line); color: var(--bad-text);
  }
  .tag.suggested { background: var(--violet-soft); border-color: var(--violet); color: var(--violet-strong); }
  .tag.chosen { background: var(--violet); border-color: var(--violet); color: #fff; }

  .pro, .con, .who { font-size: 13px; margin: 6px 0; }
  .pro::before { content: "Good: "; font-weight: 600; color: var(--good-text); }
  .con::before { content: "Cost: "; font-weight: 600; color: var(--bad-text); }
  .who::before { content: "Best for: "; font-weight: 600; color: var(--muted); }
  .blocked { font-size: 13px; margin: 6px 0; color: var(--bad-text); }
  .blocked::before { content: "Not available here: "; font-weight: 600; }

  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { text-align: left; padding: 9px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
  tr:last-child th, tr:last-child td { border-bottom: 0; }
  th { color: var(--muted); font-weight: 500; width: 40%; }
  code {
    background: var(--code);
    padding: 1px 5px;
    border-radius: 4px;
    font-size: 12.5px;
    word-break: break-all;
  }

  /* A value that reads as a state rather than as a number. */
  .state { display: inline-flex; align-items: center; gap: 7px; }
  .state::before {
    content: "";
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--muted);
  }
  .state.good::before { background: #33a06f; }
  .state.bad::before { background: #d05353; }

  .error, .notice {
    border-radius: 12px;
    padding: 13px 16px;
    margin: 0 0 18px;
    font-size: 14px;
  }
  .error { background: var(--bad-bg); border: 1px solid var(--bad-line); color: var(--bad-text); }
  .notice { background: var(--good-bg); border: 1px solid var(--good-line); color: var(--good-text); }

  a { color: var(--violet-strong); }
  .content a:focus-visible, .rail a:focus-visible { outline: 2px solid var(--violet); outline-offset: 2px; }

  /*
   * Narrow windows put the rail on top as a scrolling row. A configuration page
   * is opened on a phone more often than its author expects, usually because the
   * link was sent from the machine it runs on.
   */
  @media (max-width: 860px) {
    .frame { display: block; }
    .rail { flex: none; flex-direction: row; align-items: center; gap: 4px; overflow-x: auto; padding: 10px 12px; }
    .brand { padding: 0 12px 0 4px; flex: 0 0 auto; }
    .brand .unofficial { margin-top: 2px; }
    .rail .group { margin: 0; display: flex; align-items: center; gap: 4px; }
    .rail .group-name { display: none; }
    .rail a { white-space: nowrap; }
    .rail .foot { display: none; }
    main { padding: 24px 18px 40px; }
  }
`

/** The statement that this is not Proton's software. */
const DISCLAIMER =
  'This is <strong>proton-mcp</strong>, an unofficial open source tool. It is not made by, ' +
  'affiliated with or endorsed by Proton AG. "Proton" and "Proton Mail" are their trademarks. ' +
  'This interface only talks to the Proton Mail Bridge running on your own machine.'

/**
 * Whether the notice appears, and whether it can be sent away.
 *
 * It is read once and then it is furniture, so it can be dismissed and stays
 * dismissed. What does not go away is the `unofficial` mark beside the name in
 * the rail: the point of the notice is that nobody mistakes this for Proton's
 * own software, and a mark that is always in view carries that better than a
 * paragraph nobody reads twice.
 *
 * Dismissing is a form post rather than a click handler, because there is no
 * JavaScript here, and it is remembered by the server rather than by the
 * browser, because a setting the server holds survives a different browser.
 */
export type DisclaimerState =
  /** Shown, with the button. The token is bound to the dismissal path. */
  | { csrf: string; from: Section }
  /** Shown without a button: no valid session to remember a dismissal against. */
  | 'plain'
  /** Dismissed earlier, so not shown at all. */
  | 'dismissed'

export interface LayoutOptions {
  title: string
  body: string
  /**
   * Which entry is marked as current. `none` renders no navigation at all,
   * which is what the sign-in and unlock pages want: there is nothing to reach
   * yet, and a rail full of dead links would suggest otherwise.
   */
  section: Section
  /** Needed to build the links. Absent before anybody has signed in. */
  token?: string
  /** Defaults to showing it without a button, the safe direction. */
  disclaimer?: DisclaimerState
}

function disclaimerBanner(state: DisclaimerState, token: string | undefined): string {
  if (state === 'dismissed') return ''
  if (state === 'plain' || token === undefined) {
    return `<div class="disclaimer"><p>${DISCLAIMER}</p></div>`
  }
  return `<div class="disclaimer">
  <p>${DISCLAIMER}</p>
  <form method="post" action="/dismiss-notice?token=${escapeHtml(token)}">
    <input type="hidden" name="csrf" value="${escapeHtml(state.csrf)}">
    <input type="hidden" name="from" value="${escapeHtml(state.from)}">
    <button type="submit" class="dismiss" title="Do not show this again"
            aria-label="Do not show this again">&times;</button>
  </form>
</div>`
}

function rail(current: Section, token: string): string {
  const groups = navigation()
    .map((group) => {
      const links = group.entries
        .map((entry) => {
          const href = `${entry.path}?token=${escapeHtml(token)}`
          const mark = entry.section === current ? ' aria-current="page"' : ''
          return `<a href="${href}"${mark}>${entry.icon}<span>${escapeHtml(entry.label)}</span></a>`
        })
        .join('\n      ')
      // The group heading is a plain element and the name goes on the nav as a
      // label. A real heading here would put "Setup" above the page's own <h1>
      // in the outline, and anything reading the page aloud would announce the
      // furniture before the room.
      const heading = group.heading ? `<p class="group-name">${escapeHtml(group.heading)}</p>` : ''
      const label = group.heading ? ` aria-label="${escapeHtml(group.heading)}"` : ''
      return `<nav class="group"${label}>${heading}\n      ${links}\n    </nav>`
    })
    .join('\n    ')

  return `<div class="rail">
    <div class="brand"><b>proton-mcp</b><span class="unofficial">unofficial</span></div>
    ${groups}
    <p class="foot">Running on 127.0.0.1 only.<br>Not reachable from anywhere else.</p>
  </div>`
}

export function layout(options: LayoutOptions): string {
  const { title, body, section, token, disclaimer = 'plain' } = options
  const navigable = section !== 'none' && token !== undefined

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)} - proton-mcp</title>
<style>${STYLES}</style>
</head>
<body>
<div class="frame">
${navigable ? rail(section, token) : ''}
<div class="content">
<main>
${disclaimerBanner(disclaimer, token)}
${body}
</main>
</div>
</div>
</body>
</html>
`
}

/** Renders a duration the way a person would say it. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ${seconds % 60} s`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} h ${minutes % 60} min`
  return `${Math.floor(hours / 24)} d ${hours % 24} h`
}

/** An error banner, or nothing. */
export function errorBanner(message: string | undefined): string {
  return message ? `<div class="error">${escapeHtml(message)}</div>` : ''
}

/** A success banner, or nothing. */
export function noticeBanner(message: string | undefined): string {
  return message ? `<div class="notice">${escapeHtml(message)}</div>` : ''
}
