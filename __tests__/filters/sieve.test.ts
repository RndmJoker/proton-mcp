import { describe, it, expect } from 'vitest'
import {
  reviewSieve,
  parseSieve,
  filterNameProblem,
  parseUnlocks,
  SPAM_GUARD_PROLOGUE,
  MAX_SCRIPT_LENGTH,
  UNLOCKABLE,
  SieveSyntaxError,
  type Unlockable,
} from '../../src/filters/sieve.js'

/**
 * The check every proposed filter passes, in this server and again in the
 * browser extension (#59).
 *
 * A filter keeps acting long after the conversation that wrote it, so the
 * question here is not whether a script is valid Sieve, which Proton checks,
 * but whether it can delete, hide, answer or switch off anything. Each refusal
 * also has to say why, because the assistant reads it and corrects the script.
 */

const GUARD = SPAM_GUARD_PROLOGUE.replace(
  '"spamtest"];',
  '"spamtest", "fileinto", "imap4flags"];',
)
const script = (rules: string) => `${GUARD}\n${rules}\n`

describe('scripts that pass', () => {
  it("accepts a rule written the way Proton's own assistant writes one", () => {
    const review = reviewSieve(script('if address :is "from" "tickets@airline.example" {\n    fileinto "Travel";\n}'))
    expect(review.problems).toEqual([])
    expect(review.effects).toEqual(['files it into "Travel"'])
    expect(review.warnings).toEqual([])
  })

  it('accepts the guard reformatted and without its comment, since the structure is what counts', () => {
    const compact =
      'require ["include","environment","variables","relational","comparator-i;ascii-numeric","spamtest","fileinto"];' +
      'if allof(environment :matches "vnd.proton.spam-threshold" "*",spamtest :value "ge" :comparator "i;ascii-numeric" "${1}"){return;}' +
      'if header :contains "subject" "invoice" { fileinto "Bills"; }'
    expect(reviewSieve(compact).problems).toEqual([])
  })

  it('reads stars, unread and the inbox as what they are', () => {
    const review = reviewSieve(
      script(
        'if header :contains "subject" "urgent" {\n  addflag "\\\\Flagged";\n  removeflag "\\\\Seen";\n  fileinto "inbox";\n}',
      ),
    )
    expect(review.problems).toEqual([])
    expect(review.effects).toEqual(['stars it', 'marks it as unread', 'moves it into the inbox'])
  })

  it('reads elsif, else, anyof, not and size', () => {
    const review = reviewSieve(
      script(
        [
          'if anyof (not exists "x-spam", size :over 1M) {',
          '  fileinto "Big";',
          '} elsif header :matches "subject" "*report*" {',
          '  fileinto "Reports";',
          '} else {',
          '  keep;',
          '}',
        ].join('\n'),
      ),
    )
    expect(review.problems).toEqual([])
  })
})

