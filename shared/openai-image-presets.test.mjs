import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OPENAI_IMAGE_BUILTIN_PRESETS,
  OPENAI_IMAGE_PRESET_LIMITS,
  applyOwnOpenAIImagePresetChange,
  cleanOpenAIImagePresetName,
  findOpenAIImagePreset,
  listOpenAIImagePresets,
  openAIImagePresetKey,
  parseOwnOpenAIImagePresets,
  splitOpenAIImagePreset,
  validateOwnOpenAIImagePreset,
} from './openai-image-presets.mjs';
import { validateOpenAIImageOptions } from './openai-image-options.mjs';

test('the built-ins pass the validator for a gpt-image model', () => {
  assert.deepEqual(OPENAI_IMAGE_BUILTIN_PRESETS.map((preset) => preset.name), ['Draft square', 'Photo landscape', 'Portrait', 'Wallpaper 4K', 'Sticker']);
  for (const { name, ...values } of OPENAI_IMAGE_BUILTIN_PRESETS) {
    assert.equal(validateOpenAIImageOptions(values, { model: 'gpt-image-2' }).ok, true, name);
  }
});

test('one name key: NFC, trimmed, single spaces, lower case; hidden characters refused', () => {
  assert.equal(cleanOpenAIImagePresetName('  Café   poster ').name, 'Café poster');
  assert.equal(openAIImagePresetKey('CAFÉ  Poster'), openAIImagePresetKey('café poster'));
  assert.match(cleanOpenAIImagePresetName('a​b').error, /invisible/);
  assert.match(cleanOpenAIImagePresetName('a\nb').error, /control/);
  assert.match(cleanOpenAIImagePresetName('   ').error, /empty/);
  for (const name of ['.', '..', ' ... ']) assert.match(cleanOpenAIImagePresetName(name).error, /dots alone/, name);
  assert.equal(cleanOpenAIImagePresetName('v1.5').name, 'v1.5');
  assert.match(validateOwnOpenAIImagePreset({ name: '..', size: '1024x1024' }).error, /dots alone/);
  assert.match(cleanOpenAIImagePresetName('x'.repeat(OPENAI_IMAGE_PRESET_LIMITS.nameChars + 1)).error, /at most 40/);
  assert.equal(openAIImagePresetKey(7), '');
});

test('own presets: a built-in name, no options or a bad option are refused', () => {
  assert.match(validateOwnOpenAIImagePreset({ name: ' sticker ', size: '1024x1024' }).error, /built-in/);
  assert.match(validateOwnOpenAIImagePreset({ name: 'Bare' }).error, /at least one/);
  assert.match(validateOwnOpenAIImagePreset({ name: 'Odd', size: '1000x1000' }).error, /multiples of 16/);
  assert.match(validateOwnOpenAIImagePreset({ name: 'Extra', size: '1024x1024', seed: 1 }).error, /does not take: seed/);
  assert.deepEqual(validateOwnOpenAIImagePreset({ name: 'Banner', size: '1536X512', quality: 'High' }), { ok: true, preset: { name: 'Banner', size: '1536x512', quality: 'high' } });
});

test('changes: add, replace only when asked, delete; limits', () => {
  let list = [];
  ({ presets: list } = applyOwnOpenAIImagePresetChange(list, { op: 'put', preset: { name: 'Banner', size: '1536x512' } }));
  assert.match(applyOwnOpenAIImagePresetChange(list, { op: 'put', preset: { name: 'banner', size: '1024x1024' } }).error, /save with replace/);
  ({ presets: list } = applyOwnOpenAIImagePresetChange(list, { op: 'put', preset: { name: 'BANNER', size: '1024x1024' }, replace: true }));
  assert.deepEqual(list, [{ name: 'BANNER', size: '1024x1024' }]);
  assert.match(applyOwnOpenAIImagePresetChange(list, { op: 'delete', name: 'Sticker' }).error, /built-in/);
  assert.match(applyOwnOpenAIImagePresetChange(list, { op: 'delete', name: 'nope' }).error, /no own preset/);
  assert.deepEqual(applyOwnOpenAIImagePresetChange(list, { op: 'delete', name: ' banner ' }).presets, []);
  const full = Array.from({ length: OPENAI_IMAGE_PRESET_LIMITS.ownMax }, (_, index) => ({ name: `P${index}`, quality: 'low' }));
  assert.match(applyOwnOpenAIImagePresetChange(full, { op: 'put', preset: { name: 'One more', quality: 'low' } }).error, /at most 30/);
});

test('stored presets are read back checked; lookup by key; precedence is the caller\'s', () => {
  const own = parseOwnOpenAIImagePresets(JSON.stringify([{ name: 'Banner', size: '1536x512' }, { name: 'banner', size: '1024x1024' }, { name: 'Sticker', quality: 'low' }, 'junk']));
  assert.deepEqual(own, [{ name: 'Banner', size: '1536x512' }]);
  assert.deepEqual(parseOwnOpenAIImagePresets('not json'), []);
  assert.deepEqual(findOpenAIImagePreset(' wallpaper  4k ', own), { ok: true, values: { size: '3840x2160', quality: 'high' }, name: 'Wallpaper 4K' });
  assert.deepEqual(findOpenAIImagePreset('BANNER', own).values, { size: '1536x512' });
  assert.match(findOpenAIImagePreset('Poster', own).error, /no image preset "Poster" here; presets: Draft square, .*Banner$/);
  assert.deepEqual(findOpenAIImagePreset('', own), { ok: true, values: {} });
  assert.equal(listOpenAIImagePresets(own).filter((preset) => preset.builtIn).length, 5);
  assert.deepEqual(splitOpenAIImagePreset({ preset: 'Sticker', quality: 'high' }), { preset: 'Sticker', own: { quality: 'high' } });
  assert.deepEqual(splitOpenAIImagePreset(null), { preset: null, own: null });
});
