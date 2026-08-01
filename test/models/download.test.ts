/**
 * Download + verify.
 *
 * Against a real loopback HTTP server rather than a mocked fetch, because the
 * things worth testing here are stream-shaped: redirects, a truncated transfer,
 * and what is left on disk after a failure. A mock that returns a string proves
 * none of them.
 *
 * The property under test is not "it downloads". It is: **after a failure,
 * nothing is at the destination path, and nothing is left in .part.** A partial
 * or wrong file that survives is a file that gets loaded later.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

import { downloadVerified, sha256File } from '../../src/models/download.js';

const PAYLOAD = Buffer.from('cast worn type into fresh type\n'.repeat(400), 'utf-8');
const PAYLOAD_SHA = crypto.createHash('sha256').update(PAYLOAD).digest('hex');

let server: http.Server;
let base: string;
let tmpDir: string;

/**
 * Every accepted socket, so teardown can destroy them.
 *
 * `server.close()` waits for open connections to finish, and the stalled-
 * transfer test deliberately leaves one that never will — so without this the
 * suite passes and then hangs forever in afterAll.
 */
const sockets = new Set<import('node:net').Socket>();

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-download-test-'));

  server = http.createServer((req, res) => {
    const url = req.url ?? '/';

    if (url === '/model.gguf') {
      res.writeHead(200, { 'Content-Length': String(PAYLOAD.length) });
      res.end(PAYLOAD);
      return;
    }

    // A HuggingFace resolve URL redirects to a CDN; the real path is the
    // redirected one, so the happy path has to survive it.
    if (url === '/resolve/model.gguf') {
      res.writeHead(302, { Location: '/model.gguf' });
      res.end();
      return;
    }

    if (url === '/loop') {
      res.writeHead(302, { Location: '/loop' });
      res.end();
      return;
    }

    // Declares more than it sends, then drops the connection: a transfer cut
    // short mid-stream, which is what a flaky link actually looks like.
    if (url === '/truncated.gguf') {
      res.writeHead(200, { 'Content-Length': String(PAYLOAD.length) });
      res.write(PAYLOAD.subarray(0, 100));
      setTimeout(() => res.socket?.destroy(), 20);
      return;
    }

    // Headers, then nothing, forever. The connection stays open and healthy —
    // it just never sends a byte. Indistinguishable from a slow server without
    // an inactivity timeout, and it hangs the whole program.
    if (url === '/stalled.gguf') {
      res.writeHead(200, { 'Content-Length': String(PAYLOAD.length) });
      res.write(PAYLOAD.subarray(0, 16));
      return;
    }

    // 200, well-formed, and simply not the file the catalog describes.
    if (url === '/wrong.gguf') {
      const other = Buffer.from('a completely different set of weights\n');
      res.writeHead(200, { 'Content-Length': String(other.length) });
      res.end(other);
      return;
    }

    // No content-length: progress cannot be a percentage, but the download
    // must still work and still verify.
    if (url === '/nolength.gguf') {
      res.writeHead(200);
      res.end(PAYLOAD);
      return;
    }

    res.writeHead(404);
    res.end('nope');
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no test server address');
  base = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function dest(name: string): string {
  return path.join(tmpDir, name);
}

/** Nothing at the destination, and no orphaned .part beside it. */
function expectNothingLeftBehind(destPath: string): void {
  expect(fs.existsSync(destPath)).toBe(false);
  expect(fs.existsSync(`${destPath}.part`)).toBe(false);
}

describe('sha256File', () => {
  test('hashes a file on disk', async () => {
    const p = dest('hash-me.bin');
    fs.writeFileSync(p, PAYLOAD);
    expect(await sha256File(p)).toBe(PAYLOAD_SHA);
  });

  test('rejects on a missing file rather than returning the empty hash', async () => {
    await expect(sha256File(dest('not-here.bin'))).rejects.toThrow();
  });
});

describe('downloadVerified — success', () => {
  test('downloads, verifies and installs', async () => {
    const p = dest('ok.gguf');
    await downloadVerified({
      url: `${base}/model.gguf`,
      destPath: p,
      sha256: PAYLOAD_SHA,
      bytes: PAYLOAD.length,
    });
    expect(fs.readFileSync(p)).toEqual(PAYLOAD);
    expect(fs.existsSync(`${p}.part`)).toBe(false);
  });

  test('follows redirects, as a HuggingFace resolve URL requires', async () => {
    const p = dest('redirected.gguf');
    await downloadVerified({ url: `${base}/resolve/model.gguf`, destPath: p, sha256: PAYLOAD_SHA });
    expect(fs.readFileSync(p)).toEqual(PAYLOAD);
  });

  test('accepts an uppercase expected hash', async () => {
    const p = dest('upper.gguf');
    await downloadVerified({
      url: `${base}/model.gguf`, destPath: p, sha256: PAYLOAD_SHA.toUpperCase(),
    });
    expect(fs.existsSync(p)).toBe(true);
  });

  test('creates the destination directory', async () => {
    const p = path.join(tmpDir, 'made', 'up', 'tree', 'ok.gguf');
    await downloadVerified({ url: `${base}/model.gguf`, destPath: p, sha256: PAYLOAD_SHA });
    expect(fs.existsSync(p)).toBe(true);
  });

  test('reports progress, ending at 100', async () => {
    const seen: number[] = [];
    await downloadVerified({
      url: `${base}/model.gguf`,
      destPath: dest('progress.gguf'),
      sha256: PAYLOAD_SHA,
      onProgress: (p) => seen.push(p.pct),
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)).toBe(100);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });

  test('works without a content-length', async () => {
    const p = dest('nolength.gguf');
    await downloadVerified({ url: `${base}/nolength.gguf`, destPath: p, sha256: PAYLOAD_SHA });
    expect(fs.readFileSync(p)).toEqual(PAYLOAD);
  });

  test('discards a stale .part from a previous run instead of appending to it', async () => {
    // Appending to a partial from an earlier, possibly different, revision is
    // how you assemble a file out of two downloads and get a checksum mismatch
    // that has no explanation.
    const p = dest('stale.gguf');
    fs.writeFileSync(`${p}.part`, Buffer.from('leftovers from last time'));
    await downloadVerified({ url: `${base}/model.gguf`, destPath: p, sha256: PAYLOAD_SHA });
    expect(fs.readFileSync(p)).toEqual(PAYLOAD);
  });
});

describe('downloadVerified — a hash mismatch is deleted and named', () => {
  test('the file is not installed, and the error names both hashes', async () => {
    const p = dest('wrong.gguf');
    const wrongExpectation = 'f'.repeat(64);
    await expect(downloadVerified({
      url: `${base}/wrong.gguf`, destPath: p, sha256: wrongExpectation,
    })).rejects.toThrow(/Checksum mismatch/);
    expectNothingLeftBehind(p);
  });

  test('the error quotes the expected and the actual hash', async () => {
    const p = dest('wrong-message.gguf');
    let message = '';
    try {
      await downloadVerified({ url: `${base}/model.gguf`, destPath: p, sha256: 'f'.repeat(64) });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('f'.repeat(64));
    expect(message).toContain(PAYLOAD_SHA);
    expect(message).toContain('deleted');
  });

  test('an unverifiable expectation is refused before a byte is fetched', async () => {
    const p = dest('nohash.gguf');
    await expect(downloadVerified({ url: `${base}/model.gguf`, destPath: p, sha256: '' }))
      .rejects.toThrow(/not 64 hex characters/);
    expectNothingLeftBehind(p);
  });
});

describe('downloadVerified — transfer failures', () => {
  test('a short transfer is reported as incomplete, not as a checksum mismatch', async () => {
    // Same outcome, but "incomplete" points at the network and "checksum
    // mismatch" points at the catalog. They are different bugs.
    const p = dest('truncated.gguf');
    await expect(downloadVerified({
      url: `${base}/truncated.gguf`, destPath: p, sha256: PAYLOAD_SHA, bytes: PAYLOAD.length,
    })).rejects.toThrow(/incomplete/);
    expectNothingLeftBehind(p);
  });

  test('a stalled transfer is abandoned instead of hanging forever', async () => {
    // Without the inactivity timeout this test never returns — which is exactly
    // what `foundry models pull` would do against a server that sends headers
    // and then nothing: no error, no output, no progress, indefinitely.
    const p = dest('stalled.gguf');
    await expect(downloadVerified({
      url: `${base}/stalled.gguf`, destPath: p, sha256: PAYLOAD_SHA, idleTimeoutMs: 300,
    })).rejects.toThrow(/stalled/);
    expectNothingLeftBehind(p);
  });

  test('a 404 names the URL', async () => {
    const p = dest('missing.gguf');
    await expect(downloadVerified({ url: `${base}/nope.gguf`, destPath: p, sha256: PAYLOAD_SHA }))
      .rejects.toThrow(/HTTP 404/);
    expectNothingLeftBehind(p);
  });

  test('a redirect loop terminates', async () => {
    const p = dest('loop.gguf');
    await expect(downloadVerified({ url: `${base}/loop`, destPath: p, sha256: PAYLOAD_SHA }))
      .rejects.toThrow(/Too many redirects/);
    expectNothingLeftBehind(p);
  });

  test('an unreachable host fails without leaving a file', async () => {
    const p = dest('unreachable.gguf');
    // Port 1 on loopback: reliably refused, never listening.
    await expect(downloadVerified({
      url: 'http://127.0.0.1:1/model.gguf', destPath: p, sha256: PAYLOAD_SHA,
    })).rejects.toThrow();
    expectNothingLeftBehind(p);
  });

  test('a non-http protocol is refused', async () => {
    const p = dest('ftp.gguf');
    await expect(downloadVerified({
      url: 'ftp://example.com/model.gguf', destPath: p, sha256: PAYLOAD_SHA,
    })).rejects.toThrow(/Unsupported protocol/);
    expectNothingLeftBehind(p);
  });

  test('an abort leaves nothing behind', async () => {
    const p = dest('aborted.gguf');
    const controller = new AbortController();
    controller.abort();
    await expect(downloadVerified({
      url: `${base}/model.gguf`, destPath: p, sha256: PAYLOAD_SHA, signal: controller.signal,
    })).rejects.toThrow(/cancelled/);
    expectNothingLeftBehind(p);
  });
});
