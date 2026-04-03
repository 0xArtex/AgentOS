/**
 * AgentOS CLI UI — terminal rendering utilities
 * Inspired by Claude Code's aesthetic
 */

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

export class Spinner {
  private interval: ReturnType<typeof setInterval> | null = null
  private frame = 0
  private label = ''

  start(label: string) {
    this.label = label
    this.frame = 0
    process.stdout.write('\n')
    this.interval = setInterval(() => {
      const f = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length]
      process.stdout.write(`\r  ${theme.info}${f}${theme.reset} ${theme.text}${this.label}${theme.reset}`)
      this.frame++
    }, 80)
  }

  update(label: string) {
    this.label = label
  }

  stop(label: string, success = true) {
    if (this.interval) clearInterval(this.interval)
    this.interval = null
    process.stdout.write(`\r\x1b[2K`)
    if (success) {
      console.log(`  ${icon.success} ${label}`)
    } else {
      console.log(`  ${icon.error} ${label}`)
    }
  }
}

// ─── Layout ───
export function header(title: string) {
  console.log()
  console.log(`  ${theme.accent}${theme.bold}${title}${theme.reset}`)
  console.log(`  ${theme.dim}${'─'.repeat(Math.min(title.length + 4, 50))}${theme.reset}`)
  console.log()
}

export function row(label: string, value: string, valueColor = theme.text) {
  const padded = label.padEnd(16)
  console.log(`  ${theme.muted}${padded}${theme.reset} ${valueColor}${value}${theme.reset}`)
}

export function ok(msg: string) {
  console.log(`  ${icon.success} ${msg}`)
}

export function fail(msg: string) {
  console.log(`  ${icon.error} ${msg}`)
}

export function warn(msg: string) {
  console.log(`  ${icon.warn} ${theme.warn}${msg}${theme.reset}`)
}

export function info(msg: string) {
  console.log(`  ${icon.info} ${msg}`)
}

export function subtle(msg: string) {
  console.log(`  ${theme.muted}${msg}${theme.reset}`)
}

export function divider() {
  console.log(`  ${theme.dim}${'─'.repeat(50)}${theme.reset}`)
}

export function blank() {
  console.log()
}

// ─── Table ───
export function table(headers: string[], rows: string[][]) {
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
  const width = 30
  const filled = Math.round((current / total) * width)
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled)
  const pct = Math.round((current / total) * 100)
  process.stdout.write(`\r  ${theme.info}${bar}${theme.reset} ${theme.muted}${pct}%${label ? ' ' + label : ''}${theme.reset}`)
  if (current >= total) console.log()
}

// ─── Init Report (Claude Code style) ───
export function initReport(title: string, items: Array<{name: string, status: 'created' | 'updated' | 'skipped' | 'exists'}>) {
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
  console.log()
  console.log(`  ${theme.accent}${theme.bold}▲ AgentOS${theme.reset} ${theme.muted}v${process.env.AGENTOS_VERSION || '0.2.0'}${theme.reset}`)
  console.log(`  ${theme.dim}Everything your AI agent needs${theme.reset}`)
  console.log()
}

// ─── Key-Value Pair (compact) ───
export function kv(label: string, value: string) {
  console.log(`  ${theme.muted}${label}${theme.reset} ${theme.text}${value}${theme.reset}`)
}

// ─── Section ───
export function section(title: string) {
  console.log()
  console.log(`  ${theme.bold}${title}${theme.reset}`)
}

// ─── List Item ───
export function listItem(text: string, indent = 0) {
  const pad = '  '.repeat(indent + 1)
  console.log(`${pad}${icon.bullet} ${theme.muted}${text}${theme.reset}`)
}

// ─── Compact Status Line ───
export function statusLine(label: string, value: string, good: boolean) {
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
    `${theme.dim}  ~/.agentos/${theme.reset}`,
    '',
  ]

  // Right panel content
  const hasWallets = config.wallets && (config.wallets.solana || config.wallets.base)
  const rightLines = [
    `${theme.accent}Quick start${theme.reset}`,
    `${theme.muted}agentos phone search --country US${theme.reset}`,
    `${theme.muted}agentos compute plans${theme.reset}`,
    `${theme.muted}agentos domain check --name my.dev${theme.reset}`,
    '',
    `${theme.accent}Status${theme.reset}`,
    `${hasWallets ? `${theme.success}●${theme.reset}` : `${theme.error}●${theme.reset}`} ${theme.muted}Wallets: ${hasWallets ? Object.keys(config.wallets).join(', ') : 'not configured'}${theme.reset}`,
    `${config.apiOk ? `${theme.success}●${theme.reset}` : `${theme.error}●${theme.reset}`} ${theme.muted}API: ${config.apiOk ? 'connected' : 'unreachable'}${theme.reset}`,
    '',
  ]

  const leftPanel = panel(`AgentOS v${config.version}`, leftLines, leftWidth, theme.dim)
  const rightPanel = panel('', rightLines, rightWidth, theme.dim)
  const combined = sideBySide(leftPanel, rightPanel, 1)

  for (const line of combined) {
    console.log(`  ${line}`)
  }
}

// ─── Status Bar ───
export function statusBar(left: string, right: string) {
  const termWidth = process.stdout.columns || 100
  const usable = termWidth - 4
  const leftLen = visibleLength(left)
  const rightLen = visibleLength(right)
  const gap = Math.max(1, usable - leftLen - rightLen)
  console.log(`  ${left}${' '.repeat(gap)}${right}`)
}
