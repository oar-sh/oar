import test from 'node:test';
import assert from 'node:assert/strict';

import { consumeSettingsDeepLink, readSettingsDeepLink, requestSettingsTab, SETTINGS_DEEP_LINK_TABS } from './settings-deep-link.mjs';
import { relayPageUrl, relaySettingsUrl, sameHostOtherPort } from './remote-relay-links.mjs';
import { QR_QUIET_ZONE, decodeQrMatrix, drawQrCode } from './qr-canvas.mjs';
import { qrMatrix } from '../../services/qr-matrix.mjs';

test('?settings=<tab>: an allowlisted tab, add-relay with Relays only, taken out of the address', () => {
  assert.deepEqual(readSettingsDeepLink('https://b.example.test/?settings=notifications'), { tab: 'notifications', addRelay: false, cleanedPath: '/' });
  assert.deepEqual(readSettingsDeepLink('https://b.example.test/oar/?settings=relays&add-relay=1&conv=c-1#x'), { tab: 'relays', addRelay: true, cleanedPath: '/oar/?conv=c-1#x' });
  assert.deepEqual(readSettingsDeepLink('https://b.example.test/?settings=Security'), { tab: 'security', addRelay: false, cleanedPath: '/' });
  assert.deepEqual(readSettingsDeepLink('https://b.example.test/?settings=security&add-relay=1'), { tab: 'security', addRelay: false, cleanedPath: '/' });
  assert.deepEqual(readSettingsDeepLink('https://b.example.test/?settings=javascript:alert(1)'), { tab: '', addRelay: false, cleanedPath: '/' });
  assert.deepEqual(readSettingsDeepLink('https://b.example.test/?settings=relays&add-relay=yes'), { tab: 'relays', addRelay: false, cleanedPath: '/' });
  assert.deepEqual(readSettingsDeepLink('https://b.example.test/?conv=c-1'), { tab: '', addRelay: false, cleanedPath: null });
  assert.deepEqual(readSettingsDeepLink('not a url'), { tab: '', addRelay: false, cleanedPath: null });
});

test('the allowlist is the Settings tabs', async () => {
  // settings-tabs.js needs a DOM only when called; its list is a plain export.
  const { SETTINGS_TABS } = await import('./settings-tabs.js');
  assert.deepEqual([...SETTINGS_DEEP_LINK_TABS], SETTINGS_TABS);
});

test('consume replaces the entry once and keeps its state', () => {
  const calls = [];
  const history = { state: { mark: 1 }, replaceState: (...args) => calls.push(args) };
  assert.deepEqual(consumeSettingsDeepLink({ location: { href: 'https://b.example.test/?settings=relays&add-relay=1' }, history, title: 'OAR' }), { tab: 'relays', addRelay: true });
  assert.deepEqual(calls, [[{ mark: 1 }, 'OAR', '/']]);
  calls.length = 0;
  consumeSettingsDeepLink({ location: { href: 'https://b.example.test/' }, history, title: 'OAR' });
  assert.deepEqual(calls, []);
});

test('links to another relay: http(s), its own origin, no credentials, base path kept', () => {
  assert.equal(relayPageUrl('https://relay-b.example.test'), 'https://relay-b.example.test/');
  assert.equal(relayPageUrl('https://relay-b.example.test/oar?token=x#y'), 'https://relay-b.example.test/oar/', 'a query or fragment of the stored address is dropped');
  assert.equal(relaySettingsUrl('https://relay-b.example.test/oar/', 'relays', { addRelay: true }), 'https://relay-b.example.test/oar/?settings=relays&add-relay=1');
  assert.equal(relayPageUrl('data:text/html,x'), '');
  assert.equal(relayPageUrl('https://a:b@relay-b.example.test'), '');
  assert.equal(relayPageUrl('https://relay-b.example.test', {}, { origin: 'https://relay-c.example.test' }), '');
  assert.equal(sameHostOtherPort('http://localhost:3333', 'http://localhost:3334/'), true);
  assert.equal(sameHostOtherPort('http://LOCALHOST:3333', 'http://localhost:3333'), false);
  assert.equal(sameHostOtherPort('http://relay.example.test', 'https://relay.example.test'), true, '80 and 443 share the cookies too');
  assert.equal(sameHostOtherPort('http://127.0.0.1:3333', 'http://localhost:3334'), false);
});

