'use strict';

import { createRequire } from 'node:module';

// The QR code of a sign-in link as a module matrix (agent auth §13.2, 2b),
// for the web UI to draw on a canvas. It uses the MIT-licensed encoder
// (Kazuhiko Arase's QRCode for JavaScript) that `qrcode-terminal`, already a
// dependency at the exact version 0.12.0, ships in its `vendor/QRCode`: the
// one encoder `oar` already prints its terminal QR codes with, kept in one
// place instead of a second copy in public/app/vendor.
//
// Error correction level M (15 %): a phone camera reads a link of ~120
// characters off a laptop screen at version 7 or so.
//
// Result `{ size, bits }`: `size` modules per side (no quiet zone; the
// client adds 4 modules), `bits` base64 of size × size bits, row by row,
// most significant bit first, 1 = dark, the last byte padded with zeros.

const require = createRequire(import.meta.url);
const QRCode = require('qrcode-terminal/vendor/QRCode');
const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');

export const QR_ERROR_CORRECTION = 'M';
// Far below the capacity of version 40 at level M; a sign-in link is ~120.
export const QR_TEXT_MAX = 1024;

/** The dark modules of `text` as rows of booleans (`modules[row][col]`). */
export function qrModules(text) {
  const value = String(text ?? '');
  if (!value || value.length > QR_TEXT_MAX) throw new Error('QR text is empty or too long');
  const code = new QRCode(-1, QRErrorCorrectLevel[QR_ERROR_CORRECTION]);
  code.addData(value);
  code.make();
  const size = code.getModuleCount();
  const modules = [];
  for (let row = 0; row < size; row += 1) {
    const line = [];
    for (let col = 0; col < size; col += 1) line.push(code.isDark(row, col) === true);
    modules.push(line);
  }
  return modules;
}

/** `{ size, bits }` (see the top of this file). */
export function qrMatrix(text) {
  const modules = qrModules(text);
  const size = modules.length;
  const bytes = Buffer.alloc(Math.ceil((size * size) / 8));
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (!modules[row][col]) continue;
      const index = row * size + col;
      bytes[index >> 3] |= 0x80 >> (index & 7);
    }
  }
  return { size, bits: bytes.toString('base64') };
}

/** The reverse of qrMatrix's packing: rows of booleans (tests, and documents the format). */
export function unpackQrBits({ size, bits }) {
  const bytes = Buffer.from(String(bits || ''), 'base64');
  const rows = [];
  for (let row = 0; row < size; row += 1) {
    const line = [];
    for (let col = 0; col < size; col += 1) {
      const index = row * size + col;
      line.push((bytes[index >> 3] & (0x80 >> (index & 7))) !== 0);
    }
    rows.push(line);
  }
  return rows;
}