describe('what deletes, hides, answers or switches off', () => {
  it.each([
    ['discard', 'discard;', 'it deletes mail'],
    ['stop', 'fileinto "A";\n  stop;', 'switches those filters off'],
    // Proton's filters do not run redirect at all, measured in its documentation on 06.11.2026.
    ['redirect', 'redirect "someone@example.org";', 'Proton does not run it in filters'],
  ])('refuses %s and says why', (_name, body, reason) => {
    const review = reviewSieve(script(`if true {\n  ${body}\n}`))
    expect(review.problems.join('\n')).toContain(reason)
  })

  it('refuses them however they are capitalised, as Sieve does not care', () => {
    expect(reviewSieve(script('if true { Discard; }')).problems.join('\n')).toContain('discard is refused')
    expect(reviewSieve(script('if true { STOP; }')).problems.join('\n')).toContain('stop is refused')
  })

  it.each([
    ['reject', 'it turns mail away'],
    ['vacation', 'sends replies from your address'],
    ['vnd.proton.expire', 'deletes mail after a set time'],
  ])('refuses the extension %s already in require', (extension, reason) => {
    const source = SPAM_GUARD_PROLOGUE.replace('"spamtest"];', `"spamtest", "fileinto", "${extension}"];`) +
      'if true { fileinto "A"; }'
    expect(reviewSieve(source).problems.join('\n')).toContain(reason)
  })

  it.each(['Trash', 'SPAM', ' trash '])('refuses filing into %j', (folder) => {
    const review = reviewSieve(script(`if true { fileinto "${folder}"; }`))
    expect(review.problems.join('\n')).toContain('hides mail')
  })

  it('refuses a folder named by a variable, which could be Trash after the check', () => {
    const review = reviewSieve(
      script('require "variables";\nif true { set "f" "Trash"; fileinto "${f}"; }').replace('require "variables";\n', ''),
    )
    expect(review.problems.join('\n')).toContain('has to be written out')
  })

  it('refuses a script that does nothing, which is how a rule is switched off', () => {
    expect(reviewSieve(GUARD).problems.join('\n')).toContain('does nothing to a message')
    expect(reviewSieve(script('if true { keep; }')).problems.join('\n')).toContain('does nothing to a message')
  })

  it('warns when mail is marked as read, and more so when it is also moved away', () => {
    expect(reviewSieve(script('if true { addflag "\\\\Seen"; }')).warnings).toEqual([
      'Matching mail is marked as read, so it does not show up as new.',
    ])
    expect(reviewSieve(script('if true { addflag "\\\\Seen"; fileinto "Archive"; }')).warnings[0]).toContain(
      'without you ever noticing it',
    )
  })

  it('refuses a flag Proton does not know', () => {
    expect(reviewSieve(script('if true { addflag "\\\\Deleted"; }')).problems.join('\n')).toContain('not a flag Proton knows')
  })

  it('refuses an unknown command, test or extension rather than guessing', () => {
    expect(reviewSieve(script('if true { teleport "x"; }')).problems.join('\n')).toContain('not a command')
    expect(reviewSieve(script('if hasexpiration { fileinto "A"; }')).problems.join('\n')).toContain('expiry')
    expect(reviewSieve(script('if mystery { fileinto "A"; }')).problems.join('\n')).toContain('not a test')
    const unknown = SPAM_GUARD_PROLOGUE.replace('"spamtest"];', '"spamtest", "fileinto", "editheader"];') + 'if true { fileinto "A"; }'
    expect(reviewSieve(unknown).problems.join('\n')).toContain('"editheader" is not one')
  })
})

describe('the spam guard', () => {
  it('is required, and the refusal shows it so the assistant can copy it', () => {
    const review = reviewSieve('require "fileinto";\nif true { fileinto "A"; }')
    expect(review.problems.join('\n')).toContain('spam guard has to come right after require')
    expect(review.problems.join('\n')).toContain('vnd.proton.spam-threshold')
  })

  it('may not be weakened', () => {
    const weaker = script('if true { fileinto "A"; }').replace(':value "ge"', ':value "gt"')
    expect(reviewSieve(weaker).problems.join('\n')).toContain('spam guard')
    const otherThreshold = script('if true { fileinto "A"; }').replace('"${1}"', '"99"')
    expect(reviewSieve(otherThreshold).problems.join('\n')).toContain('spam guard')
  })

  it('may not do more than return, and may not be followed by an else that runs on spam', () => {
    const more = script('if true { fileinto "A"; }').replace('return;', 'fileinto "Inbox"; return;')
    expect(reviewSieve(more).problems.join('\n')).toContain('spam guard')
    const elseAfter = script('else { fileinto "A"; }')
    expect(reviewSieve(elseAfter).problems.join('\n')).toContain('spam guard')
  })

  it('has to come before the rules', () => {
    const late = 'require ["include", "environment", "variables", "relational", "comparator-i;ascii-numeric", "spamtest", "fileinto"];\n' +
      'if true { fileinto "A"; }\n' + SPAM_GUARD_PROLOGUE.split('\n').slice(2).join('\n')
    expect(reviewSieve(late).problems.join('\n')).toContain('spam guard')
  })

  it('needs its extensions in require', () => {
    const source = SPAM_GUARD_PROLOGUE.replace('"include", ', '').replace('"spamtest"];', '"spamtest", "fileinto"];') +
      'if true { fileinto "A"; }'
    expect(reviewSieve(source).problems.join('\n')).toContain('"include"')
  })
})

