import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

// Settings › General reads as headed groups. Rendered against the real
// index.html: the five sections in order, every control in exactly one of
// them, nothing loose in the panel.
const indexHtml = await readFile(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
const { document } = new JSDOM(indexHtml).window;

const panel = () => document.getElementById('settings-panel-general');

const EXPECTED = [
  ['appearance', 'Appearance', ['theme-select', 'font-scale-select', 'thoughts-expanded-toggle', 'live-activity-cap-slider', 'stream-view-toggle', 'show-suspend-host-toggle']],
  ['reading', 'Reading', ['scroll-on-send-toggle', 'conversation-window-retention-slider']],
  ['turns', 'Turns and tasks', [
    'turn-ceiling-slider',
    'background-task-timeout-slider',
    'task-stall-minutes-slider',
    'subagent-record-retention-select',
  ]],
  ['relay', 'This relay', [
    'pwa-app-name-input',
    'restart-resume-toggle',
    'relay-restart-max-wait-select',
    'default-session-workspace-root-input',
    'windows-autostart-setting',
  ]],
  ['updates', 'Updates', ['update-auto-check-toggle', 'update-check-now-btn', 'update-available-card', 'update-outcome']],
];

test('General holds the five sections in order, each with its title', () => {
  const sections = [...panel().children];
  assert.deepEqual(sections.map((el) => el.id), EXPECTED.map(([name]) => `settings-section-${name}`));
  for (const [index, [name, title]] of EXPECTED.entries()) {
    const section = sections[index];
    assert.equal(section.tagName, 'SECTION');
    assert.equal(section.className, 'settings-section');
    const heading = section.firstElementChild;
    assert.equal(heading.tagName, 'H3');
    assert.equal(heading.className, 'settings-section-title');
    assert.equal(heading.textContent, title);
    assert.equal(section.getAttribute('aria-labelledby'), heading.id);
    assert.equal(heading.id, `settings-section-${name}-title`);
  }
});

test('every control sits in its section, in order, and in exactly one', () => {
  for (const [name, , ids] of EXPECTED) {
    const section = document.getElementById(`settings-section-${name}`);
    const found = ids.map((id) => {
      assert.equal(document.querySelectorAll(`#settings-modal [id="${id}"]`).length, 1, `${id} once in the modal`);
      const el = document.getElementById(id);
      assert.equal(el.closest('.settings-section'), section, `${id} in ${name}`);
      return el;
    });
    for (let i = 1; i < found.length; i += 1) {
      const order = found[i - 1].compareDocumentPosition(found[i]);
      assert.ok(order & document.defaultView.Node.DOCUMENT_POSITION_FOLLOWING, `${ids[i - 1]} before ${ids[i]}`);
    }
  }
});

test('no row, help line or control sits outside a section', () => {
  for (const el of panel().querySelectorAll('[id], .settings-row, .settings-help, input, select, button')) {
    assert.ok(el.closest('.settings-section'), `${el.id || el.className} inside a section`);
  }
});

test('relay rows say whose setting they are', () => {
  const relayRows = [
    'turn-ceiling-slider',
    'background-task-timeout-slider',
    'task-stall-minutes-slider',
    'subagent-record-retention-select',
    'pwa-app-name-input',
    'restart-resume-toggle',
    'relay-restart-max-wait-select',
    'default-session-workspace-root-input',
    'update-auto-check-toggle',
  ];
  for (const id of relayRows) {
    const row = document.getElementById(id).closest('.settings-row');
    const help = row.querySelector('.settings-help') || row.nextElementSibling;
    assert.ok(help.classList.contains('settings-help'), `${id} has a help line`);
    assert.match(help.textContent, /a setting of this relay\.$/i, id);
  }
  for (const id of ['thoughts-expanded-toggle', 'live-activity-cap-slider', 'stream-view-toggle', 'scroll-on-send-toggle', 'conversation-window-retention-slider']) {
    assert.match(document.getElementById(id).closest('.settings-row').nextElementSibling.textContent, /Saved in this browser\.$/, id);
  }
});
