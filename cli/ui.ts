/**
 * Palmyr CLI UI — terminal rendering utilities
 * Inspired by Claude Code's aesthetic
 */

// ─── Agent mode ───
//
// When the CLI is being driven by an agent (stdout isn't a TTY, or the user
// passed --json), every decorative helper in this file becomes a no-op so the
// caller gets clean machine-parseable output instead of garbled spinner frames
// and ANSI escape sequences interleaved with JSON.
//
// `cli.ts:main()` calls `setAgentMode(true)` early when the conditions match;
// helpers and the Spinner self-check via `isAgentMode()` so we never write to
// stdout. Spinners can still be used freely in command code — they just become
// invisible in agent mode.
let agentMode = !process.stdout.isTTY
export function setAgentMode(v: boolean): void { agentMode = v }
export function isAgentMode(): boolean { return agentMode }

// ─── Theme ───
export const theme = {
  // Brand
  accent: '\x1b[38;5;208m',     // orange
  
  // Semantic
  success: '\x1b[38;5;78m',     // soft green
  error: '\x1b[38;5;203m',      // soft red
  warn: '\x1b[38;5;220m',       // yellow
  info: '\x1b[38;5;111m',       // soft blue
  
  // Text
  text: '\x1b[37m',             // white
  muted: '\x1b[38;5;243m',      // gray
  dim: '\x1b[38;5;238m',        // darker gray
  
  // Formatting
  bold: '\x1b[1m',
  reset: '\x1b[0m',
  underline: '\x1b[4m',
}

// ─── Icons ───
export const icon = {
  success: `${theme.success}✔${theme.reset}`,
  error: `${theme.error}✘${theme.reset}`,
  warn: `${theme.warn}⚠${theme.reset}`,
  info: `${theme.info}●${theme.reset}`,
  arrow: `${theme.muted}→${theme.reset}`,
  dot: `${theme.dim}·${theme.reset}`,
  bullet: `${theme.muted}▸${theme.reset}`,
}

// ─── Spinner ───
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

// Hide / show the terminal cursor. The blinking cursor sitting at the end of
// the spinner line otherwise looks like flicker.
const HIDE_CURSOR = '\x1b[?25l'
const SHOW_CURSOR = '\x1b[?25h'

// One-time exit hook so a Ctrl+C / unexpected exit while a spinner is active
// doesn't leave the user's terminal with a hidden cursor.
let cursorRestoreInstalled = false
function installCursorRestoreOnce() {
  if (cursorRestoreInstalled) return
  cursorRestoreInstalled = true
  const restore = () => process.stdout.write(SHOW_CURSOR)
  process.on('exit', restore)
  process.on('SIGINT', () => { restore(); process.exit(130) })
  process.on('SIGTERM', () => { restore(); process.exit(143) })
}

export class Spinner {
  // Module-level stack of currently-running spinners. When a new spinner
  // starts, it pauses whatever was on top; when it stops/cancels, the parent
  // resumes. Prevents two spinners from stomping on each other's stdout
  // (the classic "outer + inner spinner flashing back and forth" bug).
  private static stack: Spinner[] = []

  private interval: ReturnType<typeof setInterval> | null = null
  private frame = 0
  private label = ''
  private active = false
  private stopped = false

