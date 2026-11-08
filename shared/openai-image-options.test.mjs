import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OPENAI_IMAGE_LIMITS,
  OPENAI_IMAGE_MODEL_NEEDS_OPENAI_CODE,
  checkOpenAIImageSize,
  formatOpenAIImageSummary,
  isOpenAIImageModelId,
  mergeOpenAIImageOptions,
  openAIImageModelHasPixelFloor,
  openAIImageModelQualities,
  openAIImageModelFamily,
  openAIImageModelNeedsOpenAIText,
  OPENAI_IMAGE_DEFAULT_MODELS,
  OPENAI_IMAGE_NO_MODEL_CODE,
  openAIImageNoModelText,
  pickOpenAIImageDefaultModel,
  parseOpenAIImageSize,
  validateOpenAIImageOptions,
} from './openai-image-options.mjs';

test('model families', () => {
  assert.equal(openAIImageModelFamily('gpt-image-1'), 'gpt-image');
  assert.equal(openAIImageModelFamily('openai/GPT-Image-2'), 'gpt-image');
  assert.equal(openAIImageModelFamily('dall-e-3'), 'dall-e-3');
  assert.equal(openAIImageModelFamily('dall-e-2'), 'dall-e-2');
  assert.equal(openAIImageModelFamily('gpt-5.4-mini'), null);
  assert.equal(isOpenAIImageModelId('gpt-image-1-mini'), true);
  assert.equal(isOpenAIImageModelId('gpt-4o'), false);
});

test('a Copilot chat on an image model: one code, a pointer to OpenAI Image', () => {
  assert.equal(OPENAI_IMAGE_MODEL_NEEDS_OPENAI_CODE, 'IMAGE_MODEL_NEEDS_OPENAI');
  assert.equal(openAIImageModelNeedsOpenAIText(' gpt-image-1 '), '"gpt-image-1" makes images: start an OpenAI Image chat (provider openai) for it.');
});

test('the default model of a new image session: a fixed order, then the first gpt-image listed', () => {
  // A newer model the list offers is not picked over the default.
  const listed = ['gpt-4o', 'gpt-image-2.6-flare', 'gpt-image-2.6-sunburst', 'gpt-image-2.5-flare-2026-09-08', 'gpt-image-2.5-flare', 'gpt-image-2', 'gpt-image-1'];
  assert.equal(pickOpenAIImageDefaultModel(listed), 'gpt-image-2.5-flare');
  assert.equal(pickOpenAIImageDefaultModel(listed.filter((id) => id !== 'gpt-image-2.5-flare')), 'gpt-image-2.5-flare-2026-09-08');
  assert.equal(pickOpenAIImageDefaultModel(['gpt-image-2.6-flare', 'gpt-image-2', 'gpt-image-1']), 'gpt-image-2');
  assert.equal(pickOpenAIImageDefaultModel(['gpt-4o', 'gpt-image-1-mini', 'gpt-image-2.6-flare']), 'gpt-image-1-mini', 'else the first gpt-image in the list');
  assert.equal(pickOpenAIImageDefaultModel(['openai/GPT-Image-2.5-Flare']), 'openai/GPT-Image-2.5-Flare', 'in the list\'s casing');
  assert.equal(pickOpenAIImageDefaultModel(['gpt-4o', 'dall-e-3']), '', 'dall-e is never picked');
  assert.equal(pickOpenAIImageDefaultModel(), '');
  assert.deepEqual([...OPENAI_IMAGE_DEFAULT_MODELS], ['gpt-image-2.5-flare', 'gpt-image-2.5-flare-2026-09-08', 'gpt-image-2']);
  assert.equal(OPENAI_IMAGE_NO_MODEL_CODE, 'OPENAI_IMAGE_NO_MODEL');
  assert.match(openAIImageNoModelText(), /no gpt-image model/);
});

test('sizes: parse forms', () => {
  assert.deepEqual(parseOpenAIImageSize('1536x1024'), { width: 1536, height: 1024 });
  assert.deepEqual(parseOpenAIImageSize(' 1024 × 1536 '), { width: 1024, height: 1536 });
  assert.deepEqual(parseOpenAIImageSize('1024X1024'), { width: 1024, height: 1024 });
  assert.equal(parseOpenAIImageSize('0x1024'), null);
  assert.equal(parseOpenAIImageSize('1024'), null);
  assert.equal(parseOpenAIImageSize('-16x16'), null);
});

