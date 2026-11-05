#!/usr/bin/env node
/**
 * Adopt an @owen/foundry-core release: fetch the tarball into vendor/, repin,
 * npm install, prove it.
 *
 *   node tools/adopt-foundry-core.mjs 0.1.0
 *   node tools/adopt-foundry-core.mjs --newest
 *   node tools/adopt-foundry-core.mjs --check                 # what is pinned, and what is newest
 *   node tools/adopt-foundry-core.mjs --from <path/to/owen-foundry-core-X.Y.Z.tgz>
 *                                                              # an unreleased local pack
 *
 * The consumer-side half of packages/foundry-core/tools/release.mjs, cloned
 * from tools/adopt-crucible-release.mjs and run from a CONSUMER'S root
 * (BookForge copies this file into its own tools/). It replaces re-vendoring:
 * the commit it leaves behind is `chore: foundry-core <version>`.
 *
 * WHAT A PIN LOOKS LIKE. One dependency line,
 * `"@owen/foundry-core": "file:vendor/owen-foundry-core-X.Y.Z.tgz"`, in the
 * package.json at `.` or `app/` that depends on the Crucible client (the same
 * search adopt-crucible-release makes; the library peer-depends on it, so the
 * manifest that pins the one pins the other). Any string key naming
 * foundry-core whose prose quotes the old version is rewritten in place, as
 * adopt-crucible-release does for its `//crucible-*` notes. The FIRST adoption
 * — no pin yet — adds the line; --check says which case this is.
 *
 * WHAT IT CHECKS AT THE END. It asks the installed package its version rather
 * than trusting the filename, and it asks where the library's peers resolve
 * FROM INSIDE the installed library versus from the consumer: two copies of
 * `@crucible/client` (or of the library) mean two registries, two host records
 * and `instanceof CrucibleRefused` failing across them, silently. That is the
 * single-instance hazard in docs/FOUNDRY-CORE-PLAN.md §5, refused here by name.
 *
 * A release's tarball is checked against the release's `.sha256` asset before
 * anything on disk changes. Nothing else here is reversible by itself: it edits
 * package.json, deletes the old tarball and runs `npm install`. It is all inside
 * the repo, so `git checkout` undoes it, but --check first is free.
 *
 * `.mjs` for the same reason as adopt-crucible-release: BookForge's package.json
 * has no `type`, Foundry's says `"module"`; one file must mean one thing in both.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_SLUG = 'telltaleatheist/foundry';
const NAME = '@owen/foundry-core';
const TAG_PREFIX = 'foundry-core-v';
const ANCHOR = '@crucible/client';
const SEMVER = /^\d+\.\d+\.\d+$/;
const TARBALL = /^owen-foundry-core-(\d+\.\d+\.\d+)(?:-[A-Za-z0-9.]+)?\.tgz$/;

function die(message) {
  console.error(`adopt: ${message}`);
  process.exit(1);
}

/** The package.json that pins the Crucible client (and so, the library), and where its vendor/ is. */
export function findManifest() {
  const roots = ['.', 'app'];
  for (const root of roots) {
    const file = path.resolve(root, 'package.json');
    if (!fs.existsSync(file)) continue;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed.dependencies?.[ANCHOR]) return { file, dir: path.resolve(root), parsed };
  }
  die(`no package.json in ${roots.join(' or ')} depends on ${ANCHOR}; run this from a consumer's root (BookForge's)`);
}

/**
 * The version the pin names: null when there is no pin yet, refused when the
 * dependency is something other than a vendored tarball (a `file:../` directory
 * dependency is how Foundry's own app/ consumes the library; it is not adopted).
 */
export function pinnedVersion(parsed) {
  const specifier = parsed.dependencies?.[NAME];
  if (specifier === undefined) return null;
  const match = /^file:vendor\/(owen-foundry-core-[^/]+\.tgz)$/.exec(specifier);
  const version = match && TARBALL.exec(match[1]);
  if (!version) die(`${NAME} is pinned as ${specifier}, which is not a vendored release tarball`);
  return version[1];
}

/** Every release of the library, newest first (this repo's plain v* tags are the desktop installers). */
async function libraryReleases() {
  const response = await fetch(`https://api.github.com/repos/${REPO_SLUG}/releases?per_page=100`,
    { headers: { Accept: 'application/vnd.github+json' } });
  if (!response.ok) die(`GitHub answered ${response.status} asking for ${REPO_SLUG}'s releases`);
  const releases = await response.json();
  return releases
    .map((release) => release.tag_name)
    .filter((tag) => tag.startsWith(TAG_PREFIX) && SEMVER.test(tag.slice(TAG_PREFIX.length)))
    .map((tag) => tag.slice(TAG_PREFIX.length));
}

