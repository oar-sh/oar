import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_MODEL_SWITCH_TIMEOUT_MS,
  MODEL_SWITCH_UNCONFIRMED_STABLE_CODE,
  createCopilotModelSwitcher,
  createModelSwitchUnconfirmedError,
  isModelSwitchUnconfirmedError,
  isRuntimeTransportError,
  normalizeRelayEffort,
  supportedEffortsOf,
} from './copilot-model-switch.mjs';
import { createFakeCopilotSession } from './copilot-sdk-test-harness.mjs';

/** A catalog entry shaped like the runtime's ModelInfo. */
const REASONING_MODEL = {
  id: 'gpt-5.4',
  supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
  defaultReasoningEffort: 'medium',
};
const PLAIN_MODEL = { id: 'gpt-4o' };

function makeSession(modelRpc = {}) {
  return createFakeCopilotSession({ config: { sessionId: 'conv-1' }, modelRpc });
}

test('the relay effort vocabulary normalizes: none and empty mean the model default', () => {
  // SDK 1.0.13's ReasoningEffort union has NO "none" member; the relay's
  // "none" is a reset and must never reach the wire as a literal.
  assert.equal(normalizeRelayEffort('none'), null);
  assert.equal(normalizeRelayEffort(''), null);
  assert.equal(normalizeRelayEffort(null), null);
  assert.equal(normalizeRelayEffort(' High '), 'high');
});

test('every supported effort level rides the switchTo request on a model change', async () => {
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const switcher = createCopilotModelSwitcher();
    const session = makeSession();
    const outcome = await switcher.apply(session, { model: 'gpt-5.4', effort: level });
    assert.deepEqual(outcome, { ok: true, changed: true });
    assert.deepEqual(session.rpc.model.switchToCalls, [{ modelId: 'gpt-5.4', reasoningEffort: level }], level);
    assert.deepEqual(switcher.current(), { model: 'gpt-5.4', effort: level });
  }
});

test('a no-delta selection costs zero RPCs', async () => {
  const switcher = createCopilotModelSwitcher();
  const session = makeSession();
  await switcher.apply(session, { model: 'gpt-5.4', effort: 'high' });
  await switcher.apply(session, { model: 'gpt-5.4', effort: 'high' });
  assert.equal(session.rpc.model.switchToCalls.length, 1);
  assert.equal(session.rpc.model.effortCalls.length, 0);
});

test('an effort-only delta uses the effort RPC, model+effort a single switchTo', async () => {
  const switcher = createCopilotModelSwitcher();
  const session = makeSession({ catalog: [REASONING_MODEL] });
  await switcher.apply(session, { model: 'gpt-5.4', effort: 'low' });
  assert.equal(session.rpc.model.switchToCalls.length, 1);

  const outcome = await switcher.apply(session, { model: 'gpt-5.4', effort: 'high' });
  assert.deepEqual(outcome, { ok: true, changed: true });
  // Same model: no second switchTo, one setReasoningEffort.
  assert.equal(session.rpc.model.switchToCalls.length, 1);
  assert.deepEqual(session.rpc.model.effortCalls, [{ reasoningEffort: 'high' }]);
  assert.deepEqual(switcher.current(), { model: 'gpt-5.4', effort: 'high' });
});

test('effort none maps to the model default when the catalog knows it', async () => {
  const switcher = createCopilotModelSwitcher();
  const session = makeSession({ catalog: [REASONING_MODEL] });
  await switcher.apply(session, { model: 'gpt-5.4', effort: 'high' });

  const outcome = await switcher.apply(session, { model: 'gpt-5.4', effort: 'none' });
  assert.deepEqual(outcome, { ok: true, changed: true });
  // The first apply was a model change (switchTo carried "high"); the reset
  // to the default is the effort-only RPC.
  assert.deepEqual(session.rpc.model.switchToCalls, [{ modelId: 'gpt-5.4', reasoningEffort: 'high' }]);
  assert.deepEqual(session.rpc.model.effortCalls, [{ reasoningEffort: 'medium' }]);
  assert.deepEqual(switcher.current(), { model: 'gpt-5.4', effort: 'medium' });
  // The catalog is fetched once and cached for the session.
  assert.equal(session.rpc.model.listCalls, 1);
});

test('effort none with an unknown default omits the field and resets tracking', async () => {
  const switcher = createCopilotModelSwitcher();
  const session = makeSession(); // empty catalog: no default to map to
  await switcher.apply(session, { model: 'gpt-5.4', effort: 'high' });

  const outcome = await switcher.apply(session, { model: 'gpt-5.4', effort: 'none' });
  // Nothing can be sent (there is no "clear" RPC and no known default), but
  // the tracking resets so a later explicit level still reads as a delta.
  assert.deepEqual(outcome, { ok: true, changed: false });
  assert.equal(session.rpc.model.effortCalls.length, 0);
  assert.deepEqual(switcher.current(), { model: 'gpt-5.4', effort: null });

  const again = await switcher.apply(session, { model: 'gpt-5.4', effort: 'high' });
  assert.equal(again.changed, true);
  assert.deepEqual(session.rpc.model.effortCalls, [{ reasoningEffort: 'high' }]);
});