test('gpt-image sizes: multiples of 16, edge, area and aspect limits', () => {
  assert.deepEqual(checkOpenAIImageSize('auto', 'gpt-image'), { size: 'auto' });
  assert.deepEqual(checkOpenAIImageSize('3840x2160', 'gpt-image'), { size: '3840x2160' });
  assert.deepEqual(checkOpenAIImageSize('2160x3840', 'gpt-image'), { size: '2160x3840' });
  assert.deepEqual(checkOpenAIImageSize('1536x512', 'gpt-image'), { size: '1536x512' }, '3:1 exactly');
  assert.match(checkOpenAIImageSize('1552x512', 'gpt-image').error, /aspect/);
  assert.match(checkOpenAIImageSize('1000x1000', 'gpt-image').error, /multiples of 16/);
  assert.match(checkOpenAIImageSize('3856x1024', 'gpt-image').error, /longer edge/);
  assert.match(checkOpenAIImageSize('3840x2176', 'gpt-image').error, /pixels/);
  assert.match(checkOpenAIImageSize('big', 'gpt-image').error, /WIDTHxHEIGHT/);
});

test('dall-e keep their fixed lists; without a model a dall-e entry passes', () => {
  assert.deepEqual(checkOpenAIImageSize('1792x1024', 'dall-e-3'), { size: '1792x1024' });
  assert.match(checkOpenAIImageSize('1536x1024', 'dall-e-3').error, /1024x1024, 1792x1024, 1024x1792/);
  assert.deepEqual(checkOpenAIImageSize('256x256', 'dall-e-2'), { size: '256x256' });
  assert.match(checkOpenAIImageSize('1792x1024', 'dall-e-2').error, /one of/);
  assert.deepEqual(checkOpenAIImageSize('auto', 'dall-e-3'), { size: 'auto' });
  // 1792 is a multiple of 16 anyway; 1000-wide lists do not exist.
  assert.deepEqual(checkOpenAIImageSize('1792x1024'), { size: '1792x1024' });
});

test('gpt-image-2 and later take 655,360 to 8,294,400 pixels; earlier models keep their sizes', () => {
  for (const model of ['gpt-image-2', 'gpt-image-2.5-flare', 'gpt-image-2.6-sunburst']) {
    assert.equal(
      validateOpenAIImageOptions({ size: '640x1008' }, { model }).error,
      `image.size 640x1008: ${model} takes 655360 to 8294400 pixels, this is 645120`,
    );
    assert.equal(validateOpenAIImageOptions({ size: '1024x1024' }, { model }).ok, true, model);
    assert.equal(validateOpenAIImageOptions({ size: '1024x640' }, { model }).ok, true, `${model}: 655,360 exactly`);
    assert.equal(validateOpenAIImageOptions({ size: 'auto' }, { model }).ok, true);
  }
  assert.equal(openAIImageModelHasPixelFloor('gpt-image-2-2026-03-01'), true);
  for (const model of ['gpt-image-1', 'gpt-image-1.5', 'gpt-image-1-mini']) {
    assert.equal(validateOpenAIImageOptions({ size: '640x1008' }, { model }).ok, true, model);
    assert.equal(openAIImageModelHasPixelFloor(model), false);
  }
  // Without a model the floor is the relay's to check.
  assert.equal(validateOpenAIImageOptions({ size: '640x1008' }).ok, true);
});

