'use strict';

import { channelForVersion, compareSemverIsh, parseSemverIsh } from '../../shared/update-semver.mjs';

// Polls oar.sh/latest.json for new OAR releases. Zero-telemetry promise:
// automatic checking is OPT-IN (off unless the stored setting says '1'), so a
// default install never contacts oar.sh — only the settings toggle or an
// explicit "check now" triggers a request. OAR_NO_UPDATE_CHECK=1 is the hard
// kill switch (tests, air-gapped hosts): the runtime then never constructs
// this service, so not even manual checks can reach out.

export const UPDATE_MANIFEST_URL_DEFAULT = 'https://oar.sh/latest.json';
export const UPDATE_CHECK_INTERVAL_MS = 12 * 3_600_000;
export const UPDATE_CHECK_JITTER_MS = 3_600_000;
export const UPDATE_FETCH_TIMEOUT_MS = 5_000;

export const UPDATE_AUTO_CHECK_SETTING_KEY = 'update_auto_check_enabled';
const ETAG_SETTING_KEY = 'update_check_etag';
const RESULT_SETTING_KEY = 'update_check_result';
const DISMISSED_SETTING_KEY = 'update_dismissed_version';

export function isUpdateCheckKilled(env = process.env) {
  return String(env?.OAR_NO_UPDATE_CHECK || '').trim() === '1';
}

export function resolveUpdateManifestUrl(env = process.env) {
  return String(env?.OAR_UPDATE_MANIFEST_URL || '').trim() || UPDATE_MANIFEST_URL_DEFAULT;
}

