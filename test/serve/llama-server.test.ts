/**
 * Server lifecycle, against a stub that behaves like llama-server.
 *
 * No weights and no llama.cpp: `stub-llama-server.ts` is spawned as the binary,
 * so this exercises the real spawn, the real argv, the real readiness poll and
 * the real HTTP round trip. What it does NOT exercise is inference, which is
 * not what this layer is for — this layer takes a string and returns a string.
 *
 * The two properties worth the whole file:
 *
 *  1. **Readiness requires HTTP 200.** llama-server binds its port and answers
 *     /health with 503 while the model loads. A check that accepts "something
 *     answered" passes instantly and the first real request lands on a 503. The
 *     stub answers 503 first, so a regression here fails the test.
 *  2. **The prompt arrives verbatim.** ARCHITECTURE §4. The stub echoes the
 *     request body back, and the prompt is asserted byte-for-byte — including
 *     the empty `<think>\n\n</think>` block that a chat template would rebuild
 *     differently.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { freeLoopbackPort, LlamaServer } from '../../src/serve/llama-server.js';

const STUB = path.join(import.meta.dir, 'stub-llama-server.ts');

let tmpDir: string;
let basePath: string;
let boxesAdapter: string;
let ocrAdapter: string;
let footnotesAdapter: string;

const started: LlamaServer[] = [];

/** A server wired to the stub, tracked so afterEach can stop it. */
function makeServer(over: Partial<ConstructorParameters<typeof LlamaServer>[0]> = {}): LlamaServer {
  const server = new LlamaServer({
    binaryPath: STUB,
    basePath,
    adapters: [
      { name: 'boxes', path: boxesAdapter },
      { name: 'ocr', path: ocrAdapter },
      { name: 'footnotes', path: footnotesAdapter },
    ],
    contextSize: 4096,
    startupTimeoutMs: 15_000,
    ...over,
  });
  started.push(server);
  return server;
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-llama-server-'));
  basePath = path.join(tmpDir, 'foundry-4b.gguf');
  boxesAdapter = path.join(tmpDir, 'boxes.gguf');
  ocrAdapter = path.join(tmpDir, 'ocr.gguf');
  footnotesAdapter = path.join(tmpDir, 'footnotes.gguf');
  for (const p of [basePath, boxesAdapter, ocrAdapter, footnotesAdapter]) {
    fs.writeFileSync(p, 'not really a gguf');
  }
  fs.chmodSync(STUB, 0o755);
});

