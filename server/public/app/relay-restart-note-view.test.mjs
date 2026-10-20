import test from 'node:test';
import assert from 'node:assert/strict';

import * as server from '../../services/restart-resume-service.mjs';
import {
  RESTART_RESUME_KIND,
  RESTART_RESUME_LEAD,
  isRestartResumeNote,
  renderRestartResumeNoteHtml,
} from './relay-restart-note-view.mjs';

test('the browser copy matches the relay service', () => {
  assert.equal(RESTART_RESUME_KIND, server.RESTART_RESUME_KIND);
  assert.equal(RESTART_RESUME_LEAD, server.RESTART_RESUME_LEAD);
});

test('only the relay\'s user-role note of that kind is one', () => {
  assert.equal(isRestartResumeNote({ role: 'user', kind: RESTART_RESUME_KIND }), true);
  assert.equal(isRestartResumeNote({ role: 'assistant', kind: RESTART_RESUME_KIND }), false);
  assert.equal(isRestartResumeNote({ role: 'user', kind: 'relay-event' }), false);
  assert.equal(isRestartResumeNote({ role: 'user' }), false);
});

test('the row is folded to one relay line and opens to the note without its lead, escaped', () => {
  const text = server.buildRestartResumeNoteText({ restartedAt: Date.parse('2026-03-02T10:00:00.000Z') });
  const html = renderRestartResumeNoteHtml({ role: 'user', kind: RESTART_RESUME_KIND, text: `${text} <b>` }, { timeText: '10:01' });
  assert.match(html, /^<details class="relay-event-row relay-restart-note">/);
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.match(html, /<span class="relay-event-tag"[^>]*>relay<\/span>/);
  assert.match(html, /Relay restarted · the interrupted turn was asked to carry on/);
  assert.match(html, /<span class="relay-event-time">10:01<\/span>/);
  assert.match(html, /the relay restarted at 2026-03-02 10:00 UTC/);
  assert.doesNotMatch(html, /Automatic message from OAR/);
  assert.match(html, /&lt;b&gt;/);
});
