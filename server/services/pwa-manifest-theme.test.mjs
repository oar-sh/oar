import test from 'node:test';
import assert from 'node:assert/strict';

import { applyPwaManifestTheme, normalizePwaTheme } from './pwa-manifest-theme.mjs';

const template = () => ({
  name: 'OAR',
  background_color: '#161b22',
  theme_color: '#161b22',
  icons: [
    { src: 'app-icon.svg?v=26', sizes: 'any', type: 'image/svg+xml' },
    { src: 'app-icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: 'app-icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: 'app-icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
});

test('only "light" is the light theme', () => {
  assert.equal(normalizePwaTheme('light'), 'light');
  assert.equal(normalizePwaTheme(' LIGHT '), 'light');
  for (const value of ['dark', '', null, undefined, 'auto', 'lightish']) {
    assert.equal(normalizePwaTheme(value), 'dark');
  }
});

test('the dark manifest is the template unchanged', () => {
  const manifest = template();
  assert.equal(applyPwaManifestTheme(manifest, 'dark'), manifest);
  assert.equal(applyPwaManifestTheme(manifest, undefined), manifest);
});

test('the light manifest names the light icons and a white background', () => {
  const manifest = template();
  const light = applyPwaManifestTheme(manifest, 'light');
  assert.equal(light.background_color, '#ffffff');
  assert.equal(light.theme_color, '#ffffff');
  assert.deepEqual(light.icons.map((icon) => icon.src), [
    'app-icon-light.svg?v=26',
    'app-icon-light-192.png',
    'app-icon-light-512.png',
    'app-icon-light-maskable-512.png',
  ]);
  assert.equal(light.name, 'OAR');
  assert.equal(manifest.icons[0].src, 'app-icon.svg?v=26', 'the template is not modified');
});

test('every light icon the manifest can name ships with the relay', async () => {
  const fs = await import('node:fs');
  const light = applyPwaManifestTheme(template(), 'light');
  for (const icon of light.icons) {
    const file = new URL(`../public/${icon.src.split('?')[0]}`, import.meta.url);
    assert.ok(fs.existsSync(file), `${icon.src} exists`);
  }
});
