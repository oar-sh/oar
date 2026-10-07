// The prompts and the menu of `oar`, driven through fake terminal streams.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import {
  askLine,
  askYesNo,
  MENU_ENTRIES,
  menuUsesColor,
  PromptAborted,
  readMenuKey,
  renderMenu,
  runMenu,
} from './oar-cli-menu.mjs';

// A terminal: an input that takes raw mode (and records it) and an output
// whose text the test reads back.
function fakeTerminal({ rawMode = true, tty = true } = {}) {
  const input = new PassThrough();
  input.isTTY = tty;
  input.rawModes = [];
  if (rawMode === true) input.setRawMode = (on) => { input.rawModes.push(on); };
  if (rawMode === 'refused') input.setRawMode = () => { throw new Error('EIO'); };
  const output = new PassThrough();
  output.isTTY = tty;
  let text = '';
  output.on('data', (chunk) => { text += chunk; });
  return { input, output, text: () => text };
}

async function until(check, what) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const count = (text, part) => text.split(part).length - 1;

const STATUS = {
  version: '9.9.9',
  relay: 'running',
  url: 'http://localhost:3340/',
  port: 3340,
  access: 'local',
  service: 'active',
  warnings: ['Windows holds port 3340 (node.exe)'],
};

test('the menu renders the status header and every entry, the selected one marked', () => {
  assert.deepEqual(renderMenu({ status: STATUS, selected: 1 }), [
    'OAR 9.9.9 · relay running',
    '  URL      http://localhost:3340/',
    '  Port     3340',
    '  Access   this machine only',
    '  Service  installed, running',
    '  ! Windows holds port 3340 (node.exe)',
    '',
    '  1  Start',
    '> 2  Stop',
    '  3  Restart',
    '  4  Show URL and QR code',
    '  5  Settings',
    '  6  Install or remove the service',
    '  7  Update',
    '  8  Doctor',
    '  9  Copilot session',
    '  q  Quit',
    '',
    'Arrow keys and Enter, or a digit, to choose; q to quit.',
  ]);
});

test('the header says stopped, LAN and a missing config in words', () => {
  const stopped = renderMenu({ status: { version: '9.9.9', relay: 'stopped', port: 3340, access: 'lan', service: 'none' } });
  assert.equal(stopped[0], 'OAR 9.9.9 · relay stopped');
  assert.ok(stopped.includes('  Access   LAN'));
  assert.ok(stopped.includes('  Service  not installed'));
  const fresh = renderMenu({ status: { version: '9.9.9', relay: 'unconfigured', service: 'unavailable' } });
  assert.equal(fresh[0], 'OAR 9.9.9 · not set up yet (choose Settings)');
  assert.ok(fresh.includes('  Service  not available here'));
  assert.ok(!fresh.some((line) => line.startsWith('  URL')));
});

test('colour is used only on a terminal and never with NO_COLOR', () => {
  assert.equal(menuUsesColor({ env: {}, output: { isTTY: true } }), true);
  assert.equal(menuUsesColor({ env: { NO_COLOR: '1' }, output: { isTTY: true } }), false);
  assert.equal(menuUsesColor({ env: {}, output: { isTTY: false } }), false);
  const plain = renderMenu({ status: STATUS, selected: 0, color: false }).join('\n');
  assert.ok(!plain.includes('\x1b['));
  const coloured = renderMenu({ status: STATUS, selected: 0, color: true });
  assert.ok(coloured[0].includes('\x1b[32mrelay running\x1b[0m'));
  assert.ok(coloured.some((line) => line.startsWith('\x1b[7m> 1  Start')));
});

test('keys: arrows, j and k, Enter, digits, q and Ctrl+C', () => {
  assert.equal(readMenuKey('\x1b[A'), 'up');
  assert.equal(readMenuKey('\x1bOB'), 'down');
  assert.equal(readMenuKey('k'), 'up');
  assert.equal(readMenuKey('j'), 'down');
  assert.equal(readMenuKey('\r'), 'enter');
  assert.equal(readMenuKey('q'), 'quit');
  assert.equal(readMenuKey('\x03'), 'interrupt');
  assert.equal(readMenuKey('1'), 0);
  assert.equal(readMenuKey('9'), 8);
  assert.equal(readMenuKey('0'), null);
  assert.equal(readMenuKey('x'), null);
});

test('arrow keys move, Enter runs the entry, the menu redraws and q quits', async () => {
  const terminal = fakeTerminal();
  const ran = [];
  let loads = 0;
  const done = runMenu({
    ...terminal,
    env: { NO_COLOR: '1' },
    loadStatus: async () => { loads += 1; return STATUS; },
    actions: { stop: async (status) => { ran.push(['stop', status.port]); } },
  });
  await until(() => terminal.text().includes('> 1  Start'), 'the first drawing');
  terminal.input.write('\x1b[B');
  await until(() => terminal.text().includes('> 2  Stop'), 'the moved selection');
  terminal.input.write('\r');
  await until(() => terminal.text().includes('Press a key'), 'the pause after the action');
  assert.deepEqual(ran, [['stop', 3340]]);
  terminal.input.write(' ');
  await until(() => loads === 2 && count(terminal.text(), '> 2  Stop') === 2, 'the redraw');
  terminal.input.write('q');
  assert.deepEqual(await done, { code: 0, reason: 'menu-quit' });
  // Raw mode is left again after every read.
  assert.deepEqual(terminal.input.rawModes, [true, false, true, false, true, false]);
  assert.ok(terminal.text().startsWith('\x1b[2J\x1b[H'), 'a terminal is cleared before each drawing');
});