  private render() {
    if (!this.active) return
    const f = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length]
    // \r returns to col 0; \x1b[2K erases the entire line so a shorter label
    // doesn't leave the previous label's tail visible.
    process.stdout.write(`\r\x1b[2K  ${theme.info}${f}${theme.reset} ${theme.text}${this.label}${theme.reset}`)
  }

  private terminateRender() {
    if (this.interval) clearInterval(this.interval)
    this.interval = null
    this.active = false
    process.stdout.write(`\r\x1b[2K`)
  }

  private pause() {
    // Suspend animation but stay registered as the (paused) parent that will
    // resume once the child stops. Don't show the cursor — the child is
    // about to take over.
    if (this.interval) clearInterval(this.interval)
    this.interval = null
    this.active = false
    process.stdout.write(`\r\x1b[2K`)
  }

  private resume() {
    if (this.stopped) return
    this.active = true
    process.stdout.write(HIDE_CURSOR)
    this.render()
    this.interval = setInterval(() => {
      this.frame++
      this.render()
    }, 80)
  }

  private popAndResume() {
    const idx = Spinner.stack.indexOf(this)
    if (idx >= 0) Spinner.stack.splice(idx, 1)
    const next = Spinner.stack[Spinner.stack.length - 1]
    if (next) {
      next.resume()
    } else {
      // No parent to resume — really done; restore the cursor.
      process.stdout.write(SHOW_CURSOR)
    }
  }

  start(label: string) {
    // Reuse path: already-running spinner just gets a new label.
    if (this.active) { this.update(label); return }
    if (agentMode) { this.label = label; this.stopped = false; this.active = true; return }
    installCursorRestoreOnce()
    this.label = label
    this.frame = 0
    this.active = true
    this.stopped = false

    const parent = Spinner.stack[Spinner.stack.length - 1]
    if (parent) parent.pause()
    Spinner.stack.push(this)

    // Only add a leading newline if we're the topmost spinner. Nested
    // spinners render in place on the line the parent just cleared.
    if (Spinner.stack.length === 1) process.stdout.write('\n')
    process.stdout.write(HIDE_CURSOR)
    this.render()
    this.interval = setInterval(() => {
      this.frame++
      this.render()
    }, 80)
  }

  update(label: string) {
    this.label = label
    if (agentMode) return
    // Repaint immediately so label changes don't feel laggy waiting for the
    // next tick.
    this.render()
  }

  stop(label: string, success = true) {
    if (this.stopped) return
    this.stopped = true
    if (agentMode) { this.active = false; return }
    this.terminateRender()
    if (success) {
      console.log(`  ${icon.success} ${label}`)
    } else {
      console.log(`  ${icon.error} ${label}`)
    }
    this.popAndResume()
  }

  // Stop the animation without printing anything. Use when the caller will
  // surface the error via a different channel (e.g. throwing, so the wrapper
  // can format the user-facing message itself).
  cancel() {
    if (this.stopped) return
    this.stopped = true
    if (agentMode) { this.active = false; return }
    this.terminateRender()
    this.popAndResume()
  }
}

// ─── Layout ───
//
// Every helper below is decorative: ANSI-colored boxes, dividers, status icons.
// In agent mode we no-op them so JSON output isn't poisoned with leading blank
// lines, dim-grey separators, or check-mark prefixes.
export function header(title: string) {
  if (agentMode) return
  console.log()
  console.log(`  ${theme.accent}${theme.bold}${title}${theme.reset}`)
  console.log(`  ${theme.dim}${'─'.repeat(Math.min(title.length + 4, 50))}${theme.reset}`)
  console.log()
}

export function row(label: string, value: string, valueColor = theme.text) {
  if (agentMode) return
  const padded = label.padEnd(16)
  console.log(`  ${theme.muted}${padded}${theme.reset} ${valueColor}${value}${theme.reset}`)
}

export function ok(msg: string) {
  if (agentMode) return
  console.log(`  ${icon.success} ${msg}`)
}

export function fail(msg: string) {
  if (agentMode) return
  console.log(`  ${icon.error} ${msg}`)
}

export function warn(msg: string) {
  if (agentMode) return
  console.log(`  ${icon.warn} ${theme.warn}${msg}${theme.reset}`)
}

export function info(msg: string) {
  if (agentMode) return
  console.log(`  ${icon.info} ${msg}`)
}

export function subtle(msg: string) {
  if (agentMode) return
  console.log(`  ${theme.muted}${msg}${theme.reset}`)
}

export function divider() {
  if (agentMode) return
  console.log(`  ${theme.dim}${'─'.repeat(50)}${theme.reset}`)
}

export function blank() {
  if (agentMode) return
  console.log()
}

// ─── Table ───
export function table(headers: string[], rows: string[][]) {
  if (agentMode) return
  // Calculate column widths
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => (r[i] || '').length))
  )

  // Header
  const headerRow = headers.map((h, i) => h.padEnd(widths[i])).join('  ')
  console.log(`  ${theme.muted}${headerRow}${theme.reset}`)
  console.log(`  ${theme.dim}${widths.map(w => '─'.repeat(w)).join('──')}${theme.reset}`)

  // Rows
  for (const r of rows) {
    const line = r.map((cell, i) => {
      const padded = (cell || '').padEnd(widths[i])
      return i === 0 ? `${theme.text}${padded}${theme.reset}` : `${theme.muted}${padded}${theme.reset}`
    }).join('  ')
    console.log(`  ${line}`)
  }
}

