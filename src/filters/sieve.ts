/**
 * Reading and checking a Sieve script before it reaches Proton (#59).
 *
 * A filter keeps acting on every message that arrives, long after the
 * conversation that wrote it. So a script an assistant proposes is held to a
 * list of what it may do, not to a list of what it may not: anything this file
 * does not know is refused, and the refusal says why.
 *
 * The same code runs in two places: in this server before a proposal leaves,
 * and in the browser extension before anything is written. Neither trusts the
 * check of the other, which is why this file uses nothing from Node.
 *
 * What it refuses, as decided on 05.11.2026:
 *
 * - discard, expire, reject and vacation: they delete mail, turn it away or
 *   answer it in the user's name.
 * - stop: it ends every later filter for a matching message, which switches
 *   those filters off without anyone seeing it. Proton's own assistant allows
 *   it; this one does not.
 * - filing into Trash or Spam: it hides mail.
 * - a script without Proton's spam guard at the top: without it the filter
 *   runs on spam as well and can file spam among normal mail.
 * - a script that does nothing beyond the guard: an empty filter is how a rule
 *   is switched off, and switching off is the user's decision.
 *
 * Tightened on 06.11.2026, after two reviewers found scripts that passed and
 * read differently in the confirmation from what they do, or that Proton's
 * own parser may read differently from this one:
 *
 * - no comment but Proton's own two, the line above the spam guard and the
 *   one its filter editor writes above each rule, and no text: blocks: both
 *   are where Proton's public parser (libsieve-php) and RFC 5228 part ways,
 *   and where a discard can sit that looks commented out;
 * - no line break, no invisible character and no lone carriage return
 *   anywhere, and addresses in plain ASCII, as for recipients since #42;
 * - the spam guard written as Proton writes it, without escapes;
 * - no :regex and no :eval: a pattern or a sum that fails while Proton runs
 *   the filter might end it like stop, and that is not known;
 * - folder paths that name Trash, Spam or Junk in any spelling, and folders
 *   given by Proton's internal numbers;
 * - arguments, tags and comparators that are not on the list, and conditions
 *   where only allof, anyof and not take them;
 * - rules that can never match or are never reached count as doing nothing.
 *
 * It is not Proton's check and does not replace it. Proton reads the grammar
 * again through mail/v4/filters/check before anything is saved.
 */

/**
 * The longest script accepted. A filter is confirmed by reading it, so it has
 * to stay readable. Raised from 20,000 on 06.11.2026, after a real account
 * held a filter of 20,130 characters, a long list of senders, that an
 * assistant could then neither change nor apply. A change to such a script is
 * read through the difference the window shows, not line by line.
 */
export const MAX_SCRIPT_LENGTH = 50_000

/** The longest filter name accepted. */
export const MAX_NAME_LENGTH = 100

/** How deep blocks and test lists may nest before the script is refused as unreadable. */
const MAX_DEPTH = 32

/** One of the two comments a script may carry: Proton's own line above the spam guard. */
export const GUARD_COMMENT = '# Generated: Do not run this script on spam messages'

/**
 * The other: the comment Proton's filter editor writes above each rule, which
 * its settings read back to show the rule in the simple editor. It holds
 * nothing but Proton's fixed words, "@type and" or "@type or" and one
 * "@comparator" per condition, so nothing can hide in it. Allowed since Tobi
 * decided so on 06.11.2026: 94 of his 98 filters carry it, and refused, it
 * kept an assistant from replacing or applying any of them. Proton writes it
 * with Windows line ends; a plain line feed is read the same.
 */
export const EDITOR_COMMENT =
  /^\/\*\*(?:\r?\n \* @type (?:and|or))?(?:\r?\n \* @comparator !?(?:contains|is|starts|ends|matches|default))*\r?\n \*\/$/

/**
 * Proton's spam guard, as Proton's own filter editor and assistant write it.
 *
 * The comparison below is on the parsed structure and the strings as written,
 * so a reformatted guard still counts, an escaped one does not. The text is
 * here for the tool description and the examples, which must show the guard
 * the same way Proton does.
 */
export const SPAM_GUARD_PROLOGUE =
  'require ["include", "environment", "variables", "relational", "comparator-i;ascii-numeric", "spamtest"];\n' +
  '\n' +
  `${GUARD_COMMENT}\n` +
  'if allof (environment :matches "vnd.proton.spam-threshold" "*",\n' +
  'spamtest :value "ge" :comparator "i;ascii-numeric" "${1}")\n' +
  '{\n' +
  '    return;\n' +
  '}\n'

/** The extensions the spam guard itself needs in the require line. */
const GUARD_EXTENSIONS = ['include', 'environment', 'variables', 'relational', 'comparator-i;ascii-numeric', 'spamtest']

/**
 * Every extension a proposed script may require, and for the refused ones the
 * reason. An extension that is not listed is refused as unknown.
 */
const EXTENSIONS: Readonly<Record<string, true | string>> = {
  include: true,
  environment: true,
  variables: true,
  relational: true,
  'comparator-i;ascii-numeric': true,
  spamtest: true,
  fileinto: true,
  imap4flags: true,
  date: true,
  envelope: true,
  extlists: true,
  reject: 'it turns mail away so it never arrives',
  vacation: 'it sends replies from your address without anyone reading them first',
  'vnd.proton.expire': 'it deletes mail after a set time',
  regex:
    'a regular expression can fail while Proton runs the filter, and whether that ends the later filters like stop is not known',
  'vnd.proton.eval':
    'arithmetic can fail while Proton runs the filter, and whether that ends the later filters like stop is not known',
}

