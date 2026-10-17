import test from 'node:test';
import assert from 'node:assert/strict';

import { describeRelayRestartError } from './relay-restart-error.mjs';

test('an HTTP answer is a refusal and names the relay\'s reason', () => {
  assert.deepEqual(
    describeRelayRestartError(Object.assign(new Error('Unauthorized'), { status: 401 })),
    { kind: 'refused', text: 'The relay refused the restart: Unauthorized' },
  );
  assert.equal(
    describeRelayRestartError({ status: 500, message: '' }).text,
    'The relay refused the restart: HTTP 500',
  );
});

test('no answer is not reported as a refusal or as a success', () => {
  const result = describeRelayRestartError(Object.assign(new Error('The relay did not answer in time.'), { status: 0 }));
  assert.equal(result.kind, 'unanswered');
  assert.match(result.text, /^The relay did not answer in time\. If it took the restart/);
  assert.equal(describeRelayRestartError(null).kind, 'unanswered');
});
