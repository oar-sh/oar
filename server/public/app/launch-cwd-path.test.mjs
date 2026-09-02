import assert from 'node:assert/strict';
import test from 'node:test';

import { isWindowsStyleRoot, joinLaunchCwdPath } from './launch-cwd-path.mjs';

// platform-agnostic: joinLaunchCwdPath is pure string manipulation — the
// separator comes from the root's own shape, never from the host's `path`.

test('POSIX roots join with forward slashes', () => {
  assert.equal(joinLaunchCwdPath('/home/dev/git/copilot-remote', '.github'), '/home/dev/git/copilot-remote/.github');
  assert.equal(joinLaunchCwdPath('/home/dev/git/copilot-remote/', '.github/extensions'), '/home/dev/git/copilot-remote/.github/extensions');
  // A stray backslash in the relative part is normalized to the root's style.
  assert.equal(joinLaunchCwdPath('/srv/app', 'a\\b'), '/srv/app/a/b');
});

test('Windows roots keep the backslash join byte-identical to the old helper', () => {
  assert.equal(joinLaunchCwdPath('C:\\workspaces\\alpha', 'sub/dir'), 'C:\\workspaces\\alpha\\sub\\dir');
  assert.equal(joinLaunchCwdPath('C:\\workspaces\\alpha\\', '/sub'), 'C:\\workspaces\\alpha\\sub');
  assert.equal(joinLaunchCwdPath('C:', 'sub'), 'C:\\sub');
  // Forward-slash drive paths (as the tree serves them) still count as Windows.
  assert.equal(joinLaunchCwdPath('C:/workspaces/alpha', 'sub/dir'), 'C:/workspaces/alpha\\sub\\dir');
});

test('empty parts fall through unchanged', () => {
  assert.equal(joinLaunchCwdPath('', 'rel/path'), 'rel/path');
  assert.equal(joinLaunchCwdPath('/root/dir', ''), '/root/dir');
  assert.equal(joinLaunchCwdPath('', ''), '');
});

test('root style detection', () => {
  assert.equal(isWindowsStyleRoot('C:\\Users\\dev'), true);
  assert.equal(isWindowsStyleRoot('D:/data'), true);
  assert.equal(isWindowsStyleRoot('\\\\share\\x'), true);
  assert.equal(isWindowsStyleRoot('/home/dev'), false);
  assert.equal(isWindowsStyleRoot(''), false);
});
