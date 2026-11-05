#!/usr/bin/env node
/*
 * lib-loads-without-electron — require every compiled LIBRARY module with
 * `electron` made unresolvable, and show the platform port's refusal and its
 * answer (FOUNDRY-CORE-PLAN step 1, 2026-11-04).
 *
 * Since step 3 the library is @owen/foundry-core, so what is loaded is the
 * package's built main-process half (packages/foundry-core/dist/node, or the copy
 * this app installed, by argument), and the negative control is the APP's
 * window.js in app/dist/electron.
 *
 * The graph keeper (test/lib-no-electron.test.ts) reads source; this proves the
 * EMITTED files load as plain Node, which is what BookForge's CLI and the future
 * package actually run. The app-side list mirrors that test's APP_SIDE; window.js
 * is loaded last as the negative control and must be refused.
 *
 *   cd app && npm run build:electron && node tools/checks/lib-loads-without-electron.cjs [<dist/node dir>]
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const orig = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) {
  if (req === 'electron' || req.startsWith('electron/')) throw new Error(`electron was required (by ${rest[0] && rest[0].filename})`);
  return orig.call(this, req, ...rest);
};
const dist = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', '..', 'packages', 'foundry-core', 'dist', 'node'));
const appDist = path.join(__dirname, '..', '..', 'dist', 'electron');
const APP_SIDE = new Set(['main.js','window.js','preload.js','crucible-ui.js','ipc.js','mount.js','documents.js']);
const files = fs.readdirSync(dist).filter(f => f.endsWith('.js')).sort();
console.log(`library: ${dist}`);
const strays = files.filter(f => APP_SIDE.has(f));
if (strays.length !== 0) { console.log(`app-side modules inside the library build: ${strays.join(', ')}`); process.exitCode = 1; }
let ok = 0, bad = [];
for (const f of files) {
  if (APP_SIDE.has(f)) continue;
  try { require(path.join(dist, f)); ok++; } catch (e) { bad.push(`${f}: ${e.message.split('\n')[0]}`); }
}
console.log(`loaded ${ok} library modules without electron; failed ${bad.length}`);
for (const b of bad) console.log('  ' + b);
if (bad.length !== 0) process.exitCode = 1;
// and the refusal, by name, before the platform is set:
try { require(path.join(dist, 'app-settings.js')).readAppSettings(); console.log('readAppSettings: NO REFUSAL'); process.exitCode = 1; }
catch (e) { console.log('readAppSettings before setPlatform ->', e.message); }
// and that a set platform is what it reads:
const os = require('os');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-smoke-'));
require(path.join(dist, 'platform.js')).setPlatform({ userDataDir: () => tmp, tempDir: () => tmp, broadcast: () => {}, image: { createFromPath() { throw 0; }, createFromBuffer() { throw 0; } } });
const s = require(path.join(dist, 'app-settings.js')).readAppSettings();
console.log('readAppSettings after setPlatform -> ok, keys:', Object.keys(s).length);
fs.rmSync(tmp, { recursive: true, force: true });
// the negative control: an app-side module DOES need electron
try { require(path.join(appDist, 'window.js')); console.log('window.js: loaded (unexpected)'); process.exitCode = 1; } catch (e) { console.log('control window.js ->', e.message); }
