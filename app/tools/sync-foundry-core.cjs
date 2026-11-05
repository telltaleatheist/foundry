/**
 * sync-foundry-core — build ../packages/foundry-core and put that build into
 * this app's node_modules, as real files.
 *
 *   node tools/sync-foundry-core.cjs              build the package, then refresh the copy
 *   node tools/sync-foundry-core.cjs --check      refresh nothing; exit 1 if the copy is
 *                                                 not the package's current build
 *   node tools/sync-foundry-core.cjs --reinstall  the package's dependencies or peers
 *                                                 changed: drop its lock entry and copy,
 *                                                 `npm install`, then sync
 *
 * ── WHY THIS EXISTS (FOUNDRY-CORE-PLAN step 3, 2026-11-04) ─────────────────
 *
 * The app consumes `@owen/foundry-core` the way every other consumer will — by
 * package name, out of node_modules — so standalone Foundry proves the exports
 * BookForge will pin. In THIS repo the dependency is `file:../packages/foundry-core`,
 * and `.npmrc` sets `install-links=true`, so npm installs it as a PACKED COPY
 * (the package's `files`, its dependencies hoisted beside it), never as a link.
 *
 * Never a link, because on Windows npm makes a directory link a JUNCTION, and a
 * junction is followed by every recursive delete: `rm -rf node_modules`,
 * `Remove-Item -Recurse`, `git worktree remove` would go through it and delete
 * the package's SOURCES (BookForge CLAUDE.md, worktree hygiene — the same
 * mechanism has gutted a main checkout's node_modules twice). A copy can be
 * deleted like any other directory.
 *
 * A copy goes stale the moment the library changes, and npm does not refresh a
 * same-version directory dependency, so this does: it builds the package and
 * replaces node_modules/@owen/foundry-core with exactly the files `npm pack`
 * would ship. `build:electron` runs it first, so `npm run build` and
 * `electron:dev` always run the library as it is on disk — no release step.
 *
 * It refuses, by name, to touch a node_modules/@owen/foundry-core that is a link
 * (it would be deleting through it), and it does not install dependencies
 * unasked: when the package's dependency set changed it says so and names
 * `--reinstall`. A plain `npm install` is not enough there — npm keeps a
 * same-version directory dependency's lock entry (its dependencies, its peers)
 * as it first recorded it — so --reinstall removes that entry and the copy and
 * lets npm resolve the directory again, which rewrites package-lock.json.
 */
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const APP = path.resolve(__dirname, '..');
const PKG = path.resolve(APP, '..', 'packages', 'foundry-core');
const INSTALLED = path.join(APP, 'node_modules', '@owen', 'foundry-core');
const check = process.argv.includes('--check');
const reinstall = process.argv.includes('--reinstall');

function fail(sentence) {
  process.stderr.write(`sync-foundry-core: ${sentence}\n`);
  process.exit(1);
}

function npm(args, cwd) {
  // npm is npm.cmd on Windows, which execFile cannot start without a shell.
  return execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    cwd, encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'inherit'],
  });
}

/** Refuse, by name, to delete through a link. */
function refuseLink(where) {
  const stat = fs.lstatSync(where);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail(`${where} is a link, not a copy, so it was installed without app/.npmrc's install-links=true. `
      + 'Refusing to delete through it. Remove the link itself (Windows: `cmd /c rmdir`, never a recursive delete), then `npm install` in app/.');
  }
}

if (!check) npm(['run', 'build', '--silent'], PKG);

if (reinstall) {
  const lockFile = path.join(APP, 'package-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  delete lock.packages['node_modules/@owen/foundry-core'];
  fs.writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
  if (fs.existsSync(INSTALLED)) {
    refuseLink(INSTALLED);
    fs.rmSync(INSTALLED, { recursive: true });
  }
  npm(['install', '--no-audit', '--no-fund'], APP);
}

/** What `npm pack` would put in the tarball, relative to the package root. */
const listing = JSON.parse(npm(['pack', '--dry-run', '--json', '--ignore-scripts'], PKG));
const files = listing[0].files.map((f) => f.path).sort();

const source = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));
if (!fs.existsSync(INSTALLED)) {
  fail(`${INSTALLED} does not exist. Run \`npm install\` in app/ first (it installs the package and its dependencies).`);
}
refuseLink(INSTALLED);
const installed = JSON.parse(fs.readFileSync(path.join(INSTALLED, 'package.json'), 'utf8'));
for (const field of ['dependencies', 'peerDependencies']) {
  if (JSON.stringify(installed[field] ?? {}) !== JSON.stringify(source[field] ?? {})) {
    fail(`the package's ${field} changed since app/ installed it. Run \`node tools/sync-foundry-core.cjs --reinstall\` `
      + 'in app/ (it re-resolves the package and rewrites package-lock.json).');
  }
}

function filesUnder(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) fail(`${full} is a link inside the installed copy; refusing to walk it.`);
    return entry.isDirectory() ? filesUnder(full, base) : [path.relative(base, full).split(path.sep).join('/')];
  });
}

if (check) {
  const have = filesUnder(INSTALLED).filter((f) => !f.startsWith('node_modules/')).sort();
  const stale = [];
  for (const f of files) {
    const there = path.join(INSTALLED, f);
    if (!fs.existsSync(there)) stale.push(`${f} is missing`);
    else if (!fs.readFileSync(there).equals(fs.readFileSync(path.join(PKG, f)))) stale.push(`${f} differs`);
  }
  for (const f of have) if (!files.includes(f)) stale.push(`${f} is not in the package`);
  if (stale.length > 0) {
    fail(`node_modules/@owen/foundry-core is STALE:\n  ${stale.slice(0, 20).join('\n  ')}\nRun \`node tools/sync-foundry-core.cjs\` in app/.`);
  }
  process.stdout.write(`sync-foundry-core: node_modules/@owen/foundry-core is current (${files.length} files)\n`);
  process.exit(0);
}

// npm may have nested a dependency under the package (a version conflict with
// the app's own); keep that, replace everything else.
for (const entry of fs.readdirSync(INSTALLED)) {
  if (entry === 'node_modules') continue;
  if (fs.lstatSync(path.join(INSTALLED, entry)).isSymbolicLink()) fail(`${path.join(INSTALLED, entry)} is a link; refusing to delete through it.`);
  fs.rmSync(path.join(INSTALLED, entry), { recursive: true, force: true });
}
for (const f of files) {
  const to = path.join(INSTALLED, f);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(PKG, f), to);
}
process.stdout.write(`sync-foundry-core: node_modules/@owen/foundry-core <- packages/foundry-core (${files.length} files)\n`);
