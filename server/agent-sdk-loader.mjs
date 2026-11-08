import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  agentSdkFromCheckout,
  getAgentSdkDescriptor,
  isValidAgentSdkInstall,
  writeAgentSdkLease,
} from './services/agent-sdk-paths.mjs';
import { currentBootId, processIdentity } from './services/relay-singleton-guard.mjs';

/**
 * Loads an agent SDK the relay installs on demand (agent-sdk-store.mjs),
 * wherever this process has it:
 *
 *   1. OAR_AGENT_SDK_DIR_<SDK>: the folder the relay launched this worker
 *      with, kept for the worker's whole life;
 *   2. in the relay itself, the store's ready folder (setAgentSdkStore);
 *   3. in a git checkout that has it installed, the package's devDependency.
 *
 * Otherwise AgentSdkMissingError. A folder is imported through its entry
 * file by path: the bare imports in it resolve from the folder's own
 * node_modules, so there is no NODE_PATH and no exports map to read.
 */

export const AGENT_SDK_MISSING_CODE = 'AGENT_SDK_MISSING';

export class AgentSdkMissingError extends Error {
  constructor(sdk, detail = '') {
    const label = getAgentSdkDescriptor(sdk)?.label || sdk;
    super(`${label} is not installed${detail ? ` (${detail})` : ''}.`);
    this.name = 'AgentSdkMissingError';
    this.code = AGENT_SDK_MISSING_CODE;
    this.sdk = sdk;
  }
}

export function agentSdkDirEnvName(sdk) {
  return `OAR_AGENT_SDK_DIR_${String(sdk || '').toUpperCase()}`;
}

let relayStore = null;
const cache = new Map();
const leased = new Set();

/**
 * The relay registers its store at start. From then on the environment's
 * folder is not looked at in this process: a relay started from inside a
 * worker's session would otherwise take that worker's SDK.
 */
export function setAgentSdkStore(store) {
  relayStore = store || null;
  cache.clear();
}

// What a checkout's devDependency gives, in the shape of the entry files.
const CHECKOUT_IMPORTS = {
  claude: {
    main: async () => ({ ...(await import('@anthropic-ai/claude-agent-sdk')), z: await import('zod') }),
  },
  cursor: {
    main: () => import('@cursor/sdk'),
    sqlite: () => import('@cursor/sdk/sqlite'),
  },
};

function importFromDir(descriptor, dir, entry, { lease, env }) {
  if (!isValidAgentSdkInstall(dir, { id: descriptor.id })) {
    throw new AgentSdkMissingError(descriptor.id, `${dir} is not a finished install`);
  }
  if (lease && !leased.has(dir)) {
    leased.add(dir);
    writeAgentSdkLease(dir, {
      holder: (() => { try { return processIdentity(process.pid); } catch { return null; } })(),
      bootId: currentBootId(),
    });
  }
  return import(pathToFileURL(path.join(dir, descriptor.entries[entry])).href);
}

/** Where loadAgentSdk would take the SDK from: { source, dir }, or null. */
export function resolveAgentSdkSource(sdk, { env = process.env, store = relayStore, fromCheckout } = {}) {
  const descriptor = getAgentSdkDescriptor(sdk);
  if (!descriptor) return null;
  if (!store) {
    const dir = String(env?.[agentSdkDirEnvName(descriptor.id)] || '').trim();
    if (dir) return { source: 'env', dir: path.resolve(dir) };
  } else {
    const dir = store.readyDir(descriptor.id);
    if (dir) return { source: 'store', dir };
  }
  if (fromCheckout ?? agentSdkFromCheckout(descriptor.id, { env })) return { source: 'checkout', dir: null };
  return null;
}

/**
 * The SDK's module namespace (`entry`: 'main', or 'sqlite' for Cursor's
 * local store). Claude's carries `z`, the zod its tools are written with.
 */
export async function loadAgentSdk(sdk, { entry = 'main', env = process.env, store = relayStore, fromCheckout } = {}) {
  const descriptor = getAgentSdkDescriptor(sdk);
  if (!descriptor || !descriptor.entries[entry]) throw new Error(`Unknown agent SDK entry: ${sdk}/${entry}`);
  const found = resolveAgentSdkSource(descriptor.id, { env, store, fromCheckout });
  if (!found) throw new AgentSdkMissingError(descriptor.id);
  const key = `${descriptor.id}:${entry}:${found.source}:${found.dir || ''}`;
  if (!cache.has(key)) {
    const loading = found.source === 'checkout'
      ? CHECKOUT_IMPORTS[descriptor.id][entry]()
      // The relay's own import (model discovery) holds the folder for the
      // relay's life, a worker's for its own: both lease it.
      : importFromDir(descriptor, found.dir, entry, { lease: true, env });
    cache.set(key, loading);
    loading.catch(() => { if (cache.get(key) === loading) cache.delete(key); });
  }
  return cache.get(key);
}
