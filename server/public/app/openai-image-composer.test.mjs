import test from 'node:test';
import assert from 'node:assert/strict';

import * as shared from '../../../shared/openai-image-options.mjs';
import * as sharedPreviews from '../../../shared/openai-image-previews.mjs';
import * as mirror from './openai-image-composer.mjs';

test('the browser copy of the image options matches shared/openai-image-options.mjs', () => {
  for (const name of [
    'OPENAI_IMAGE_PER_TURN_MAX',
    'OPENAI_IMAGE_LIMITS',
    'OPENAI_IMAGE_OPTION_KEYS',
    'OPENAI_IMAGE_OUTPUT_FORMATS',
    'OPENAI_IMAGE_BACKGROUNDS',
    'OPENAI_IMAGE_FAMILIES',
    'OPENAI_IMAGE_EXTENDED_QUALITIES',
  ]) {
    assert.deepEqual(mirror[name], shared[name], name);
  }
  const models = ['gpt-image-2', 'openai/gpt-image-1-mini', 'DALL-E-3', 'dall-e-2', 'gpt-4o', '',
    'gpt-image-2.5-flare', 'gpt-image-2.5-sunburst-2026-09-08', 'gpt-image-2.6-flare', 'gpt-image-2.7-flare', 'gpt-image-1.5', 'gpt-image-25'];
  for (const model of models) {
    assert.equal(mirror.openAIImageModelFamily(model), shared.openAIImageModelFamily(model), model);
    assert.deepEqual(mirror.openAIImageModelQualities(model), shared.openAIImageModelQualities(model), model);
    assert.equal(mirror.openAIImageModelHasPixelFloor(model), shared.openAIImageModelHasPixelFloor(model), model);
  }
  const sizes = ['auto', '1024x1024', '1536 × 1024', '2048x1152', '3840x2160', '3840x2176', '1000x1000',
    '4096x1024', '1024x3200', '1792x1024', '256x256', 'big', '', '0x16', '16x64'];
  for (const size of sizes) {
    assert.deepEqual(mirror.parseOpenAIImageSize(size), shared.parseOpenAIImageSize(size), size);
    for (const family of [null, 'gpt-image', 'dall-e-3', 'dall-e-2']) {
      assert.deepEqual(mirror.checkOpenAIImageSize(size, family), shared.checkOpenAIImageSize(size, family), `${size} ${family}`);
    }
    for (const model of ['gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-1']) {
      assert.deepEqual(mirror.checkOpenAIImageSize(size, 'gpt-image', { model }), shared.checkOpenAIImageSize(size, 'gpt-image', { model }), `${size} ${model}`);
    }
  }
  const inputs = [
    undefined,
    null,
    [],
    'x',
    { size: '1536x1024', quality: 'high', count: 2, output_format: 'webp', background: 'transparent' },
    { quality: 'xhigh' },
    { quality: 'max' },
    { size: '640x1008' },
    { size: '1024x640', quality: 'max' },
    { quality: 'hd' },
    { count: 5 },
    { count: true },
    { count: '3' },
    { output_format: 'jpeg', background: 'transparent' },
    { output_format: 'gif' },
    { colour: 'red' },
    { size: '', quality: null },
  ];
  for (const input of inputs) {
    for (const model of ['', 'gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.6-sunburst', 'gpt-image-1', 'dall-e-3', 'dall-e-2', 'gpt-4o']) {
      assert.deepEqual(
        mirror.validateOpenAIImageOptions(input, { model }),
        shared.validateOpenAIImageOptions(input, { model }),
        `${JSON.stringify(input)} ${model}`,
      );
    }
  }
});

test('the browser copy of the preview event names matches shared/openai-image-previews.mjs', () => {
  assert.equal(mirror.OPENAI_IMAGE_STARTED_EVENT, sharedPreviews.OPENAI_IMAGE_STARTED_EVENT);
  assert.equal(mirror.OPENAI_IMAGE_PREVIEW_EVENT, sharedPreviews.OPENAI_IMAGE_PREVIEW_EVENT);
  assert.equal(mirror.OPENAI_IMAGE_PREVIEW_RESET_EVENT, sharedPreviews.OPENAI_IMAGE_PREVIEW_RESET_EVENT);
  assert.deepEqual(mirror.OPENAI_IMAGE_PREVIEW_RESET_REASONS, sharedPreviews.OPENAI_IMAGE_PREVIEW_RESET_REASONS);
});

