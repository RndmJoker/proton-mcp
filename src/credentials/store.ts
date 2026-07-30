/**
 * Where the Bridge credentials live.
 *
 * The user chooses, because the trade-off is theirs to make. All four options
 * are fully supported: none of them is a second-class fallback, and none is
 * presented as the obvious answer. What differs is which drawback you accept.
 *
 * Each option therefore states both sides plus who it is actually for, and one
 * factual property that makes them comparable without prose: what ends up on
 * disk.
 *
 * One property shapes the whole module: reading from a system keyring can
 * **block**. A locked KWallet or GNOME Keyring opens a dialog, and the calls in
 * @napi-rs/keyring are synchronous, so there is no way to abandon one from the
 * same thread. Anything that touches a keyring therefore has to assume it may
 * never return, which is why the availability probe runs in a child process.
 */

export interface Credentials {
  user: string
  pass: string
}

/** The ways credentials can be kept. */
export type StoreKind = 'keyring' | 'session' | 'encrypted-file' | 'plain-file'

export interface CredentialStore {
  readonly kind: StoreKind
  /** Returns the credentials, or undefined when none are stored. */
  load(): Promise<Credentials | undefined>
  save(credentials: Credentials): Promise<void>
  /** Removes what is stored. Succeeds even when nothing was there. */
  clear(): Promise<void>
  /**
   * Whether something is stored, without unlocking it.
   *
   * Only the encrypted file implements this, and it is the reason the method
   * exists: it is the one store that can hold credentials the server cannot
   * read on its own. The interface has to tell "nothing stored" from "stored
   * but locked", because the first calls for the full sign-in form and the
   * second only for a master password.
   */
  exists?(): Promise<boolean>
}

/**
 * What lands on disk. The one property that makes the options comparable
 * without reading three paragraphs.
 */
export type DiskExposure =
  /** Nothing at all. */
  | 'none'
  /** Encrypted with a key that is not stored anywhere. */
  | 'encrypted'
  /** Protected by the operating system, readable by your account. */
  | 'os-protected'
  /** Readable by anything that can read your files. */
  | 'plaintext'

/** What the user is told about an option before choosing it. */
export interface StoreDescription {
  kind: StoreKind
  title: string
  /** One sentence on what it does. */
  summary: string
  /** What it is good at. */
  benefit: string
  /** What it costs. Every option has something. */
  cost: string
  /** Who should pick this one. */
  bestFor: string
  exposure: DiskExposure
  /** How often you have to type something to use the server. */
  prompts: 'never' | 'once per server start' | 'occasionally'
}

export const EXPOSURE_LABELS: Record<DiskExposure, string> = {
  none: 'nothing on disk',
  encrypted: 'encrypted on disk',
  'os-protected': 'on disk, protected by the operating system',
  plaintext: 'unencrypted on disk',
}

export const STORE_DESCRIPTIONS: Record<StoreKind, StoreDescription> = {
  keyring: {
    kind: 'keyring',
    title: 'System keyring',
    summary:
      'The password goes where the operating system keeps your other passwords: Credential Manager ' +
      'on Windows, Keychain on macOS, GNOME Keyring or KWallet on Linux.',
    benefit:
      'Nothing to type after the first sign-in, and the password is protected by the same mechanism ' +
      'as the rest of your logins. It is also the only option where the secret is not simply a file ' +
      'you could accidentally copy into a backup or a shared folder.',
    cost:
      'Needs a running keyring service, which a container, a plain SSH session or WSL usually lacks. ' +
      'On macOS the permission is tied to the code hash of the node binary, so after a Node update ' +
      'the system asks for your login password again. Reading it can also block if the keyring is ' +
      'locked.',
    bestFor: 'A desktop machine you use yourself. This is the ordinary case.',
    exposure: 'os-protected',
    prompts: 'occasionally',
  },
  'encrypted-file': {
    kind: 'encrypted-file',
    title: 'Encrypted file',
    summary:
      'The password is encrypted with a master password of your choosing and written into your user ' +
      'directory.',
    benefit:
      'Works everywhere, with no system service and no graphical session, so it is the one option ' +
      'that behaves identically on every platform. Even if someone copies the file, it is useless ' +
      'without your master password.',
    cost:
      'You type the master password every time the server starts. Forget it and the stored password ' +
      'is gone for good, since nothing anywhere can decrypt it. And a master password you can ' +
      'remember is usually weaker than one the operating system would have generated.',
    bestFor:
      'Servers, containers, headless machines, and anyone who would rather type something than ' +
      'depend on a system service.',
    exposure: 'encrypted',
    prompts: 'once per server start',
  },
  session: {
    kind: 'session',
    title: 'This session only',
    summary: 'Nothing is stored. The password is held in memory and forgotten when the server stops.',
    benefit:
      'Nothing to find, on disk or elsewhere. A stolen laptop, a backup or a misplaced file cannot ' +
      'give the password away, because there is nothing to give away.',
    cost:
      'You sign in again whenever the server starts, which for most clients means every new ' +
      'conversation. In practice this is the option people abandon after a few days.',
    bestFor:
      'A shared or untrusted machine, a one-off look at a mailbox, or anyone who genuinely wants ' +
      'nothing left behind.',
    exposure: 'none',
    prompts: 'once per server start',
  },
  'plain-file': {
    kind: 'plain-file',
    title: 'Plain file',
    summary:
      'The password sits unencrypted in a file in your user directory, readable only by your ' +
      'account.',
    benefit:
      'The simplest thing that works. No service, no master password, no prompts ever, and you can ' +
      'read and edit it with any text editor, which makes it the easiest to script and to debug.',
    cost:
      'Anything that can read your files can read the password: a backup tool, a synchronised ' +
      'folder, another program running as you, or anyone who gets hold of the disk. File ' +
      'permissions are the only thing protecting it.',
    bestFor:
      'Automation and scripted setups where no one can type a password, on a machine you control ' +
      'and whose backups you trust.',
    exposure: 'plaintext',
    prompts: 'never',
  },
}

/**
 * The order options are presented in: least exposed first.
 *
 * Not a ranking of quality. It puts the security-relevant difference in front,
 * so that choosing convenience is a conscious step down the list rather than
 * something that happens by accident.
 */
export const PRESENTATION_ORDER: StoreKind[] = ['session', 'keyring', 'encrypted-file', 'plain-file']
