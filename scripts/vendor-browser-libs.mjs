#!/usr/bin/env node
// Copies the browser libraries the web UI loads (marked, KaTeX with mhchem and
// its fonts, highlight.js with its prebuilt files) from the installed npm
// packages into server/public/vendor/, so the page loads no code from a
// third-party server. The npm devDependencies, at exact versions, are the
// source of truth; the copies are committed and server/vendor-browser-libs.test.mjs
// proves each one is byte-identical to the installed package.
//
// Usage: npm ci --ignore-scripts && node scripts/vendor-browser-libs.mjs
//
// Layout: server/public/vendor/<package>@<version>/<path inside the package>,
// plus server/public/vendor/manifest.json (package, version, path, SHA-256 and
// the SRI hash index.html uses for every file). No file is modified; the
// script reads node_modules only, never a lockfile.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const VENDOR_DIR = path.join(repoRoot, 'server', 'public', 'vendor');
export const MANIFEST_NAME = 'manifest.json';

// Each entry: the package, the files in it the page needs (a trailing slash
// takes every file directly in that folder), and its licence file.
export const VENDOR_SPEC = [
  {
    package: 'marked',
    files: ['marked.min.js', 'LICENSE.md'],
  },
  {
    package: 'katex',
    // katex.min.css loads the fonts by relative path (fonts/KaTeX_*), so the
    // whole fonts folder comes along and keeps its place next to the CSS.
    files: ['dist/katex.min.css', 'dist/katex.min.js', 'dist/contrib/mhchem.min.js', 'dist/fonts/', 'LICENSE'],
  },
  {
    // highlight.js's own npm package has no prebuilt browser files; this one
    // (the project's CDN build, same publisher) has them.
    package: '@highlightjs/cdn-assets',
    files: [
      'highlight.min.js',
      'languages/nginx.min.js',
      'languages/powershell.min.js',
      'languages/x86asm.min.js',
      'styles/github-dark.min.css',
      'LICENSE',
    ],
  },
];

export function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export function sriSha384(bytes) {
  return `sha384-${crypto.createHash('sha384').update(bytes).digest('base64')}`;
}

/** `<package>@<version>` folder name under vendor/ (a scoped name keeps its scope folder). */
export function vendorFolder(packageName, version) {
  return `${packageName}@${version}`;
}

function expandFiles(packageDir, entries) {
  const out = [];
  for (const entry of entries) {
    if (entry.endsWith('/')) {
      const names = fs.readdirSync(path.join(packageDir, entry), { withFileTypes: true })
        .filter((dirent) => dirent.isFile())
        .map((dirent) => dirent.name)
        .sort();
      if (!names.length) throw new Error(`${entry} holds no files in ${packageDir}`);
      for (const name of names) out.push(`${entry}${name}`);
    } else {
      out.push(entry);
    }
  }
  return out;
}

export function readInstalledPackage(packageName, { root = repoRoot } = {}) {
  const packageDir = path.join(root, 'node_modules', ...packageName.split('/'));
  let version = '';
  try {
    version = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')).version;
  } catch {
    throw new Error(`${packageName} is not installed; run npm ci --ignore-scripts first`);
  }
  // The version becomes a folder name under vendor/ and part of a URL.
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`${packageName} has version ${JSON.stringify(version)}, not a plain x.y.z release`);
  }
  return { packageDir, version };
}

/** Where `entry` is written: always inside VENDOR_DIR, or this throws. */
export function vendorTarget(entry) {
  const target = path.resolve(VENDOR_DIR, vendorRelativePath(entry));
  const inside = path.relative(VENDOR_DIR, target);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
    throw new Error(`${vendorRelativePath(entry)} would be written outside ${VENDOR_DIR}`);
  }
  return target;
}

function assertExactDevDependency(packageName, version) {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const declared = manifest.devDependencies?.[packageName];
  if (declared !== version) {
    throw new Error(`package.json pins ${packageName} at ${declared ?? '(nothing)'}, but ${version} is installed; run npm ci --ignore-scripts`);
  }
}

export function buildVendor({ root = repoRoot } = {}) {
  const files = [];
  for (const spec of VENDOR_SPEC) {
    const { packageDir, version } = readInstalledPackage(spec.package, { root });
    for (const relPath of expandFiles(packageDir, spec.files)) {
      const bytes = fs.readFileSync(path.join(packageDir, relPath));
      files.push({
        package: spec.package,
        version,
        path: relPath,
        sha256: sha256Hex(bytes),
        integrity: sriSha384(bytes),
        bytes,
      });
    }
  }
  return files;
}

export function vendorRelativePath(entry) {
  return `${vendorFolder(entry.package, entry.version)}/${entry.path}`;
}

function main() {
  for (const spec of VENDOR_SPEC) {
    const { version } = readInstalledPackage(spec.package);
    assertExactDevDependency(spec.package, version);
  }
  const files = buildVendor();
  // Every path is checked before anything is removed or written.
  const targets = files.map(vendorTarget);
  // Start from an empty folder, so a file that left the list leaves the repo too.
  fs.rmSync(VENDOR_DIR, { recursive: true, force: true });
  for (const [index, entry] of files.entries()) {
    const target = targets[index];
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.bytes);
  }
  const manifest = {
    generatedBy: 'scripts/vendor-browser-libs.mjs',
    files: files.map(({ package: pkg, version, path: relPath, sha256, integrity }) => ({
      package: pkg, version, path: relPath, sha256, integrity,
    })),
  };
  fs.writeFileSync(path.join(VENDOR_DIR, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Wrote ${files.length} files and ${MANIFEST_NAME} to ${path.relative(repoRoot, VENDOR_DIR)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
