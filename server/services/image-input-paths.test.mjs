import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  IMAGE_INPUT_EDGE_MAX,
  checkImageInputPathShape,
  readImageInputFile,
  resolveImageInputPath,
  resolveImageInputRoots,
  resolveImageInputs,
  sniffImageInput,
} from './image-input-paths.mjs';
import { GIF_BYTES, jpegBytes, pngBytes, webpBytes } from './image-input-test-fixtures.mjs';

// The path rules of a send's imagePaths, against real temp folders. The win32
// shapes are checked with the platform injected, so they run everywhere; the
// links and the FIFO need a POSIX host.

function tempTree(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oar-image-paths-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const dirs = {
    base,
    project: path.join(base, 'project'),
    state: path.join(base, 'state'),
    data: path.join(base, 'data'),
    outside: path.join(base, 'outside'),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  return dirs;
}

test('a path is checked for its shape before anything touches the disk', () => {
  const posix = (value) => checkImageInputPathShape(value, { platform: 'linux' });
  const win32 = (value) => checkImageInputPathShape(value, { platform: 'win32' });
  assert.equal(posix('/home/dev/project/a.png').ok, true);
  assert.equal(win32('C:\\Users\\dev\\project\\a.png').ok, true);
  assert.equal(win32('C:/Users/dev/project/a.png').ok, true);

  for (const [value, pattern] of [
    ['', /empty, too long/],
    ['/home/dev/a\0.png', /not a path/],
    [`/${'a'.repeat(4096)}`, /too long/],
    ['C:\\Users\\dev\\a.png', /not an absolute path/],
    ['relative/a.png', /not an absolute path/],
    ['//server/share/a.png', /network or device path/],
    ['/home/dev/project/../secret/a.png', /\. or \.\. segments/],
  ]) {
    const checked = posix(value);
    assert.equal(checked.ok, false, value);
    assert.match(checked.error, pattern, value);
  }
  for (const [value, pattern] of [
    ['\\Users\\dev\\a.png', /not an absolute path/],
    ['/Users/dev/a.png', /not an absolute path/],
    ['\\\\server\\share\\a.png', /network or device path/],
    ['\\\\?\\C:\\Users\\dev\\a.png', /network or device path/],
    ['\\\\.\\PhysicalDrive0', /network or device path/],
    ['//server/share/a.png', /network or device path/],
    ['C:\\Users\\dev\\a.png:secret', /alternate data stream/],
    ['C:\\Users\\dev.\\a.png', /ends in a dot or a space/],
    ['C:\\Users\\dev \\a.png', /ends in a dot or a space/],
    ['C:\\Users\\dev\\CON', /reserved device/],
    ['C:\\Users\\dev\\nul.png', /reserved device/],
    ['C:\\Users\\dev\\COM1.jpg', /reserved device/],
    ['C:\\Users\\dev\\lpt9', /reserved device/],
    ['C:\\Users\\dev\\..\\a.png', /\. or \.\. segments/],
  ]) {
    const checked = win32(value);
    assert.equal(checked.ok, false, value);
    assert.match(checked.error, pattern, value);
  }
  // A name that only starts like a device is a name.
  assert.equal(win32('C:\\Users\\dev\\console.png').ok, true);
});

test('the header decides the type; GIF, animated and oversized images are refused', () => {
  assert.deepEqual(sniffImageInput(pngBytes(64, 32)), { ok: true, mime: 'image/png', width: 64, height: 32 });
  assert.equal(sniffImageInput(jpegBytes(20, 10)).mime, 'image/jpeg');
  assert.equal(sniffImageInput(webpBytes(30, 40)).mime, 'image/webp');
  assert.match(sniffImageInput(GIF_BYTES, 'a.png').error, /"a.png" is not a PNG, JPEG or WebP image/);
  assert.match(sniffImageInput(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')).error, /not a PNG, JPEG or WebP/);
  assert.match(sniffImageInput(pngBytes(64, 32, { animated: true })).error, /animated image/);
  assert.match(sniffImageInput(webpBytes(30, 40, { animated: true })).error, /animated image/);
  assert.match(sniffImageInput(pngBytes(IMAGE_INPUT_EDGE_MAX + 1, 16)).error, /at most 16384 pixels a side/);
  assert.match(sniffImageInput(pngBytes(10000, 10000)).error, /64 megapixels/);
  assert.equal(sniffImageInput(pngBytes(IMAGE_INPUT_EDGE_MAX, 16)).ok, true);
});

test('only the session folder and the generated-image shape are readable; the relay\'s own data never', (t) => {
  const dirs = tempTree(t);
  const write = (file, bytes = pngBytes(8, 8)) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    return file;
  };
  const inside = write(path.join(dirs.project, 'a.png'));
  const outside = write(path.join(dirs.outside, 'b.png'));
  const generated = write(path.join(dirs.state, 'sdk-1', 'generated-images', 'conv-b', 'msg-1', 'img-01.png'));
  const goneGenerated = write(path.join(dirs.state, 'sdk-2', 'generated-images', 'conv-gone', 'msg-1', 'img-01.png'));
  const evil = write(path.join(dirs.state, 'sdk-1', 'generated-images-evil', 'conv-b', 'msg-1', 'img-01.png'));
  const stateOther = write(path.join(dirs.state, 'sdk-1', 'events.png'));
  const ownData = write(path.join(dirs.data, 'uploads', 'c.png'));
  const config = write(path.join(dirs.project, 'config.json'));
  const live = new Set(['conv-b']);
  // The tree is the host's real folders, so the host's platform reads them
  // (the win32 rules have their own test below, on any host).
  const options = { isLiveConversation: (id) => live.has(id), platform: process.platform }; // host-platform: real temp folders
  const roots = resolveImageInputRoots({
    cwd: dirs.project,
    sessionStateRoot: dirs.state,
    deniedDirs: [dirs.data],
    deniedFiles: [config],
  });

  assert.equal(resolveImageInputPath(inside, roots, options).source, 'cwd');
  assert.equal(resolveImageInputPath(generated, roots, options).source, 'generated');
  assert.match(resolveImageInputPath(outside, roots, options).error, /outside this session's folder/);
  assert.match(resolveImageInputPath(goneGenerated, roots, options).error, /session that is gone/);
  assert.match(resolveImageInputPath(evil, roots, options).error, /session-state folder/);
  assert.match(resolveImageInputPath(stateOther, roots, options).error, /session-state folder/);
  assert.match(resolveImageInputPath(config, roots, options).error, /own data/);
  assert.match(resolveImageInputPath(path.join(dirs.project, 'missing.png'), roots, options).error, /was not found/);
  // Outside the roots a missing file answers like an existing one: no oracle.
  const missingOutside = resolveImageInputPath(path.join(dirs.outside, 'missing.png'), roots, options).error;
  assert.match(missingOutside, /outside this session's folder/);
  assert.equal(missingOutside.replace('missing.png', 'b.png'), resolveImageInputPath(outside, roots, options).error);
  assert.match(resolveImageInputPath(path.join(dirs.state, 'sdk-1', 'generated-images', 'conv-b', 'msg-1', 'img-09.png'), roots, options).error, /was not found/);

  // A folder at the root of the tree's drive ("/" on POSIX) holds everything
  // but the relay's own data.
  const everything = resolveImageInputRoots({ cwd: path.parse(dirs.outside).root, sessionStateRoot: dirs.state, deniedDirs: [dirs.data], deniedFiles: [config] });
  assert.equal(resolveImageInputPath(outside, everything, options).ok, true);
  assert.match(resolveImageInputPath(ownData, everything, options).error, /own data/);
  assert.match(resolveImageInputPath(stateOther, everything, options).error, /session-state folder/);

  // A folder that does not resolve allows nothing.
  const missingCwd = resolveImageInputRoots({ cwd: path.join(dirs.base, 'nowhere'), sessionStateRoot: dirs.state });
  assert.match(resolveImageInputPath(inside, missingCwd, options).error, /outside this session's folder/);
});

test('links are followed to their real path, and a dangling one is refused', { skip: process.platform === 'win32' }, (t) => {
  const dirs = tempTree(t);
  fs.writeFileSync(path.join(dirs.outside, 'b.png'), pngBytes(8, 8));
  fs.symlinkSync(path.join(dirs.outside, 'b.png'), path.join(dirs.project, 'escape.png'));
  fs.symlinkSync(path.join(dirs.outside, 'gone.png'), path.join(dirs.project, 'dangling.png'));
  // The session folder itself a link: what is in it counts as inside.
  fs.writeFileSync(path.join(dirs.project, 'a.png'), pngBytes(8, 8));
  fs.symlinkSync(dirs.project, path.join(dirs.base, 'project-link'));
  const options = { isLiveConversation: () => true, platform: 'linux' };
  const roots = resolveImageInputRoots({ cwd: path.join(dirs.base, 'project-link'), sessionStateRoot: dirs.state });
  assert.match(resolveImageInputPath(path.join(dirs.project, 'escape.png'), roots, options).error, /outside this session's folder/);
  assert.match(resolveImageInputPath(path.join(dirs.project, 'dangling.png'), roots, options).error, /was not found/);
  assert.equal(resolveImageInputPath(path.join(dirs.base, 'project-link', 'a.png'), roots, options).ok, true);
});

test('a file is read once, bounded: empty, too big and a folder are refused', (t) => {
  const dirs = tempTree(t);
  const empty = path.join(dirs.project, 'empty.png');
  fs.writeFileSync(empty, Buffer.alloc(0));
  assert.match(readImageInputFile(empty).error, /is empty/);
  const big = path.join(dirs.project, 'big.png');
  fs.writeFileSync(big, pngBytes(8, 8));
  fs.truncateSync(big, 20 * 1024 * 1024 + 1);
  assert.match(readImageInputFile(big).error, /larger than 20 MB/);
  assert.equal(readImageInputFile(big, { maxBytes: 21 * 1024 * 1024 }).bytes.length, 20 * 1024 * 1024 + 1);
  assert.match(readImageInputFile(dirs.project).error, /not a regular file|could not be opened/);
  const small = path.join(dirs.project, 'small.png');
  fs.writeFileSync(small, pngBytes(8, 8));
  assert.deepEqual(readImageInputFile(small).bytes, pngBytes(8, 8));
});

test('a FIFO is refused without blocking', { skip: process.platform === 'win32' }, (t) => {
  const dirs = tempTree(t);
  const fifo = path.join(dirs.project, 'pipe.png');
  try {
    execFileSync('mkfifo', [fifo]);
  } catch {
    t.skip('mkfifo is not available');
    return;
  }
  assert.match(readImageInputFile(fifo).error, /not a regular file/);
});

test('one send\'s images: the same file or the same bytes are kept once, in order', { skip: process.platform === 'win32' }, (t) => {
  const dirs = tempTree(t);
  fs.writeFileSync(path.join(dirs.project, 'a.png'), pngBytes(8, 8));
  fs.writeFileSync(path.join(dirs.project, 'copy.png'), pngBytes(8, 8));
  fs.writeFileSync(path.join(dirs.project, 'b.jpg'), jpegBytes(8, 8));
  fs.symlinkSync(path.join(dirs.project, 'a.png'), path.join(dirs.project, 'link.png'));
  const roots = resolveImageInputRoots({ cwd: dirs.project, sessionStateRoot: dirs.state });
  const paths = ['b.jpg', 'a.png', 'a.png', 'link.png', 'copy.png'].map((name) => path.join(dirs.project, name));
  const resolved = resolveImageInputs(paths, { roots, isLiveConversation: () => true, platform: 'linux' });
  assert.equal(resolved.ok, true);
  assert.deepEqual(resolved.images.map((image) => [image.name, image.mime]), [['b.jpg', 'image/jpeg'], ['a.png', 'image/png']]);
  assert.equal(resolved.dropped, 3);
  // One refused path refuses them all.
  const refused = resolveImageInputs([paths[0], path.join(dirs.outside, 'x.png')], { roots, isLiveConversation: () => true, platform: 'linux' });
  assert.equal(refused.ok, false);
});

// A Windows file system for the resolver, so its win32 rules run on every
// host: realpath answers the canonical path of a listed file or folder for
// any casing and either separator, as Windows does, and fails for the rest.
function win32Fs(canonical, { calls = [] } = {}) {
  const byKey = new Map(canonical.map((entry) => [entry.toLowerCase(), entry]));
  const realpath = (value) => {
    calls.push(value);
    const found = byKey.get(path.win32.normalize(String(value)).toLowerCase());
    if (!found) throw Object.assign(new Error(`ENOENT: ${value}`), { code: 'ENOENT' });
    return found;
  };
  realpath.native = realpath;
  // One file id per canonical path; the resolver records it for the read.
  const statSync = (value) => {
    const found = realpath(value);
    return { dev: 1n, ino: BigInt(canonical.indexOf(found) + 1) };
  };
  return { realpathSync: realpath, statSync };
}

test('win32: drive-letter case, mixed separators, other drives, \\\\?\\ and UNC paths', () => {
  const W = path.win32;
  const project = W.join('C:\\', 'Users', 'dev', 'project');
  const state = W.join('C:\\', 'Users', 'dev', 'AppData', 'Roaming', 'oar', 'session-state');
  const data = W.join('C:\\', 'Users', 'dev', 'AppData', 'Roaming', 'oar', 'data');
  const files = {
    inside: W.join(project, 'art', 'a.png'),
    lookalike: W.join('C:\\', 'Users', 'dev', 'project-evil', 'a.png'),
    otherDrive: W.join('D:\\', 'Users', 'dev', 'project', 'a.png'),
    generated: W.join(state, 'sdk-1', 'generated-images', 'conv-b', 'msg-1', 'img-01.png'),
    generatedLookalike: W.join(state, 'sdk-1', 'generated-images-evil', 'conv-b', 'msg-1', 'img-01.png'),
    upload: W.join(data, 'uploads', 'c.png'),
  };
  const calls = [];
  const fs = win32Fs([project, state, data, 'C:\\', ...Object.values(files)], { calls });
  const options = { isLiveConversation: (id) => id === 'conv-b', platform: 'win32', fs };
  const roots = resolveImageInputRoots({ cwd: project, sessionStateRoot: state, deniedDirs: [data], fs });
  const resolve = (raw, rootsUsed = roots) => resolveImageInputPath(raw, rootsUsed, options);

  // Any casing of the drive and the folders, either separator, mixed.
  for (const raw of [
    files.inside,
    'c:\\users\\DEV\\Project\\ART\\A.PNG',
    'C:/Users/dev/project/art/a.png',
    'c:/Users\\dev/project\\art/a.png',
  ]) {
    const place = resolve(raw);
    assert.equal(place.ok, true, `${raw}: ${place.error}`);
    assert.equal(place.source, 'cwd', raw);
    assert.equal(place.realPath, files.inside, raw);
  }
  assert.equal(resolve('c:\\USERS\\dev\\AppData\\Roaming\\OAR\\session-state\\SDK-1\\Generated-Images\\conv-b\\msg-1\\IMG-01.PNG').source, 'generated');
  assert.match(resolve(files.lookalike).error, /outside this session's folder/);
  assert.match(resolve(files.otherDrive).error, /outside this session's folder/);
  assert.match(resolve(files.generatedLookalike).error, /session-state folder/);
  assert.match(resolve('c:\\users\\dev\\appdata\\roaming\\oar\\DATA\\uploads\\C.png').error, /own data/);

  // A realpath that keeps the caller's casing still compares without case.
  const keepsCase = { realpathSync: Object.assign((value) => path.win32.normalize(String(value)), {}), statSync: () => ({ dev: 1n, ino: 1n }) };
  keepsCase.realpathSync.native = keepsCase.realpathSync;
  const caseRoots = resolveImageInputRoots({ cwd: 'C:\\Users\\Dev\\Project', sessionStateRoot: state, fs: keepsCase });
  assert.equal(resolveImageInputPath('c:\\users\\dev\\project\\a.png', caseRoots, { ...options, fs: keepsCase }).source, 'cwd');
  assert.match(resolveImageInputPath('c:\\users\\dev\\projectx\\a.png', caseRoots, { ...options, fs: keepsCase }).error, /outside/);

  // A folder at a drive's root holds that drive, not another one.
  const driveRoot = resolveImageInputRoots({ cwd: 'C:\\', sessionStateRoot: state, deniedDirs: [data], fs });
  assert.equal(resolve(files.lookalike, driveRoot).source, 'cwd');
  assert.match(resolve(files.otherDrive, driveRoot).error, /outside this session's folder/);
  assert.match(resolve(files.upload, driveRoot).error, /own data/);

  // Device and network paths never reach the file system.
  const before = calls.length;
  for (const raw of [
    '\\\\?\\C:\\Users\\dev\\project\\art\\a.png',
    '\\\\.\\C:\\Users\\dev\\project\\art\\a.png',
    '\\\\fileserver\\share\\a.png',
    '//fileserver/share/a.png',
    '\\/fileserver/share/a.png',
    'C:\\Users\\dev\\project\\art\\a.png:hidden',
  ]) {
    assert.equal(resolve(raw).ok, false, raw);
  }
  assert.equal(calls.length, before, 'no realpath for a refused shape');
});

test('a parent folder swapped for a link after the checks is caught at the read', { skip: process.platform === 'win32' }, (t) => {
  const dirs = tempTree(t);
  fs.mkdirSync(path.join(dirs.project, 'art'));
  fs.writeFileSync(path.join(dirs.project, 'art', 'a.png'), pngBytes(8, 8));
  fs.mkdirSync(path.join(dirs.outside, 'art'));
  fs.writeFileSync(path.join(dirs.outside, 'art', 'a.png'), pngBytes(9, 9));
  const roots = resolveImageInputRoots({ cwd: dirs.project, sessionStateRoot: dirs.state });
  const target = path.join(dirs.project, 'art', 'a.png');
  // Between the checks and the open, art/ becomes a link to a folder
  // elsewhere: O_NOFOLLOW guards only the file name itself.
  const swapping = {
    ...fs,
    constants: fs.constants,
    openSync: (file, flags) => {
      fs.renameSync(path.join(dirs.project, 'art'), path.join(dirs.project, 'art-old'));
      fs.symlinkSync(path.join(dirs.outside, 'art'), path.join(dirs.project, 'art'));
      return fs.openSync(file, flags);
    },
  };
  const resolved = resolveImageInputs([target], { roots, isLiveConversation: () => true, platform: 'linux', fs: swapping });
  assert.equal(resolved.ok, false);
  assert.match(resolved.error, /changed while it was read/);

  // Each guard holds alone: the same file id but another real path, and the
  // same real path but another file id, are both refused.
  const place = resolveImageInputPath(path.join(dirs.project, 'art-old', 'a.png'), roots, { isLiveConversation: () => true, platform: 'linux' });
  assert.equal(place.ok, true, place.error);
  const movedPath = { ...fs, constants: fs.constants, realpathSync: Object.assign(() => path.join(dirs.outside, 'art', 'a.png'), { native: () => path.join(dirs.outside, 'art', 'a.png') }) };
  assert.match(readImageInputFile(place.realPath, { identity: place.identity, platform: 'linux', fs: movedPath }).error, /changed while it was read/);
  assert.match(readImageInputFile(place.realPath, { identity: { dev: place.identity.dev, ino: place.identity.ino + 1n }, platform: 'linux' }).error, /changed while it was read/);
  assert.equal(readImageInputFile(place.realPath, { identity: place.identity, platform: 'linux' }).ok, true);
});

test('a parent folder swapped for a link before the checks and back after the open is caught too', { skip: process.platform === 'win32' }, (t) => {
  const dirs = tempTree(t);
  fs.mkdirSync(path.join(dirs.project, 'art'));
  fs.writeFileSync(path.join(dirs.project, 'art', 'a.png'), pngBytes(8, 8));
  fs.mkdirSync(path.join(dirs.outside, 'art'));
  fs.writeFileSync(path.join(dirs.outside, 'art', 'a.png'), pngBytes(9, 9));
  const roots = resolveImageInputRoots({ cwd: dirs.project, sessionStateRoot: dirs.state });
  const target = path.join(dirs.project, 'art', 'a.png');
  const art = path.join(dirs.project, 'art');
  const swapIn = () => {
    fs.renameSync(art, `${art}-kept`);
    fs.symlinkSync(path.join(dirs.outside, 'art'), art);
  };
  const swapBack = () => {
    fs.unlinkSync(art);
    fs.renameSync(`${art}-kept`, art);
  };
  // The swap lands right after the path was resolved, so the recorded file
  // id is the outside file's; the open reads it, and the path is put back.
  let resolvedOnce = false;
  const realpath = (value) => {
    const real = fs.realpathSync.native(value);
    if (!resolvedOnce && value === target) {
      resolvedOnce = true;
      swapIn();
    }
    return real;
  };
  realpath.native = realpath;
  const swapping = {
    ...fs,
    constants: fs.constants,
    realpathSync: realpath,
    openSync: (file, flags) => {
      const fd = fs.openSync(file, flags);
      swapBack();
      return fd;
    },
  };
  const resolved = resolveImageInputs([target], { roots, isLiveConversation: () => true, platform: process.platform, fs: swapping }); // host-platform: /proc/self/fd on Linux
  assert.equal(resolved.ok, false);
  assert.match(resolved.error, /changed while it was read/);
  // Without any swap the same file reads fine.
  assert.equal(resolveImageInputs([target], { roots, isLiveConversation: () => true, platform: process.platform }).ok, true); // host-platform: as above
});
