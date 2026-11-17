/**
 * Module hooks of tests/helpers/runtime-probe.mjs (registered with
 * module.register, so they run off the main thread).
 *
 * An import of a server/routes module by server/server-runtime.mjs resolves to
 * a wrapper instead: the same module, with each `register…` export replaced
 * by a function that reports the keys of its arguments to the probe and then
 * calls the original. Every other importer gets the module itself, and the
 * wrapper imports it too, so there is still one instance.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const WRAP = '?runtime-probe-wrap';
const GUARD = '?runtime-probe-database-guard';
let probeUrl = '';
let runtimeUrl = '';

export function initialize(data) {
  probeUrl = data.probeUrl;
  runtimeUrl = data.runtimeUrl;
}

const isRouteModule = (url) => /\/server\/routes\/[^/]+\.mjs$/.test(url);

export async function resolve(specifier, context, nextResolve) {
  const result = await nextResolve(specifier, context);
  if (specifier === 'better-sqlite3') {
    return { url: `${result.url}${GUARD}`, format: 'module', shortCircuit: true };
  }
  if (context.parentURL === runtimeUrl && result.url.startsWith('file:') && isRouteModule(result.url)) {
    return { ...result, url: `${result.url}${WRAP}`, shortCircuit: true };
  }
  return result;
}

/** The `register…` names a module's source exports (declarations and export lists). */
export function registerExportNames(source) {
  const names = new Set();
  for (const match of source.matchAll(/export\s+(?:async\s+)?function\s*\*?\s*(register[A-Z]\w*)/g)) names.add(match[1]);
  for (const match of source.matchAll(/export\s+(?:const|let|var)\s+(register[A-Z]\w*)/g)) names.add(match[1]);
  for (const match of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && /^register[A-Z]\w*$/.test(name)) names.add(name);
    }
  }
  return [...names].sort();
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(GUARD)) {
    const source = [
      `import { guardedDatabaseClass } from ${JSON.stringify(probeUrl)};`,
      'export default guardedDatabaseClass();',
    ].join('\n');
    return { format: 'module', source, shortCircuit: true };
  }
  if (!url.endsWith(WRAP)) return nextLoad(url, context);
  const target = url.slice(0, -WRAP.length);
  const source = fs.readFileSync(fileURLToPath(target), 'utf8');
  const quoted = JSON.stringify(target);
  const lines = [
    `import * as original from ${quoted};`,
    `import { recordRegisterCall } from ${JSON.stringify(probeUrl)};`,
    `export * from ${quoted};`,
    ...(/export\s+default\b/.test(source) ? [`export { default } from ${quoted};`] : []),
    ...registerExportNames(source).map((name) => (
      `export function ${name}(...args) { recordRegisterCall(${JSON.stringify(name)}, args); return original.${name}(...args); }`
    )),
  ];
  return { format: 'module', source: lines.join('\n'), shortCircuit: true };
}