async function newestRelease() {
  const versions = await libraryReleases();
  if (versions.length === 0) die(`${REPO_SLUG} has no ${TAG_PREFIX}* release yet`);
  return versions[0];
}

async function fetchAsset(url, what) {
  const response = await fetch(url);
  if (!response.ok) die(`${what} is not published (GitHub answered ${response.status} for ${url})`);
  return Buffer.from(await response.arrayBuffer());
}

/** The release's tarball, checked against its .sha256 before it is written anywhere. */
async function downloadRelease(version, into) {
  const filename = `owen-foundry-core-${version}.tgz`;
  const base = `https://github.com/${REPO_SLUG}/releases/download/${TAG_PREFIX}${version}/${filename}`;
  const bytes = await fetchAsset(base, filename);
  if (bytes.length === 0) die(`${filename} downloaded as zero bytes`);
  const listed = (await fetchAsset(`${base}.sha256`, `${filename}.sha256`)).toString('utf8').trim().split(/\s+/)[0];
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (listed !== actual) die(`${filename} hashes to ${actual}, but the release lists ${listed}; nothing was changed`);
  fs.writeFileSync(path.join(into, filename), bytes);
  console.log(`  ${filename}  (${bytes.length.toLocaleString()} bytes, sha256 ${actual.slice(0, 12)}… matches)`);
  return filename;
}

/** A local pack (`npm pack` in packages/foundry-core), copied in under its own name. */
function copyLocal(from, into) {
  const filename = path.basename(from);
  if (!TARBALL.test(filename)) die(`${from} is not named owen-foundry-core-X.Y.Z[-label].tgz`);
  if (!fs.existsSync(from)) die(`${from} does not exist`);
  fs.copyFileSync(from, path.join(into, filename));
  console.log(`  ${filename}  (${fs.statSync(from).size.toLocaleString()} bytes, local)`);
  return filename;
}

/**
 * Point the dependency at the new tarball and rewrite the prose that names the
 * old version. A first adoption appends the dependency instead; npm sorts the
 * block on its next write, so the line's position is not ours to pick.
 */
