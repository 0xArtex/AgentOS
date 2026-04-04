#!/usr/bin/env node
// Convert mascot image into braille Unicode art
// Each braille char encodes a 2x4 dot pattern = much higher resolution

import sharp from 'sharp'

const WIDTH = 22  // chars wide (each char = 2 pixels wide)
const PX_W = WIDTH * 2
const PX_H = Math.round(PX_W * 1.0)  // square-ish source
const CROP = { left: 80, top: 80, width: 1120, height: 1120 }
const THRESHOLD = 160  // brightness threshold (higher = more detail)

// Braille dot positions: dots are numbered
// 1 4
// 2 5
// 3 6
// 7 8
const BRAILLE_OFFSET = 0x2800
const DOT_MAP = [
  [0x01, 0x08],  // row 0: dot1, dot4
  [0x02, 0x10],  // row 1: dot2, dot5
  [0x04, 0x20],  // row 2: dot3, dot6
  [0x40, 0x80],  // row 3: dot7, dot8
]

async function main() {
  const pixH = Math.ceil(PX_H / 4) * 4  // round up to multiple of 4
  const { data, info } = await sharp('./mascot-source.jpg')
    .extract(CROP)
    .resize(PX_W, pixH, { fit: 'cover' })
    .greyscale()
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const w = info.width
  const h = info.height

  function px(x, y) {
    if (x >= w || y >= h) return 255
    return data[y * w + x]
  }

  const lines = []
  for (let cy = 0; cy < h; cy += 4) {
    let line = ''
    for (let cx = 0; cx < w; cx += 2) {
      let code = BRAILLE_OFFSET
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const brightness = px(cx + dx, cy + dy)
          // Invert: dark = dot, light = empty
          if (brightness < THRESHOLD) {
            code |= DOT_MAP[dy][dx]
          }
        }
      }
      line += String.fromCharCode(code)
    }
    lines.push(line)
  }

  // Trim blank rows
  const EMPTY = String.fromCharCode(BRAILLE_OFFSET)
  let start = 0, end = lines.length - 1
  while (start < lines.length && lines[start].replace(new RegExp(EMPTY, 'g'), '').length === 0) start++
  while (end >= 0 && lines[end].replace(new RegExp(EMPTY, 'g'), '').length === 0) end--
  const trimmed = lines.slice(start, end + 1)

  // Output as TS
  console.log('// Auto-generated braille art from mascot-source.jpg')
  console.log('export const MASCOT_STIPPLE: string[] = [')
  for (const l of trimmed) console.log(`  ${JSON.stringify(l)},`)
  console.log('];')

  // Preview
  for (const l of trimmed) process.stderr.write(l + '\n')
}

main()
