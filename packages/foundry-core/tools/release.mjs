#!/usr/bin/env node
/**
 * release — cut one @owen/foundry-core release: build, `npm pack`, prove the
 * tarball, publish it as a GitHub release asset in telltaleatheist/foundry.
 *
 *   node tools/release.mjs                    release main
 *   node tools/release.mjs --dry-run          build, pack and check; create nothing
 *   node tools/release.mjs --branch <name>    release a branch about to merge
 *
 * (from packages/foundry-core; `npm run release -- --dry-run` is the same.)
 *
 * ── WHAT A RELEASE IS ──────────────────────────────────────────────────────
 *
 * One tag, `foundry-core-v<version>`, carrying two assets:
 *
 *   owen-foundry-core-<version>.tgz          exactly what `npm pack` makes here
 *   owen-foundry-core-<version>.tgz.sha256   its checksum, `sha256sum` format
 *
 * The version is the package's own `package.json` and is NEVER bumped here: set
 * it, commit, push, then cut (the same rule as tools/deploy.sh and Crucible's
 * release.sh — a release describes a commit everyone can get). The tag has its
 * own prefix because this repo's plain `v<x.y.z>` tags are Foundry's desktop
 * installers; the two trains never share a tag, and a library release is cut
 * `--prerelease --latest=false` so it never becomes the repo's "Latest" — that
 * badge belongs to the installers people download.
 *
 * A consumer takes a release with tools/adopt-foundry-core.mjs (repo root),
 * which fetches the tarball into its vendor/, repins and asks the installed
 * package its version. Modelled on Crucible's scripts/release.sh (which cuts
 * @crucible/client the same way) and tools/adopt-crucible-release.mjs.
 *
 * ── WHAT IT REFUSES ────────────────────────────────────────────────────────
 *
 * Another branch than main (without --branch), a dirty tree, an unpushed HEAD,
 * a tag or release that already exists (a version is cut once), a stale engine
 * bundle (`build-engine.mjs --check`), and a tarball that is not what a consumer
 * needs: its package.json must carry the version being tagged, and the engine,
 * the CommonJS node/ and shared/ builds and the ES shared/ build must all be in
 * it. --dry-run runs every check but the creation, so it is free to run.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RELEASE_BRANCH = 'main';
const REPO_SLUG = 'telltaleatheist/foundry';
const TAG_PREFIX = 'foundry-core-v';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(PKG, 'build', 'release');
const WIN = process.platform === 'win32';

/** Entries every consumer reaches; a tarball without one of them is not released. */
const REQUIRED = [
  'package/package.json',
  'package/engine/foundry-engine.cjs',
  'package/dist/package.json',
  'package/dist/esm/package.json',
  'package/dist/node/engine.js',
  'package/dist/node/host.js',
  'package/dist/node/platform.js',
  'package/dist/shared/api.js',
  'package/dist/esm/shared/api.js',
];

function fail(sentence) {
  process.stderr.write(`release: ${sentence}\n`);
  process.exit(1);
}

function run(cmd, args, options = {}) {
  return execFileSync(WIN && cmd === 'npm' ? 'npm.cmd' : cmd, args, {
    cwd: PKG, encoding: 'utf8', shell: WIN && cmd === 'npm', stdio: ['ignore', 'pipe', 'pipe'], ...options,
  }).trim();
}

function succeeds(cmd, args) {
  return spawnSync(cmd, args, { cwd: PKG, stdio: 'ignore' }).status === 0;
}