function repin(manifest, from, filename) {
  let text = fs.readFileSync(manifest.file, 'utf8');
  const line = `"${NAME}": "file:vendor/${filename}"`;
  const changed = [NAME];
  if (from === null) {
    const deps = /"dependencies"\s*:\s*\{/.exec(text);
    if (!deps) die(`${manifest.file} has no dependencies block to add ${NAME} to`);
    const indent = /\n(\s+)"/.exec(text.slice(deps.index + deps[0].length))?.[1] ?? '    ';
    text = `${text.slice(0, deps.index + deps[0].length)}\n${indent}${line},${text.slice(deps.index + deps[0].length)}`;
  } else {
    const pin = new RegExp(`"${NAME.replace('/', '\\/')}": "file:vendor/owen-foundry-core-[^"]+\\.tgz"`);
    if (!pin.test(text)) die(`could not find the pin line for ${NAME} (${from})`);
    text = text.replace(pin, line);
    const to = TARBALL.exec(filename)[1];
    for (const [key, value] of Object.entries(manifest.parsed)) {
      if (!/foundry-?core/i.test(key) || typeof value !== 'string' || !value.includes(from) || from === to) continue;
      const before = JSON.stringify(value);
      if (!text.includes(before)) die(`could not find the prose for ${key} to update`);
      text = text.replace(before, JSON.stringify(value.split(from).join(to)));
      changed.push(key);
    }
  }
  fs.writeFileSync(manifest.file, text);
  return changed;
}

/** `node -e` from a directory, so resolution starts where npm just installed. */
function resolveFrom(dir, expression) {
  const probe = spawnSync(process.execPath, ['-e', `process.stdout.write(String(${expression}))`],
    { cwd: dir, encoding: 'utf8' });
  if (probe.status !== 0) return { ok: false, error: (probe.stderr || probe.stdout).trim() };
  return { ok: true, value: probe.stdout.trim() };
}

/** The installed library's version, and one resolved copy of each peer for app and library alike. */
function verify(manifest) {
  const version = resolveFrom(manifest.dir, `require('${NAME}/package.json').version`);
  if (!version.ok) die(`${NAME} is not resolvable after npm install:\n${version.error}`);
  const where = resolveFrom(manifest.dir, `require('path').dirname(require.resolve('${NAME}/package.json'))`);
  const installed = JSON.parse(fs.readFileSync(path.join(where.value, 'package.json'), 'utf8'));
  const doubled = [];
  for (const peer of Object.keys(installed.peerDependencies ?? {})) {
    const expr = `require('fs').realpathSync(require.resolve('${peer}/package.json'))`;
    const fromApp = resolveFrom(manifest.dir, expr);
    const fromLib = resolveFrom(where.value, expr);
    if (!fromApp.ok || !fromLib.ok) die(`peer ${peer} does not resolve (${fromApp.ok ? fromLib.error : fromApp.error})`);
    if (fromApp.value !== fromLib.value) doubled.push(`${peer}: app ${fromApp.value}, library ${fromLib.value}`);
  }
  if (doubled.length > 0) {
    die(`the library and the app resolve different copies of their shared peers — two registries, two host records:\n  ${doubled.join('\n  ')}`);
  }
  return version.value;
}

async function main() {
  const args = process.argv.slice(2);
  const manifest = findManifest();
  const from = pinnedVersion(manifest.parsed);
  const shown = path.relative(process.cwd(), manifest.file) || 'package.json';
  const vendor = path.join(manifest.dir, 'vendor');

  if (args.includes('--check')) {
    console.log(`adopt: ${shown} ${from === null ? `does not pin ${NAME} yet` : `pins ${from}`}`);
    const versions = await libraryReleases();
    console.log(`adopt: the newest published release is ${versions[0] ?? '(none yet)'}`);
    return;
  }

  const fromIndex = args.indexOf('--from');
  const local = fromIndex >= 0 ? args[fromIndex + 1] : null;
  if (fromIndex >= 0 && !local) die('--from needs a tarball path');
  let to;
  if (local) to = (TARBALL.exec(path.basename(local)) ?? die(`${local} is not named owen-foundry-core-X.Y.Z[-label].tgz`))[1];
  else if (args.includes('--newest')) to = await newestRelease();
  else to = args.find((value) => SEMVER.test(value)) ?? die('name a release (0.1.0), or pass --newest, --from <tgz>, or --check');

  const pinnedFile = from === null ? null : /file:vendor\/(.+)$/.exec(manifest.parsed.dependencies[NAME])[1];
  if (!local && to === from && pinnedFile === `owen-foundry-core-${to}.tgz`) {
    console.log(`adopt: already pinned to ${to}; nothing to do`);
    return;
  }
  console.log(`adopt: ${from ?? '(no pin)'} -> ${to}${local ? ' (local pack)' : ''}`);

  fs.mkdirSync(vendor, { recursive: true });
  console.log('adopt: fetching');
  const filename = local ? copyLocal(path.resolve(local), vendor) : await downloadRelease(to, vendor);

  const changed = repin(manifest, from, filename);
  console.log(`adopt: repinned ${changed.join(', ')}`);

  // Only after the new bytes are on disk and the manifest names them: every
  // other foundry-core tarball leaves vendor/, so vendor/ holds what is pinned.
  for (const file of fs.readdirSync(vendor).filter((it) => TARBALL.test(it) && it !== filename)) {
    fs.unlinkSync(path.join(vendor, file));
    console.log(`adopt: removed ${file}`);
  }

  console.log('adopt: npm install');
  const install = spawnSync('npm', ['install', '--no-audit', '--no-fund'],
    { cwd: manifest.dir, stdio: 'inherit', shell: process.platform === 'win32' });
  if (install.status !== 0) die('npm install failed; the pin is updated but the install is not');

  const actual = verify(manifest);
  if (actual !== to) die(`asked for ${to} but the installed ${NAME} says ${actual}; the tarball and the version it carries disagree`);
  console.log(`adopt: ${NAME} reports ${actual}; its peers resolve to one copy each`);
  console.log(`adopt: ${filename} adopted. Run the consumer's keepers before committing.`);
}

// Only when RUN, never when imported: a keeper can import pinnedVersion to
// check it against the pin the consumer carries without downloading anything.
const invokedDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
  main().catch((error) => die(error.stack || String(error)));
}
