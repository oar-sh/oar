import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LIVE_ROW_RELOAD_ATTEMPTS,
  loadKeepingLiveRows,
  shouldKeepTranscriptOnReload,
} from './transcript-reload-freshness.mjs';

// A conversation on the relay, a page that renders reload answers, and a
// socket that appends a stored row to the page.
function harness() {
  const stored = ['msg_fixture_1', 'msg_fixture_2'];
  let page = [...stored];
  let liveRows = 0;
  const pendingDuringLoad = [];
  let requests = 0;
  const load = async () => {
    requests += 1;
    const answer = { messages: [...stored] };
    // Rows that land while this request is on its way: stored and pushed to
    // the page after the request read the conversation.
    const arriving = pendingDuringLoad.shift() || [];
    for (const id of arriving) {
      stored.push(id);
      page.push(id);
      liveRows += 1;
    }
    await null;
    return answer;
  };
  return {
    load,
    getLiveRowEpoch: () => liveRows,
    arriveDuringRequest: (...ids) => pendingDuringLoad.push(ids),
    render(response) { page = [...response.messages]; },
    get page() { return page; },
    get requests() { return requests; },
  };
}

test('a row the socket appends during the request survives the reload', async () => {
  const relay = harness();
  relay.arriveDuringRequest('msg_fixture_live');
  const { response, stale } = await loadKeepingLiveRows(relay.load, relay.getLiveRowEpoch);
  assert.equal(stale, false);
  relay.render(response);
  assert.deepEqual(relay.page, ['msg_fixture_1', 'msg_fixture_2', 'msg_fixture_live']);
  assert.equal(relay.requests, 2);
});

test('a quiet reload asks once', async () => {
  const relay = harness();
  const { response, stale } = await loadKeepingLiveRows(relay.load, relay.getLiveRowEpoch);
  assert.equal(stale, false);
  assert.deepEqual(response.messages, ['msg_fixture_1', 'msg_fixture_2']);
  assert.equal(relay.requests, 1);
});

test('rows arriving during every attempt leave the answer marked stale', async () => {
  const relay = harness();
  for (let index = 0; index < LIVE_ROW_RELOAD_ATTEMPTS; index += 1) relay.arriveDuringRequest(`msg_fixture_burst_${index}`);
  const { stale } = await loadKeepingLiveRows(relay.load, relay.getLiveRowEpoch);
  assert.equal(stale, true);
  assert.equal(relay.requests, LIVE_ROW_RELOAD_ATTEMPTS);
  // The caller leaves the page as it is: every row is still there.
  assert.equal(relay.page.length, 2 + LIVE_ROW_RELOAD_ATTEMPTS);
});

test('a failed request is handed back at once', async () => {
  let liveRows = 0;
  let requests = 0;
  const { response, stale } = await loadKeepingLiveRows(async () => {
    requests += 1;
    liveRows += 1;
    return null;
  }, () => liveRows);
  assert.equal(response, null);
  assert.equal(stale, false);
  assert.equal(requests, 1);
});

test('a stale answer is kept off the live transcript but replaces a drawn copy', async () => {
  // The live poll: the page already has every row, the answer lacks some.
  assert.equal(shouldKeepTranscriptOnReload({ stale: true }), true);
  assert.equal(shouldKeepTranscriptOnReload({ stale: false }), false);
  // After a switch drew the kept copy: rows stored while the reader was away
  // are only in the answer, so it goes on the page even when stale.
  assert.equal(shouldKeepTranscriptOnReload({ stale: true, showsLiveTranscript: false }), false);
  assert.equal(shouldKeepTranscriptOnReload({ stale: false, showsLiveTranscript: false }), false);
  // A jump into the history wins either way.
  assert.equal(shouldKeepTranscriptOnReload({ jumped: true, showsLiveTranscript: false }), true);
  assert.equal(shouldKeepTranscriptOnReload({ jumped: true, stale: true }), true);

  // End to end: the drawn copy lacks a row stored while the reader was away,
  // and live rows land during every attempt.
  const relay = harness();
  relay.render({ messages: ['msg_fixture_1'] });
  for (let index = 0; index < LIVE_ROW_RELOAD_ATTEMPTS; index += 1) relay.arriveDuringRequest(`msg_fixture_burst_${index}`);
  const { response, stale } = await loadKeepingLiveRows(relay.load, relay.getLiveRowEpoch);
  assert.equal(stale, true);
  if (!shouldKeepTranscriptOnReload({ stale, showsLiveTranscript: false })) relay.render(response);
  assert.ok(relay.page.includes('msg_fixture_2'), 'the row stored while away is on the page');
});
