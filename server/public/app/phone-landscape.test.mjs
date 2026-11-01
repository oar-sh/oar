import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

import {
  PHONE_LANDSCAPE_ATTRIBUTE,
  PHONE_LANDSCAPE_CHANGE_EVENT,
  isPhoneLandscape,
  isPhoneLandscapeLayout,
  readPhoneLandscapeInputs,
  shouldCollapseListAfterPick,
  syncPhoneLandscapeAttribute,
} from './phone-landscape.mjs';

const sideways = { coarsePointer: true, screenWidth: 915, screenHeight: 412, orientationType: 'landscape-primary' };

test('a touch phone on its side is phone landscape', () => {
  assert.equal(isPhoneLandscape(sideways), true);
  assert.equal(isPhoneLandscape({ ...sideways, orientationType: 'landscape-secondary' }), true);
});

test('portrait, a mouse, or a tablet is not', () => {
  assert.equal(isPhoneLandscape({ ...sideways, screenWidth: 412, screenHeight: 915, orientationType: 'portrait-primary' }), false);
  assert.equal(isPhoneLandscape({ ...sideways, coarsePointer: false }), false);
  // A tablet's short side is over 500px.
  assert.equal(isPhoneLandscape({ ...sideways, screenWidth: 1280, screenHeight: 800 }), false);
  assert.equal(isPhoneLandscape({ ...sideways, screenWidth: 0, screenHeight: 0 }), false);
  assert.equal(isPhoneLandscape(), false);
});

test('the screen orientation decides, not the screen sides, when it is known', () => {
  // A portrait phone whose browser reports unswapped sides still reads as portrait.
  assert.equal(isPhoneLandscape({ ...sideways, orientationType: 'portrait-primary' }), false);
  // Without screen.orientation: window.orientation, then the sides.
  assert.equal(isPhoneLandscape({ ...sideways, orientationType: '', screenWidth: 390, screenHeight: 844, orientationAngle: 90 }), true);
  assert.equal(isPhoneLandscape({ ...sideways, orientationType: '', screenWidth: 390, screenHeight: 844, orientationAngle: 0 }), false);
  assert.equal(isPhoneLandscape({ ...sideways, orientationType: '' }), true);
  assert.equal(isPhoneLandscape({ ...sideways, orientationType: '', screenWidth: 412, screenHeight: 915 }), false);
});

test('a pick collapses only the persistent list of a phone on its side, and only when it is open', () => {
  assert.equal(shouldCollapseListAfterPick({ phoneLandscape: true, overlayList: false, listOpen: true }), true);
  assert.equal(shouldCollapseListAfterPick({ phoneLandscape: true, overlayList: false, listOpen: false }), false);
  // The overlay list (a narrow phone) closes on its own in openConversation.
  assert.equal(shouldCollapseListAfterPick({ phoneLandscape: true, overlayList: true, listOpen: true }), false);
  assert.equal(shouldCollapseListAfterPick({ phoneLandscape: false, overlayList: false, listOpen: true }), false);
  assert.equal(shouldCollapseListAfterPick(), false);
});

test('the attribute follows the window and a flip is announced once', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
  const win = dom.window;
  let coarse = true;
  let orientationType = 'landscape-primary';
  win.matchMedia = (query) => ({ matches: query === '(pointer: coarse)' ? coarse : false });
  Object.defineProperty(win.screen, 'width', { configurable: true, get: () => (orientationType.startsWith('landscape') ? 915 : 412) });
  Object.defineProperty(win.screen, 'height', { configurable: true, get: () => (orientationType.startsWith('landscape') ? 412 : 915) });
  Object.defineProperty(win.screen, 'orientation', { configurable: true, get: () => ({ type: orientationType }) });
  const flips = [];
  win.addEventListener(PHONE_LANDSCAPE_CHANGE_EVENT, (event) => flips.push(event.detail.phoneLandscape));

  assert.deepEqual(readPhoneLandscapeInputs(win), {
    coarsePointer: true, screenWidth: 915, screenHeight: 412, orientationType: 'landscape-primary', orientationAngle: null,
  });
  assert.equal(syncPhoneLandscapeAttribute(win), true);
  assert.equal(win.document.documentElement.hasAttribute(PHONE_LANDSCAPE_ATTRIBUTE), true);
  assert.equal(isPhoneLandscapeLayout(win.document), true);
  assert.equal(syncPhoneLandscapeAttribute(win), true);
  assert.deepEqual(flips, [true], 'no event without a change');

  orientationType = 'portrait-primary';
  assert.equal(syncPhoneLandscapeAttribute(win), false);
  assert.equal(isPhoneLandscapeLayout(win.document), false);
  orientationType = 'landscape-primary';
  coarse = false;
  assert.equal(syncPhoneLandscapeAttribute(win), false);
  assert.deepEqual(flips, [true, false]);
});
