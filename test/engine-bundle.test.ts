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
import { spawn, spawnSync } from 'node:child_process';
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

  /*
   * THE WIRE, AS NODE SENDS IT — a smoke test of the real path. 2026-09-24: the
   * first engine run on Node sent `content-type: application/json,
   * application/json` and Crucible refused every request. The regression guard
   * for that merge is test/translate/transport-headers.test.ts, which fails on
   * the old code on any runtime; this one proves the bundle, run by node over a
   * real socket, sends one content-type and a JSON body on a clean-text pass.
   */
  test('under node, every request carries ONE content-type and a JSON body', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-engine-wire-'));
    const seen: Array<{ method: string; contentType: string | null; parsed: boolean }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const raw = await request.text();
        let parsed = true;
        if (request.method === 'POST') { try { JSON.parse(raw); } catch { parsed = false; } }
        seen.push({ method: request.method, contentType: request.headers.get('content-type'), parsed });
        if (request.method === 'GET') return Response.json({ object: 'list', data: [{ id: 'm', object: 'model' }] });
        return Response.json({
          id: 'x', object: 'chat.completion', model: 'm',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"edits":[]}' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
    });
    try {
      const book = path.join(dir, 'book.jsonl');
      const header = { book: 3, engine: 'foundry-test', language: 'en', source: { pages: 1, unreadable: [], bankSha: 'sha256:test' }, chapters: [], typography: null, seams: [], loose: { markers: [], notes: [] } };
      // An acronym, so the block is ASKED (blockMayTakeAnEdit).
      const text = 'The NATO report was finally published, long after anyone cared.';
      const row = { id: 'b1-1', category: 'Text', text, page: 1, pages: [1], box: [0, 0, 100, 10], parts: [{ src: 'p1-1', page: 1, chars: [0, text.length] }] };
      fs.writeFileSync(book, `${JSON.stringify(header)}
${JSON.stringify(row)}
`);
      const child = spawn('node', [bundle, 'clean-text', '--book', book,
        '--records', path.join(dir, 'out.records.jsonl'), '--stamp', path.join(dir, 'out.stamp.json'),
        '--endpoint', `http://127.0.0.1:${server.port}/v1`, '--model', 'm'], {
        cwd: repo, windowsHide: true,
        env: { ...process.env, FOUNDRY_ENDPOINT_HEADERS: JSON.stringify({ Authorization: 'Bearer t' }) },
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
      expect(stderr).not.toMatch(/invalid_request|refused the request/);
      expect(code).toBe(0);
      const posts = seen.filter((one) => one.method === 'POST');
      expect(posts.length).toBeGreaterThan(0);
      for (const one of posts) {
        expect(one.contentType).toBe('application/json');
        expect(one.parsed).toBe(true);
      }
    } finally {
      server.stop(true);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
