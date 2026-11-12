import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { QR_ERROR_CORRECTION, qrMatrix, qrModules, unpackQrBits } from './qr-matrix.mjs';

// The sign-in QR matrix (agent auth §13.2, 2b) is the one `qrcode-terminal`
// computes: its output, read back from the terminal rendering, must be
// module for module what qrMatrix packs. The link is made up and holds no
// credential (a sign-in link of the usual length, ~120 characters).

const require = createRequire(import.meta.url);
const qrcodeTerminal = require('qrcode-terminal');

// A 43-character code after oarc1_, as a real one has.
const LINK = `https://otter-relay-at-home.example-tunnel.test/workspace/oar/?signin=oarc1_${'Ab3-x_Yz9'.repeat(4)}Q2w5Rt7`;

// qrcode-terminal's plain rendering: one row per line, two characters per
// module, a one-module white border; black = "\x1b[40m  \x1b[0m".
function modulesFromTerminal(text) {
  const previous = qrcodeTerminal.error;
  // setErrorLevel('M') is a no-op in 0.12.0 (M is 0, which its `||`
  // falls through); the level is set directly.
  qrcodeTerminal.error = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel')[QR_ERROR_CORRECTION];
  let output = '';
  try {
    qrcodeTerminal.generate(text, (rendered) => { output = rendered; });
  } finally {
    qrcodeTerminal.error = previous;
  }
  const black = '\x1b[40m  \x1b[0m';
  const white = '\x1b[47m  \x1b[0m';
  const lines = output.split('\n');
  // Drop the border rows, then the border cell at each end.
  return lines.slice(1, -1).map((line) => {
    const cells = [];
    let rest = line;
    while (rest.length) {
      if (rest.startsWith(black)) { cells.push(true); rest = rest.slice(black.length); } else if (rest.startsWith(white)) { cells.push(false); rest = rest.slice(white.length); } else throw new Error('unexpected cell');
    }
    return cells.slice(1, -1);
  });
}

test('the matrix of a ~120-character link equals what qrcode-terminal computes (level M)', () => {
  assert.ok(LINK.length >= 110 && LINK.length <= 130, `link length ${LINK.length}`);
  const expected = modulesFromTerminal(LINK);
  const matrix = qrMatrix(LINK);
  assert.equal(matrix.size, expected.length);
  assert.equal(matrix.size % 4, 1, 'a QR side is 17 + 4 × version');
  assert.deepEqual(unpackQrBits(matrix), expected);
  assert.deepEqual(qrModules(LINK), expected);
  assert.equal(Buffer.from(matrix.bits, 'base64').length, Math.ceil((matrix.size * matrix.size) / 8));
  // The finder pattern's corner modules are dark.
  const rows = unpackQrBits(matrix);
  assert.equal(rows[0][0], true);
  assert.equal(rows[0][matrix.size - 1], true);
  assert.equal(rows[matrix.size - 1][0], true);
});

test('level M differs from qrcode-terminal\'s default level L (the setting is not left changed)', () => {
  assert.equal(qrcodeTerminal.error, 1, 'qrcode-terminal still prints at level L');
  let levelL = '';
  qrcodeTerminal.generate(LINK, (rendered) => { levelL = rendered; });
  const asM = modulesFromTerminal(LINK);
  assert.notEqual(levelL.split('\n').length - 2, 0);
  assert.equal(qrcodeTerminal.error, 1);
  assert.ok(asM.length >= levelL.split('\n').length - 2, 'level M needs at least as many modules');
});

test('empty or oversized text is refused', () => {
  assert.throws(() => qrMatrix(''));
  assert.throws(() => qrMatrix('x'.repeat(1025)));
});
