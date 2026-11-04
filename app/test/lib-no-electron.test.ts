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
 * relative imports (static, `export … from`, `import()`, `require`, and
 * type-only imports too — a library whose types need Electron's is not
 * headless either). New files are library by default; making one app-side is
 * an edit to this list, which is a decision somebody has to write down.
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
 */
import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';

const APP = path.dirname(import.meta.dir);
const ELECTRON = path.join(APP, 'electron');
const SHARED = path.join(APP, 'shared');
const BROWSER = path.join(APP, 'browser');

const APP_SIDE = new Set([
  'main.ts',
  'window.ts',
  'preload.ts',
  'crucible-ui.ts',
  'ipc.ts',
  'mount.ts',
  'documents.ts',
]);

function importsOf(file: string): string[] {
  const info = ts.preProcessFile(fs.readFileSync(file, 'utf8'), true, true);
  return info.importedFiles.map((ref) => ref.fileName);
}

/** A relative specifier to the file it names, or null for one that is not ours. */
function resolveLocal(from: string, spec: string): string {
  const base = path.resolve(path.dirname(from), spec);
  for (const candidate of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`${path.relative(APP, from)} imports '${spec}', which resolves to no file`);
}

/** The chain from `start` to the `electron` package, or null when there is none. */
function chainToElectron(start: string): string[] | null {
  const seen = new Set<string>();
  const walk = (file: string, trail: string[]): string[] | null => {
    if (seen.has(file)) return null;
    seen.add(file);
    const here = [...trail, path.relative(APP, file).replace(/\\/g, '/')];
    for (const spec of importsOf(file)) {
      if (spec === 'electron' || spec.startsWith('electron/')) return [...here, spec];
      if (!spec.startsWith('.')) continue;
      const target = resolveLocal(file, spec);
      if (!target.endsWith('.ts')) continue; // JSON
      const found = walk(target, here);
      if (found !== null) return found;
    }
    return null;
  };
  return walk(start, []);
}

const electronFiles = fs.readdirSync(ELECTRON).filter((f) => f.endsWith('.ts')).sort();

test('every APP_SIDE entry exists', () => {
  expect([...APP_SIDE].filter((f) => !electronFiles.includes(f))).toEqual([]);
});

test('no library file under app/electron reaches electron, directly or transitively', () => {
  const offenders = electronFiles
    .filter((f) => !APP_SIDE.has(f))
    .map((f) => chainToElectron(path.join(ELECTRON, f)))
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
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { visit(full); continue; }
      if (!entry.name.endsWith('.ts')) continue;
      for (const spec of importsOf(full)) {
        const where = path.relative(APP, full).replace(/\\/g, '/');
        if (!spec.startsWith('.')) { offenders.push(`${where} imports '${spec}'`); continue; }
        const target = resolveLocal(full, spec);
        if (allowed.every((dir) => path.relative(dir, target).startsWith('..'))) {
          offenders.push(`${where} imports '${spec}' (outside ${allowed.map((dir) => path.basename(dir) + '/').join(' and ')})`);
        }
      }
    }
  };
  visit(root);
  return offenders;
}

test('browser/ imports nothing but shared/ and browser/ (no node:, no packages, no electron)', () => {
  expect(importsOutside(BROWSER, [BROWSER, SHARED])).toEqual([]);
});

test('shared/ imports nothing but shared/ (no node:, no packages, no electron)', () => {
  const offenders: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { visit(full); continue; }
      if (!entry.name.endsWith('.ts')) continue;
      for (const spec of importsOf(full)) {
        const where = path.relative(APP, full).replace(/\\/g, '/');
        if (!spec.startsWith('.')) { offenders.push(`${where} imports '${spec}'`); continue; }
        const target = resolveLocal(full, spec);
        if (path.relative(SHARED, target).startsWith('..')) offenders.push(`${where} imports '${spec}' (outside shared/)`);
      }
    }
  };
  visit(SHARED);
  expect(offenders).toEqual([]);
});