test('the QR code: the relay\'s matrix drawn module for module, inside a 4-module quiet zone', () => {
  const link = 'https://relay-a.example.test/?signin=oarc1_FAKE-test-value-made-up-for-this-test-only';
  const qr = qrMatrix(link);
  const matrix = decodeQrMatrix(qr);
  assert.equal(matrix.size, qr.size);
  // The finder pattern's corner: dark, its inner ring light.
  assert.equal(matrix.dark(0, 0), true);
  assert.equal(matrix.dark(1, 1), false);
  assert.equal(matrix.dark(2, 2), true);
  const cells = [];
  const canvas = { width: 0, height: 0, getContext: () => ({ fillStyle: '', fillRect(x, y, w, h) { cells.push({ fill: this.fillStyle, x, y, w, h }); }, clearRect() {} }) };
  const modules = drawQrCode(canvas, qr, { scale: 2 });
  assert.equal(modules, qr.size + 2 * QR_QUIET_ZONE);
  assert.equal(canvas.width, modules * 2);
  const dark = cells.filter((cell) => cell.fill === '#000000');
  let expected = 0;
  for (let y = 0; y < qr.size; y += 1) for (let x = 0; x < qr.size; x += 1) if (matrix.dark(x, y)) expected += 1;
  assert.equal(dark.length, expected);
  assert.ok(dark.every((cell) => cell.x >= QR_QUIET_ZONE * 2 && cell.y >= QR_QUIET_ZONE * 2));
  // Not a matrix: nothing drawn, the canvas emptied.
  assert.equal(decodeQrMatrix({ size: 22, bits: qr.bits }), null);
  assert.equal(decodeQrMatrix({ size: 21, bits: 'AAAA' }), null);
  assert.equal(decodeQrMatrix({ size: 21, bits: '<script>' }), null);
  assert.equal(drawQrCode(canvas, null), 0);
  assert.equal(canvas.width, 0);
});

test('a notification tap over the sign-in box opens no Settings: the tab waits in the address for the start after the sign-in', () => {
  const opened = [];
  const calls = [];
  const history = { state: { mark: 2 }, replaceState: (...args) => calls.push(args) };
  const location = { href: 'https://b.example.test/oar/?conv=c-1&settings=relays&add-relay=1#x' };
  const gated = { isAuthGateVisible: () => true, open: (tab) => opened.push(tab), location, history, title: 'OAR' };
  assert.equal(requestSettingsTab('Security', gated), 'deferred');
  assert.deepEqual(opened, []);
  assert.deepEqual(calls, [[{ mark: 2 }, 'OAR', '/oar/?conv=c-1&settings=security#x']]);
  // What the start after the sign-in reads.
  assert.deepEqual(readSettingsDeepLink(`https://b.example.test${calls[0][2]}`), { tab: 'security', addRelay: false, cleanedPath: '/oar/?conv=c-1#x' });
  // Signed in: Settings opens at once and the address stays.
  assert.equal(requestSettingsTab('security', { ...gated, isAuthGateVisible: () => false }), 'opened');
  assert.deepEqual(opened, ['security']);
  assert.equal(calls.length, 1);
  // Not a tab: nothing, gate or not.
  assert.equal(requestSettingsTab('javascript:alert(1)', gated), 'ignored');
  assert.equal(requestSettingsTab('', { ...gated, isAuthGateVisible: () => false }), 'ignored');
  assert.deepEqual(opened, ['security']);
  assert.equal(calls.length, 1);
});