describe('what could make the script read differently', () => {
  it('refuses a right-to-left override, which can disguise a folder name', () => {
    const override = String.fromCodePoint(0x202e)
    const review = reviewSieve(script(`if true { fileinto "hsarT${override}"; }`))
    expect(review.problems.join('\n')).toContain('U+202E')
  })

  it('refuses a zero width space and control characters', () => {
    expect(reviewSieve(script(`if true { fileinto "A${String.fromCodePoint(0x200b)}"; }`)).problems.join('\n')).toContain('U+200B')
    expect(reviewSieve(script(`if true { fileinto "A${String.fromCodePoint(0x7)}"; }`)).problems.join('\n')).toContain('U+0007')
  })

  it('refuses a script too long to read before agreeing to it', () => {
    const long = script(`if true { fileinto "A"; }\n#${'x'.repeat(MAX_SCRIPT_LENGTH)}`)
    expect(reviewSieve(long).problems[0]).toContain('too long to be read')
  })
})

describe('reading', () => {
  it('names the line where reading stopped', () => {
    expect(reviewSieve(script('if true { fileinto "A" }')).problems.join('\n')).toMatch(/Line \d+: fileinto has to end/)
    expect(reviewSieve(script('if true { fileinto "A;\n}')).problems.join('\n')).toMatch(/Line \d+: A quoted string is never closed/)
    expect(reviewSieve(script('if true { fileinto "A";')).problems.join('\n')).toMatch(/block of if is never closed/)
  })

  it('takes escapes in strings as Sieve does', () => {
    const [command] = parseSieve('fileinto "Work/Misc\\\\/Others";')
    expect(command!.args[0]).toMatchObject({ kind: 'strings', values: ['Work/Misc\\/Others'] })
  })

  it('stops at a nesting deeper than anyone writes by hand', () => {
    const deep = `${'if true {'.repeat(40)}fileinto "A";${'}'.repeat(40)}`
    expect(() => parseSieve(deep)).toThrow(SieveSyntaxError)
  })
})

describe('the name', () => {
  it('accepts an ordinary name, umlauts included', () => {
    expect(filterNameProblem('Travel')).toBeUndefined()
    expect(filterNameProblem(`B${String.fromCodePoint(0xfc)}ro`)).toBeUndefined()
  })

  it('refuses an empty, an overlong and a disguised name', () => {
    expect(filterNameProblem('  ')).toContain('needs a name')
    expect(filterNameProblem('x'.repeat(101))).toContain('longer than')
    expect(filterNameProblem('a\nb')).toContain('line break')
    expect(filterNameProblem(`a${String.fromCodePoint(0x202e)}b`)).toContain('invisible')
  })
})

describe('what a filter does that an assistant may not set up (for moving filters)', () => {
  it('names each refused action once, in plain words', () => {
    const source = SPAM_GUARD_PROLOGUE.replace('"spamtest"];', '"spamtest", "fileinto", "vnd.proton.expire"];') +
      'if true { fileinto "Trash"; discard; discard; stop; expire "day" "3"; }'
    expect(reviewSieve(source).refused).toEqual(['expire', 'filing into Trash', 'discard', 'stop'])
  })

  it('is empty for a filter that only files and flags', () => {
    expect(reviewSieve(script('if true { fileinto "A"; addflag "\\\\Seen"; }')).refused).toEqual([])
  })

  it('says so for a script it cannot read or that is too long', () => {
    expect(reviewSieve('if true {').refused).toEqual(['a script this check cannot read'])
    expect(reviewSieve('x'.repeat(MAX_SCRIPT_LENGTH + 1)).refused).toEqual(['a script too long to be checked here'])
  })
})