// ─── Box ───
export function box(title: string, content: string, color = theme.muted) {
  if (agentMode) return
  const lines = content.split('\n')
  const maxLen = Math.max(title.length + 2, ...lines.map(l => l.length))
  const width = Math.min(maxLen + 4, 60)

  console.log(`  ${color}╭${'─'.repeat(width)}╮${theme.reset}`)
  console.log(`  ${color}│${theme.reset} ${theme.bold}${title}${theme.reset}${' '.repeat(width - title.length - 1)}${color}│${theme.reset}`)
  console.log(`  ${color}├${'─'.repeat(width)}┤${theme.reset}`)
  for (const line of lines) {
    console.log(`  ${color}│${theme.reset} ${line}${' '.repeat(Math.max(0, width - line.length - 1))}${color}│${theme.reset}`)
  }
  console.log(`  ${color}╰${'─'.repeat(width)}╯${theme.reset}`)
}

// ─── Progress ───
export function progress(current: number, total: number, label?: string) {
  if (agentMode) return
  const width = 30
  const filled = Math.round((current / total) * width)
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled)
  const pct = Math.round((current / total) * 100)
  // \x1b[2K clears the line so a shorter label doesn't leave the previous
  // label's tail visible — same fix as the spinner redraw.
  process.stdout.write(`\r\x1b[2K  ${theme.info}${bar}${theme.reset} ${theme.muted}${pct}%${label ? ' ' + label : ''}${theme.reset}`)
  if (current >= total) console.log()
}

// ─── Init Report (Claude Code style) ───
export function initReport(title: string, items: Array<{name: string, status: 'created' | 'updated' | 'skipped' | 'exists'}>) {
  if (agentMode) return
  console.log()
  console.log(`  ${theme.accent}${theme.bold}${title}${theme.reset}`)
  console.log()
  for (const item of items) {
    const statusColor = item.status === 'created' ? theme.success
      : item.status === 'updated' ? theme.warn
      : theme.muted
    const statusLabel = item.status === 'created' ? 'created'
      : item.status === 'updated' ? 'updated'
      : item.status === 'exists' ? 'already exists'
      : 'skipped'
    console.log(`  ${statusColor}${item.status === 'created' ? '✔' : item.status === 'updated' ? '↻' : '·'}${theme.reset} ${theme.text}${item.name.padEnd(24)}${theme.reset} ${theme.muted}${statusLabel}${theme.reset}`)
  }
  console.log()
}

// ─── Greeting / Banner ───
export function banner() {
  if (agentMode) return
  console.log()
  console.log(`  ${theme.accent}${theme.bold}▲ Palmyr${theme.reset} ${theme.muted}v${process.env.PALMYR_VERSION || '0.5.0'}${theme.reset}`)
  console.log(`  ${theme.dim}Everything your AI agent needs${theme.reset}`)
  console.log()
}

// ─── Key-Value Pair (compact) ───
export function kv(label: string, value: string) {
  if (agentMode) return
  console.log(`  ${theme.muted}${label}${theme.reset} ${theme.text}${value}${theme.reset}`)
}

// ─── Section ───
export function section(title: string) {
  if (agentMode) return
  console.log()
  console.log(`  ${theme.bold}${title}${theme.reset}`)
}

// ─── List Item ───
export function listItem(text: string, indent = 0) {
  if (agentMode) return
  const pad = '  '.repeat(indent + 1)
  console.log(`${pad}${icon.bullet} ${theme.muted}${text}${theme.reset}`)
}

// ─── Compact Status Line ───
export function statusLine(label: string, value: string, good: boolean) {
  if (agentMode) return
  const dot = good ? `${theme.success}●${theme.reset}` : `${theme.error}●${theme.reset}`
  console.log(`  ${dot} ${theme.muted}${label.padEnd(16)}${theme.reset} ${theme.text}${value}${theme.reset}`)
}

// ─── TUI Panels ───