/** Commands that are refused wherever they stand, with the reason. */
const REFUSED_COMMANDS: Readonly<Record<string, string>> = {
  discard: 'it deletes mail, and no later filter runs on the message',
  stop: 'it ends every later filter for a matching message, which switches those filters off without anyone seeing it',
  reject: 'it turns mail away so it never arrives',
  ereject: 'it turns mail away so it never arrives',
  vacation: 'it sends replies from your address without anyone reading them first',
  expire: 'it deletes mail after a set time',
  unexpire: 'it belongs to expiry, which is left to the user',
  redirect: 'it forwards mail to another address',
  notify: 'it sends notifications to another address',
  include: 'Proton runs other scripts through it only as return',
}

/** Commands a proposed script may use, apart from the control structure. */
const ACTIONS = new Set(['fileinto', 'addflag', 'removeflag', 'setflag', 'keep', 'set', 'return'])

/** Tests a proposed script may use. A test changes nothing, but an unknown one is still refused. */
const TESTS = new Set([
  'header',
  'address',
  'envelope',
  'exists',
  'size',
  'allof',
  'anyof',
  'not',
  'true',
  'false',
  'date',
  'currentdate',
  'string',
  'hasflag',
  'environment',
  'spamtest',
  'valid_ext_list',
])

/** The only tests that take other tests. */
const COMBINING_TESTS = new Set(['allof', 'anyof', 'not'])

/** Tests that are refused with the reason, because their extension is. */
const REFUSED_TESTS: Readonly<Record<string, string>> = {
  hasexpiration: 'it belongs to expiry, which is left to the user',
  expiration: 'it belongs to expiry, which is left to the user',
}

/** Tags a proposed script may use, in tests and in set. */
const TAGS = new Set([
  'is',
  'contains',
  'matches',
  'value',
  'count',
  'comparator',
  'all',
  'localpart',
  'domain',
  'user',
  'detail',
  'over',
  'under',
  'zone',
  'originalzone',
  'list',
  'lower',
  'upper',
  'lowerfirst',
  'upperfirst',
  'quotewildcard',
  'length',
])

/** Tags refused with the reason. */
const REFUSED_TAGS: Readonly<Record<string, string>> = {
  regex: EXTENSIONS.regex as string,
  eval: EXTENSIONS['vnd.proton.eval'] as string,
}

/** The comparators Proton documents. */
const COMPARATORS = new Set(['i;ascii-casemap', 'i;octet', 'i;ascii-numeric', 'i;unicode-casemap'])

/** What :value and :count may compare with. */
const RELATIONS = new Set(['gt', 'ge', 'lt', 'le', 'eq', 'ne'])

/** The modifiers set takes. :eval is refused above. */
const SET_MODIFIERS = new Set(['lower', 'upper', 'lowerfirst', 'upperfirst', 'quotewildcard', 'length'])

/** The two flags Proton knows, written without the escaping Sieve needs for the backslash. */
const FLAGS = new Map([
  ['\\seen', '\\Seen'],
  ['\\flagged', '\\Flagged'],
])

/**
 * Folder names a filter may not file into, as path segments compared after
 * folding: Trash and Spam hide mail, and Junk is what some clients call Spam.
 */
const HIDDEN_SEGMENTS = new Set(['trash', 'spam', 'junk'])

export type SieveArgument =
  | { kind: 'strings'; values: string[]; raws: string[]; list: boolean; multiLine: boolean; line: number }
  | { kind: 'number'; value: number; line: number }
  | { kind: 'tag'; name: string; line: number }

export interface SieveTest {
  name: string
  args: SieveArgument[]
  tests: SieveTest[]
  line: number
}

export interface SieveCommand {
  name: string
  args: SieveArgument[]
  tests: SieveTest[]
  block?: SieveCommand[]
  line: number
}

/** A comment as written, kept so the check can see it. */
export interface SieveComment {
  kind: 'hash' | 'bracket'
  text: string
  line: number
}

/** A script this file cannot read. The line is where the reading stopped. */
export class SieveSyntaxError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(message)
  }
}

type Punctuation = '[' | ']' | '(' | ')' | '{' | '}' | ',' | ';'

type Token =
  | { type: 'identifier'; value: string; line: number }
  | { type: 'tag'; value: string; line: number }
  | { type: 'number'; value: number; line: number }
  | { type: 'string'; value: string; raw: string; multiLine: boolean; line: number }
  | { type: 'punct'; value: Punctuation; line: number }

const IDENTIFIER = /[A-Za-z_][A-Za-z0-9_]*/y
const NUMBER = /[0-9]+([KMGkmg])?/y

/**
 * Splits a script into tokens and comments, following RFC 5228.
 *
 * Identifiers and tags are lowered, because Sieve compares them without case:
 * `FileInto` is `fileinto`, and a check that compared them as written would let
 * `Discard` through. Comments are kept rather than dropped, so the check can
 * refuse them.
 */
