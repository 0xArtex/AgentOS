// Regenerates public/favicon.ico and public/favicon.png from public/favicon.svg.
//
// Run with:
//   npm install --no-save @resvg/resvg-js png-to-ico
//   node scripts/generate-favicons.mjs
//
// Outputs:
//   public/favicon.png  (32x32 PNG — used by older browsers + most embeds)
//   public/favicon.ico  (multi-res 16/32/48 ICO — Windows file explorer, IE, Discord embeds)
//
// Source of truth is public/favicon.svg. Re-run this whenever the SVG changes.

import { readFileSync, writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';
import pngToIco from 'png-to-ico';

const SOURCE_SVG = 'public/favicon.svg';

const svgBuffer = readFileSync(SOURCE_SVG);

function renderPng(width) {
  const resvg = new Resvg(svgBuffer, {
    fitTo: { mode: 'width', value: width },
    background: 'rgba(0,0,0,0)', // transparent — match the SVG
  });
  return resvg.render().asPng();
}

const png16 = renderPng(16);
const png32 = renderPng(32);
const png48 = renderPng(48);

writeFileSync('public/favicon.png', png32);
console.log(`wrote public/favicon.png (32x32, ${png32.length} bytes)`);

const ico = await pngToIco([png16, png32, png48]);
writeFileSync('public/favicon.ico', ico);
console.log(`wrote public/favicon.ico (16/32/48 multi-res, ${ico.length} bytes)`);
