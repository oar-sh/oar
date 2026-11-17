// The prompt sanitizers match the machine-injected prefixes word by word. A
// RegExp built from the relay tool guidance (thousands of words) overflowed
// the stack when V8 compiled it, first on Windows: every message then failed
// for the life of the process. These tests hold the stack use down and the
// output byte-identical to the regex version.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Worker } from 'node:worker_threads';

import * as serverSanitizer from './relay-prompt-sanitizer.mjs';
import * as browserSanitizer from '../public/app/relay-prompt-sanitizer.mjs';
import { renderMediaEmbedInstructionBlock } from '../../shared/media-embed-instructions.mjs';
import { renderMathInstructionBlock } from '../../shared/math-instructions.mjs';

const execFileAsync = promisify(execFile);

const SERVER_URL = new URL('./relay-prompt-sanitizer.mjs', import.meta.url).href;
const BROWSER_URL = new URL('../public/app/relay-prompt-sanitizer.mjs', import.meta.url).href;
const RUNTIME_URL = new URL('../../shared/worker-runtime/prompt-context.mjs', import.meta.url).href;
const REFERENCE_URL = new URL('./relay-prompt-sanitizer-regex-reference-test-harness.mjs', import.meta.url);

// Far below what the regex version needs for today's guidance on Linux (it
// overflows below about 650 KB), and well above what Node itself needs to
// start (about 60 KB).
const SMALL_STACK_KB = 200;

