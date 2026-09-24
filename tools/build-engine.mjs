#!/usr/bin/env node
/**
 * build-engine — bundle the engine (src/) into the app, as ordinary code.
 *
 *   node tools/build-engine.mjs            # write app/engine/
 *   node tools/build-engine.mjs --check    # exit 1 if app/engine/ is not what src/ builds to
 *
 * ── WHY THE ENGINE IS NOT AN EXECUTABLE ANY MORE ────────────────────────────
 *
 * Owen, 2026-09-24: *"foundry.exe — this was intended to be a model runner
 * originally. i dont think it needs to be an exe anymore. it can be an engine
 * but maybe we should explode it out into normal code that moves along with the
 * app."* Every model now runs on a Crucible server; what is left in the engine
 * is file work (zip, EPUB, PDF text layers) and HTTP to that server. A 100 MB
 * `bun build --compile` binary per platform, cut as its own release and
 * downloaded by BookForge as an add-on, was a second release train for code
 * that is really part of the app — and every version gate in the host existed
 * only because the two trains could disagree.
 *
 * So the engine is bundled into ONE CommonJS file, `app/engine/foundry-engine.cjs`,
 * which the app runs with its own Electron as Node (`ELECTRON_RUN_AS_NODE=1`,
 * app/electron/engine.ts). It is still a CHILD PROCESS, deliberately: its file
 * work is synchronous and CPU-heavy, every run gets its own credential through
 * the environment, it reports progress on stderr and ends with an exit code,
 * and a cancel takes its whole tree down — none of which belongs inside the
 * app's main process.
 *
 * ── WHY THE BUNDLE IS COMMITTED ─────────────────────────────────────────────
 *
 * `app/` is the unit that travels: BookForge vendors it byte for byte into
 * `foundry-app/`, and nothing outside `app/` goes with it. A bundle built into
 * a gitignored `dist/` would leave the host with an app and no engine; a bundle
 * built by the host would need this repo's `src/` beside it. Committed, the
 * engine moves with the app by construction, and `--check` (run by
 * test/engine-bundle.test.ts) is what stops it drifting from `src/`: a change
 * to the engine that was not rebuilt fails the suite.
 *
 * That needs the build to be REPRODUCIBLE across machines, which is why:
 *   - the text this bundles (.py, .txt) is read with its line endings folded to
 *     LF, and so is the output — a `core.autocrlf=true` checkout on Windows and
 *     an LF one on the Mac must build the same bytes;
 *   - `.gitattributes` marks `app/engine/**` binary, so git never converts it;
 *   - the version stamp is a DIGEST OF THE INPUTS, not the git commit. A commit
 *     cannot contain its own hash, so stamping HEAD would name the commit BEFORE
 *     the one that carries the bundle, and would change on every commit whether
 *     the engine did or not. `foundry 2.0.2 (src 1a2b3c4d5e6f)` names exactly
 *     the sources this bundle was built from.
 *
 * ── WHAT BUN DID THAT THIS HAS TO DO BY HAND ────────────────────────────────
 *
 *   - `.py` / `.txt` imports `with { type: 'text' }` → the `text` loader.
 *   - `.ttf` imports `with { type: 'file' }` (vlm/pdf-text.ts) → a PATH to the
 *     face, copied to `app/engine/assets/`. The same contract Bun kept (a path
 *     `fs.readFileSync` can open; see vlm/font-asset.d.ts), so the source is
 *     unchanged, and 1.4 MB of fonts stay files rather than base64 in the bundle.
 *   - `import.meta.url` → this bundle's own file URL. bridge.ts and
 *     nli-bridge.ts look for their Python helper beside the module and, not
 *     finding it, write the embedded copy out — which is the right answer here.
 *   - the `#!/usr/bin/env bun` line on cli.ts is dropped: this file is run by
 *     Node, never executed by name.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(repo, 'app', 'engine');
const BUNDLE = 'foundry-engine.cjs';
const check = process.argv.includes('--check');

/** CRLF and lone CR folded to LF — see "reproducible" above. */
const lf = (text) => text.replace(/\r\n?/g, '\n');

/** Relative, forward-slashed: the same key on every machine. */
const rel = (file) => path.relative(repo, file).split(path.sep).join('/');

