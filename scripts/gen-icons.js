#!/usr/bin/env node
/**
 * Generate build/icon.png (512×512) for electron-builder.
 * Pure Node (zlib) — no native deps. Geometric GrokCode mark.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 512;

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeB = Buffer.from(type, 'ascii');
  const crcB = Buffer.alloc(4);
  crcB.writeUInt32BE(crc32(Buffer.concat([typeB, data])), 0);
  return Buffer.concat([len, typeB, data, crcB]);
}

function writePng(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function dist(x, y, cx, cy) {
  const dx = x - cx;
  const dy = y - cy;
  return Math.sqrt(dx * dx + dy * dy);
}

function paint() {
  const rgba = Buffer.alloc(SIZE * SIZE * 4);
  const cx = SIZE / 2;
  const cy = SIZE / 2;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      const r = dist(x, y, cx, cy) / (SIZE * 0.48);
      // void background with subtle radial
      let R = 5,
        G = 6,
        B = 12,
        A = 255;
      if (r < 1) {
        // outer ring ice
        const ring1 = Math.abs(r - 0.92);
        const ring2 = Math.abs(r - 0.62);
        if (ring1 < 0.04) {
          R = 125;
          G = 211;
          B = 252;
        } else if (ring2 < 0.035) {
          R = 56;
          G = 189;
          B = 248;
          A = 220;
        } else if (r < 0.55) {
          // face disc
          R = 12;
          G = 18;
          B = 32;
        }
        // smile arc
        const ang = Math.atan2(y - cy, x - cx);
        const smileR = dist(x, y, cx, cy + 8);
        if (smileR > SIZE * 0.18 && smileR < SIZE * 0.22 && ang > 0.25 && ang < Math.PI - 0.25) {
          R = 249;
          G = 115;
          B = 22;
        }
        // eyes
        const e1 = dist(x, y, cx - 48, cy - 28);
        const e2 = dist(x, y, cx + 48, cy - 28);
        if (e1 < 10 || e2 < 10) {
          R = 255;
          G = 255;
          B = 255;
        }
        // core
        if (dist(x, y, cx, cy) < 14) {
          R = 125;
          G = 211;
          B = 252;
        }
        // soft outer alpha fade for rounded app icon feel
        if (r > 0.96) {
          A = Math.max(0, Math.floor(255 * (1 - (r - 0.96) / 0.04)));
        }
      } else {
        A = 0;
      }
      rgba[i] = R;
      rgba[i + 1] = G;
      rgba[i + 2] = B;
      rgba[i + 3] = A;
    }
  }
  return rgba;
}

function main() {
  const root = path.join(__dirname, '..');
  const outDir = path.join(root, 'build');
  fs.mkdirSync(outDir, { recursive: true });
  const png = writePng(paint(), SIZE, SIZE);
  const out = path.join(outDir, 'icon.png');
  fs.writeFileSync(out, png);
  // also small favicon-ish for docs
  const docsIcon = path.join(root, 'docs', 'catalog', 'icon.png');
  try {
    fs.mkdirSync(path.dirname(docsIcon), { recursive: true });
    fs.writeFileSync(docsIcon, png);
  } catch {
    /* ignore */
  }
  console.log('ok  build/icon.png', SIZE + 'x' + SIZE, png.length, 'bytes');
}

main();
