import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  OPENAI_IMAGE_ESTIMATE_PROMPT_TOKENS,
  OPENAI_IMAGE_PRICED_MODELS,
  estimateOpenAIImageCost,
  findOpenAIImagePriceEntry,
  openAIImageBookingModel,
  openAIImageCostFloor,
  openAIImageOutputTokens,
  priceOpenAIImageUsage,
} from './openai-image-prices.mjs';
import { OPENAI_IMAGE_COST_SOURCES } from './openai-image-spend.mjs';

const near = (actual, expected, label = '') => assert.ok(Math.abs(actual - expected) < 1e-9, `${label} ${actual} ≠ ${expected}`);

test('gpt-image-2 output tokens match the guide calculator and its published per-image prices', () => {
  const at = (size) => ['low', 'medium', 'high'].map((quality) => openAIImageOutputTokens({ model: 'gpt-image-2', size, quality }));
  assert.deepEqual(at('1024x1024'), [196, 1756, 7024]);
  assert.deepEqual(at('1536x1024'), [158, 1372, 5488]);
  assert.deepEqual(at('1024x1536'), [158, 1372, 5488]);
  const usd = (size, quality) => openAIImageCostFloor({ model: 'gpt-image-2', size, quality }).costUsd;
  assert.equal(usd('1024x1024', 'low').toFixed(3), '0.006');
  assert.equal(usd('1024x1024', 'medium').toFixed(3), '0.053');
  assert.equal(usd('1024x1024', 'high').toFixed(3), '0.211');
  assert.equal(usd('1536x1024', 'low').toFixed(3), '0.005');
  assert.equal(usd('1536x1024', 'medium').toFixed(3), '0.041');
  assert.equal(usd('1536x1024', 'high').toFixed(3), '0.165');
});

test('2.5 and 2.6 output tokens: xhigh, max, and the 2.6 factors', () => {
  assert.equal(openAIImageOutputTokens({ model: 'gpt-image-2.5-flare', size: '1024x1024', quality: 'xhigh' }), 3122);
  assert.equal(openAIImageOutputTokens({ model: 'gpt-image-2.5-sunburst', size: '3840x2160', quality: 'max' }), 13342);
  assert.equal(openAIImageOutputTokens({ model: 'gpt-image-2.5-flare', size: '1024x1024', quality: 'low' }), 196);
  assert.equal(openAIImageOutputTokens({ model: 'gpt-image-2.6-flare', size: '1024x1024', quality: 'low' }), 823);
  assert.equal(openAIImageOutputTokens({ model: 'gpt-image-2.6-sunburst', size: '1024x1024', quality: 'medium' }), 1449);
  assert.equal(openAIImageOutputTokens({ model: 'gpt-image-2.6-sunburst', size: '2048x2048', quality: 'high' }), 3568);
});

test('lookup: the exact bare lower-case id, then a dated snapshot stripped, no family fallback', () => {
  assert.ok(findOpenAIImagePriceEntry('GPT-Image-2'));
  assert.ok(findOpenAIImagePriceEntry('openai/gpt-image-2'));
  assert.equal(findOpenAIImagePriceEntry('gpt-image-2.5-flare-2026-09-08'), findOpenAIImagePriceEntry('gpt-image-2.5-flare'));
  assert.equal(findOpenAIImagePriceEntry('gpt-image-2.5-flare-preview'), null);
  assert.equal(findOpenAIImagePriceEntry('gpt-image-2.5'), null);
  assert.equal(findOpenAIImagePriceEntry('gpt-image-3'), null);
  assert.equal(findOpenAIImagePriceEntry('dall-e-3'), null);
  assert.equal(openAIImageBookingModel(' OpenAI/GPT-Image-2.5-Flare-2026-09-08 '), 'gpt-image-2.5-flare-2026-09-08');
});