test('options: quality, count, format and background per family', () => {
  const ok = validateOpenAIImageOptions({ size: '1536X1024', quality: 'HIGH', count: '2', output_format: 'webp', background: 'transparent' }, { model: 'gpt-image-2' });
  assert.deepEqual(ok, { ok: true, values: { size: '1536x1024', quality: 'high', count: 2, output_format: 'webp', background: 'transparent' } });
  // xhigh and max: the gpt-image 2.5 and 2.6 models, and no other.
  for (const model of ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2.5-flare-2026-09-08', 'gpt-image-2.6-flare', 'openai/GPT-Image-2.6-Sunburst']) {
    for (const quality of ['auto', 'low', 'medium', 'high', 'xhigh', 'max']) {
      assert.equal(validateOpenAIImageOptions({ quality }, { model }).ok, true, `${model} ${quality}`);
    }
  }
  for (const model of ['gpt-image-2', 'gpt-image-1.5', 'gpt-image-1', 'gpt-image-1-mini', 'gpt-image-2.7-flare', 'gpt-image-25']) {
    assert.equal(validateOpenAIImageOptions({ quality: 'high' }, { model }).ok, true, model);
    assert.equal(
      validateOpenAIImageOptions({ quality: 'xhigh' }, { model }).error,
      `image.quality must be one of: auto, low, medium, high for ${model} (xhigh and max: the gpt-image 2.5 and 2.6 models only)`,
    );
  }
  assert.deepEqual(openAIImageModelQualities('gpt-image-2.6-flare'), ['auto', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(openAIImageModelQualities('gpt-image-2'), ['auto', 'low', 'medium', 'high']);
  assert.deepEqual(openAIImageModelQualities('dall-e-3'), ['auto', 'standard', 'hd']);
  // Without a model (the contract) they pass: the relay checks with the session's model.
  assert.equal(validateOpenAIImageOptions({ quality: 'max' }).ok, true);
  assert.match(validateOpenAIImageOptions({ quality: 'ultra' }).error, /^image\.quality must be one of: auto, low, medium, high, standard, hd, xhigh, max$/);
  assert.match(validateOpenAIImageOptions({ quality: 'hd' }, { model: 'gpt-image-1' }).error, /image\.quality must be one of: auto, low/);
  assert.equal(validateOpenAIImageOptions({ quality: 'hd' }, { model: 'dall-e-3' }).ok, true);
  assert.equal(validateOpenAIImageOptions({ quality: 'hd' }).ok, true, 'without a model any family\'s quality passes');
  assert.match(validateOpenAIImageOptions({ count: 2 }, { model: 'dall-e-3' }).error, /1 to 1 for dall-e-3/);
  assert.match(validateOpenAIImageOptions({ count: OPENAI_IMAGE_LIMITS.countMax + 1 }).error, /1 to 4/);
  assert.match(validateOpenAIImageOptions({ count: 1.5 }).error, /whole number/);
  assert.match(validateOpenAIImageOptions({ count: true }).error, /whole number/);
  assert.match(validateOpenAIImageOptions({ output_format: 'png' }, { model: 'dall-e-3' }).error, /gpt-image models only/);
  assert.match(validateOpenAIImageOptions({ output_format: 'gif' }).error, /png, webp, jpeg/);
  assert.match(validateOpenAIImageOptions({ background: 'transparent', output_format: 'jpeg' }).error, /png or webp/);
  assert.match(validateOpenAIImageOptions({ seed: 4 }).error, /does not take: seed/);
  assert.match(validateOpenAIImageOptions('1024x1024').error, /must be an object/);
  assert.match(validateOpenAIImageOptions({ size: 'auto' }, { model: 'gpt-5.4-mini' }).error, /image model/);
  assert.deepEqual(validateOpenAIImageOptions({ size: '', quality: null }), { ok: true, values: {} });
  assert.deepEqual(validateOpenAIImageOptions(null), { ok: true, values: {} });
});

test('merge: the turn over the session defaults, count 1 by default', () => {
  assert.deepEqual(mergeOpenAIImageOptions(null, null), { count: 1 });
  assert.deepEqual(
    mergeOpenAIImageOptions({ size: '1024x1024', quality: 'low', background: 'opaque' }, { quality: 'high', count: 3, size: '' }),
    { size: '1024x1024', quality: 'high', background: 'opaque', count: 3 },
  );
});

test('summary line: count, sizes, model, cost when known', () => {
  assert.equal(formatOpenAIImageSummary({ images: [{ width: 1536, height: 1024 }], model: 'gpt-image-2', costUsd: 0.04 }), '1 image · 1536x1024 · gpt-image-2 · ~USD 0.04');
  assert.equal(formatOpenAIImageSummary({ images: [{ width: 1024, height: 1024 }, { width: 1024, height: 1024 }], model: 'gpt-image-2' }), '2 images · 1024x1024 · gpt-image-2');
  assert.equal(formatOpenAIImageSummary({ images: [{}], model: '' }), '1 image');
  assert.equal(formatOpenAIImageSummary({ images: [{ width: 1, height: 1 }], costUsd: 0.004 }), '1 image · 1x1 · ~USD 0.004');
});