test('a model change with effort none carries the target model default in the switchTo', async () => {
  const switcher = createCopilotModelSwitcher();
  const session = makeSession({ catalog: [REASONING_MODEL] });
  switcher.noteApplied('gpt-4o', null);
  await switcher.apply(session, { model: 'gpt-5.4', effort: 'none' });
  assert.deepEqual(session.rpc.model.switchToCalls, [{ modelId: 'gpt-5.4', reasoningEffort: 'medium' }]);
  assert.deepEqual(switcher.current(), { model: 'gpt-5.4', effort: 'medium' });
});

test('an unsupported effort level fails like a refused explicit selection', async () => {
  const switcher = createCopilotModelSwitcher();
  const session = makeSession({ catalog: [REASONING_MODEL] });
  await switcher.apply(session, { model: 'gpt-5.4' });

  await assert.rejects(
    () => switcher.apply(session, { model: 'gpt-5.4', effort: 'max' }),
    (error) => {
      assert.equal(isModelSwitchUnconfirmedError(error), true);
      assert.equal(error.stableCode, MODEL_SWITCH_UNCONFIRMED_STABLE_CODE);
      assert.match(error.message, /"max"/);
      return true;
    },
  );
  // Nothing was sent for an effort the model is known to refuse.
  assert.equal(session.rpc.model.effortCalls.length, 0);
});

test('an entry with no parseable effort list is PERMISSIVE: send and let the runtime decide', async () => {
  // Regression for burn-in session ed5febdd (2026-09-07): the session-level
  // rpc.model.list() speaks raw CAPI shape, so the typed field this code once
  // required was never present and every effort-carrying turn failed closed.
  // The catalog may only fast-fail on a POSITIVE exclusion; an entry with no
  // recognisable list defers to the runtime, which is the actual authority.
  const hosted = createCopilotModelSwitcher();
  const hostedSession = makeSession({ catalog: [PLAIN_MODEL] });
  hosted.noteApplied('gpt-4o', null);
  const outcome = await hosted.apply(hostedSession, { model: 'gpt-4o', effort: 'high' });
  assert.deepEqual(outcome, { ok: true, changed: true });
  assert.deepEqual(hostedSession.rpc.model.effortCalls, [{ reasoningEffort: 'high' }]);
});

test('a positive exclusion fails hosted (naming the advertised levels), skips BYOK', async () => {
  const EXCLUDING_MODEL = { id: 'kimi-k3', supportedReasoningEfforts: ['low', 'high', 'max'] };
  const hosted = createCopilotModelSwitcher();
  const hostedSession = makeSession({ catalog: [EXCLUDING_MODEL] });
  hosted.noteApplied('kimi-k3', null);
  await assert.rejects(
    () => hosted.apply(hostedSession, { model: 'kimi-k3', effort: 'medium' }),
    /reasoning effort "medium".*supports: low, high, max/s,
  );
  assert.equal(hostedSession.rpc.model.effortCalls.length, 0);

  // BYOK: openai-compatible effort vocabularies differ; a level the catalog
  // rejects is skipped silently rather than failed or rebuilt over.
  const byok = createCopilotModelSwitcher();
  const byokSession = makeSession({ catalog: [EXCLUDING_MODEL] });
  byok.noteApplied('kimi-k3', null);
  const outcome = await byok.apply(byokSession, { model: 'kimi-k3', effort: 'medium', byok: true });
  assert.deepEqual(outcome, { ok: true, changed: false });
  assert.equal(byokSession.rpc.model.effortCalls.length, 0);
});

// The raw CAPI entry shape the live session RPC actually returns (captured
// from runtime 1.0.83 on 2026-09-07); the typed ModelInfo fields do NOT exist
// on it.
const RAW_WIRE_MODEL = {
  id: 'gpt-5.6-terra',
  name: 'GPT-5.6 Terra',
  capabilities: {
    family: 'gpt-5.6-terra',
    object: 'model_capabilities',
    supports: {
      parallel_tool_calls: true,
      reasoning_effort: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      streaming: true,
      tool_calls: true,
      vision: true,
    },
  },
};