test('the sanitizers strip the full guidance prefix on a small stack', async () => {
  const script = `
    const server = await import(${JSON.stringify(SERVER_URL)});
    const browser = await import(${JSON.stringify(BROWSER_URL)});
    const runtime = await import(${JSON.stringify(RUNTIME_URL)});
    const media = ${JSON.stringify(renderMediaEmbedInstructionBlock())};
    const math = ${JSON.stringify(renderMathInstructionBlock())};
    const results = [];
    for (const mode of ['plan', 'ask', 'autopilot', 'agent', '']) {
      for (const sanitizer of [server, browser]) {
        for (const prefix of sanitizer.relayPromptPrefixTextsForTests(mode)) {
          results.push(sanitizer.stripRelayPromptContext(media + '\\n\\n' + math + '\\n\\n' + prefix + '\\n\\ntidy the docs', mode));
        }
      }
    }
    const longPrefix = server.relayPromptPrefixTextsForTests('agent')[0];
    results.push(runtime.stripPromptContextPrefix(longPrefix.replaceAll(' ', '\\n') + ' tidy the docs', { relayMode: 'agent' }, '', longPrefix));
    console.log(JSON.stringify(results));
  `;
  const { stdout } = await execFileAsync(
    process.execPath,
    [`--stack-size=${SMALL_STACK_KB}`, '--input-type=module', '-e', script],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const results = JSON.parse(stdout);
  assert.ok(results.length > 40);
  for (const result of results) assert.equal(result, 'tidy the docs');
});

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ODD_WHITESPACE = [' ', '  ', '\n', '\r\n', '\t', ' \n\t ', ' ', ' ', '　', '﻿', '\v\f', ' '];

function pick(rand, values) {
  return values[Math.floor(rand() * values.length)];
}

function oddWhitespace(text, rand) {
  return text.split(' ').map((word, index) => (index ? pick(rand, ODD_WHITESPACE) : '') + word).join('');
}

function mixedCase(text, rand) {
  return Array.from(text, (char) => (rand() < 0.5 ? char.toUpperCase() : char.toLowerCase())).join('');
}

function wordOff(text, index) {
  const words = text.split(' ');
  const at = Math.max(0, Math.min(words.length - 1, index < 0 ? words.length + index : index));
  words[at] = `${words[at]}x`;
  return words.join(' ');
}

function firstWords(text, fraction) {
  const words = text.split(' ');
  return words.slice(0, Math.max(1, Math.floor(words.length * fraction))).join(' ');
}

function prefixVariants(prefix, rand) {
  const body = 'tidy the docs';
  return [
    `${prefix} ${body}`,
    `${prefix}\n\n${body}\nand then\n\nthe tests`,
    prefix,
    `${prefix}   `,
    `  \n${prefix}\n${body}`,
    `${prefix}${body}`,
    `${oddWhitespace(prefix, rand)}${pick(rand, ODD_WHITESPACE)}${body}`,
    `${mixedCase(prefix, rand)} ${body}`,
    `${mixedCase(oddWhitespace(prefix, rand), rand)}\n${body}`,
    `${prefix.toUpperCase()} ${body}`,
    `${wordOff(prefix, 0)} ${body}`,
    `${wordOff(prefix, Math.floor(prefix.split(' ').length / 2))} ${body}`,
    `${wordOff(prefix, -1)} ${body}`,
    `${firstWords(prefix, 0.5)} ${body}`,
    `${firstWords(prefix, 0.98)} ${body}`,
    `${prefix.slice(0, -3)} ${body}`,
    `${prefix.replace(' ', '')} ${body}`,
    `${prefix} ${prefix} ${body}`,
    `${body} ${prefix}`,
  ];
}

function buildCorpus(sanitizer) {
  const rand = mulberry32(0x5eed);
  const media = renderMediaEmbedInstructionBlock();
  const math = renderMathInstructionBlock();
  const modes = ['plan', 'ask', 'autopilot', 'agent', '', 'AGENT ', 'bogus'];
  const cases = [];
  const prefixTextsByMode = {};
  for (const mode of modes) prefixTextsByMode[mode] = sanitizer.relayPromptPrefixTextsForTests(mode);
  for (const mode of ['plan', 'ask', 'autopilot', 'agent', '']) {
    for (const prefix of prefixTextsByMode[mode]) {
      for (const text of prefixVariants(prefix, rand)) cases.push({ mode, text });
    }
  }
  // Another mode's prefix, and the modes the sanitizer reads as no mode.
  for (const prefix of prefixTextsByMode.plan) {
    cases.push({ mode: 'agent', text: `${prefix} tidy the docs` });
    cases.push({ mode: 'AGENT ', text: `${prefix} tidy the docs` });
    cases.push({ mode: 'bogus', text: `${oddWhitespace(prefix, rand)} tidy the docs` });
  }
  const agentFull = prefixTextsByMode.agent[0];
  const blockTexts = [
    `${media}\n\n${math}\n\n${agentFull}\n\ntidy the docs`,
    `${oddWhitespace(media, rand)}\n\n${mixedCase(math, rand)}\n\n${agentFull} tidy the docs`,
    `tidy ${media} the ${math} docs`,
    `${media}\n\n${media}\n\ntidy the docs`,
    `${wordOff(media, 5)}\n\ntidy the docs`,
    `${firstWords(math, 0.7)}\n\ntidy the docs`,
    `${media}${math} tidy the docs`,
    `${media}`,
    `${media}\n\n${math}`,
  ];
  for (const text of blockTexts) {
    cases.push({ mode: 'agent', text });
    cases.push({ mode: '', text });
  }
  const plainTexts = [
    '',
    '   ',
    'hello there',
    'Please explain [Relay mode: agent] to me',
    '[Relay mode: agent]',
    '[Relay mode: agent]fix it',
    '[relay MODE:\n\tagent]\nfix it',
    '[Relay mode: agent ] fix it',
    '[Relay  mode agent] fix it',
    'Straße İstanbul ſtrange µ K Kelvin',
    '[RELAY MODE: AGENT] Straße',
  ];
  for (const text of plainTexts) {
    for (const mode of ['agent', '', 'plan']) cases.push({ mode, text });
  }
  return { cases, prefixTextsByMode };
}

function referenceOutputs(workerData) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(REFERENCE_URL, { workerData, resourceLimits: { stackSizeMb: 64 } });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`reference worker exited with ${code}`));
    });
  });
}

for (const [name, sanitizer, browserBlocks] of [
  ['server', serverSanitizer, false],
  ['browser', browserSanitizer, true],
]) {
  test(`the ${name} sanitizer strips byte for byte what the regex version stripped`, async () => {
    const { cases, prefixTextsByMode } = buildCorpus(sanitizer);
    const expected = await referenceOutputs({
      cases,
      prefixTextsByMode,
      blockTexts: [renderMediaEmbedInstructionBlock(), renderMathInstructionBlock()],
      browserBlocks,
    });
    assert.equal(expected.length, cases.length);
    let stripped = 0;
    cases.forEach(({ mode, text }, index) => {
      const actual = sanitizer.stripRelayPromptContext(text, mode);
      if (actual !== text.trim()) stripped += 1;
      if (actual !== expected[index]) {
        assert.fail(`case ${index} (mode ${JSON.stringify(mode)}) differs: ${JSON.stringify(actual.slice(0, 120))} vs ${JSON.stringify(expected[index].slice(0, 120))}`);
      }
    });
    // The corpus exercises both outcomes, not only the near misses.
    assert.ok(stripped > cases.length / 3, `${stripped} of ${cases.length} cases stripped`);
    assert.ok(stripped < cases.length, 'some cases are left alone');
  });
}
