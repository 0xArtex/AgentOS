/**
 * Interactive passphrase prompt — no-echo via readline + muted stdout.
 *
 * Uses Node's stock `readline` but wires `output` to a Writable whose `write`
 * suppresses every keystroke after the initial prompt is rendered. Avoids the
 * raw-mode TTY dance and works on every platform Node supports.
 *
 * Non-TTY callers (CI, daemon, piped stdin) throw clearly so we never silently
 * hang waiting for input.
 */
import { createInterface } from 'readline'
import { Writable } from 'stream'

export class NoTTYError extends Error {
  constructor() {
    super('Interactive passphrase prompt requires a TTY. Set PALMYR_TRADING_KEYSTORE_PASSPHRASE or run `palmyr wallet trading-keystore unlock` from a terminal first.')
    this.name = 'NoTTYError'
  }
}

function makeMutableStdout() {
  const writable = new Writable({
    write(chunk, _encoding, cb) {
      if (!(this as unknown as { muted?: boolean }).muted) {
        process.stdout.write(chunk)
      }
      cb()
    },
  })
  return writable as Writable & { muted: boolean }
}

async function ask(label: string): Promise<string> {
  if (!process.stdin.isTTY) throw new NoTTYError()
  const out = makeMutableStdout()
  out.muted = false
  const rl = createInterface({
    input: process.stdin,
    output: out,
    terminal: true,
  })
  return new Promise<string>((resolve) => {
    rl.question(label, (answer) => {
      rl.close()
      process.stdout.write('\n')
      resolve(answer)
    })
    out.muted = true
  })
}

/** Prompt for a single passphrase. Throws NoTTYError off a TTY. */
export async function promptPassphrase(label = 'Trading keystore passphrase: '): Promise<string> {
  return ask(label)
}

/**
 * Prompt twice with confirmation. Used by `init` and any other path that
 * creates / rotates a passphrase. Re-prompts on mismatch up to 3 times.
 */
export async function promptNewPassphrase(): Promise<string> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const a = await ask('New trading keystore passphrase: ')
    if (a.length < 8) {
      process.stdout.write('  passphrase must be at least 8 characters; try again\n')
      continue
    }
    const b = await ask('Confirm passphrase: ')
    if (a !== b) {
      process.stdout.write('  passphrases did not match; try again\n')
      continue
    }
    return a
  }
  throw new Error('Failed to set a new passphrase after 3 attempts.')
}