afterEach(async () => {
  while (started.length) {
    const server = started.pop();
    await server?.stop();
  }
  delete process.env['STUB_HEALTH_503'];
  delete process.env['STUB_ALWAYS_503'];
  delete process.env['STUB_EXIT_CODE'];
  delete process.env['STUB_ARGS_FILE'];
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** The stub echoes the request back inside `content`. */
interface Echo {
  received: {
    prompt: string;
    temperature: number;
    n_predict: number;
    stop?: string[];
    cache_prompt: boolean;
    lora: Array<{ id: number; scale: number }>;
  };
  healthProbes: number;
}

function echo(content: string): Echo {
  return JSON.parse(content) as Echo;
}

describe('readiness', () => {
  test('waits for HTTP 200 and does not accept a 503', async () => {
    // Four 503s before the first 200. A readiness check that merely connects,
    // or that accepts any HTTP response, would report ready during those.
    process.env['STUB_HEALTH_503'] = '4';
    const server = makeServer();
    await server.ensureStarted();
    expect(server.running).toBe(true);

    const answer = echo(await server.complete({ prompt: 'x' }));
    // The stub counts /health hits; the completion is only reachable after the
    // 200, so this proves the poll rode out every 503.
    expect(answer.healthProbes).toBeGreaterThanOrEqual(5);
  });

  test('a server that never finishes loading times out, and says it was loading', async () => {
    process.env['STUB_ALWAYS_503'] = '1';
    const server = makeServer({ startupTimeoutMs: 1_200 });
    await expect(server.ensureStarted()).rejects.toThrow(/did not become ready/);
    expect(server.running).toBe(false);
  }, 20_000);

  test('the timeout message distinguishes "still loading" from "never answered"', async () => {
    process.env['STUB_ALWAYS_503'] = '1';
    const server = makeServer({ startupTimeoutMs: 1_200 });
    let message = '';
    try {
      await server.ensureStarted();
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('503');
    expect(message).toContain('loading the model');
  }, 20_000);

  test('a binary that exits during startup is reported as such', async () => {
    process.env['STUB_EXIT_CODE'] = '3';
    const server = makeServer({ startupTimeoutMs: 5_000 });
    await expect(server.ensureStarted()).rejects.toThrow(/exited during startup/);
  }, 20_000);

  test('concurrent callers join one start rather than racing two spawns', async () => {
    const server = makeServer();
    await Promise.all([
      server.ensureStarted(),
      server.ensureStarted(),
      server.ensureStarted(),
    ]);
    expect(server.running).toBe(true);
    // One process, one port, and it answers.
    expect(echo(await server.complete({ prompt: 'ok' })).received.prompt).toBe('ok');
  });

  test('a missing base model is named, not guessed around', async () => {
    const server = makeServer({ basePath: path.join(tmpDir, 'absent.gguf') });
    await expect(server.ensureStarted()).rejects.toThrow(/base model is not at/);
  });

  test('a missing adapter is named', async () => {
    const server = makeServer({
      adapters: [{ name: 'boxes', path: path.join(tmpDir, 'absent-adapter.gguf') }],
    });
    await expect(server.ensureStarted()).rejects.toThrow(/adapter 'boxes' is not at/);
  });

  test('the port is not readable before the server starts', () => {
    const server = makeServer();
    expect(() => server.port).toThrow(/has not started/);
  });
});

describe('the prompt is sent verbatim to /completion', () => {
  test('byte-for-byte, including the empty think block', async () => {
    // The exact shape Qwen3's template with thinking disabled produces. A chat
    // endpoint would rebuild this from `messages` and get it subtly different,
    // which does not error — the answers just get worse.
    const prompt =
      '<|im_start|>system\nYou label blocks.<|im_end|>\n'
      + '<|im_start|>user\n1: TITLE\n2: body text  \n<|im_end|>\n'
      + '<|im_start|>assistant\n<think>\n\n</think>\n\n';

    const server = makeServer();
    const answer = echo(await server.complete({ prompt }));
    expect(answer.received.prompt).toBe(prompt);
    expect(answer.received.prompt).toContain('<think>\n\n</think>');
  });

  test('nothing is trimmed, wrapped or normalised', async () => {
    const prompt = '   leading and trailing whitespace matters \t\n\n';
    const server = makeServer();
    expect(echo(await server.complete({ prompt })).received.prompt).toBe(prompt);
  });

  test('generation is greedy by default — these are deterministic tasks', async () => {
    const server = makeServer();
    expect(echo(await server.complete({ prompt: 'x' })).received.temperature).toBe(0);
  });

  test('the stop token is passed through, not invented', async () => {
    const server = makeServer();
    const answer = echo(await server.complete({ prompt: 'x', stop: ['<|im_end|>'] }));
    expect(answer.received.stop).toEqual(['<|im_end|>']);
  });

  test('the shared prefix is cached across requests', async () => {
    const server = makeServer();
    expect(echo(await server.complete({ prompt: 'x' })).received.cache_prompt).toBe(true);
  });

  test('n_predict is a ceiling the caller can set', async () => {
    const server = makeServer({ maxPredict: 512 });
    expect(echo(await server.complete({ prompt: 'x' })).received.n_predict).toBe(512);
    expect(echo(await server.complete({ prompt: 'x', nPredict: 64 })).received.n_predict).toBe(64);
  });

  test('a route that is not /completion is never used', async () => {
    // The stub 404s everything else, notably /v1/chat/completions. If this
    // layer ever reached for a chat endpoint, every test above would fail — but
    // assert the negative directly too.
    const server = makeServer();
    await server.ensureStarted();
    const chat = await fetch(`${server.endpoint}/v1/chat/completions`, { method: 'POST' });
    expect(chat.status).toBe(404);
  });
});

describe('one base, adapters selected per request', () => {
  test('adapters are loaded at scale 0 so nothing is applied by default', async () => {
    const argsFile = path.join(tmpDir, 'argv.json');
    process.env['STUB_ARGS_FILE'] = argsFile;
    const server = makeServer();
    await server.ensureStarted();

    const argv = JSON.parse(fs.readFileSync(argsFile, 'utf-8')) as string[];
    expect(argv).toContain('--lora-scaled');
    // Three adapters, each loaded at 0.0 — an adapter is only ever active
    // because a request asked for it, never because it was first on the
    // command line.
    expect(argv.filter((a) => a === '--lora-scaled')).toHaveLength(3);
    for (const p of [boxesAdapter, ocrAdapter, footnotesAdapter]) {
      const at = argv.indexOf(p);
      expect(at).toBeGreaterThan(0);
      expect(argv[at - 1]).toBe('--lora-scaled');
      expect(argv[at + 1]).toBe('0.0');
    }
    // One model, loopback only.
    expect(argv[argv.indexOf('-m') + 1]).toBe(basePath);
    expect(argv[argv.indexOf('--host') + 1]).toBe('127.0.0.1');
    expect(argv[argv.indexOf('-c') + 1]).toBe('4096');
  });

  test('a request names its adapter and gets the full scale vector', async () => {
    // The FULL vector every time, not just the one being switched on:
    // llama-server carries forward whatever it was last told, so a partial
    // vector makes the applied adapter depend on request order. A boxes prompt
    // answered under the ocr adapter still produces plausible output — nothing
    // errors, the labels are simply wrong.
    const server = makeServer();
    const answer = echo(await server.complete({ prompt: 'x', adapter: 'ocr' }));
    expect(answer.received.lora).toEqual([
      { id: 0, scale: 0 },
      { id: 1, scale: 1 },
      { id: 2, scale: 0 },
    ]);
  });

  test('each adapter selects its own index', async () => {
    const server = makeServer();
    for (const [i, name] of ['boxes', 'ocr', 'footnotes'].entries()) {
      const answer = echo(await server.complete({ prompt: 'x', adapter: name }));
      const active = answer.received.lora.filter((l) => l.scale === 1);
      expect(active).toEqual([{ id: i, scale: 1 }]);
    }
  });

  test('one server serves all three adapters without a restart', async () => {
    // The inversion from BookForge (MIGRATION §4): three separate 4B servers
    // would mean gigabytes of unload/reload every time convert moved between
    // stages. Same process, same port, three adapters.
    const server = makeServer();
    await server.ensureStarted();
    const port = server.port;
    for (const name of ['boxes', 'ocr', 'footnotes', null]) {
      await server.complete({ prompt: 'x', adapter: name });
    }
    expect(server.port).toBe(port);
    expect(server.running).toBe(true);
  });

  test('no adapter means every scale is zero — the bare base', async () => {
    const server = makeServer();
    for (const req of [{ prompt: 'x' }, { prompt: 'x', adapter: null }]) {
      const answer = echo(await server.complete(req));
      expect(answer.received.lora.every((l) => l.scale === 0)).toBe(true);
    }
  });

  test('an unknown adapter throws naming the ones that are loaded', async () => {
    const server = makeServer();
    await expect(server.complete({ prompt: 'x', adapter: 'rubric' })).rejects.toThrow(
      /Unknown adapter 'rubric'.*boxes, ocr, footnotes/s,
    );
  });

  test('duplicate adapter names are rejected at construction', () => {
    expect(() => new LlamaServer({
      binaryPath: STUB,
      basePath,
      adapters: [
        { name: 'boxes', path: boxesAdapter },
        { name: 'boxes', path: ocrAdapter },
      ],
      contextSize: 4096,
    })).toThrow(/Duplicate adapter name/);
  });

  test('a server with no adapters sends an empty vector', async () => {
    const server = makeServer({ adapters: [] });
    expect(echo(await server.complete({ prompt: 'x' })).received.lora).toEqual([]);
    expect(server.adapterNames).toEqual([]);
  });
});

describe('shutdown', () => {
  test('stop() kills the process and is idempotent', async () => {
    const server = makeServer();
    await server.ensureStarted();
    const endpoint = server.endpoint;

    await server.stop();
    expect(server.running).toBe(false);
    await server.stop();

    await expect(fetch(`${endpoint}/health`)).rejects.toThrow();
  });

  test('the idle timer shuts the server down and gives the RAM back', async () => {
    const server = makeServer({ idleShutdownMs: 250 });
    await server.ensureStarted();
    expect(server.running).toBe(true);
    await Bun.sleep(900);
    expect(server.running).toBe(false);
  }, 20_000);

  test('activity postpones the idle shutdown', async () => {
    const server = makeServer({ idleShutdownMs: 600 });
    await server.ensureStarted();
    for (let i = 0; i < 4; i++) {
      await Bun.sleep(200);
      await server.complete({ prompt: `keepalive ${i}` });
    }
    expect(server.running).toBe(true);
  }, 20_000);

  test('a stopped server restarts on the next request', async () => {
    const server = makeServer();
    await server.ensureStarted();
    await server.stop();
    expect(echo(await server.complete({ prompt: 'again' })).received.prompt).toBe('again');
    expect(server.running).toBe(true);
  });
});

describe('port selection', () => {
  test('an explicit port is honoured', async () => {
    const port = await freeLoopbackPort();
    const server = makeServer({ port });
    await server.ensureStarted();
    expect(server.port).toBe(port);
  });

  test('without one, an ephemeral loopback port is taken', async () => {
    // Never a fixed port: it would collide with a llama-server the user started
    // themselves, which is a real thing on a machine where someone is
    // developing this.
    const a = makeServer();
    const b = makeServer();
    await a.ensureStarted();
    await b.ensureStarted();
    expect(a.port).not.toBe(b.port);
    expect(a.port).toBeGreaterThan(1024);
  });
});