function pad(str: string, width: number): string {
  const stripped = str.replace(/\x1b\[[0-9;]*m/g, '')
  const len = stripped.length
  return str + ' '.repeat(Math.max(0, width - len))
}

function visibleLength(str: string): number {
  return str.replace(/\x1b\[[0-9;]*m/g, '').length
}

export function panel(title: string, lines: string[], width: number, borderColor = theme.dim): string[] {
  const out: string[] = []
  const inner = width - 4
  const titleStr = title ? ` ${title} ` : ''
  const topPad = width - 2 - visibleLength(titleStr)
  out.push(`${borderColor}╭─${theme.muted}${titleStr}${borderColor}${'─'.repeat(Math.max(0, topPad))}╮${theme.reset}`)
  for (const line of lines) {
    out.push(`${borderColor}│${theme.reset} ${pad(line, inner)} ${borderColor}│${theme.reset}`)
  }
  out.push(`${borderColor}╰${'─'.repeat(width - 2)}╯${theme.reset}`)
  return out
}

export function sideBySide(left: string[], right: string[], gap = 1): string[] {
  const maxLen = Math.max(left.length, right.length)
  const out: string[] = []
  // Find width of left panel
  const leftWidth = Math.max(...left.map(l => visibleLength(l)))
  for (let i = 0; i < maxLen; i++) {
    const l = i < left.length ? left[i] : ''
    const r = i < right.length ? right[i] : ''
    out.push(pad(l, leftWidth) + ' '.repeat(gap) + r)
  }
  return out
}

export function welcomeScreen(config: { version: string, name?: string, model?: string, chain?: string, wallets?: any, apiOk?: boolean }) {
  if (agentMode) return
  const termWidth = process.stdout.columns || 100
  const leftWidth = Math.min(Math.floor(termWidth * 0.45), 48)
  const rightWidth = Math.min(Math.floor(termWidth * 0.45), 48)

  // ASCII art logo
  const logo = [
    `${theme.accent}    ╔═══╗${theme.reset}`,
    `${theme.accent}    ║ ▲ ║${theme.reset}`,
    `${theme.accent}    ╚═══╝${theme.reset}`,
  ]

  // Left panel content
  const leftLines = [
    '',
    `${theme.bold}    Welcome${config.name ? ' back ' + config.name : ''}!${theme.reset}`,
    '',
    ...logo,
    '',
    `${theme.muted}  ${config.chain || 'solana'} · ${config.apiOk ? `${theme.success}connected${theme.reset}` : `${theme.error}offline${theme.reset}`}${theme.reset}`,
    `${theme.dim}  ~/.palmyr/${theme.reset}`,
    '',
  ]

  // Right panel content
  const hasWallets = config.wallets && (config.wallets.solana || config.wallets.base)
  const rightLines = [
    `${theme.accent}Quick start${theme.reset}`,
    `${theme.muted}palmyr phone search --country US${theme.reset}`,
    `${theme.muted}palmyr compute plans${theme.reset}`,
    `${theme.muted}palmyr domain check --name my.dev${theme.reset}`,
    '',
    `${theme.accent}Status${theme.reset}`,
    `${hasWallets ? `${theme.success}●${theme.reset}` : `${theme.error}●${theme.reset}`} ${theme.muted}Wallets: ${hasWallets ? Object.keys(config.wallets).join(', ') : 'not configured'}${theme.reset}`,
    `${config.apiOk ? `${theme.success}●${theme.reset}` : `${theme.error}●${theme.reset}`} ${theme.muted}API: ${config.apiOk ? 'connected' : 'unreachable'}${theme.reset}`,
    '',
  ]

  const leftPanel = panel(`Palmyr v${config.version}`, leftLines, leftWidth, theme.dim)
  const rightPanel = panel('', rightLines, rightWidth, theme.dim)
  const combined = sideBySide(leftPanel, rightPanel, 1)

  for (const line of combined) {
    console.log(`  ${line}`)
  }
}

// ─── Status Bar ───
export function statusBar(left: string, right: string) {
  if (agentMode) return
  const termWidth = process.stdout.columns || 100
  const usable = termWidth - 4
  const leftLen = visibleLength(left)
  const rightLen = visibleLength(right)
  const gap = Math.max(1, usable - leftLen - rightLen)
  console.log(`  ${left}${' '.repeat(gap)}${right}`)
}