function tokenize(source: string): { tokens: Token[]; comments: SieveComment[] } {
  const tokens: Token[] = []
  const comments: SieveComment[] = []
  let i = 0
  let line = 1
  const n = source.length

  while (i < n) {
    const c = source[i]!
    if (c === '\n') {
      line++
      i++
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++
      continue
    }
    if (c === '#') {
      const start = i
      while (i < n && source[i] !== '\n') i++
      comments.push({ kind: 'hash', text: source.slice(start, i).replace(/\r$/, ''), line })
      continue
    }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      if (end < 0) throw new SieveSyntaxError('A comment that starts with /* is never closed.', line)
      comments.push({ kind: 'bracket', text: source.slice(i, end + 2), line })
      for (let k = i; k < end; k++) if (source[k] === '\n') line++
      i = end + 2
      continue
    }
    if ('[](){},;'.includes(c)) {
      tokens.push({ type: 'punct', value: c as Punctuation, line })
      i++
      continue
    }
    if (c === '"') {
      const start = line
      const from = i + 1
      let value = ''
      i++
      for (;;) {
        if (i >= n) throw new SieveSyntaxError('A quoted string is never closed.', start)
        const d = source[i]!
        if (d === '"') {
          i++
          break
        }
        if (d === '\\') {
          // RFC 5228, 2.4.2: a backslash takes the next character as it is.
          const next = source[i + 1]
          if (next === undefined) throw new SieveSyntaxError('A quoted string is never closed.', start)
          if (next === '\n') line++
          value += next
          i += 2
          continue
        }
        if (d === '\n') line++
        value += d
        i++
      }
      tokens.push({ type: 'string', value, raw: source.slice(from, i - 1), multiLine: false, line: start })
      continue
    }
    if (c === ':') {
      IDENTIFIER.lastIndex = i + 1
      const match = IDENTIFIER.exec(source)
      if (!match) throw new SieveSyntaxError('A colon is not followed by the name of a tag.', line)
      tokens.push({ type: 'tag', value: match[0].toLowerCase(), line })
      i = IDENTIFIER.lastIndex
      continue
    }
    if (c >= '0' && c <= '9') {
      NUMBER.lastIndex = i
      const match = NUMBER.exec(source)!
      const after = source[NUMBER.lastIndex]
      if (after !== undefined && /[A-Za-z0-9_]/.test(after)) {
        throw new SieveSyntaxError('A number runs straight into a word.', line)
      }
      const digits = Number.parseInt(match[0], 10)
      const unit = match[1]?.toUpperCase()
      const factor = unit === 'K' ? 1024 : unit === 'M' ? 1024 ** 2 : unit === 'G' ? 1024 ** 3 : 1
      tokens.push({ type: 'number', value: digits * factor, line })
      i = NUMBER.lastIndex
      continue
    }
    IDENTIFIER.lastIndex = i
    const word = IDENTIFIER.exec(source)
    if (word) {
      const value = word[0].toLowerCase()
      i = IDENTIFIER.lastIndex
      if (value === 'text' && source[i] === ':') {
        const start = line
        const read = readMultiLine(source, i + 1, line)
        tokens.push({ type: 'string', value: read.value, raw: read.value, multiLine: true, line: start })
        i = read.end
        line = read.line
        continue
      }
      tokens.push({ type: 'identifier', value, line })
      continue
    }
    const shown = c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')
    throw new SieveSyntaxError(`The character U+${shown} cannot stand here.`, line)
  }
  return { tokens, comments }
}

/**
 * Reads a multi-line string, from just after `text:` to the line that holds a
 * single dot. A line starting with two dots loses one, as RFC 5228, 2.4.2
 * describes. Proposals may not use them; they are read so the refusal can say
 * where.
 */
function readMultiLine(source: string, from: number, startLine: number): { value: string; end: number; line: number } {
  let i = from
  let line = startLine
  while (source[i] === ' ' || source[i] === '\t') i++
  if (source[i] === '#') while (i < source.length && source[i] !== '\n') i++
  if (source[i] === '\r') i++
  if (source[i] !== '\n') throw new SieveSyntaxError('text: has to be followed by the end of the line.', line)
  i++
  line++
  const lines: string[] = []
  for (;;) {
    if (i >= source.length) throw new SieveSyntaxError('A text: block is never closed with a line holding a single dot.', startLine)
    let end = source.indexOf('\n', i)
    if (end < 0) end = source.length
    let content = source.slice(i, end)
    if (content.endsWith('\r')) content = content.slice(0, -1)
    i = end + 1
    line++
    if (content === '.') break
    lines.push(content.startsWith('..') ? content.slice(1) : content)
  }
  return { value: lines.map((l) => `${l}\n`).join(''), end: i, line }
}

/** Reads tokens into commands and tests. */
class Parser {
  #position = 0

  constructor(private readonly tokens: Token[]) {}

  parse(): SieveCommand[] {
    const commands = this.#commands(0)
    const extra = this.#peek()
    if (extra) throw new SieveSyntaxError('A closing brace has no block to close.', extra.line)
    return commands
  }

  #peek(): Token | undefined {
    return this.tokens[this.#position]
  }

  #next(): Token | undefined {
    return this.tokens[this.#position++]
  }

