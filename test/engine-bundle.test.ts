/**
 * The committed engine bundle is what src/ builds to, and it runs under Node.
 *
 * `app/engine/foundry-engine.cjs` is the engine every app runs (this one, a
 * packaged one, and BookForge's vendored copy — see tools/build-engine.mjs).
 * It is built and COMMITTED, so the one way it goes wrong is a change to src/
 * that nobody rebuilt: the app would run yesterday's engine with today's
 * sources beside it. `--check` rebuilds in memory and compares bytes, and this
 * suite fails until the bundle is rebuilt and committed.
 *
 * The runs below use `node`, not bun, because Node is what the apps give it —
 * a bundle that only worked under the runtime the tests happen to use would
 * pass here and fail in front of somebody.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import pkg from '../package.json';
import { unzipMap } from './export/unzip.js';
import { PUBLISHER_ONE_PATH, publisherEpub } from './translate/fixture.js';

const repo = path.resolve(import.meta.dir, '..');
const bundle = path.join(repo, 'app', 'engine', 'foundry-engine.cjs');

function node(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync('node', args, { cwd: repo, encoding: 'utf8', timeout: 120_000, windowsHide: true });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

describe('the bundled engine', () => {
  test('app/engine/ is exactly what src/ builds to (rebuild with `node tools/build-engine.mjs`)', () => {
    const run = node([path.join('tools', 'build-engine.mjs'), '--check']);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
  }, 120_000);

  test('it runs under Node and names its version and the sources it was built from', () => {
    const run = node([bundle, '--version']);
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toMatch(new RegExp(`^foundry ${pkg.version.replace(/\./g, '\\.')} \\(src [0-9a-f]{12}\\)$`));
  });

  test('a usage error exits 2 with its whole sentence on stderr', () => {
    const run = node([bundle, 'no-such-command']);
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('unknown command "no-such-command"');
    expect(run.stderr).toContain('Run `foundry --help`.');
  });

  test('the fonts it sets text PDFs in are beside it', () => {
    for (const face of ['DejaVuSerif.ttf', 'DejaVuSerif-Italic.ttf', 'DejaVuSerif-Bold.ttf', 'DejaVuSerif-BoldItalic.ttf']) {
      expect(fs.statSync(path.join(repo, 'app', 'engine', 'assets', face)).size).toBeGreaterThan(100_000);
    }
  });

  test('it writes a file through a real command (epub-stamp: a zip written to disk)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-engine-bundle-'));
    try {
      const epub = path.join(dir, 'Buch.epub');
      const out = path.join(dir, 'Buch.stamped.epub');
      fs.writeFileSync(epub, publisherEpub());
      const run = node([bundle, 'epub-stamp', '--epub', epub, '--out', out]);
      expect(run.status).toBe(0);
      const written = unzipMap(new Uint8Array(fs.readFileSync(out)));
      expect(written.get(PUBLISHER_ONE_PATH)?.text() ?? '').toContain('data-bf-id=');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
