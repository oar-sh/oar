'use strict';

// What the relay does once at start about the Copilot Extension engine it no
// longer has: a stored engine choice of "extension" is named, and the wrapper
// earlier versions wrote into the Copilot CLI's extensions folder is removed.

const COPILOT_ENGINE_SETTING_KEY = 'copilot_engine';

/**
 * The one boot log line for a stored Copilot engine choice of "extension",
 * or null for any other value and for none. Copilot runs on the SDK worker
 * whatever the row says. Nothing stored is changed: a downgrade finds its
 * value as it was.
 */
export function retiredCopilotEngineLine({ readSetting = null } = {}) {
  if (typeof readSetting !== 'function') return null;
  let value = null;
  try { value = readSetting(COPILOT_ENGINE_SETTING_KEY); } catch {}
  if (String(value ?? '').trim().toLowerCase() !== 'extension') return null;
  return `the Copilot Extension engine is gone, Copilot runs on the SDK worker; ignoring ${COPILOT_ENGINE_SETTING_KEY}=extension (app setting)`;
}

/**
 * Removes the generated wrapper through `remove`
 * (removeGeneratedCopilotWrapper in oar-cli-helpers.mjs) and logs one line
 * when it was removed or could not be; nothing for a wrapper that is absent,
 * not a generated one, or of an install whose extension is still there.
 * Never throws: a clean-up that fails must not stop the relay's start.
 */
export function cleanUpCopilotWrapperAtStart({ remove = null, log = () => {} } = {}) {
  let result = null;
  try {
    result = typeof remove === 'function' ? remove() : null;
  } catch (error) {
    result = { status: 'failed', error };
  }
  let line = null;
  if (result?.status === 'removed') {
    line = `removed the Copilot CLI extension wrapper of an earlier version: ${result.path}`;
  } else if (result?.status === 'failed') {
    const where = result.path ? ` ${result.path}` : '';
    line = `could not remove the Copilot CLI extension wrapper of an earlier version${where}: ${result.error?.message || result.error || 'unknown error'}; the Copilot CLI may report an extension that fails to load until the file is deleted`;
  }
  if (line) {
    try { log(line); } catch {}
  }
  return result;
}