  #isPunct(token: Token | undefined, value: Punctuation): boolean {
    return token?.type === 'punct' && token.value === value
  }

  #lastLine(): number {
    return this.tokens[this.tokens.length - 1]?.line ?? 1
  }

  #commands(depth: number): SieveCommand[] {
    const commands: SieveCommand[] = []
    for (;;) {
      const token = this.#peek()
      if (!token || this.#isPunct(token, '}')) return commands
      commands.push(this.#command(depth))
    }
  }

  #command(depth: number): SieveCommand {
    if (depth > MAX_DEPTH) throw new SieveSyntaxError('The script nests too deeply to be read.', this.#peek()?.line ?? 1)
    const head = this.#next()!
    if (head.type !== 'identifier') {
      throw new SieveSyntaxError('A command has to start with its name.', head.line)
    }
    const { args, tests } = this.#arguments(depth)
    const end = this.#next()
    if (this.#isPunct(end, ';')) return { name: head.value, args, tests, line: head.line }
    if (this.#isPunct(end, '{')) {
      const block = this.#commands(depth + 1)
      const close = this.#next()
      if (!this.#isPunct(close, '}')) {
        throw new SieveSyntaxError(`The block of ${head.value} is never closed.`, head.line)
      }
      return { name: head.value, args, tests, block, line: head.line }
    }
    throw new SieveSyntaxError(
      `${head.value} has to end with a semicolon or a block.`,
      end?.line ?? this.#lastLine(),
    )
  }

  /** The arguments of a command or test, then at most one test or one list of tests. */
  #arguments(depth: number): { args: SieveArgument[]; tests: SieveTest[] } {
    const args: SieveArgument[] = []
    for (;;) {
      const token = this.#peek()
      if (!token) return { args, tests: [] }
      if (token.type === 'string') {
        this.#next()
        args.push({ kind: 'strings', values: [token.value], raws: [token.raw], list: false, multiLine: token.multiLine, line: token.line })
        continue
      }
      if (token.type === 'number') {
        this.#next()
        args.push({ kind: 'number', value: token.value, line: token.line })
        continue
      }
      if (token.type === 'tag') {
        this.#next()
        args.push({ kind: 'tag', name: token.value, line: token.line })
        continue
      }
      if (this.#isPunct(token, '[')) {
        args.push(this.#stringList())
        continue
      }
      break
    }
    const token = this.#peek()
    if (token?.type === 'identifier') return { args, tests: [this.#test(depth + 1)] }
    if (this.#isPunct(token, '(')) return { args, tests: this.#testList(depth + 1) }
    return { args, tests: [] }
  }

  #stringList(): SieveArgument {
    const open = this.#next()!
    const values: string[] = []
    const raws: string[] = []
    let multiLine = false
    for (;;) {
      const token = this.#next()
      if (token?.type !== 'string') throw new SieveSyntaxError('A list in brackets may hold only strings.', token?.line ?? open.line)
      values.push(token.value)
      raws.push(token.raw)
      multiLine ||= token.multiLine
      const after = this.#next()
      if (this.#isPunct(after, ']')) return { kind: 'strings', values, raws, list: true, multiLine, line: open.line }
      if (!this.#isPunct(after, ',')) throw new SieveSyntaxError('A list in brackets is never closed.', open.line)
    }
  }

  #test(depth: number): SieveTest {
    if (depth > MAX_DEPTH) throw new SieveSyntaxError('The script nests too deeply to be read.', this.#peek()?.line ?? 1)
    const head = this.#next()
    if (!head) throw new SieveSyntaxError('A condition is missing at the end of the script.', this.#lastLine())
    if (head.type !== 'identifier') throw new SieveSyntaxError('A condition has to start with its name.', head.line)
    const { args, tests } = this.#arguments(depth)
    return { name: head.value, args, tests, line: head.line }
  }

  #testList(depth: number): SieveTest[] {
    const open = this.#next()!
    if (this.#isPunct(this.#peek(), ')')) throw new SieveSyntaxError('A list of conditions is empty.', open.line)
    const tests: SieveTest[] = []
    for (;;) {
      tests.push(this.#test(depth))
      const after = this.#next()
      if (this.#isPunct(after, ')')) return tests
      if (!this.#isPunct(after, ',')) throw new SieveSyntaxError('A list of conditions in parentheses is never closed.', open.line)
    }
  }
}

/** Reads a script into commands. Throws SieveSyntaxError when it cannot. */
export function parseSieve(source: string): SieveCommand[] {
  return new Parser(tokenize(source).tokens).parse()
}

export interface SieveReview {
  /** Why the script cannot be proposed. Empty when it can. */
  problems: string[]
  /** What the script does to a matching message, in plain words, without repeats. */
  effects: string[]
  /** What a person should look at twice before agreeing: mail that would go unnoticed. */
  warnings: string[]
  /**
   * The refused things the script does, in a few words each, such as
   * "discard" or "filing into Trash". Empty when it does none of them. For a
   * script this file cannot read, it says so. Used where a filter the user
   * wrote is moved: the order decides what those actions end up doing.
   */
  refused: string[]
}

/**
 * Characters that change how text is shown without being seen: format
 * characters, everything Unicode marks as ignorable by default, and the line
 * and paragraph separators. Written as properties, not as escapes.
 */
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}\p{Zl}\p{Zp}]/u
/** Control characters other than tab and the two line ends. */
const CONTROL = /[^\P{Cc}\t\n\r]/u
/** A carriage return that does not end a line. */
const LONE_CR = /\r(?!\n)/

function describeCharacter(text: string, pattern: RegExp): { code: string; line: number } | undefined {
  const match = pattern.exec(text)
  if (!match) return undefined
  const code = match[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')
  const line = text.slice(0, match.index).split('\n').length
  return { code: `U+${code}`, line }
}

/** Why a filter name cannot be used, or nothing when it can. */
export function filterNameProblem(name: string): string | undefined {
  const trimmed = name.trim()
  if (!trimmed) return 'The filter needs a name.'
  if (trimmed.length > MAX_NAME_LENGTH) return `The filter name is longer than ${MAX_NAME_LENGTH} characters.`
  if (/[\p{Cc}]/u.test(trimmed)) return 'The filter name contains a control character or a line break.'
  const hidden = describeCharacter(trimmed, INVISIBLE)
  if (hidden) {
    return `The filter name contains an invisible character (${hidden.code}), which can make it read as something else.`
  }
  return undefined
}

/** True when the strings of an argument are exactly these, in this order, written without escapes. */
function isStrings(arg: SieveArgument | undefined, ...values: string[]): boolean {
  return (
    arg?.kind === 'strings' &&
    !arg.multiLine &&
    arg.values.length === values.length &&
    arg.values.every((value, index) => value === values[index] && arg.raws[index] === value)
  )
}

function isTag(arg: SieveArgument | undefined, name: string): boolean {
  return arg?.kind === 'tag' && arg.name === name
}

/**
 * True when the command is Proton's spam guard:
 *
 *   if allof (environment :matches "vnd.proton.spam-threshold" "*",
 *             spamtest :value "ge" :comparator "i;ascii-numeric" "${1}") { return; }
 *
 * Compared as structure, in the order Proton writes it, so whitespace does not
 * matter but every part of the condition does. The strings have to stand as
 * Proton writes them, without escapes: whether Proton resolves an escape in
 * them the way RFC 5228 says is not known, and a guard that compares against
 * something else lets spam through to the rules below it.
 */
function isSpamGuard(command: SieveCommand): boolean {
  if (command.name !== 'if' || command.args.length !== 0 || command.tests.length !== 1) return false
  const all = command.tests[0]!
  if (all.name !== 'allof' || all.args.length !== 0 || all.tests.length !== 2) return false
  const [environment, spamtest] = all.tests as [SieveTest, SieveTest]
  const environmentOk =
    environment.name === 'environment' &&
    environment.tests.length === 0 &&
    environment.args.length === 3 &&
    isTag(environment.args[0], 'matches') &&
    isStrings(environment.args[1], 'vnd.proton.spam-threshold') &&
    isStrings(environment.args[2], '*')
  const spamtestOk =
    spamtest.name === 'spamtest' &&
    spamtest.tests.length === 0 &&
    spamtest.args.length === 5 &&
    isTag(spamtest.args[0], 'value') &&
    isStrings(spamtest.args[1], 'ge') &&
    isTag(spamtest.args[2], 'comparator') &&
    isStrings(spamtest.args[3], 'i;ascii-numeric') &&
    isStrings(spamtest.args[4], '${1}')
  const block = command.block ?? []
  const returnsOnly =
    block.length === 1 &&
    block[0]!.name === 'return' &&
    block[0]!.args.length === 0 &&
    block[0]!.tests.length === 0 &&
    block[0]!.block === undefined
  return environmentOk && spamtestOk && returnsOnly
}

type StringsArgument = Extract<SieveArgument, { kind: 'strings' }>

/**
 * The path segments of a folder name, folded the way a lenient reader might:
 * compatibility forms joined (fullwidth letters, the long s), case dropped,
 * the backslashes Proton uses to escape a slash removed, empty and "." parts
 * dropped. Whatever Proton does exactly, a name that folds to Trash, Spam or
 * Junk here is refused.
 */
export function folderSegments(target: string): string[] {
  return target
    .normalize('NFKC')
    .toLowerCase()
    .split('/')
    .map((segment) => segment.replace(/\\/g, '').trim())
    .filter((segment) => segment !== '' && segment !== '.')
}

/** The verdict on a condition when it does not depend on the message: true, false, or not known. */
function constant(test: SieveTest): boolean | undefined {
  switch (test.name) {
    case 'true':
      return true
    case 'false':
      return false
    case 'not': {
      const inner = test.tests[0] ? constant(test.tests[0]) : undefined
      return inner === undefined ? undefined : !inner
    }
    case 'allof': {
      const verdicts = test.tests.map(constant)
      if (verdicts.some((verdict) => verdict === false)) return false
      return verdicts.every((verdict) => verdict === true) ? true : undefined
    }
    case 'anyof': {
      const verdicts = test.tests.map(constant)
      if (verdicts.some((verdict) => verdict === true)) return true
      return verdicts.every((verdict) => verdict === false) ? false : undefined
    }
    default:
      return undefined
  }
}

interface Walk {
  problems: string[]
  effects: string[]
  refused: string[]
  marksRead: boolean
  movesAway: boolean
  acts: boolean
}

function addRefused(walk: Walk, what: string): void {
  if (!walk.refused.includes(what)) walk.refused.push(what)
}

function addEffect(walk: Walk, effect: string): void {
  if (!walk.effects.includes(effect)) walk.effects.push(effect)
}

/** Every string anywhere in a command or test: no line breaks, and addresses in plain ASCII. */
function checkStrings(args: SieveArgument[], line: number, walk: Walk): void {
  for (const arg of args) {
    if (arg.kind !== 'strings') continue
    if (arg.multiLine) {
      walk.problems.push(`Line ${line}: a text: block is not taken in a proposed filter. Write the string in quotes on one line.`)
      continue
    }
    for (const value of arg.values) {
      if (/[\r\n]/.test(value)) {
        walk.problems.push(`Line ${line}: a string runs over more than one line, which can make the script read as something it is not.`)
      } else if (value.includes('@') && /[^\x20-\x7e]/.test(value)) {
        walk.problems.push(
          `Line ${line}: "${value}" holds an address with letters outside plain ASCII. They can spell a familiar ` +
            'address that is a different one; write it in plain ASCII, a domain in its xn-- form.',
        )
      }
    }
  }
}

function checkTags(args: SieveArgument[], line: number, walk: Walk, allowed: ReadonlySet<string>): void {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg.kind !== 'tag') continue
    const refused = REFUSED_TAGS[arg.name]
    if (refused) {
      walk.problems.push(`Line ${line}: :${arg.name} is refused: ${refused}.`)
      addRefused(walk, arg.name === 'regex' ? 'regular expressions' : 'arithmetic')
      continue
    }
    if (!allowed.has(arg.name)) {
      walk.problems.push(`Line ${line}: :${arg.name} is not a tag a proposed filter may use here.`)
      continue
    }
    const next = args[index + 1]
    if (arg.name === 'comparator' && !(next?.kind === 'strings' && next.values.length === 1 && COMPARATORS.has(next.values[0]!))) {
      walk.problems.push(`Line ${line}: :comparator takes one of ${[...COMPARATORS].map((c) => `"${c}"`).join(', ')}.`)
    }
    if ((arg.name === 'value' || arg.name === 'count') && !(next?.kind === 'strings' && next.values.length === 1 && RELATIONS.has(next.values[0]!))) {
      walk.problems.push(`Line ${line}: :${arg.name} takes one of ${[...RELATIONS].map((r) => `"${r}"`).join(', ')}.`)
    }
  }
}

function walkTests(tests: SieveTest[], walk: Walk): void {
  for (const test of tests) {
    const refused = REFUSED_TESTS[test.name]
    if (refused) {
      walk.problems.push(`Line ${test.line}: the test ${test.name} is refused: ${refused}.`)
      addRefused(walk, test.name)
    } else if (!TESTS.has(test.name)) {
      walk.problems.push(`Line ${test.line}: ${test.name} is not a test a proposed filter may use.`)
      addRefused(walk, `the unknown test ${test.name}`)
    }
    if (COMBINING_TESTS.has(test.name)) {
      if (test.args.length > 0) walk.problems.push(`Line ${test.line}: ${test.name} takes conditions, nothing else.`)
      if (test.name === 'not' && test.tests.length !== 1) walk.problems.push(`Line ${test.line}: not takes exactly one condition.`)
      if (test.tests.length === 0) walk.problems.push(`Line ${test.line}: ${test.name} needs at least one condition.`)
    } else if (test.tests.length > 0) {
      walk.problems.push(`Line ${test.line}: ${test.name} takes no other condition after its arguments.`)
    }
    checkStrings(test.args, test.line, walk)
    checkTags(test.args, test.line, walk, TAGS)
    walkTests(test.tests, walk)
  }
}

/** The strings an action names, refusing a variable that could name something else after the check. */
function namedStrings(command: SieveCommand, walk: Walk, what: string): string[] | undefined {
  const strings = command.args.filter((arg): arg is StringsArgument => arg.kind === 'strings')
  if (
    command.args.some((arg) => arg.kind !== 'strings') ||
    strings.length !== 1 ||
    command.tests.length > 0
  ) {
    walk.problems.push(`Line ${command.line}: ${command.name} takes exactly one ${what} here, written out, and nothing else.`)
    return undefined
  }
  const values = strings[0]!.values
  if (values.some((value) => value.includes('${'))) {
    walk.problems.push(
      `Line ${command.line}: the ${what} of ${command.name} has to be written out. A variable could ` +
        'name something the check never saw.',
    )
    if (command.name === 'fileinto') addRefused(walk, 'filing into a folder named by a variable')
    return undefined
  }
  return values
}

/**
 * Walks commands in order. `reachable` says whether these commands can run at
 * all: an action after a plain return, or inside a rule whose condition can
 * never be true, does not count as something the filter does.
 */
function walkCommands(commands: SieveCommand[], walk: Walk, reachable: boolean): void {
  let previous: string | undefined
  let chainSettled = false
  let live = reachable
  for (const command of commands) {
    const name = command.name
    if (name === 'require') {
      walk.problems.push(`Line ${command.line}: require belongs at the top of the script, before everything else.`)
    } else if (name === 'if' || name === 'elsif' || name === 'else') {
      if ((name === 'elsif' || name === 'else') && previous !== 'if' && previous !== 'elsif') {
        walk.problems.push(`Line ${command.line}: ${name} has to follow an if or an elsif.`)
      }
      if (command.args.length > 0) walk.problems.push(`Line ${command.line}: ${name} takes a condition and a block, nothing else.`)
      if (name === 'else' && command.tests.length > 0) {
        walk.problems.push(`Line ${command.line}: else takes no condition.`)
      }
      if (name !== 'else' && command.tests.length !== 1) {
        walk.problems.push(`Line ${command.line}: ${name} needs exactly one condition.`)
      }
      if (!command.block) walk.problems.push(`Line ${command.line}: ${name} needs a block in braces.`)
      walkTests(command.tests, walk)
      if (name === 'if') chainSettled = false
      const verdict = name === 'else' ? true : command.tests[0] ? constant(command.tests[0]) : undefined
      const runs = live && !chainSettled && verdict !== false
      walkCommands(command.block ?? [], walk, runs)
      // A branch that always runs leaves the rest of the chain unreachable.
      if (verdict === true) chainSettled = true
      // A rule that always runs and returns ends the script for every message.
      if (runs && verdict === true && name === 'if' && (command.block ?? []).some((inner) => inner.name === 'return')) {
        live = false
      }
    } else if (REFUSED_COMMANDS[name]) {
      walk.problems.push(
        `Line ${command.line}: ${name} is refused: ${REFUSED_COMMANDS[name]}. Only the user can add it, in Proton's settings.`,
      )
      addRefused(walk, name)
    } else if (!ACTIONS.has(name)) {
      walk.problems.push(`Line ${command.line}: ${name} is not a command a proposed filter may use.`)
      addRefused(walk, `the unknown command ${name}`)
    } else {
      if (command.block) walk.problems.push(`Line ${command.line}: ${name} takes no block.`)
      if (command.tests.length > 0) walk.problems.push(`Line ${command.line}: ${name} takes no condition.`)
      checkStrings(command.args, command.line, walk)
      checkAction(command, walk, live)
      if (name === 'return') live = false
    }
    previous = name
  }
}

function checkAction(command: SieveCommand, walk: Walk, live: boolean): void {
  switch (command.name) {
    case 'fileinto': {
      const values = namedStrings(command, walk, 'folder or label')
      if (!values) return
      if (values.length !== 1) {
        walk.problems.push(`Line ${command.line}: fileinto takes one folder or label at a time.`)
        return
      }
      const target = values[0]!
      const segments = folderSegments(target)
      const hidden = segments.find((segment) => HIDDEN_SEGMENTS.has(segment))
      if (hidden) {
        walk.problems.push(
          `Line ${command.line}: filing into ${JSON.stringify(target)} is refused: it names ${hidden === 'trash' ? 'Trash' : 'Spam'}, which hides mail. ` +
            "Only the user can add it, in Proton's settings.",
        )
        addRefused(walk, hidden === 'trash' ? 'filing into Trash' : 'filing into Spam')
        return
      }
      if (/^\d+$/.test(segments.join(''))) {
        walk.problems.push(
          `Line ${command.line}: filing into ${JSON.stringify(target)} is refused: Proton numbers its own folders, 3 is Trash ` +
            'and 4 is Spam, so a folder given as a number is not taken.',
        )
        addRefused(walk, 'filing into a folder given as a number')
        return
      }
      if (segments.length === 0) {
        walk.problems.push(`Line ${command.line}: fileinto names no folder.`)
        return
      }
      if (!live) return
      walk.acts = true
      if (segments.length === 1 && segments[0] === 'inbox') {
        addEffect(walk, 'moves it into the inbox')
      } else {
        // Labels and folders cannot be told apart here: both are filed with
        // fileinto, and only the account knows which name is which.
        addEffect(walk, `files it into ${JSON.stringify(target)}`)
        walk.movesAway = true
      }
      return
    }
    case 'addflag':
    case 'removeflag':
    case 'setflag': {
      const values = namedStrings(command, walk, 'flag')
      if (!values) return
      const flags: string[] = []
      // RFC 5232 allows several flags in one string, separated by spaces.
      for (const value of values.flatMap((v) => v.split(/\s+/)).filter(Boolean)) {
        const flag = FLAGS.get(value.toLowerCase())
        if (!flag) {
          walk.problems.push(`Line ${command.line}: "${value}" is not a flag Proton knows. Only \\Seen and \\Flagged are.`)
          return
        }
        flags.push(flag)
      }
      if (flags.length === 0 && command.name !== 'setflag') {
        walk.problems.push(`Line ${command.line}: ${command.name} names no flag.`)
        return
      }
      if (!live) return
      walk.acts = true
      const seen = flags.includes('\\Seen')
      const flagged = flags.includes('\\Flagged')
      if (command.name === 'removeflag') {
        if (seen) addEffect(walk, 'marks it as unread')
        if (flagged) addEffect(walk, 'removes its star')
      } else {
        if (seen) {
          addEffect(walk, 'marks it as read')
          walk.marksRead = true
        }
        if (flagged) addEffect(walk, 'stars it')
        if (command.name === 'setflag') {
          if (!seen) addEffect(walk, 'marks it as unread')
          if (!flagged) addEffect(walk, 'removes its star')
        }
      }
      return
    }
    case 'keep':
    case 'return':
      if (command.args.length > 0) walk.problems.push(`Line ${command.line}: ${command.name} takes no arguments.`)
      return
    case 'set': {
      // set [modifiers] "name" "value". Variables change nothing on their own;
      // the actions that could use one to name a target refuse variables.
      checkTags(command.args, command.line, walk, SET_MODIFIERS)
      const strings = command.args.filter((arg): arg is StringsArgument => arg.kind === 'strings')
      const misplaced = command.args.findIndex((arg) => arg.kind === 'strings') < command.args.findLastIndex((arg) => arg.kind === 'tag')
      if (
        strings.length !== 2 ||
        strings.some((arg) => arg.list) ||
        command.args.some((arg) => arg.kind === 'number') ||
        misplaced
      ) {
        walk.problems.push(`Line ${command.line}: set takes its modifiers, then a name and a value, each one string.`)
        return
      }
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(strings[0]!.values[0]!)) {
        walk.problems.push(`Line ${command.line}: "${strings[0]!.values[0]}" is not a variable name.`)
      }
      return
    }
  }
}

/**
 * Checks a proposed script against everything above.
 *
 * Every problem is listed, not just the first, so an assistant can correct
 * the script in one go rather than one refusal at a time.
 */
export function reviewSieve(source: string): SieveReview {
  const problems: string[] = []
  if (source.length > MAX_SCRIPT_LENGTH) {
    return {
      problems: [`The script is longer than ${MAX_SCRIPT_LENGTH} characters, too long to be read before it is confirmed.`],
      effects: [],
      warnings: [],
      refused: ['a script too long to be checked here'],
    }
  }
  const hidden = describeCharacter(source, INVISIBLE)
  if (hidden) {
    problems.push(
      `Line ${hidden.line}: the script contains an invisible character (${hidden.code}). ` +
        'It can make the script read differently from what it does, so it is refused.',
    )
  }
  const control = describeCharacter(source, CONTROL)
  if (control) problems.push(`Line ${control.line}: the script contains a control character (${control.code}).`)
  const lone = describeCharacter(source, LONE_CR)
  if (lone) problems.push(`Line ${lone.line}: a carriage return stands without a line feed, which readers split differently.`)
  if (problems.length > 0) return { problems, effects: [], warnings: [], refused: ['characters that hide what the script does'] }

  let commands: SieveCommand[]
  let comments: SieveComment[]
  try {
    const read = tokenize(source)
    comments = read.comments
    commands = new Parser(read.tokens).parse()
  } catch (error) {
    if (error instanceof SieveSyntaxError) {
      return { problems: [`Line ${error.line}: ${error.message}`], effects: [], warnings: [], refused: ['a script this check cannot read'] }
    }
    throw error
  }

  // Two comments are Proton's own: the line above the guard and the one its
  // filter editor writes. Any other can make the script read as something
  // else, and comments are where parsers part ways.
  for (const comment of comments) {
    if (comment.kind === 'hash' && comment.text.trim() === GUARD_COMMENT) continue
    if (comment.kind === 'bracket' && EDITOR_COMMENT.test(comment.text)) continue
    problems.push(
      `Line ${comment.line}: comments are not taken in a proposed filter, except Proton's own two: the line above ` +
        "the spam guard and the one Proton's filter editor writes above a rule. A comment can make the script read " +
        'differently in the confirmation from what it does.',
    )
  }

  // The require lines come first, as Sieve demands.
  const required = new Set<string>()
  const refusedExtensions: string[] = []
  let index = 0
  while (commands[index]?.name === 'require') {
    const command = commands[index]!
    const lists = command.args.filter((arg): arg is StringsArgument => arg.kind === 'strings')
    if (lists.length !== 1 || command.args.length !== 1 || command.tests.length > 0 || command.block) {
      problems.push(`Line ${command.line}: require takes one name or one list of names.`)
    }
    for (const list of lists) {
      for (const [position, value] of list.values.entries()) {
        const extension = value.toLowerCase()
        const verdict = EXTENSIONS[extension]
        if (verdict === undefined || list.raws[position] !== value || list.multiLine) {
          problems.push(`Line ${command.line}: the extension "${value}" is not one a proposed filter may use.`)
        } else if (verdict !== true) {
          problems.push(
            `Line ${command.line}: the extension "${value}" is refused: ${verdict}. Only the user can add it, in Proton's settings.`,
          )
          refusedExtensions.push(
            extension === 'vnd.proton.expire'
              ? 'expire'
              : extension === 'regex'
                ? 'regular expressions'
                : extension === 'vnd.proton.eval'
                  ? 'arithmetic'
                  : extension,
          )
        }
        required.add(extension)
      }
    }
    index++
  }

  const guard = commands[index]
  const after = commands[index + 1]
  if (!guard || !isSpamGuard(guard) || after?.name === 'elsif' || after?.name === 'else') {
    problems.push(
      "Proton's spam guard has to come right after require, unchanged and written without escapes, so the " +
        'filter never runs on spam. Start the script with this, and put your rules below it:\n\n' +
        SPAM_GUARD_PROLOGUE,
    )
  } else {
    const missing = GUARD_EXTENSIONS.filter((extension) => !required.has(extension))
    if (missing.length > 0) {
      problems.push(`The spam guard needs these in require as well: ${missing.map((m) => `"${m}"`).join(', ')}.`)
    }
    index++
  }

  const walk: Walk = { problems, effects: [], refused: [], marksRead: false, movesAway: false, acts: false }
  for (const extension of refusedExtensions) addRefused(walk, extension)
  walkCommands(commands.slice(index), walk, true)

  if (problems.length === 0 && !walk.acts) {
    problems.push(
      'The script does nothing to a message beyond the spam guard: no rule in it can ever act. A filter that ' +
        'does nothing is how a rule is switched off, and that is left to the user.',
    )
  }

  const warnings: string[] = []
  if (walk.marksRead && walk.movesAway) {
    warnings.push('Matching mail is marked as read and moved out of the inbox, so it can arrive without you ever noticing it.')
  } else if (walk.marksRead) {
    warnings.push('Matching mail is marked as read, so it does not show up as new.')
  }
  return { problems, effects: walk.effects, warnings, refused: walk.refused }
}

/**
 * Whether two scripts are the same filter as far as a person could tell:
 * the same characters, with line ends and trailing spaces evened out. Proton
 * may store a script with other line ends than it was sent with.
 */
export function sameScript(a: string, b: string): boolean {
  const even = (script: string): string =>
    script
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.replace(/[ \t]+$/, ''))
      .join('\n')
      .trimEnd()
  return even(a) === even(b)
}