test('supportedEffortsOf reads both the typed and the raw CAPI wire shapes', () => {
  assert.deepEqual(supportedEffortsOf(REASONING_MODEL), ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(supportedEffortsOf(RAW_WIRE_MODEL), ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(supportedEffortsOf(PLAIN_MODEL), null);
  assert.equal(supportedEffortsOf(null), null);
});

test('a raw-wire catalog entry validates the effort and sends it (burn-in ed5febdd regression)', async () => {
  const switcher = createCopilotModelSwitcher();
  const session = makeSession({ catalog: [RAW_WIRE_MODEL] });
  switcher.noteApplied('gpt-5.6-terra', null);
  const outcome = await switcher.apply(session, { model: 'gpt-5.6-terra', effort: 'max' });
  assert.deepEqual(outcome, { ok: true, changed: true });
  assert.deepEqual(session.rpc.model.effortCalls, [{ reasoningEffort: 'max' }]);
});

test('relay "none" sends the literal reset when the wire catalog offers it', async () => {
  const switcher = createCopilotModelSwitcher();
  const session = makeSession({ catalog: [RAW_WIRE_MODEL] });
  switcher.noteApplied('gpt-5.6-terra', 'high');
  const outcome = await switcher.apply(session, { model: 'gpt-5.6-terra', effort: 'none' });
  assert.deepEqual(outcome, { ok: true, changed: true });
  assert.deepEqual(session.rpc.model.effortCalls, [{ reasoningEffort: 'none' }]);
  // Tracked as null (= default), so the steady state stays zero-RPC.
  assert.deepEqual(switcher.current(), { model: 'gpt-5.6-terra', effort: null });
  const repeat = await switcher.apply(session, { model: 'gpt-5.6-terra', effort: 'none' });
  assert.deepEqual(repeat, { ok: true, changed: false });
  assert.equal(session.rpc.model.effortCalls.length, 1);
});

test('a deferred switch that drains in time confirms through session.model_change', async () => {
  const switcher = createCopilotModelSwitcher({ switchTimeoutMs: 2_000 });
  const session = makeSession({
    switchTo: (params, s) => {
      // The runtime enqueued the switch behind an active turn; it drains at
      // the next model-call boundary and announces itself as an event.
      setTimeout(() => switcher.observeEvent({
        type: 'session.model_change',
        data: { newModel: params.modelId, reasoningEffort: params.reasoningEffort || null },
      }), 5);
      return { deferred: true };
    },
  });
  const outcome = await switcher.apply(session, { model: 'gpt-5.4', effort: 'high' });
  assert.deepEqual(outcome, { ok: true, changed: true });
  assert.deepEqual(switcher.current(), { model: 'gpt-5.4', effort: 'high' });
});

test('a drain that lands before the deferred result cannot be missed', async () => {
  // The waiter is armed BEFORE the RPC: a model_change dispatched while the
  // switchTo response is still in flight must still count as the drain.
  const switcher = createCopilotModelSwitcher({ switchTimeoutMs: 2_000 });
  const session = makeSession({
    switchTo: (params) => {
      switcher.observeEvent({ type: 'session.model_change', data: { newModel: params.modelId } });
      return { deferred: true };
    },
  });
  const outcome = await switcher.apply(session, { model: 'gpt-5.4' });
  assert.deepEqual(outcome, { ok: true, changed: true });
});

test('a deferred switch that never drains fails the selection, naming both models', async () => {
  const switcher = createCopilotModelSwitcher({ switchTimeoutMs: 20 });
  const session = makeSession({ switchTo: () => ({ deferred: true }) });
  switcher.noteApplied('gpt-4o', null);
  await assert.rejects(
    () => switcher.apply(session, { model: 'gpt-5.4' }),
    (error) => {
      assert.equal(isModelSwitchUnconfirmedError(error), true);
      assert.match(error.message, /"gpt-5\.4"/);
      assert.match(error.message, /"gpt-4o"/);
      assert.match(error.message, /did not apply/);
      return true;
    },
  );
  // The old model stays the confirmed one.
  assert.equal(switcher.current().model, 'gpt-4o');
});

test('a confirmation-required result fails rather than sending on the old model', async () => {
  const switcher = createCopilotModelSwitcher();
  const session = makeSession({
    switchTo: () => ({ confirmation: { targetModelDisplayName: 'GPT-5.4', currentTokens: 1, targetLimit: 2 } }),
  });
  await assert.rejects(
    () => switcher.apply(session, { model: 'gpt-5.4' }),
    /interactive confirmation/,
  );
});

test('a switchTo that reports a different active model is a refusal', async () => {
  const switcher = createCopilotModelSwitcher();
  const session = makeSession({ switchTo: () => ({ modelId: 'gpt-4o' }) });
  await assert.rejects(
    () => switcher.apply(session, { model: 'gpt-5.4' }),
    (error) => {
      assert.match(error.message, /"gpt-5\.4"/);
      assert.match(error.message, /reports "gpt-4o"/);
      return true;
    },
  );
});

test('a thrown switchTo fails hosted and returns ok:false for BYOK', async () => {
  const reject = { switchTo: () => { throw new Error('registry rejected the model'); } };

  const hosted = createCopilotModelSwitcher();
  await assert.rejects(
    () => hosted.apply(makeSession(reject), { model: 'gpt-5.4' }),
    isModelSwitchUnconfirmedError,
  );

  const byok = createCopilotModelSwitcher();
  const outcome = await byok.apply(makeSession(reject), { model: 'gpt-5.4', byok: true });
  assert.equal(outcome.ok, false);
  assert.match(outcome.detail, /registry rejected/);
  // Nothing was confirmed.
  assert.equal(byok.current().model, '');
});

test('an external model_change keeps the tracking truthful for the next turn', async () => {
  // A deferred switch whose wait expired can still drain later, or the
  // runtime can switch on its own (refusal fallback): the tracked pair must
  // follow the runtime, not this worker's last request.
  const switcher = createCopilotModelSwitcher();
  const session = makeSession();
  await switcher.apply(session, { model: 'gpt-5.4', effort: 'high' });

  switcher.observeEvent({ type: 'session.model_change', data: { newModel: 'gpt-4o', reasoningEffort: null } });
  assert.deepEqual(switcher.current(), { model: 'gpt-4o', effort: null });

  // Re-selecting the original model is now a real delta again.
  await switcher.apply(session, { model: 'gpt-5.4', effort: 'high' });
  assert.equal(session.rpc.model.switchToCalls.length, 2);
});

test('reset drops the confirmed pair and the cached catalog with the session', async () => {
  const switcher = createCopilotModelSwitcher();
  const first = makeSession({ catalog: [REASONING_MODEL] });
  await switcher.apply(first, { model: 'gpt-5.4', effort: 'none' });
  assert.equal(first.rpc.model.listCalls, 1);

  switcher.reset();
  assert.deepEqual(switcher.current(), { model: '', effort: null });
  const second = makeSession({ catalog: [REASONING_MODEL] });
  await switcher.apply(second, { model: 'gpt-5.4', effort: 'none' });
  // A fresh session gets a fresh list() — the old cache does not leak across.
  assert.equal(second.rpc.model.listCalls, 1);
});

test('the unconfirmed error carries the stable code the relay keys on', () => {
  const error = createModelSwitchUnconfirmedError({ requestedModel: 'a', actualModel: 'b' });
  assert.equal(error.stableCode, 'relay.model-switch-unconfirmed');
  assert.equal(isModelSwitchUnconfirmedError(error), true);
  assert.equal(isModelSwitchUnconfirmedError(new Error('x')), false);
  assert.equal(DEFAULT_MODEL_SWITCH_TIMEOUT_MS, 10_000);
});

test('catalogEntries shares the effort-validation cache: one list() serves both', async () => {
  const switcher = createCopilotModelSwitcher();
  const session = makeSession({ catalog: [REASONING_MODEL, PLAIN_MODEL] });

  const entries = await switcher.catalogEntries(session);
  assert.deepEqual(entries.map((entry) => entry.id), ['gpt-5.4', 'gpt-4o']);
  // The raw ModelInfo rides through untouched — the snapshot publisher needs
  // the capability/billing fields, not a projection.
  assert.equal(entries[0], REASONING_MODEL);
  assert.equal(session.rpc.model.listCalls, 1);

  // An effort validation after the snapshot read costs no second RPC…
  await switcher.apply(session, { model: 'gpt-5.4', effort: 'high' });
  assert.equal(session.rpc.model.listCalls, 1);
  // …and neither does a repeat snapshot read.
  await switcher.catalogEntries(session);
  assert.equal(session.rpc.model.listCalls, 1);
});

test('catalogEntries on a refused list is empty and cached, not retried', async () => {
  const switcher = createCopilotModelSwitcher();
  let listAttempts = 0;
  const session = makeSession({ list: async () => { listAttempts += 1; throw new Error('list refused'); } });

  assert.deepEqual(await switcher.catalogEntries(session), []);
  assert.deepEqual(await switcher.catalogEntries(session), []);
  // Cached-as-empty is the standing degradation policy for a failed list.
  assert.equal(listAttempts, 1);
});

test('a connection that is gone is recognised by code, name and wording', () => {
  assert.equal(isRuntimeTransportError(Object.assign(new Error('write failed'), { code: -32099 })), true);
  assert.equal(isRuntimeTransportError(Object.assign(new Error('boom'), { name: 'ConnectionError' })), true);
  assert.equal(isRuntimeTransportError(new Error('Pending response rejected since connection got disposed')), true);
  assert.equal(isRuntimeTransportError(new Error('Connection is closed.')), true);
  assert.equal(isRuntimeTransportError(Object.assign(new Error('model not available'), { code: -32603 })), false);
  assert.equal(isRuntimeTransportError(new Error('the model refused the connection string')), false);
});