function parseArgs(argv) {
  const opts = { dryRun: false, branch: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--branch') {
      opts.branch = argv[i + 1];
      if (!opts.branch) fail('--branch needs a branch name');
      i += 1;
    } else if (arg === '-h' || arg === '--help') {
      process.stdout.write(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(2, 9).join('\n') + '\n');
      process.exit(0);
    } else fail(`unknown argument ${arg}`);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  for (const tool of ['git', 'gh', 'tar']) {
    if (!succeeds(tool, ['--version'])) fail(`no ${tool} on PATH`);
  }
  if (!succeeds('gh', ['auth', 'status'])) fail('gh is not logged in (gh auth login)');

  const wanted = opts.branch ?? RELEASE_BRANCH;
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== wanted) {
    fail(`on branch ${branch}, not ${wanted} (releases come from ${RELEASE_BRANCH}; pass --branch to release another)`);
  }
  if (run('git', ['status', '--porcelain']) !== '') {
    fail('the working tree is dirty; a release must be reproducible from the tag');
  }
  const head = run('git', ['rev-parse', 'HEAD']);
  run('git', ['fetch', '--quiet', 'origin', branch]);
  const remote = run('git', ['rev-parse', `origin/${branch}`]);
  if (head !== remote) {
    fail(`HEAD (${head.slice(0, 7)}) is not origin/${branch} (${remote.slice(0, 7)}); push first`);
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(PKG, 'package.json'), 'utf8'));
  const version = manifest.version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`package.json's version ${version} is not x.y.z`);
  const tag = `${TAG_PREFIX}${version}`;
  process.stdout.write(`release: ${tag} from ${branch} (${head.slice(0, 7)})\n`);

  if (succeeds('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`])) {
    fail(`tag ${tag} already exists locally; a version is cut once (set a new version in package.json, commit, push)`);
  }
  if (succeeds('git', ['ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/${tag}`])) {
    fail(`tag ${tag} already exists on origin; a version is cut once`);
  }
  if (succeeds('gh', ['release', 'view', tag, '--repo', REPO_SLUG])) {
    fail(`release ${tag} already exists; a version is cut once`);
  }

  process.stdout.write('release: the engine bundle is current\n');
  try {
    run(process.execPath, ['tools/build-engine.mjs', '--check']);
  } catch (error) {
    fail(`the engine bundle is stale (run \`node tools/build-engine.mjs\`, commit, push, cut again):\n${error.stdout ?? ''}${error.stderr ?? ''}`);
  }

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  process.stdout.write('release: building and packing\n');
  run('npm', ['run', 'build', '--silent']);
  const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', OUT]));
  const tgz = path.join(OUT, packed[0].filename);
  const expected = `owen-foundry-core-${version}.tgz`;
  if (packed[0].filename !== expected || !fs.existsSync(tgz)) {
    fail(`npm pack made ${packed[0].filename}, not ${expected}`);
  }

  // The tree must still be clean: a build that rewrites a tracked file (the
  // engine bundle, a generated source) means the tag would not reproduce it.
  if (run('git', ['status', '--porcelain']) !== '') {
    fail(`building changed tracked files; the tag would not reproduce this tarball:\n${run('git', ['status', '--porcelain'])}`);
  }

  process.stdout.write('release: the tarball holds what a consumer needs\n');
  // Relative to OUT: GNU tar (Git for Windows) reads a `C:\...` path as a remote host `C`.
  const entries = new Set(run('tar', ['-tzf', expected], { cwd: OUT, maxBuffer: 64 * 1024 * 1024 }).split(/\r?\n/));
  const missing = REQUIRED.filter((entry) => !entries.has(entry));
  if (missing.length > 0) fail(`${expected} is missing ${missing.join(', ')}`);
  const shipped = JSON.parse(run('tar', ['-xzOf', expected, 'package/package.json'], { cwd: OUT }));
  if (shipped.name !== '@owen/foundry-core' || shipped.version !== version) {
    fail(`${expected} carries ${shipped.name}@${shipped.version}, not @owen/foundry-core@${version}`);
  }
  const leaked = [...entries].filter((entry) => /^package\/(src|test|node_modules)\//.test(entry) || entry.endsWith('.map'));
  if (leaked.length > 0) fail(`${expected} ships ${leaked.length} source/test/map file(s), e.g. ${leaked[0]}`);

  const digest = createHash('sha256').update(fs.readFileSync(tgz)).digest('hex');
  const sha = `${tgz}.sha256`;
  fs.writeFileSync(sha, `${digest}  ${expected}\n`);

  process.stdout.write('release: built\n');
  process.stdout.write(`  ${expected}  (${fs.statSync(tgz).size.toLocaleString()} bytes, ${entries.size} entries)\n`);
  process.stdout.write(`  ${expected}.sha256  ${digest}\n`);

  if (opts.dryRun) {
    process.stdout.write(`release: --dry-run, so ${tag} was not created (the tarball is in ${path.relative(process.cwd(), OUT) || '.'})\n`);
    return;
  }

  let notes = `\`@owen/foundry-core\` ${version} — Foundry's features without a window (engine bundle, main-process library, browser-safe shared code).

Adopt it from a consumer's root (BookForge, or anything else that pins it in \`vendor/\`):

\`\`\`
node tools/adopt-foundry-core.mjs ${version}
\`\`\`

Peers the consumer pins itself (one copy, shared with the app): ${Object.entries(shipped.peerDependencies ?? {}).map(([name, range]) => `\`${name}@${range}\``).join(', ')}.`;
  if (opts.branch) {
    notes += `\n\nCut from branch \`${opts.branch}\` at \`${head.slice(0, 7)}\`, before it was merged to \`${RELEASE_BRANCH}\`.`;
  }

  run('gh', [
    'release', 'create', tag,
    '--repo', REPO_SLUG,
    '--target', head,
    '--title', `@owen/foundry-core ${version}`,
    '--prerelease', '--latest=false',
    '--notes', notes,
    tgz, sha,
  ], { stdio: ['ignore', 'inherit', 'inherit'] });

  process.stdout.write(`release: ${tag} created (prerelease, not latest)\n`);
  process.stdout.write(`release: adopt it with: node tools/adopt-foundry-core.mjs ${version}\n`);
}

main();