describe('what the review of 06.11.2026 found', () => {
  const cp = (code: number) => String.fromCodePoint(code)
  const problems = (source: string) => reviewSieve(source).problems.join('\n')

  it('refuses text: blocks, where a parser may read a discard that looks commented out', () => {
    const disguised = script('if not header :contains "subject" text:\n\n.\n{ fileinto "Archive"; }\n')
    expect(problems(disguised)).toContain('text: block is not taken')
  })

  it("refuses every comment but Proton's own two", () => {
    expect(problems(script('/* old: { discard; } */\nif true { fileinto "A"; }'))).toContain('comments are not taken')
    expect(problems(script('# just a note\nif true { fileinto "A"; }'))).toContain('comments are not taken')
    expect(reviewSieve(script('if true { fileinto "A"; }')).problems).toEqual([])
  })

  it("takes the comment Proton's filter editor writes above a rule, exactly as it writes it", () => {
    // Measured on 06.11.2026: 94 of 98 filters in Tobi's account carry it,
    // written by Proton's settings. Built the way its web client builds it.
    const editor = (...lines: string[]) => ['/**', ...lines, '/'].join('\r\n *')
    const rule = 'if address :is "from" "a@example.com" {\r\n    fileinto "Travel";\r\n}\r\n'
    for (const comment of [
      editor(' @type and', ' @comparator contains', ' @comparator contains'),
      editor(' @type or', ' @comparator !is', ' @comparator default'),
      editor(' @comparator matches'),
      editor(),
      editor(' @type and', ' @comparator starts', ' @comparator !ends').replace(/\r/g, ''),
    ]) {
      expect(reviewSieve(`${GUARD}\r\n${comment}\r\n${rule}`).problems).toEqual([])
    }
  })

  it("refuses anything in that comment beyond Proton's fixed words", () => {
    const editor = (...lines: string[]) => ['/**', ...lines, '/'].join('\r\n *')
    for (const comment of [
      editor(' @type and', ' @comparator contains discard;'),
      editor(' @comparator regex'),
      editor(' @note keeps everything'),
      editor(' @type and', ' @type or'),
      editor(' @comparator contains', ' } discard; {'),
      // A space more than Proton writes is already something else.
      editor(' @comparator contains '),
      '/** @type and @comparator contains */',
      '/*\r\n * @comparator contains\r\n */',
    ]) {
      expect(problems(script(`${comment}\nif true { fileinto "A"; }`))).toContain('comments are not taken')
    }
    // The same words as a line comment are a comment like any other.
    expect(problems(script('# @type and\nif true { fileinto "A"; }'))).toContain('comments are not taken')
  })

  it('refuses characters that hide or change what a line says', () => {
    expect(problems(script(`if address :is "from" "boss@example.com${cp(0x34f)}" { fileinto "A"; }`))).toContain('U+034F')
    expect(problems(script(`if exists "from" { fileinto "A"; }${cp(0x2028)}`))).toContain('U+2028')
    expect(problems(script('if true { fileinto "A"; } \rif true { fileinto "B"; }'))).toContain('carriage return stands')
    expect(problems(script('if header :contains "subject" "a\nb" { fileinto "A"; }'))).toContain('more than one line')
  })

  it('takes addresses only in plain ASCII, as recipients since #42', () => {
    expect(problems(script(`if address :is "from" "b${cp(0x43e)}ss@example.com" { fileinto "A"; }`))).toContain('plain ASCII')
    expect(reviewSieve(script(`if header :contains "subject" "Best${cp(0xe4)}tigung" { fileinto "A"; }`)).problems).toEqual([])
  })

  it('takes the spam guard only as Proton writes it, without escapes', () => {
    // An escape that leaves the value as it is: only how it is written
    // differs, and a parser that reads "\${1}" as text never matches the
    // threshold, so the guard would never keep the filter off spam. The first
    // version of this test escaped the backslash itself, which changed the
    // value, and passed without the check it was written for.
    const rule = script('if true { fileinto "A"; }')
    expect(problems(rule.replace('"*"', '"\\*"'))).toContain('without escapes')
    expect(problems(rule.replace('"${1}"', '"\\${1}"'))).toContain('without escapes')
    expect(problems(rule.replace('"ge"', '"g\\e"'))).toContain('without escapes')
  })

  it('refuses a cut off list of conditions instead of failing inside', () => {
    expect(problems('if anyof (')).toMatch(/Line \d+: A condition is missing/)
    expect(problems(script('if anyof (true,'))).toMatch(/Line \d+:/)
  })

  it('checks the arguments of set, if and conditions, not only names', () => {
    expect(problems(script('set "a" "b" discard;\nif true { fileinto "A"; }'))).toContain('set takes no condition')
    expect(problems(script('if "x" :is true { fileinto "A"; }'))).toContain('takes a condition and a block')
    expect(problems(script('if size :over 10true { fileinto "A"; }'))).toContain('runs straight into a word')
    expect(problems(script('if header :foo "a" "b" { fileinto "A"; }'))).toContain(':foo is not a tag')
    expect(problems(script('if header :comparator "i;weird" "a" "b" { fileinto "A"; }'))).toContain(':comparator takes one of')
    expect(problems(script('if exists "x" true { fileinto "A"; }'))).toContain('takes no other condition')
  })

  it('counts a rule that can never match, or is never reached, as doing nothing', () => {
    for (const rules of [
      'if false { fileinto "A"; }',
      'if not true { fileinto "A"; }',
      'if allof (true, false) { fileinto "A"; }',
      'return;\nif true { fileinto "A"; }',
      'if true { return; }\nif true { fileinto "A"; }',
      'if true { keep; } elsif true { fileinto "A"; }',
    ]) {
      expect(problems(script(rules)), rules).toContain('does nothing')
    }
  })

  it('refuses folder names that may mean Trash or Spam to a lenient reader, and folder numbers', () => {
    for (const folder of ['Trash/', '/Trash', 'trash/sub', './Trash', 'Tr\\\\ash', '\\\\Trash', `Tra${cp(0x17f)}h`, `${cp(0x17f)}pam`, `${cp(0xff34)}rash`, 'Junk', '3', '40']) {
      expect(problems(script(`if true { fileinto "${folder}"; }`)), folder).toMatch(/refused/)
    }
    expect(reviewSieve(script(`if true { fileinto "Rechnungen/B${cp(0xfc)}ro"; }`)).problems).toEqual([])
  })

  it('refuses regular expressions and arithmetic, which might end the run like stop', () => {
    const regex = SPAM_GUARD_PROLOGUE.replace('"spamtest"];', '"spamtest", "fileinto", "regex"];') + 'if header :regex "subject" "x" { fileinto "A"; }'
    expect(problems(regex)).toContain('regular expression can fail')
    expect(problems(script('set :eval "x" "1/0";\nif true { fileinto "A"; }'))).toContain(':eval is refused')
  })

  it('names a folder given by a variable among the refused actions, for the warning when filters move', () => {
    expect(reviewSieve(script('set "f" "trash";\nif true { fileinto "${f}"; }')).refused).toContain('filing into a folder named by a variable')
  })

  it('takes several flags in one string, as RFC 5232 allows', () => {
    expect(reviewSieve(script('if true { addflag "\\\\Seen \\\\Flagged"; }')).effects).toEqual(['marks it as read', 'stars it'])
  })

  it('quotes a folder name so it cannot write its own sentence into the confirmation', () => {
    const effects = reviewSieve(script('if true { fileinto "Receipts\\" only if known. It changes nothing else, and \\"Receipts"; }')).effects
    expect(effects).toEqual(['files it into "Receipts\\" only if known. It changes nothing else, and \\"Receipts"'])
  })

  it('refuses invisible characters and line separators in a filter name', () => {
    expect(filterNameProblem(`a${cp(0x2028)}b`)).toContain('invisible')
    expect(filterNameProblem(`n${cp(0x34f)}ame`)).toContain('invisible')
  })
})