function plugins(fonts) {
  return [{
    name: 'foundry-engine',
    setup(build) {
      build.onLoad({ filter: /\.(py|txt)$/ }, (args) => ({
        contents: lf(fs.readFileSync(args.path, 'utf8')),
        loader: 'text',
      }));
      build.onLoad({ filter: /[\\/]src[\\/]cli\.ts$/ }, (args) => ({
        contents: fs.readFileSync(args.path, 'utf8').replace(/^#![^\n]*\n/, ''),
        loader: 'ts',
      }));
      build.onResolve({ filter: /\.ttf$/ }, (args) => ({
        path: path.resolve(args.resolveDir, args.path),
        namespace: 'font-asset',
      }));
      build.onLoad({ filter: /.*/, namespace: 'font-asset' }, (args) => {
        const name = path.basename(args.path);
        fonts.set(name, args.path);
        return {
          contents: `module.exports = require('node:path').join(__dirname, 'assets', ${JSON.stringify(name)});`,
          loader: 'js',
        };
      });
    },
  }];
}

async function bundle(stamp, fonts) {
  const result = await esbuild.build({
    entryPoints: [path.join(repo, 'src', 'cli.ts')],
    bundle: true,
    platform: 'node',
    // Electron 33's Node. The app runs this with its own Electron, so the
    // floor is whichever host ships the oldest one.
    target: 'node20',
    format: 'cjs',
    write: false,
    metafile: true,
    outfile: path.join(outDir, BUNDLE),
    legalComments: 'eof',
    logLevel: 'error',
    define: {
      FOUNDRY_GIT_COMMIT: JSON.stringify(stamp),
      'import.meta.url': '__foundryEngineUrl',
    },
    banner: {
      js: [
        '// foundry engine — GENERATED by tools/build-engine.mjs from src/. Do not edit;',
        '// rebuild. Run with Node (the app uses its own Electron, ELECTRON_RUN_AS_NODE=1).',
      ].join('\n'),
    },
    // A statement in the banner would sit above the bundle's "use strict" and
    // turn it into an ordinary string; an inject lands inside the module body.
    inject: [path.join(repo, 'tools', 'engine-import-meta-url.js')],
    plugins: plugins(fonts),
  });
  return result;
}

/**
 * The digest of everything the bundle is made of, and of the assets beside it.
 * The stamp itself is not an input, so a first pass with a placeholder yields
 * the same input set as the real one.
 */
function digestOf(metafile, fonts) {
  const hash = createHash('sha256');
  const inputs = Object.keys(metafile.inputs)
    .map((key) => {
      const file = key.startsWith('font-asset:') ? key.slice('font-asset:'.length) : key;
      return path.resolve(repo, file);
    })
    .sort((a, b) => rel(a).localeCompare(rel(b)));
  for (const file of inputs) {
    hash.update(rel(file)).update('\0');
    const bytes = fs.readFileSync(file);
    // Text inputs are hashed with LF endings (the checkout's endings are git's
    // business, not the engine's); fonts are hashed as the bytes they are.
    hash.update(file.endsWith('.ttf') ? bytes : lf(bytes.toString('utf8'))).update('\0');
  }
  for (const [name] of [...fonts].sort()) hash.update(name).update('\0');
  return hash.digest('hex').slice(0, 12);
}

const fonts = new Map();
const first = await bundle('src pending', fonts);
const stamp = `src ${digestOf(first.metafile, fonts)}`;
const built = await bundle(stamp, new Map());

const wanted = new Map();
wanted.set(BUNDLE, Buffer.from(lf(built.outputFiles[0].text), 'utf8'));
for (const [name, source] of fonts) wanted.set(path.join('assets', name), fs.readFileSync(source));
// The faces' licence travels with them (it asks to).
const licence = path.join(repo, 'src', 'vlm', 'assets', 'DejaVu-LICENSE.txt');
wanted.set(path.join('assets', 'DejaVu-LICENSE.txt'), Buffer.from(lf(fs.readFileSync(licence, 'utf8')), 'utf8'));

function onDisk(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? onDisk(full, base) : [path.relative(base, full)];
  });
}

if (check) {
  const stale = [];
  for (const [name, bytes] of wanted) {
    const file = path.join(outDir, name);
    if (!fs.existsSync(file)) stale.push(`${name} is missing`);
    else if (!fs.readFileSync(file).equals(bytes)) stale.push(`${name} differs from what src/ builds to`);
  }
  for (const name of onDisk(outDir)) {
    if (!wanted.has(name)) stale.push(`${name} is not something the build writes`);
  }
  if (stale.length > 0) {
    process.stderr.write(
      `build-engine: app/engine/ is STALE (${stamp}):\n  ${stale.join('\n  ')}\n`
      + 'Run `node tools/build-engine.mjs` and commit app/engine/.\n',
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(`build-engine: app/engine/ is current (${stamp})\n`);
  }
} else {
  fs.rmSync(outDir, { recursive: true, force: true });
  for (const [name, bytes] of wanted) {
    const file = path.join(outDir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
  const size = (wanted.get(BUNDLE).length / 1024 / 1024).toFixed(1);
  process.stdout.write(`build-engine: wrote app/engine/${BUNDLE} (${size} MB, ${stamp}) and ${wanted.size - 1} asset(s)\n`);
}