test('the older models: published per-image prices for their sizes, scaled by area for others', () => {
  near(openAIImageCostFloor({ model: 'gpt-image-1.5', size: '1024x1024', quality: 'medium' }).costUsd, 0.034);
  near(openAIImageCostFloor({ model: 'gpt-image-1-mini', size: '1024x1536', quality: 'high' }).costUsd, 0.052);
  near(openAIImageCostFloor({ model: 'gpt-image-1', size: '1536x1024', quality: 'low', count: 2 }).costUsd, 0.032);
  // A size they do not list: the shape's listed price times the area.
  near(openAIImageCostFloor({ model: 'gpt-image-1', size: '2048x2048', quality: 'high' }).costUsd, 0.167 * 4);
  near(openAIImageCostFloor({ model: 'gpt-image-1', size: '3072x2048', quality: 'high' }).costUsd, 0.25 * 4);
});

test('auto quality is the dearest the model has; auto size counts as 1536x1024', () => {
  assert.equal(
    openAIImageCostFloor({ model: 'gpt-image-2', size: '1024x1024', quality: 'auto' }).costUsd,
    openAIImageCostFloor({ model: 'gpt-image-2', size: '1024x1024', quality: 'high' }).costUsd,
  );
  assert.equal(
    openAIImageCostFloor({ model: 'gpt-image-2.5-flare', size: '1024x1024', quality: 'auto' }).costUsd,
    openAIImageCostFloor({ model: 'gpt-image-2.5-flare', size: '1024x1024', quality: 'max' }).costUsd,
  );
  // A quality the model does not take is priced as its dearest too.
  assert.equal(
    openAIImageCostFloor({ model: 'gpt-image-2', size: '1024x1024', quality: 'xhigh' }).costUsd,
    openAIImageCostFloor({ model: 'gpt-image-2', size: '1024x1024', quality: 'high' }).costUsd,
  );
  for (const size of ['auto', '', undefined, 'big']) {
    assert.equal(
      openAIImageCostFloor({ model: 'gpt-image-2', size, quality: 'low' }).costUsd,
      openAIImageCostFloor({ model: 'gpt-image-2', size: '1536x1024', quality: 'low' }).costUsd,
      String(size),
    );
  }
});

test('the formula covers custom sizes: a larger image costs more', () => {
  const small = openAIImageCostFloor({ model: 'gpt-image-2', size: '1024x1024', quality: 'medium' }).costUsd;
  const large = openAIImageCostFloor({ model: 'gpt-image-2', size: '2048x2048', quality: 'medium' }).costUsd;
  near(large, (3568 * 30) / 1e6);
  assert.ok(large > small);
});

test('an unknown model gets the stand-in: never below any priced model, never a missing cost', () => {
  // Every quality (xhigh and max included) at the composer's sizes and the
  // custom extremes of the pixel range: the stand-in is the dearest.
  const sizes = ['auto', '1024x1024', '1536x1024', '1024x1536', '1024x640', '640x1024', '3840x2160', '2160x3840',
    '1536x512', '512x1536', '2048x2048', '3840x1280', '1280x3840'];
  for (const quality of ['auto', 'low', 'medium', 'high', 'xhigh', 'max']) {
    for (const size of sizes) {
      const standIn = openAIImageCostFloor({ model: 'gpt-image-3', size, quality });
      assert.equal(standIn.costUnknown, true);
      const known = OPENAI_IMAGE_PRICED_MODELS.map((model) => openAIImageCostFloor({ model, size, quality }).costUsd);
      assert.equal(standIn.costUsd, Math.max(...known), `${quality} ${size}`);
      for (const [index, cost] of known.entries()) {
        assert.ok(standIn.costUsd >= cost, `${quality} ${size}: below ${OPENAI_IMAGE_PRICED_MODELS[index]}`);
      }
    }
  }
  // high at 1024x1024: gpt-image-2's 7024 tokens, not a 2.x sunburst's 1756.
  assert.ok(openAIImageCostFloor({ model: 'gpt-image-3', size: '1024x1024', quality: 'high' }).costUsd >= (7024 * 30) / 1e6);
  const dalle = estimateOpenAIImageCost({ model: 'dall-e-3', size: '1024x1792', quality: 'hd' });
  assert.equal(dalle.costUnknown, true);
  assert.ok(Number.isFinite(dalle.costUsd) && dalle.costUsd > 0);
  // Area: the stand-in at a bigger size costs more.
  assert.ok(openAIImageCostFloor({ model: 'x', size: '2048x2048', quality: 'low' }).costUsd
    > openAIImageCostFloor({ model: 'x', size: '1024x1024', quality: 'low' }).costUsd);
  // Known models are not unknown.
  assert.equal(openAIImageCostFloor({ model: 'gpt-image-2', size: '1024x1024', quality: 'low' }).costUnknown, false);
});

