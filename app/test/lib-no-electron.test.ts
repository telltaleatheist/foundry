/**
 * lib-no-electron — the work code does not reach Electron, directly or through
 * anything it imports; and shared/ reaches nothing but shared/.
 *
 * ── Why (FOUNDRY-CORE-PLAN step 1, 2026-11-04) ─────────────────────────────
 *
 * Foundry's main-process logic is becoming a headless library BookForge and
 * standalone Foundry both import (docs/FOUNDRY-CORE-PLAN.md). That is only true
 * while none of it needs Electron, and the way it stopped being true before was
 * ONE import line: host-ops.ts took `broadcast` from window.ts, and with it
 * BrowserWindow reached app-settings, the Crucible files and the queue. Nobody
 * saw that by reading host-ops.ts, so this walks the graph instead.
 *
 * ── The rule ───────────────────────────────────────────────────────────────
 *
 * Every `app/electron/*.ts` is LIBRARY unless it is named in `APP_SIDE` below,
 * and a library file must not reach the `electron` package by any chain of
 * imports (static, `export … from`, `import()`, `require`, and type-only
 * imports too — a library whose types need Electron's is not headless either).
 * New files are library by default; making one app-side is an edit to this
 * list, which is a decision somebody has to write down.
 *
 * `APP_SIDE` is what legitimately owns Electron: the shell, the window, the
 * preload, Crucible's own web-UI window, and the two files whose app halves
 * step 2 splits out (ipc.ts, mount.ts) plus documents.ts' window half. Each
 * entry must actually reach Electron — one that stops is a file that has become
 * library and should leave the list, so the list cannot rot into a blanket.
 *
 * shared/ is stricter, because the renderer compiles it: no `node:` builtins,
 * no packages, nothing outside shared/ (plan §1b — true today, now enforced).
 *
 * browser/ (step 2, 2026-11-04) is the renderer-only half of the library — the
 * modules that need a canvas — and is held to the same rule with one widening:
 * it may import shared/ as well as itself, and still nothing node, nothing
 * electron, no packages.
 *
 * STEP 2 LEFT APP_SIDE AS IT WAS. ipc.ts, mount.ts and documents.ts gave their
 * work to library files (doors-*.ts, mount-work.ts, document-intake.ts), and each
 * still keeps a dialog, a window or the scheme registration, so each still
 * reaches electron and stays listed.
 *
 * ── STEP 3 (2026-11-04): THE LIBRARY IS A PACKAGE ──────────────────────────
 *
 * Every library file left app/electron for `packages/foundry-core/src/node`,
 * shared/ became `src/shared` and browser/ `src/shared-browser`; the app
 * imports them as `@owen/foundry-core/node/*`, `/shared/*`, `/browser/*`.
 * APP_SIDE did not change, and is now exactly what app/electron holds. The walk
 * follows those package specifiers into the package's sources, so a chain from
 * an app file through the library is still a chain. And the PACKAGE is held to
 * more than "its main-process half is headless": no file anywhere under its
 * src/ (the engine included) imports electron, its package.json does not name
 * electron at all, and its sources import nothing outside the package except
 * the repo's package.json (the engine's version, inlined by the bundler).
 */
import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

const APP = path.dirname(import.meta.dir);
const REPO = path.dirname(APP);
const ELECTRON = path.join(APP, 'electron');
const PKG = path.join(REPO, 'packages', 'foundry-core');
const SRC = path.join(PKG, 'src');
const NODE = path.join(SRC, 'node');
const SHARED = path.join(SRC, 'shared');
const BROWSER = path.join(SRC, 'shared-browser');

/** `@owen/foundry-core/<subpath>` to the source directory (or file) it names. */
const PACKAGE_SUBPATHS: ReadonlyArray<[string, string]> = [
  ['@owen/foundry-core/node/', NODE],
  ['@owen/foundry-core/shared/', SHARED],
  ['@owen/foundry-core/browser/', BROWSER],
  ['@owen/foundry-core/host', path.join(NODE, 'host')],
  ['@owen/foundry-core/engine', path.join(NODE, 'engine')],
];

const APP_SIDE = new Set([
  'main.ts',
  'window.ts',
  'preload.ts',
  'crucible-ui.ts',
  'ipc.ts',
  'ipc-app.ts',
  'ipc-ask.ts',
  'ipc-book.ts',
  'ipc-capture.ts',
  'ipc-crucible-install.ts',
  'ipc-crucible.ts',
  'ipc-documents.ts',
  'ipc-host.ts',
  'ipc-plans.ts',
  'ipc-projects.ts',
  'ipc-queue.ts',
  'ipc-slots.ts',
  'mount.ts',
  'documents.ts',
]);

function importsOf(file: string): string[] {
  const info = ts.preProcessFile(fs.readFileSync(file, 'utf8'), true, true);
  return info.importedFiles.map((ref) => ref.fileName);
}

const rel = (file: string): string => path.relative(REPO, file).replace(/\\/g, '/');

