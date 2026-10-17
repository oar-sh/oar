// ⋯ → About OAR: the menu entry's label and the modal (about-view.mjs builds
// its HTML from GET /api/about).

import {
  closeSummaryModal,
  escHtml,
  getUpdateState,
  openSummaryModal,
  renderSummaryModalContent,
  setSummaryModalLoading,
} from './store.js';
import { apiFetchOrThrow } from './api-client.js';
import { openSettingsModal } from './settings-modal.js';
import { aboutMenuLabel, buildAboutModalHtml } from './about-view.mjs';

const ABOUT_KIND = 'about';
const ABOUT_TITLE = 'About OAR';

/** The entry carries the running version; /api/status brings it on load. */
export function syncAboutMenuLabel(version = getUpdateState()?.runningVersion) {
  const button = document.getElementById('chat-menu-about');
  if (button) button.textContent = aboutMenuLabel(version);
}

function bindAboutModalActions() {
  const body = document.getElementById('summary-modal-body');
  const button = body?.querySelector('[data-about-open-settings]');
  if (!button) return;
  button.addEventListener('click', (event) => {
    event.preventDefault();
    closeSummaryModal();
    openSettingsModal('general');
    document.getElementById('update-auto-check-toggle')?.scrollIntoView?.({ block: 'center' });
  });
}

async function loadAboutAndRender() {
  const about = await apiFetchOrThrow('/api/about');
  if (!about) throw new Error('The relay is not reachable right now.');
  renderSummaryModalContent({
    title: ABOUT_TITLE,
    subtitle: about.version ? `Version ${about.version}` : '',
    bodyHtml: buildAboutModalHtml(about),
    refresh: loadAboutAndRender,
    kind: ABOUT_KIND,
  });
  bindAboutModalActions();
  syncAboutMenuLabel(about.version);
}

export async function showAbout() {
  openSummaryModal({
    title: ABOUT_TITLE,
    subtitle: 'Loading…',
    bodyHtml: '<div class="summary-loading">Reading the relay…</div>',
    refresh: loadAboutAndRender,
    kind: ABOUT_KIND,
  });
  setSummaryModalLoading(true);
  try {
    await loadAboutAndRender();
  } catch (error) {
    renderSummaryModalContent({
      title: ABOUT_TITLE,
      subtitle: 'Unable to load',
      bodyHtml: `<div class="summary-error">${escHtml(error?.message || 'Unknown error')}</div>`,
      refresh: loadAboutAndRender,
      kind: ABOUT_KIND,
    });
  } finally {
    setSummaryModalLoading(false);
  }
}