test('xhigh and max: offered and sent for the 2.5 and 2.6 models only; the size floor where it is typed', () => {
  assert.deepEqual(mirror.imageComposerChoices('gpt-image-2.5-flare').qualities, ['auto', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(mirror.imageComposerChoices('gpt-image-2').qualities, ['auto', 'low', 'medium', 'high']);
  // The catalog lists efforts up to high; the model's rules add the rest.
  assert.deepEqual(mirror.imageQualityOptions('gpt-image-2.6-flare', ['low', 'medium', 'high']), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(mirror.imageQualityOptions('gpt-image-2', ['low', 'medium', 'high']), ['low', 'medium', 'high']);
  // The send names an effort the catalog has; image.quality carries max.
  assert.equal(mirror.imageEffortForSend('gpt-image-2.5-flare', 'max'), 'high');
  assert.equal(mirror.imageEffortForSend('gpt-image-2.5-flare', 'medium'), 'medium');
  assert.equal(mirror.imageEffortForSend('gpt-5', 'max'), 'max');
  const built = mirror.buildImageSendOptions({ model: 'gpt-image-2.5-flare', size: '1024x1024', quality: 'max' });
  assert.equal(built.ok, true);
  assert.equal(built.image.quality, 'max');
  // gpt-image-2: max is no quality of its: left to the effort field, not sent as image.quality.
  assert.equal('quality' in mirror.buildImageSendOptions({ model: 'gpt-image-2', size: '1024x1024', quality: 'max' }).image, false);
  assert.deepEqual(mirror.checkCustomImageSize('640x1008', 'gpt-image-2'), { error: 'Size 640x1008: gpt-image-2 takes 655360 to 8294400 pixels, this is 645120' });
  assert.deepEqual(mirror.checkCustomImageSize('640x1008', 'gpt-image-1'), { size: '640x1008' });
  assert.deepEqual(mirror.checkCustomImageSize('1024x1024', 'gpt-image-2'), { size: '1024x1024' });
  // No size the composer offers falls under the floor.
  for (const size of mirror.GPT_IMAGE_SIZE_PRESETS.filter((entry) => entry !== 'auto')) {
    assert.deepEqual(mirror.checkCustomImageSize(size, 'gpt-image-2.5-flare'), { size }, size);
  }
});

test('imageComposerChoices lists each family\'s controls', () => {
  const gpt = mirror.imageComposerChoices('gpt-image-2');
  assert.deepEqual(gpt.sizes, ['auto', '1024x1024', '1536x1024', '1024x1536']);
  assert.equal(gpt.customSize, true);
  assert.deepEqual(gpt.qualities, ['auto', 'low', 'medium', 'high']);
  assert.equal(gpt.countMax, 4);
  assert.equal(gpt.showCount, true);
  assert.deepEqual(gpt.formats, ['png', 'webp', 'jpeg']);
  assert.deepEqual(gpt.backgrounds, ['auto', 'transparent', 'opaque']);

  const dalle3 = mirror.imageComposerChoices('dall-e-3');
  assert.deepEqual(dalle3.sizes, ['1024x1024', '1792x1024', '1024x1792']);
  assert.equal(dalle3.customSize, false);
  assert.equal(dalle3.countMax, 1);
  assert.equal(dalle3.showCount, false);
  assert.equal(dalle3.formats, null);
  assert.equal(dalle3.backgrounds, null);

  const dalle2 = mirror.imageComposerChoices('dall-e-2');
  assert.equal(dalle2.customSize, false);
  assert.equal(dalle2.showCount, true);

  assert.equal(mirror.imageComposerChoices('gpt-5'), null);
});

test('imageQualityOptions keeps the catalog values the family takes', () => {
  assert.deepEqual(mirror.imageQualityOptions('gpt-image-2', ['auto', 'low', 'medium', 'high', 'xhigh']), ['auto', 'low', 'medium', 'high']);
  assert.deepEqual(mirror.imageQualityOptions('dall-e-3', ['standard', 'hd']), ['standard', 'hd']);
  // Nothing matches: the catalog's list as it is (the relay decides).
  assert.deepEqual(mirror.imageQualityOptions('gpt-image-2', ['none']), ['none']);
  assert.deepEqual(mirror.imageQualityOptions('gpt-5', ['low', 'xhigh']), ['low', 'xhigh']);
});

test('checkCustomImageSize validates W×H for the model\'s family', () => {
  assert.deepEqual(mirror.checkCustomImageSize('2048x1152', 'gpt-image-2'), { size: '2048x1152' });
  assert.deepEqual(mirror.checkCustomImageSize(' 2048 × 1152 ', 'gpt-image-2'), { size: '2048x1152' });
  assert.match(mirror.checkCustomImageSize('2050x1152', 'gpt-image-2').error, /multiples of 16/);
  assert.match(mirror.checkCustomImageSize('4096x1024', 'gpt-image-2').error, /at most 3840/);
  assert.match(mirror.checkCustomImageSize('3840x2176', 'gpt-image-2').error, /pixels/);
  assert.match(mirror.checkCustomImageSize('3200x1024', 'gpt-image-2').error, /aspect ratio/);
  assert.match(mirror.checkCustomImageSize('', 'gpt-image-2').error, /WIDTHxHEIGHT/);
  assert.match(mirror.checkCustomImageSize('auto', 'gpt-image-2').error, /auto/);
  assert.match(mirror.checkCustomImageSize('wide', 'gpt-image-2').error, /WIDTHxHEIGHT/);
  assert.match(mirror.checkCustomImageSize('1024x1024', 'dall-e-3').error, /listed sizes/);
  assert.ok(mirror.checkCustomImageSize('1024x1024', 'gpt-5').error);
});

test('clampImageComposerValues drops what the model does not take', () => {
  const stored = { size: '2048x1152', count: 3, output_format: 'webp', background: 'transparent', at: 5 };
  assert.deepEqual(mirror.clampImageComposerValues(stored, 'gpt-image-2'), {
    size: '2048x1152', count: 3, output_format: 'webp', background: 'transparent',
  });
  assert.deepEqual(mirror.clampImageComposerValues(stored, 'dall-e-3'), {});
  assert.deepEqual(mirror.clampImageComposerValues({ size: '1792x1024', count: 1 }, 'dall-e-3'), { size: '1792x1024', count: 1 });
  assert.deepEqual(mirror.clampImageComposerValues({ count: 9, output_format: 'gif' }, 'gpt-image-2'), {});
  assert.deepEqual(mirror.clampImageComposerValues(stored, 'gpt-5'), {});
});

test('buildImageSendOptions builds the image field checked for the model', () => {
  assert.deepEqual(mirror.buildImageSendOptions({
    model: 'gpt-image-2', size: '2048x1152', quality: 'high', count: 2, outputFormat: 'webp', background: 'transparent',
  }), {
    ok: true,
    image: { size: '2048x1152', quality: 'high', count: 2, output_format: 'webp', background: 'transparent' },
    contextTier: '2048x1152',
  });
  assert.deepEqual(mirror.buildImageSendOptions({ model: 'gpt-image-2', size: 'auto', quality: 'auto' }), {
    ok: true, image: { size: 'auto', quality: 'auto', count: 1 }, contextTier: 'auto',
  });
  // dall-e-3: no format or background even when the hidden selects hold one.
  assert.deepEqual(mirror.buildImageSendOptions({
    model: 'dall-e-3', size: '1792x1024', quality: 'hd', count: 1, outputFormat: 'png', background: 'auto',
  }), { ok: true, image: { size: '1792x1024', quality: 'hd', count: 1 }, contextTier: '1792x1024' });
  // A quality the family does not take stays with the effort field.
  assert.deepEqual(mirror.buildImageSendOptions({ model: 'gpt-image-2', size: 'auto', quality: 'xhigh' }).image, { size: 'auto', count: 1 });

  const custom = mirror.buildImageSendOptions({ model: 'gpt-image-2', size: mirror.IMAGE_SIZE_CUSTOM_VALUE, quality: 'high' });
  assert.equal(custom.ok, false);
  assert.equal(custom.field, 'size');
  // A send while the field holds a size that parses but is no multiple of 16
  // (the e2e's own input): that reason, not the generic hint.
  const typedBad = mirror.buildImageSendOptions({ model: 'gpt-image-2', size: mirror.IMAGE_SIZE_CUSTOM_VALUE, customText: '1000x1000' });
  assert.deepEqual(typedBad, { ok: false, field: 'size', error: 'Size 1000x1000: both edges must be multiples of 16' });
  assert.deepEqual(mirror.checkCustomImageSize('1000x1000', 'gpt-image-2'), { error: 'Size 1000x1000: both edges must be multiples of 16' });
  // A valid typed size (the select not caught up yet) is sent as it is.
  const typedGood = mirror.buildImageSendOptions({ model: 'gpt-image-2', size: mirror.IMAGE_SIZE_CUSTOM_VALUE, customText: ' 1536X512 ' });
  assert.equal(typedGood.ok, true);
  assert.equal(typedGood.contextTier, '1536x512');
  assert.match(mirror.buildImageSendOptions({ model: 'gpt-image-2', size: mirror.IMAGE_SIZE_CUSTOM_VALUE, customText: '' }).error, /^Enter a custom image size/);
  const badSize = mirror.buildImageSendOptions({ model: 'gpt-image-2', size: '2000x1000' });
  assert.equal(badSize.ok, false);
  assert.equal(badSize.field, 'size');
  assert.match(badSize.error, /multiples of 16/);
  const jpegTransparent = mirror.buildImageSendOptions({ model: 'gpt-image-2', size: 'auto', outputFormat: 'jpeg', background: 'transparent' });
  assert.equal(jpegTransparent.ok, false);
  assert.equal(jpegTransparent.field, 'image');
  assert.equal(mirror.buildImageSendOptions({ model: 'gpt-image-2', size: 'auto', count: 5 }).ok, false);
  assert.equal(mirror.buildImageSendOptions({ model: 'gpt-5', size: 'auto' }).ok, false);
  // A picked preset goes along by name, the fields with it.
  assert.deepEqual(mirror.buildImageSendOptions({ model: 'gpt-image-2', size: 'auto', quality: 'high', preset: '  Wallpaper   4K ' }), {
    ok: true, image: { size: 'auto', quality: 'high', count: 1, preset: 'Wallpaper 4K' }, contextTier: 'auto',
  });
  assert.equal(mirror.buildImageSendOptions({ model: 'gpt-image-2', size: 'auto', preset: '' }).image.preset, undefined);
});

test('the per-conversation store merges, drops empties and keeps the newest entries', () => {
  assert.deepEqual(mirror.parseImageComposerStore('nope'), {});
  assert.deepEqual(mirror.parseImageComposerStore('[1]'), {});
  let store = mirror.updateImageComposerStore({}, 'conv-a', { size: '2048x1152', count: 2, junk: 1 }, 10);
  assert.deepEqual(store, { 'conv-a': { size: '2048x1152', count: 2, at: 10 } });
  store = mirror.updateImageComposerStore(store, 'conv-a', { count: '', output_format: 'webp' }, 11);
  assert.deepEqual(store['conv-a'], { size: '2048x1152', output_format: 'webp', at: 11 });
  store = mirror.updateImageComposerStore(store, 'conv-a', { preset: 'Sticker' }, 12);
  assert.equal(store['conv-a'].preset, 'Sticker');
  store = mirror.updateImageComposerStore(store, 'conv-a', { preset: '' }, 13);
  assert.equal(store['conv-a'].preset, undefined);
  assert.deepEqual(mirror.updateImageComposerStore(store, '', { size: 'auto' }), store);
  let big = {};
  for (let index = 0; index < mirror.IMAGE_COMPOSER_STORE_MAX + 5; index += 1) {
    big = mirror.updateImageComposerStore(big, `conv-${index}`, { count: 1 }, index);
  }
  assert.equal(Object.keys(big).length, mirror.IMAGE_COMPOSER_STORE_MAX);
  assert.equal(big['conv-0'], undefined);
  assert.ok(big[`conv-${mirror.IMAGE_COMPOSER_STORE_MAX + 4}`]);
});

test('placeholder helpers: elapsed time, aspect ratio, details line, preview address', () => {
  assert.equal(mirror.formatImageElapsed(0), '0:00');
  assert.equal(mirror.formatImageElapsed(-5000), '0:00');
  assert.equal(mirror.formatImageElapsed(65_999), '1:05');
  assert.equal(mirror.formatImageElapsed(10 * 60_000 + 7_000), '10:07');
  assert.equal(mirror.imageAspectRatio('1536x1024'), '1536 / 1024');
  assert.equal(mirror.imageAspectRatio('auto'), '1 / 1');
  assert.equal(mirror.imagePlaceholderDetails({ size: '1536x1024', quality: 'high', count: 2, model: 'gpt-image-2' }),
    '1536x1024 · high · 2 images · gpt-image-2');
  assert.equal(mirror.imagePlaceholderDetails({ size: 'auto', quality: 'auto', count: 1, model: 'gpt-image-2' }),
    'auto size · auto quality · gpt-image-2');
  assert.equal(mirror.resolveImagePreviewUrl('/api/files/p.png', ''), '/api/files/p.png');
  assert.equal(mirror.resolveImagePreviewUrl('/api/files/p.png', '/relay'), '/relay/api/files/p.png');
  assert.equal(mirror.resolveImagePreviewUrl('/relay/api/files/p.png', '/relay'), '/relay/api/files/p.png');
  assert.equal(mirror.resolveImagePreviewUrl('https://example.test/p.png'), 'https://example.test/p.png');
  assert.equal(mirror.resolveImagePreviewUrl('javascript:alert(1)'), '');
  assert.equal(mirror.resolveImagePreviewUrl('//example.test/p.png'), '');
  assert.equal(mirror.resolveImagePreviewUrl('p.png'), '');
});

test('reduceImageTurnState follows started, preview and reset events', () => {
  const ids = { conversationId: 'conv-a', messageId: 'msg-1' };
  const startedAt = '2026-01-02T03:04:05.000Z';
  let state = mirror.reduceImageTurnState(null, 'started', {
    ...ids, attempt: 1, size: '1536x1024', quality: 'high', count: 2, model: 'gpt-image-2', startedAt,
  });
  assert.equal(state.startedAtMs, Date.parse(startedAt));
  assert.equal(state.count, 2);
  assert.deepEqual(state.partials, {});

  state = mirror.reduceImageTurnState(state, 'preview', { ...ids, attempt: 1, imageIndex: 1, partialIndex: 0, contentUrl: '/p/1-0.png' });
  state = mirror.reduceImageTurnState(state, 'preview', { ...ids, attempt: 1, imageIndex: 1, partialIndex: 1, contentUrl: '/p/1-1.png' });
  // An older partial arriving late does not replace a newer one.
  state = mirror.reduceImageTurnState(state, 'preview', { ...ids, attempt: 1, imageIndex: 1, partialIndex: 0, contentUrl: '/p/1-0.png' });
  assert.deepEqual(state.partials, { 1: { partialIndex: 1, url: '/p/1-1.png' } });
  // A refused address is not shown.
  state = mirror.reduceImageTurnState(state, 'preview', { ...ids, attempt: 1, imageIndex: 0, partialIndex: 0, contentUrl: 'javascript:x' });
  assert.equal(state.partials[0], undefined);

  state = mirror.reduceImageTurnState(state, 'reset', { ...ids, attempt: 1, reason: 'retry' });
  assert.equal(state.retrying, true);
  assert.deepEqual(state.partials, {});
  assert.equal(state.startedAtMs, Date.parse(startedAt));
  // The reset names the try whose previews went: its late partials stay away.
  assert.equal(state.attempt, 2);
  state = mirror.reduceImageTurnState(state, 'preview', { ...ids, attempt: 1, imageIndex: 0, partialIndex: 1, contentUrl: '/p/late.png' });
  assert.deepEqual(state.partials, {});
  state = mirror.reduceImageTurnState(state, 'started', { ...ids, attempt: 2, startedAt });
  assert.equal(state.attempt, 2);
  assert.equal(state.retrying, true);
  // A late partial of the first try is ignored.
  state = mirror.reduceImageTurnState(state, 'preview', { ...ids, attempt: 1, imageIndex: 0, partialIndex: 1, contentUrl: '/p/old.png' });
  assert.deepEqual(state.partials, {});
  state = mirror.reduceImageTurnState(state, 'preview', { ...ids, attempt: 2, imageIndex: 0, partialIndex: 0, contentUrl: '/p/new.png' });
  assert.equal(state.retrying, false);
  assert.equal(state.partials[0].url, '/p/new.png');

  assert.equal(mirror.reduceImageTurnState(state, 'reset', { ...ids, attempt: 2, reason: 'done' }), null);
  assert.equal(mirror.reduceImageTurnState(state, 'reset', { ...ids, attempt: 2, reason: 'failed' }), null);
  // A preview with no started event before it still makes a placeholder.
  const bare = mirror.reduceImageTurnState(null, 'preview', { ...ids, imageIndex: 0, partialIndex: 0, contentUrl: '/p/x.png' }, { now: 1000 });
  assert.equal(bare.startedAtMs, 1000);
  assert.equal(bare.partials[0].url, '/p/x.png');
  // Another turn replaces the state.
  const other = mirror.reduceImageTurnState(state, 'started', { conversationId: 'conv-a', messageId: 'msg-2', startedAt });
  assert.equal(other.messageId, 'msg-2');
  assert.deepEqual(other.partials, {});
});