function resolveCandidates(base: string, from: string, spec: string): string {
  for (const candidate of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`${rel(from)} imports '${spec}', which resolves to no file`);
}

/** The package source a `@owen/foundry-core/…` specifier names, or null for any other package. */
function resolvePackage(from: string, spec: string): string | null {
  for (const [prefix, dir] of PACKAGE_SUBPATHS) {
    if (prefix.endsWith('/') ? spec.startsWith(prefix) : spec === prefix) {
      return resolveCandidates(prefix.endsWith('/') ? path.join(dir, spec.slice(prefix.length)) : dir, from, spec);
    }
  }
  if (spec === '@owen/foundry-core' || spec.startsWith('@owen/foundry-core/')) {
    throw new Error(`${rel(from)} imports '${spec}', which is not one of the package's exports`);
  }
  return null;
}

/** A relative specifier to the file it names, or null for one that is not ours. */
function resolveLocal(from: string, spec: string): string {
  return resolveCandidates(path.resolve(path.dirname(from), spec), from, spec);
}

/** The chain from `start` to the `electron` package, or null when there is none. */
function chainToElectron(start: string): string[] | null {
  const seen = new Set<string>();
  const walk = (file: string, trail: string[]): string[] | null => {
    if (seen.has(file)) return null;
    seen.add(file);
    const here = [...trail, rel(file)];
    for (const spec of importsOf(file)) {
      if (spec === 'electron' || spec.startsWith('electron/')) return [...here, spec];
      const target = spec.startsWith('.') ? resolveLocal(file, spec) : resolvePackage(file, spec);
      if (target === null || !target.endsWith('.ts')) continue; // another package, or JSON
      const found = walk(target, here);
      if (found !== null) return found;
    }
    return null;
  };
  return walk(start, []);
}

function tsFilesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return tsFilesUnder(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  }).sort();
}

const electronFiles = fs.readdirSync(ELECTRON).filter((f) => f.endsWith('.ts')).sort();

test('every APP_SIDE entry exists', () => {
  expect([...APP_SIDE].filter((f) => !electronFiles.includes(f))).toEqual([]);
});

test('no library file (packages/foundry-core/src/node, or app/electron outside APP_SIDE) reaches electron, directly or transitively', () => {
  const library = [
    ...electronFiles.filter((f) => !APP_SIDE.has(f)).map((f) => path.join(ELECTRON, f)),
    ...tsFilesUnder(NODE),
  ];
  expect(library.length).toBeGreaterThan(0);
  const offenders = library
    .map((file) => chainToElectron(file))
    .filter((chain): chain is string[] => chain !== null)
    .map((chain) => chain.join(' -> '));
  expect(offenders).toEqual([]);
});

test('every APP_SIDE file still reaches electron (else it is library and leaves the list)', () => {
  const stale = [...APP_SIDE].filter((f) => chainToElectron(path.join(ELECTRON, f)) === null);
  expect(stale).toEqual([]);
});

function importsOutside(root: string, allowed: readonly string[]): string[] {
  const offenders: string[] = [];
  for (const full of tsFilesUnder(root)) {
    for (const spec of importsOf(full)) {
      const where = rel(full);
      if (!spec.startsWith('.')) { offenders.push(`${where} imports '${spec}'`); continue; }
      const target = resolveLocal(full, spec);
      if (allowed.every((dir) => path.relative(dir, target).startsWith('..'))) {
        offenders.push(`${where} imports '${spec}' (outside ${allowed.map((dir) => path.basename(dir) + '/').join(' and ')})`);
      }
    }
  }
  return offenders;
}

test('browser/ imports nothing but shared/ and browser/ (no node:, no packages, no electron)', () => {
  expect(importsOutside(BROWSER, [BROWSER, SHARED])).toEqual([]);
});

test('shared/ imports nothing but shared/ (no node:, no packages, no electron)', () => {
  expect(importsOutside(SHARED, [SHARED])).toEqual([]);
});

test('the package never reaches electron: no source imports it, its package.json does not name it, nothing leaves the package', () => {
  const offenders: string[] = [];
  const rootManifest = path.join(REPO, 'package.json');
  for (const full of tsFilesUnder(SRC)) {
    for (const spec of importsOf(full)) {
      if (spec === 'electron' || spec.startsWith('electron/')) offenders.push(`${rel(full)} imports '${spec}'`);
      if (!spec.startsWith('.')) continue;
      const target = path.resolve(path.dirname(full), spec);
      // The engine's version is the repo's package.json, inlined by the bundler (src/engine/version.ts).
      if (path.relative(PKG, target).startsWith('..') && target !== rootManifest) {
        offenders.push(`${rel(full)} imports '${spec}' (outside the package)`);
      }
    }
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8')) as Record<string, unknown>;
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies']) {
    const deps = (manifest[field] ?? {}) as Record<string, string>;
    if ('electron' in deps) offenders.push(`packages/foundry-core/package.json names electron in ${field}`);
  }
  expect(offenders).toEqual([]);
});