test('the estimate: floor × count, + 100 output tokens per partial received, + the input allowance', () => {
  const base = { model: 'gpt-image-2', size: '1024x1024', quality: 'low' };
  const floor = openAIImageCostFloor({ ...base, count: 2 }).costUsd;
  near(floor, (2 * 196 * 30) / 1e6);
  const plain = estimateOpenAIImageCost({ ...base, count: 2 }).costUsd;
  near(plain, floor + (OPENAI_IMAGE_ESTIMATE_PROMPT_TOKENS * 5) / 1e6);
  const withPartials = estimateOpenAIImageCost({ ...base, count: 2, partials: 3 }).costUsd;
  near(withPartials - plain, (300 * 30) / 1e6);
  const withInputs = estimateOpenAIImageCost({ ...base, count: 2, inputImages: 2 }).costUsd;
  assert.ok(withInputs > plain);
});

test('a reported usage is priced from the table; partials never added to it', () => {
  const priced = priceOpenAIImageUsage({
    model: 'gpt-image-2.5-flare-2026-09-08',
    usage: { input_tokens: 1050, input_tokens_details: { text_tokens: 50, image_tokens: 1000 }, output_tokens: 4160 },
  });
  near(priced.costUsd, (50 * 5 + 1000 * 8 + 4160 * 30) / 1e6);
  assert.equal(priced.costUnknown, false);
  assert.equal(priced.source, OPENAI_IMAGE_COST_SOURCES.table);
  assert.equal(priced.inputTokens, 1050);
  assert.equal(priced.outputTokens, 4160);
  // Without the split, all input at the image rate.
  const unsplit = priceOpenAIImageUsage({ model: 'gpt-image-2', usage: { input_tokens: 100, output_tokens: 196 } });
  near(unsplit.costUsd, (100 * 8 + 196 * 30) / 1e6);
  // gpt-image-1.5 has its own output rate.
  near(priceOpenAIImageUsage({ model: 'gpt-image-1.5', usage: { output_tokens: 1000 } }).costUsd, 0.032);
  // Nothing countable: null (the caller estimates).
  assert.equal(priceOpenAIImageUsage({ model: 'gpt-image-2', usage: {} }), null);
  assert.equal(priceOpenAIImageUsage({ model: 'gpt-image-2', usage: null }), null);
});

test('an unknown model\'s usage: the dearest rates the table has, an estimate, unknown price', () => {
  const priced = priceOpenAIImageUsage({ model: 'gpt-image-9', usage: { input_tokens: 10, input_tokens_details: { text_tokens: 10 }, output_tokens: 1000 } });
  near(priced.costUsd, (10 * 5 + 1000 * 40) / 1e6);
  assert.equal(priced.costUnknown, true);
  assert.equal(priced.source, OPENAI_IMAGE_COST_SOURCES.estimate);
});

test('every table entry names its source and the day it was read', () => {
  const source = fs.readFileSync(new URL('./openai-image-prices.mjs', import.meta.url), 'utf8');
  const table = source.slice(source.indexOf('// TABLE.'), source.indexOf('// END OF TABLE'));
  assert.ok(table.length > 0);
  assert.ok(OPENAI_IMAGE_PRICED_MODELS.length >= 8);
  // Every entry block is preceded by a comment with a source and a date.
  for (const block of table.split(/\n(?=\/\/ Rates:|  \/\/ Rates:)/).slice(1)) {
    assert.match(block, /read 2026-\d{2}-\d{2}/);
    assert.match(block, /pricing|guide|model page/);
  }
  assert.match(table, /GptImageTokenCalculator\.react\.eSCKNoob\.js/);
});
