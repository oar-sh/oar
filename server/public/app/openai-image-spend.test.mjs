import test from 'node:test';
import assert from 'node:assert/strict';

import * as sharedSpend from '../../../shared/openai-image-spend.mjs';
import * as sharedPresets from '../../../shared/openai-image-presets.mjs';
import * as spend from './openai-image-spend.mjs';

test('the browser copy matches shared/openai-image-spend.mjs', () => {
  for (const name of [
    'OPENAI_IMAGE_DAILY_CAP_DEFAULT_USD',
    'OPENAI_IMAGE_CAP_WARN_RATIO',
    'OPENAI_IMAGE_DAILY_CAP_REACHED_CODE',
    'OPENAI_IMAGE_USAGE_PATH',
    'OPENAI_IMAGE_USAGE_EVENT',
    'OPENAI_IMAGE_SETTINGS_FIELDS',
    'OPENAI_IMAGE_PRESETS_PATH',
  ]) {
    assert.deepEqual(spend[name], sharedSpend[name], name);
  }
  for (const value of [0, 0.004, 0.0099, 0.01, 1.2, 5, 12.345, -1, 'x', null, undefined, Infinity]) {
    assert.equal(spend.formatOpenAIImageUsd(value), sharedSpend.formatOpenAIImageUsd(value), String(value));
  }
});

test('the browser copy matches shared/openai-image-presets.mjs', () => {
  for (const name of ['OPENAI_IMAGE_PRESET_LIMITS', 'OPENAI_IMAGE_PRESET_REFUSED_CODE', 'OPENAI_IMAGE_BUILTIN_PRESETS']) {
    assert.deepEqual(spend[name], sharedPresets[name], name);
  }
  const names = [
    'Sticker', '  my   preset ', '', '   ', 4, null, 'a'.repeat(40), 'a'.repeat(41), 'tab\there', 'zero​width',
    'soft­hyphen', 'bom﻿', 'rtl‮flip', 'Café', 'Wallpaper 4K', 'emoji 🎨 set', '.', '..', ' ... ', 'v1.5',
  ];
  for (const name of names) {
    assert.deepEqual(spend.cleanOpenAIImagePresetName(name), sharedPresets.cleanOpenAIImagePresetName(name), JSON.stringify(name));
    assert.equal(spend.openAIImagePresetKey(name), sharedPresets.openAIImagePresetKey(name), JSON.stringify(name));
  }
});

const STATE = {
  day: '2026-11-08',
  capUsd: 5,
  spentUsd: 1.1,
  reservedUsd: 0.1,
  estimatedUsd: 0.2,
  unknownPriceUsd: 0,
  monthUsd: 7.8,
  ratio: 0.24,
  warning: false,
  reached: false,
  allowedToday: false,
  allowedAt: null,
};

test('the spend state is read with numbers, and no cap means no warning', () => {
  assert.equal(spend.normalizeImageSpendState(null), null);
  assert.equal(spend.normalizeImageSpendState([]), null);
  const state = spend.normalizeImageSpendState({ ...STATE, spentUsd: '1.1', conversation: { costUsd: '0.42', estimatedUsd: 0, images: 3.7, tries: 4 } });
  assert.equal(state.spentUsd, 1.1);
  assert.deepEqual(state.conversation, { costUsd: 0.42, estimatedUsd: 0, images: 3, tries: 4 });
  const uncapped = spend.normalizeImageSpendState({ ...STATE, capUsd: null, warning: true, reached: true, ratio: 2 });
  assert.equal(uncapped.capUsd, null);
  assert.equal(uncapped.warning, false);
  assert.equal(uncapped.reached, false);
  assert.equal(uncapped.ratio, null);
});

test('the settings line: today against the cap, in flight, the month, the override', () => {
  const state = spend.normalizeImageSpendState(STATE);
  assert.equal(spend.imageSpendSettingsLine(state), 'Today USD 1.20 of 5.00 · USD 0.10 of it in flight · this month USD 7.80');
  assert.equal(
    spend.imageSpendSettingsLine(spend.normalizeImageSpendState({ ...STATE, reservedUsd: 0, capUsd: 0 })),
    'Today USD 1.10 (no cap) · this month USD 7.80',
  );
  assert.equal(
    spend.imageSpendSettingsLine(spend.normalizeImageSpendState({ ...STATE, reservedUsd: 0, spentUsd: 5, reached: true })),
    'Today USD 5.00 of 5.00 · this month USD 7.80 · cap reached',
  );
  assert.match(
    spend.imageSpendSettingsLine(spend.normalizeImageSpendState({ ...STATE, reached: true, allowedToday: true, allowedAt: 'nonsense' })),
    / · allowed past the cap today$/,
  );
  assert.doesNotMatch(spend.imageSpendSettingsLine(state), /\$/);
});

