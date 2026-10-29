#!/usr/bin/env node
/**
 * Renders the Horizon 2.0 mark as browser icons.
 *
 * The mark is the same one src/components/site-header.tsx draws inline: a
 * forest circle, a pale horizon line and a warm disc sitting on it. Drawing it
 * here keeps the favicon reproducible and dependency-free — no image library,
 * no binary asset checked in without a way to rebuild it.
 *
 * Writes public/favicon.ico (a 256x256 PNG payload inside an ICO container,
 * which every current browser accepts) and public/favicon.svg.
 *
 * Usage: node scripts/generate-favicon.mjs
 */

import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const SIZE = 256;
const SUPERSAMPLE = 4;
const FOREST = [0x45, 0x5c, 0x4c];
const CREAM = [0xfb, 0xf6, 0xec];
const EMBER = [0xc6, 0x71, 0x2f];

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** Colour of one supersampled pixel inside the mark, or null for transparent. */
function sample(x, y, size) {
  const unit = size * SUPERSAMPLE;
  const cx = unit / 2;
  const cy = unit / 2;
  const radius = unit * 0.49;
  const dx = x + 0.5 - cx;
  const dy = y + 0.5 - cy;
  if (dx * dx + dy * dy > radius * radius) return null;

  const lineTop = unit * 0.475;
  const lineBottom = unit * 0.525;
  const discX = x + 0.5 - cx;
  const discY = y + 0.5 - unit * 0.605;
  const discRadius = unit * 0.175;
  if (discX * discX + discY * discY <= discRadius * discRadius) return EMBER;
  if (y + 0.5 >= lineTop && y + 0.5 <= lineBottom) return CREAM;
  return FOREST;
}

function renderRgba(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const step = SUPERSAMPLE;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let hits = 0;
      for (let sy = 0; sy < step; sy += 1) {
        for (let sx = 0; sx < step; sx += 1) {
          const colour = sample(x * step + sx, y * step + sy, size);
          if (!colour) continue;
          r += colour[0];
          g += colour[1];
          b += colour[2];
          hits += 1;
        }
      }
      const offset = (y * size + x) * 4;
      if (!hits) continue;
      const total = step * step;
      pixels[offset] = Math.round(r / hits);
      pixels[offset + 1] = Math.round(g / hits);
      pixels[offset + 2] = Math.round(b / hits);
      pixels[offset + 3] = Math.round((hits / total) * 255);
    }
  }
  return pixels;
}

function encodePng(pixels, size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function encodeIco(png) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // icon
  header.writeUInt16LE(1, 4); // one image
  const entry = Buffer.alloc(16);
  entry[0] = 0; // 256 px is encoded as 0
  entry[1] = 0;
  entry[2] = 0; // palette size
  entry[3] = 0;
  entry.writeUInt16LE(1, 4); // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(header.length + entry.length, 12);
  return Buffer.concat([header, entry, png]);
}

const png = encodePng(renderRgba(SIZE), SIZE);
writeFileSync(new URL("../public/favicon.ico", import.meta.url), encodeIco(png));
writeFileSync(
  new URL("../public/apple-touch-icon.png", import.meta.url),
  encodePng(renderRgba(180), 180),
);
writeFileSync(
  new URL("../public/favicon.svg", import.meta.url),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" role="img" aria-label="Horizon 2.0">
  <circle cx="16" cy="16" r="15.7" fill="#455c4c"/>
  <rect x="0.3" y="15.2" width="31.4" height="1.6" fill="#fbf6ec"/>
  <circle cx="16" cy="19.4" r="5.6" fill="#c6712f"/>
</svg>
`,
);

console.log("Wrote public/favicon.ico and public/favicon.svg");
