import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const indexPath = fileURLToPath(new URL('./public/index.html', import.meta.url));
const source = fs.readFileSync(indexPath, 'utf8');

test('index auth gate uses resilient connect handler', () => {
  assert.match(source, /window\.__copilotAuthConnect = async \(event\) => \{/);
  assert.match(source, /if \(typeof window\.doAuth === 'function'\) \{/);
  assert.match(source, /fetch\(`\$\{__APP_BASE\}\/api\/status`, \{/);
  assert.match(source, /await window\.__loadCopilotApp\(\{ recover: true \}\);/);
  assert.doesNotMatch(source, /localStorage\.setItem\(__AUTH_TOKEN_STORAGE_KEY/);
  assert.doesNotMatch(source, /document\.cookie = `\$\{__AUTH_COOKIE_NAME\}=\$\{encodeURIComponent\(token\)\}/);
  assert.match(source, /document\.cookie = `copilot_auth=; Path=\$\{cookiePath\}; Max-Age=0;/);
  assert.match(source, /onclick="window\.__copilotAuthConnect\(event\)"/);
  assert.match(source, /onkeydown="if\(event\.key==='Enter'\)window\.__copilotAuthConnect\(event\)"/);
});

test('index keeps the auth gate hidden until bootstrap needs it', () => {
  assert.match(source, /#auth-gate \{\s*display: none;/);
  assert.match(source, /<div id="startup-loading" role="status" aria-live="polite">Connecting to Copilot Remote…<\/div>/);
  assert.match(source, /document\.getElementById\('startup-loading'\)\?\.remove\(\);/);
  assert.match(source, /document\.getElementById\('auth-gate'\)\.style\.display = 'flex';/);
});