test('the banner: warning from 80 %, reached until allowed, nothing without a cap', () => {
  assert.equal(spend.imageSpendBanner(spend.normalizeImageSpendState(STATE)), null);
  const warning = spend.imageSpendBanner(spend.normalizeImageSpendState({ ...STATE, spentUsd: 4, reservedUsd: 0.1, warning: true }));
  assert.deepEqual(warning, { kind: 'warning', text: "Today's OpenAI image spend: USD 4.10 of 5.00" });
  const reached = spend.imageSpendBanner(spend.normalizeImageSpendState({ ...STATE, spentUsd: 5, warning: true, reached: true }));
  assert.equal(reached.kind, 'reached');
  assert.equal(reached.text, 'Daily image cap reached: image turns are refused until tomorrow (relay time) or until you allow more today in Settings → Providers → OpenAI');
  const allowed = spend.imageSpendBanner(spend.normalizeImageSpendState({ ...STATE, spentUsd: 5.2, reservedUsd: 0, warning: true, reached: true, allowedToday: true }));
  assert.deepEqual(allowed, { kind: 'warning', text: "Today's OpenAI image spend: USD 5.20 of 5.00 (allowed past the cap today)" });
  assert.equal(spend.imageSpendBanner(spend.normalizeImageSpendState({ ...STATE, capUsd: null, warning: true })), null);
});

test('the chat menu line names the images and the estimate', () => {
  assert.equal(spend.imageChatCostText({ costUsd: 0.42, estimatedUsd: 0, images: 3 }), 'OpenAI images: USD 0.42 in this chat (3 images)');
  assert.equal(spend.imageChatCostText({ costUsd: 0.04, estimatedUsd: 0.04, images: 1 }), 'OpenAI images: USD 0.04 in this chat (1 image, USD 0.04 of it estimated)');
  assert.equal(spend.imageChatCostText({ costUsd: 0, images: 0 }), 'OpenAI images: USD 0.00 in this chat (0 images)');
  assert.equal(spend.imageChatCostText(null), '');
});

test('the override buttons follow the cap, the reached state and the override', () => {
  const at = (patch) => spend.imageSpendOverrideButtons(spend.normalizeImageSpendState({ ...STATE, ...patch }));
  assert.deepEqual(at({}), { allow: { shown: true, label: 'Allow past the cap for today' }, stop: { shown: false } });
  assert.deepEqual(at({ reached: true }), { allow: { shown: true, label: 'Allow for today' }, stop: { shown: false } });
  assert.deepEqual(at({ reached: true, allowedToday: true }), { allow: { shown: false, label: '' }, stop: { shown: true } });
  assert.deepEqual(at({ capUsd: null }), { allow: { shown: false, label: '' }, stop: { shown: false } });
  assert.deepEqual(spend.imageSpendOverrideButtons(null).allow.shown, false);
});

test('the cap field: the default when unset, 0 for no cap, amounts with two decimals', () => {
  assert.equal(spend.imageCapInputText(undefined), '5');
  assert.equal(spend.imageCapInputText(null), '0');
  assert.equal(spend.imageCapInputText(0), '0');
  assert.equal(spend.imageCapInputText(12.5), '12.5');
  assert.deepEqual(spend.parseImageCapInput(' 7.25 '), { ok: true, capUsd: 7.25 });
  assert.deepEqual(spend.parseImageCapInput('0'), { ok: true, capUsd: 0 });
  assert.deepEqual(spend.parseImageCapInput('10000'), { ok: true, capUsd: 10000 });
  for (const bad of ['', '-1', '1.234', 'abc', '01', '1e3', '10000.01', '10000000']) {
    assert.equal(spend.parseImageCapInput(bad).ok, false, bad);
  }
});

test('presets: listed built-ins first, described, found by any spelling', () => {
  const fallback = spend.normalizeImagePresets(null);
  assert.equal(fallback.length, spend.OPENAI_IMAGE_BUILTIN_PRESETS.length);
  assert.ok(fallback.every((preset) => preset.builtIn));
  const list = spend.normalizeImagePresets({
    presets: [
      { name: 'Mine', size: '2048x1152', quality: 'high', count: 2, builtIn: false, extra: 'x' },
      { name: 'Sticker', size: '1024x1024', quality: 'medium', output_format: 'png', background: 'transparent', builtIn: true },
      { name: 'mine', size: '1024x1024' },
      { name: '' },
      null,
    ],
  });
  assert.deepEqual(list.map((preset) => preset.name), ['Sticker', 'Mine']);
  assert.equal(list[1].extra, undefined);
  assert.equal(spend.describeImagePreset(list[0]), '1024x1024 · medium · PNG · transparent background');
  assert.equal(spend.describeImagePreset(list[1]), '2048x1152 · high · 2 images');
  assert.equal(spend.findImagePreset(list, '  MINE ')?.name, 'Mine');
  assert.equal(spend.findImagePreset(list, 'nope'), null);
});

