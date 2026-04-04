#!/usr/bin/env node
// Convert mascot-source.jpg into half-block ANSI terminal art
// Each terminal row = 2 pixel rows using ▀ (upper half block)
// fg = top pixel color, bg = bottom pixel color

import sharp from 'sharp'

const TARGET_WIDTH = 30  // terminal columns
const SRC = './mascot-source.jpg'
const CROP = { left: 160, top: 160, width: 960, height: 960 }  // crop to just the face

// Quantize to nearest ANSI 256 color
function rgbTo256(r, g, b) {
  // Check if it's close to black (background)
  if (r < 30 && g < 30 && b < 30) return 0
  // Check grayscale ramp
  if (Math.abs(r - g) < 10 && Math.abs(g - b) < 10) {
    if (r < 8) return 16
    if (r > 248) return 231
    return Math.round((r - 8) / 247 * 24) + 232
  }
  // 6x6x6 color cube
  const ri = Math.round(r / 255 * 5)
  const gi = Math.round(g / 255 * 5)
  const bi = Math.round(b / 255 * 5)
  return 16 + 36 * ri + 6 * gi + bi
}

function ansi256Fg(c) { return `\x1b[38;5;${c}m` }
function ansi256Bg(c) { return `\x1b[48;5;${c}m` }
const RESET = '\x1b[0m'

async function main() {
  const targetH = TARGET_WIDTH  // square-ish
  const pixelH = targetH * 2   // 2 pixel rows per terminal row

  const { data, info } = await sharp(SRC)
    .extract(CROP)
    .resize(TARGET_WIDTH, pixelH, { fit: 'cover' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const w = info.width
  const h = info.height

  function getPixel(x, y) {
    const idx = (y * w + x) * 3
    return [data[idx], data[idx + 1], data[idx + 2]]
  }

  const lines = []
  for (let row = 0; row < h; row += 2) {
    let line = ''
    for (let col = 0; col < w; col++) {
      const [tr, tg, tb] = getPixel(col, row)
      const [br, bg, bb] = row + 1 < h ? getPixel(col, row + 1) : [0, 0, 0]
      const topColor = rgbTo256(tr, tg, tb)
      const botColor = rgbTo256(br, bg, bb)

      if (topColor === botColor) {
        if (topColor === 0) line += `${ansi256Bg(0)} ${RESET}`
        else line += `${ansi256Fg(topColor)}${ansi256Bg(topColor)}▀${RESET}`
      } else {
        line += `${ansi256Fg(topColor)}${ansi256Bg(botColor)}▀${RESET}`
      }
    }
    lines.push(line)
  }

  // Output as a JS array for embedding
  console.log('// Auto-generated mascot art')
  console.log('const MASCOT_LINES = [')
  for (const line of lines) {
    console.log(`  ${JSON.stringify(line)},`)
  }
  console.log('];')

  // Also preview in terminal
  console.log('\n// Preview:')
  for (const line of lines) {
    process.stdout.write(line + '\n')
  }
}

main()
