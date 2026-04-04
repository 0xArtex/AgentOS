#!/usr/bin/env node
// Convert mascot image into stipple/dot ASCII art
// Uses density characters: ' .·:;+*#@' from light to dark

import sharp from 'sharp'

const WIDTH = 16
const HEIGHT = 16
const CROP = { left: 160, top: 160, width: 960, height: 960 }
const CHARS = ' .·:;+*#@'  // light → dark

async function main() {
  const { data, info } = await sharp('./mascot-source.jpg')
    .extract(CROP)
    .resize(WIDTH, HEIGHT, { fit: 'cover' })
    .greyscale()
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const lines = []
  for (let y = 0; y < info.height; y++) {
    let line = ''
    for (let x = 0; x < info.width; x++) {
      const brightness = data[y * info.width + x]
      // Invert: dark pixels = dense chars, light pixels = sparse
      const inverted = 255 - brightness
      const idx = Math.floor(inverted / 256 * CHARS.length)
      line += CHARS[Math.min(idx, CHARS.length - 1)]
    }
    lines.push(line)
  }

  // Trim blank rows
  let start = 0, end = lines.length - 1
  while (start < lines.length && lines[start].trim() === '') start++
  while (end >= 0 && lines[end].trim() === '') end--
  const trimmed = lines.slice(start, end + 1)

  // Output as TS
  console.log('// Auto-generated stipple art from mascot-source.jpg')
  console.log('export const MASCOT_STIPPLE: string[] = [')
  for (const l of trimmed) console.log(`  ${JSON.stringify(l)},`)
  console.log('];')

  // Preview
  console.error('\nPreview:')
  for (const l of trimmed) console.error(l)
}

main()