test('a preset fills what the model takes and names what it skips', () => {
  const sticker = spend.OPENAI_IMAGE_BUILTIN_PRESETS.find((preset) => preset.name === 'Sticker');
  assert.deepEqual(
    spend.imagePresetComposerValues(sticker, 'gpt-image-2', { qualities: ['low', 'medium', 'high'] }),
    { values: { size: '1024x1024', quality: 'medium', output_format: 'png', background: 'transparent' }, skipped: [] },
  );
  // dall-e-3: a fixed size list, no formats.
  const landscape = { name: 'L', size: '1536x1024', quality: 'medium', output_format: 'webp' };
  assert.deepEqual(spend.imagePresetComposerValues(landscape, 'dall-e-3'), {
    values: {},
    skipped: ['size 1536x1024', 'quality medium', 'format webp'],
  });
  // A quality the Quality select does not offer stays as it is.
  assert.deepEqual(
    spend.imagePresetComposerValues({ name: 'Q', quality: 'high', count: 3 }, 'gpt-image-2', { qualities: ['low'] }),
    { values: { count: 3 }, skipped: ['quality high'] },
  );
  // Transparent with JPEG on screen: PNG goes with it.
  assert.deepEqual(
    spend.imagePresetComposerValues({ name: 'T', background: 'transparent' }, 'gpt-image-2', { currentFormat: 'jpeg' }).values,
    { background: 'transparent', output_format: 'png' },
  );
  assert.deepEqual(spend.imagePresetComposerValues(sticker, 'gpt-5'), { values: {}, skipped: [] });
});

test('a preset to save: a clean own name and the composer values', () => {
  assert.deepEqual(
    spend.buildImagePresetToSave('  Night   shots ', { size: '2048x1152', quality: 'high', count: 1 }),
    { ok: true, preset: { name: 'Night shots', size: '2048x1152', quality: 'high', count: 1 } },
  );
  assert.match(spend.buildImagePresetToSave('sticker', { size: '1024x1024' }).error, /built-in/);
  assert.match(spend.buildImagePresetToSave('', { size: '1024x1024' }).error, /^A preset name may not be empty\.$/);
  assert.equal(spend.buildImagePresetToSave('x', {}).ok, false);
  assert.equal(spend.isImagePresetExistsRefusal(new Error('a preset "Mine" exists; save with replace to change it')), true);
  assert.equal(spend.isImagePresetExistsRefusal('at most 30 own presets'), false);
  // The relay's own rule agrees with the client's check.
  const own = sharedPresets.validateOwnOpenAIImagePreset(spend.buildImagePresetToSave('Night', { size: '2048x1152', quality: 'high' }).preset);
  assert.equal(own.ok, true);
});

test('the Check Usage pieces: today against the cap with the 80 % mark, the shares named', () => {
  const state = spend.normalizeImageSpendState({ ...STATE, unknownPriceUsd: 0.05 });
  const meter = spend.renderImageUsageMeterHtml(state);
  assert.match(meter, /data-meter-id="openai-images-daily-cap"/);
  assert.match(meter, /USD 1\.20 of 5\.00 · resets at midnight \(relay time\)/);
  assert.match(meter, /class="plan-usage-bar-mark" style="left:80%"/);
  assert.match(meter, /width:24\.0%/);
  assert.match(meter, /estimated<\/span>/);
  assert.doesNotMatch(meter, /\$/);
  const facts = spend.imageUsageCardFacts(state);
  assert.deepEqual(facts.map((fact) => fact.label), ['This month', 'Daily cap', 'In progress', 'Estimated', 'Unknown price', 'Past the cap today']);
  assert.equal(facts.find((fact) => fact.label === 'Past the cap today').value, 'Not allowed');
  const uncapped = spend.normalizeImageSpendState({ ...STATE, capUsd: null });
  assert.doesNotMatch(spend.renderImageUsageMeterHtml(uncapped), /plan-usage-bar-mark/);
  assert.match(spend.renderImageUsageMeterHtml(uncapped), /USD 1\.20 today · no cap/);
  assert.equal(spend.imageUsageCardMessage(uncapped), 'No daily cap is set for OpenAI images on this relay.');
  assert.equal(spend.imageUsageBadgesHtml(state), '');
  const reached = spend.normalizeImageSpendState({ ...STATE, spentUsd: 5, reached: true, warning: true });
  assert.match(spend.imageUsageBadgesHtml(reached), /Cap reached/);
  assert.match(spend.imageUsageCardMessage(reached), /^Daily image cap reached/);
  const allowed = spend.normalizeImageSpendState({ ...STATE, spentUsd: 5, reached: true, allowedToday: true });
  assert.match(spend.imageUsageBadgesHtml(allowed), /Allowed today/);
  assert.match(spend.imageUsageCardMessage(allowed), /run anyway/);
  assert.equal(spend.renderImageUsageMeterHtml(null), '');
});

test('the presets event and the cap\'s top are the relay\'s', async () => {
  const { readFile } = await import('node:fs/promises');
  const routes = await readFile(new URL('../../routes/sessions-routes.mjs', import.meta.url), 'utf8');
  assert.match(routes, new RegExp(`io\\.emit\\('${spend.OPENAI_IMAGE_PRESETS_EVENT}'`));
  assert.match(routes, /export const OPENAI_IMAGE_DAILY_CAP_MAX_USD = 10_000;/);
  assert.equal(spend.OPENAI_IMAGE_DAILY_CAP_MAX_USD, 10_000);
});
