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

  start(label: string) {
    this.frame = 0
    this.interval = setInterval(() => {
      const f = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length]
      process.stdout.write(`\r  ${theme.info}${f}${theme.reset} ${theme.muted}${label}${theme.reset}`)
      this.frame++
    }, 80)
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