test('a digit runs its entry at once, and an action can end the menu', async () => {
  const terminal = fakeTerminal();
  const ran = [];
  const done = runMenu({
    ...terminal,
    loadStatus: async () => STATUS,
    actions: {
      doctor: async () => { ran.push('doctor'); },
      update: async () => { ran.push('update'); return { exit: true }; },
    },
  });
  await until(() => terminal.text().includes('Start'), 'the first drawing');
  terminal.input.write('8');
  await until(() => terminal.text().includes('Press a key'), 'the pause');
  terminal.input.write('x');
  await until(() => count(terminal.text(), 'Arrow keys') === 2, 'the redraw');
  terminal.input.write('7');
  assert.deepEqual(await done, { code: 0, reason: 'menu-exit' });
  assert.deepEqual(ran, ['doctor', 'update']);
});

test('Ctrl+C leaves the menu with 130 and the terminal out of raw mode', async () => {
  const terminal = fakeTerminal();
  const done = runMenu({ ...terminal, loadStatus: async () => STATUS });
  await until(() => terminal.text().includes('Start'), 'the first drawing');
  terminal.input.write('\x03');
  assert.deepEqual(await done, { code: 130, reason: 'interrupted' });
  assert.deepEqual(terminal.input.rawModes, [true, false]);

  // Also while the menu waits after an action.
  const second = fakeTerminal();
  const waiting = runMenu({ ...second, loadStatus: async () => STATUS, actions: { start: async () => {} } });
  await until(() => second.text().includes('Start'), 'the first drawing');
  second.input.write('1');
  await until(() => second.text().includes('Press a key'), 'the pause');
  second.input.write('\x03');
  assert.equal((await waiting).code, 130);
  assert.equal(second.input.rawModes.at(-1), false);
});

test('an action that fails is reported and the menu goes on; an aborted prompt in it returns to the menu', async () => {
  const terminal = fakeTerminal();
  const done = runMenu({
    ...terminal,
    loadStatus: async () => STATUS,
    actions: {
      start: async () => { throw new Error('disk full'); },
      setup: async () => { throw new PromptAborted(); },
    },
  });
  await until(() => terminal.text().includes('Start'), 'the first drawing');
  terminal.input.write('1');
  await until(() => terminal.text().includes('[oar] disk full'), 'the error line');
  await until(() => terminal.text().includes('Press a key'), 'the pause');
  terminal.input.write(' ');
  await until(() => count(terminal.text(), 'Arrow keys') === 2, 'the redraw');
  terminal.input.write('5');
  // Ctrl+C in a setup question leaves the entry; the menu is drawn again.
  await until(() => count(terminal.text(), 'Arrow keys') === 3, 'the menu after the aborted entry');
  terminal.input.write('q');
  assert.deepEqual(await done, { code: 0, reason: 'menu-quit' });
  assert.equal(terminal.input.rawModes.at(-1), false);
});

for (const rawMode of [false, 'refused']) {
  test(`a terminal ${rawMode === false ? 'without' : 'that refuses'} raw mode gets a numbered prompt`, async () => {
    const terminal = fakeTerminal({ rawMode });
    const ran = [];
    const done = runMenu({
      ...terminal,
      loadStatus: async () => STATUS,
      actions: { restart: async () => { ran.push('restart'); } },
    });
    await until(() => terminal.text().includes('Choose (1-9, q): '), 'the numbered prompt');
    terminal.input.write('3\n');
    await until(() => terminal.text().includes('Press Enter'), 'the pause');
    assert.deepEqual(ran, ['restart']);
    terminal.input.write('\n');
    await until(() => count(terminal.text(), 'Choose (1-9, q): ') === 2, 'the second prompt');
    terminal.input.write('q\n');
    assert.deepEqual(await done, { code: 0, reason: 'menu-quit' });
  });
}

test('the menu has nine numbered entries and Quit', () => {
  assert.equal(MENU_ENTRIES.length, 10);
  assert.equal(MENU_ENTRIES.at(-1).id, 'quit');
});

test('a yes/no prompt takes Enter as its default and reads y or n', async () => {
  const answer = async (typed, defaultYes) => {
    const terminal = fakeTerminal({ tty: false });
    const pending = askYesNo('Restart it now?', { defaultYes, ...terminal });
    terminal.input.write(typed);
    return [await pending, terminal.text()];
  };
  assert.deepEqual(await answer('\n', true), [true, 'Restart it now? [Y/n] ']);
  assert.deepEqual(await answer('\n', false), [false, 'Restart it now? [y/N] ']);
  assert.equal((await answer('n\n', true))[0], false);
  assert.equal((await answer('Yes\n', false))[0], true);
});

test('a line prompt returns the trimmed answer', async () => {
  const terminal = fakeTerminal({ tty: false });
  const pending = askLine('Port [3333]: ', terminal);
  terminal.input.write('  3340 \n');
  assert.equal(await pending, '3340');
});

test('Ctrl+C or a closed input in a prompt rejects with PromptAborted', async () => {
  const terminal = fakeTerminal();
  const pending = askLine('Port [3333]: ', terminal);
  terminal.input.write('\x03');
  await assert.rejects(pending, (error) => error instanceof PromptAborted && error.code === 'OAR_PROMPT_ABORTED');
  assert.deepEqual(terminal.input.rawModes.at(-1), false, 'readline hands the terminal back');

  const piped = fakeTerminal({ tty: false });
  const closed = askLine('Port [3333]: ', piped);
  piped.input.end();
  await assert.rejects(closed, PromptAborted);
});