export function createUpdateCheckService({
  runningVersion,
  installMethod = 'npm-global',
  manifestUrl = UPDATE_MANIFEST_URL_DEFAULT,
  fetchImpl = globalThis.fetch,
  readSetting,
  writeSetting,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  randomImpl = Math.random,
  nowImpl = Date.now,
  logger = console,
  onStateChange = null,
} = {}) {
  let timer = null;
  let checkInFlight = null;
  let schemaUnsupported = false;
  let schemaWarned = false;

  const channel = channelForVersion(runningVersion);

  const emit = () => {
    try {
      onStateChange?.(getSnapshot());
    } catch {}
  };

  const readResult = () => {
    try {
      const parsed = JSON.parse(String(readSetting(RESULT_SETTING_KEY) || ''));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  };

  function isAutoCheckEnabled() {
    return String(readSetting(UPDATE_AUTO_CHECK_SETTING_KEY) || '').trim() === '1';
  }

  function getSnapshot() {
    const result = readResult();
    const latest = String(result?.version || '');
    const available = !!latest && compareSemverIsh(latest, runningVersion) > 0;
    const critical = result?.critical === true;
    const dismissedVersion = String(readSetting(DISMISSED_SETTING_KEY) || '').trim();
    return {
      autoCheckEnabled: isAutoCheckEnabled(),
      runningVersion,
      installMethod,
      channel,
      available,
      version: available ? latest : null,
      notesUrl: available ? String(result?.notesUrl || '') || null : null,
      publishedAt: available ? String(result?.publishedAt || '') || null : null,
      critical: available ? critical : false,
      dismissed: available && !critical && dismissedVersion === latest,
      lastCheckedAt: result?.checkedAt || null,
      schemaUnsupported,
    };
  }

  function disarm() {
    if (timer) {
      clearTimeoutImpl(timer);
      timer = null;
    }
  }

  function arm(delayMs) {
    disarm();
    if (schemaUnsupported) return;
    timer = setTimeoutImpl(() => {
      timer = null;
      if (!isAutoCheckEnabled()) return; // opted out since arming; stay quiet
      void checkNow().finally(() => {
        if (isAutoCheckEnabled()) arm(nextDelayMs());
      });
    }, delayMs);
    timer?.unref?.();
  }

  function nextDelayMs() {
    // ±1h of jitter so a fleet of relays doesn't hit oar.sh in sync.
    return UPDATE_CHECK_INTERVAL_MS + Math.floor((randomImpl() * 2 - 1) * UPDATE_CHECK_JITTER_MS);
  }

  /** A failed check must never affect anything: all failures resolve silently. */
  async function checkNow() {
    if (schemaUnsupported) return getSnapshot();
    if (checkInFlight) return checkInFlight;
    checkInFlight = (async () => {
      try {
        const headers = { Accept: 'application/json' };
        const etag = String(readSetting(ETAG_SETTING_KEY) || '').trim();
        // Only revalidate when the cached result actually exists — an orphaned
        // ETag row would otherwise 304 forever and report nothing.
        if (etag && readResult()) headers['If-None-Match'] = etag;
        const response = await fetchImpl(manifestUrl, {
          headers,
          redirect: 'follow',
          signal: AbortSignal.timeout?.(UPDATE_FETCH_TIMEOUT_MS),
        });
        if (response.status === 304) {
          const cached = readResult();
          if (cached) {
            writeSetting(RESULT_SETTING_KEY, JSON.stringify({ ...cached, checkedAt: new Date(nowImpl()).toISOString() }));
          }
          return getSnapshot();
        }
        if (!response.ok) return getSnapshot();
        const manifest = await response.json();
        if (!manifest || typeof manifest !== 'object') return getSnapshot();
        if (manifest.schemaVersion !== 1) {
          schemaUnsupported = true;
          disarm();
          if (!schemaWarned) {
            schemaWarned = true;
            logger.warn?.(`update check: latest.json schemaVersion ${manifest.schemaVersion} is unknown to this relay; update checking stopped (update OAR manually)`);
          }
          return getSnapshot();
        }
        const entry = manifest.channels?.[channel] || manifest.channels?.stable;
        if (!entry || !parseSemverIsh(entry.version)) return getSnapshot();
        const responseEtag = String(response.headers?.get?.('etag') || '').trim();
        if (responseEtag) writeSetting(ETAG_SETTING_KEY, responseEtag);
        writeSetting(RESULT_SETTING_KEY, JSON.stringify({
          version: String(entry.version),
          notesUrl: String(entry.notesUrl || ''),
          publishedAt: String(entry.publishedAt || ''),
          critical: entry.critical === true,
          channel,
          checkedAt: new Date(nowImpl()).toISOString(),
        }));
        return getSnapshot();
      } catch {
        return getSnapshot(); // timeout, DNS, JSON garbage — all silent
      } finally {
        checkInFlight = null;
        emit();
      }
    })();
    return checkInFlight;
  }

  function setAutoCheck(enabled) {
    writeSetting(UPDATE_AUTO_CHECK_SETTING_KEY, enabled ? '1' : '0');
    if (enabled) {
      void checkNow();
      arm(nextDelayMs());
    } else {
      disarm();
    }
    emit();
    return { ok: true, autoCheckEnabled: !!enabled };
  }

  /** Boot hook: arms the poller only when the user already opted in. */
  function startIfEnabled() {
    if (!isAutoCheckEnabled()) return false;
    void checkNow();
    arm(nextDelayMs());
    return true;
  }

  function dismissVersion(version) {
    const snapshot = getSnapshot();
    if (!snapshot.available) return { ok: false, error: 'No update to dismiss' };
    if (snapshot.critical) return { ok: false, error: 'This update is marked critical and cannot be dismissed' };
    if (String(version || '').trim() !== snapshot.version) {
      return { ok: false, error: 'Version mismatch' };
    }
    writeSetting(DISMISSED_SETTING_KEY, snapshot.version);
    emit();
    return { ok: true };
  }

  function stop() {
    disarm();
  }

  return {
    startIfEnabled,
    setAutoCheck,
    isAutoCheckEnabled,
    checkNow,
    getSnapshot,
    dismissVersion,
    stop,
  };
}