describe('what the user can allow, one action at a time (Tobi, 06.11.2026)', () => {
  const allow = (...actions: Unlockable[]) => new Set(actions)
  const withExtensions = (extensions: string, rules: string) =>
    `${SPAM_GUARD_PROLOGUE.replace('"spamtest"];', `"spamtest", ${extensions}];`)}\n${rules}\n`

  it.each([
    ['trash', script('if address :is "from" "a@example.com" { fileinto "Trash"; }'), 'moves it to Trash'],
    ['discard', script('if address :is "from" "a@example.com" { discard; }'), 'deletes it at once and for good'],
    ['stop', script('if address :is "from" "a@example.com" { fileinto "A"; stop; }'), 'keeps every later filter from running on it'],
    ['expire', withExtensions('"vnd.proton.expire"', 'if address :is "from" "a@example.com" { expire "day" "30"; }'), 'deletes it after 30 days'],
    ['reject', withExtensions('"reject"', 'if address :is "from" "a@example.com" { reject "No, thank you."; }'), 'turns it away and tells the sender "No, thank you."'],
    ['vacation', withExtensions('"vacation"', 'if address :is "from" "a@example.com" { vacation "Back on Monday."; }'), 'answers the sender in your name with "Back on Monday."'],
  ] as Array<[Unlockable, string, string]>)('refuses %s by default, says where to allow it, and takes it once allowed', (action, source, effect) => {
    const refused = reviewSieve(source)
    expect(refused.problems.join('\n')).toContain('Permissions page of proton-mcp and in the popup of the browser extension')
    expect(refused.unlocked).toEqual([])
    const allowed = reviewSieve(source, allow(action))
    expect(allowed.problems).toEqual([])
    expect(allowed.effects).toContain(effect)
    expect(allowed.unlocked.length).toBe(1)
    expect(allowed.refused).toEqual([])
    // What it costs is named once more with it, for the window.
    expect(allowed.warnings.length).toBeGreaterThan(0)
  })

  it('allows one action without the others', () => {
    const both = script('if true { fileinto "Trash"; discard; }')
    const only = reviewSieve(both, allow('trash'))
    expect(only.problems.join('\n')).toContain('discard is refused')
    expect(only.refused).toEqual(['discard'])
    expect(only.unlocked).toEqual(['filing into Trash'])
  })

  it('names Trash and Spam as what they may be, whatever the spelling', () => {
    expect(reviewSieve(script('if true { fileinto "Archive/TRASH"; }'), allow('trash')).effects).toEqual([
      'moves it to Trash, written "Archive/TRASH"',
    ])
    expect(reviewSieve(script('if true { fileinto "Spam"; }'), allow('trash')).effects).toEqual(['moves it to Spam'])
  })

  it('keeps refusing what could make the script read differently from what it does, whatever is allowed', () => {
    const everything = new Set(UNLOCKABLE)
    for (const source of [
      script('if true { fileinto "3"; }'),
      script('if true { fileinto "${folder}"; }'),
      script('if header :regex "subject" "x" { discard; }'),
      script('/* note */ if true { discard; }'),
      script('if true { discard; } \rif true { stop; }'),
      script('if true { redirect "someone@example.org"; }'),
    ]) {
      expect(reviewSieve(source, everything).problems.length).toBeGreaterThan(0)
    }
    expect(reviewSieve('if true { discard; }', everything).problems.join('\n')).toContain('spam guard')
  })

  it('reads expire as Proton documents it, and says where Proton cuts it', () => {
    const expire = (args: string) => reviewSieve(withExtensions('"vnd.proton.expire"', `if true { expire ${args}; }`), allow('expire'))
    expect(expire('"minute" "1"').effects).toEqual(['deletes it after 1 minute'])
    expect(expire('"day" "900"').effects).toEqual(['deletes it after 900 days, which Proton cuts to 730 days'])
    expect(expire('"week" "1"').problems.join('\n')).toContain('"day", "minute" or "second"')
    expect(expire('"day" "ten"').problems.join('\n')).toContain('whole digits')
    expect(expire('"day"').problems.join('\n')).toContain('a unit and a number')
    expect(reviewSieve(withExtensions('"vnd.proton.expire"', 'if true { unexpire; }'), allow('expire')).effects).toEqual([
      'takes away its expiry',
    ])
    // Reading the expiry is part of the same extension.
    expect(reviewSieve(withExtensions('"vnd.proton.expire", "fileinto"', 'if hasexpiration { fileinto "A"; }'), allow('expire')).problems).toEqual([])
    expect(reviewSieve(withExtensions('"vnd.proton.expire", "fileinto"', 'if hasexpiration { fileinto "A"; }')).problems.join('\n')).toContain('the test hasexpiration is refused')
  })

  it('takes only text written out in what goes to a sender, and an address in it only in plain ASCII', () => {
    const cp = (code: number) => String.fromCodePoint(code)
    const reject = (reason: string) => reviewSieve(withExtensions('"reject"', `if true { reject "${reason}"; }`), allow('reject'))
    // Umlauts in the text are fine; only an address in it has to be plain ASCII.
    expect(reject(`Bitte schreib an buero@example.com, ich bin bis Montag weg. Gr${cp(0xfc)}${cp(0xdf)}e`).problems).toEqual([])
    expect(reject('${1}').problems.join('\n')).toContain('has to be written out')
    expect(reject(`Write to boss@ex${cp(0x430)}mple.com`).problems.join('\n')).toContain('plain ASCII')
  })

  it('reads the tags of vacation, and refuses the ones Proton does not document', () => {
    const vacation = (args: string) => reviewSieve(withExtensions('"vacation"', `if true { vacation ${args}; }`), allow('vacation'))
    expect(vacation(':days 7 :subject "Away" "Back on Monday."').effects).toEqual([
      'answers the sender in your name with "Back on Monday.", under the subject "Away", at most once in 7 days for each sender',
    ])
    expect(vacation(':handle "h" "Back soon."').problems).toEqual([])
    expect(vacation(':mime "Content-Type: text/html"').problems.join('\n')).toContain(':mime is not a tag vacation may use')
    expect(vacation(':from "x@example.com" "Hi"').problems.join('\n')).toContain(':from is not a tag vacation may use')
    expect(vacation(':days "7" "Hi"').problems.join('\n')).toContain(':days takes a whole number')
    expect(vacation('"a" "b"').problems.join('\n')).toContain('then one text')
    expect(vacation(':subject "${1}" "Hi"').problems.join('\n')).toContain('has to be written out')
    expect(vacation('"Back on Monday."').warnings.join('\n')).toContain('only on paid plans')
  })

  it('counts nothing after stop as something the filter does', () => {
    const review = reviewSieve(script('if true { stop; }\nif true { fileinto "A"; }'), allow('stop'))
    expect(review.effects).toEqual(['keeps every later filter from running on it'])
  })

  it('reads a list of allowed actions only as known names, each once', () => {
    expect(parseUnlocks(['trash', 'discard'])).toEqual(['trash', 'discard'])
    expect(parseUnlocks([])).toEqual([])
    expect(parseUnlocks(['trash', 'trash'])).toBeUndefined()
    expect(parseUnlocks(['redirect'])).toBeUndefined()
    expect(parseUnlocks('trash')).toBeUndefined()
  })
})
