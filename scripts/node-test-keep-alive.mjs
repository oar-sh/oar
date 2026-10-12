// Preloaded into every unit test file by `npm test`.
//
// The worker tests await promises that only an unref'd timer settles (the
// workers' lifecycle polls are unref'd so they never hold a real process
// open). Since Node 23 the test runner keeps a file's process alive while a
// test is pending; Node 22's runner lets the event loop drain and cancels the
// test with "Promise resolution is still pending but the event loop has
// already resolved". On Node 22 a ref'd timer stands in from the file's first
// test until its tests are done; it starts lazily because a file that
// registers no tests never runs the `after` hook. On newer Node this module
// does nothing.

import { after, beforeEach } from 'node:test';

if (Number(process.versions.node.split('.')[0]) < 23) {
  let keepAlive = null;
  beforeEach(() => { keepAlive ??= setInterval(() => {}, 2 ** 30); });
  after(() => clearInterval(keepAlive));
}
