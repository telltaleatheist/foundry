/**
 * probe — the endpoint probe against a real listening socket, the WSL probe
 * against an injected runner, and the UTF-16 tell that makes wsl.exe output
 * readable at all.
 */
import { describe, expect, test } from 'bun:test';

import {
  decodeConsole,
  probeEndpoint,
  probeWslVllm,
  type RunResult,
  type Runner,
} from '../../src/backend/probe.js';

/** wsl.exe's pipe encoding: UTF-16LE with a BOM. */
function utf16(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
}

describe('decodeConsole', () => {
  test('NUL bytes mean UTF-16LE, and the BOM comes off', () => {
    expect(decodeConsole(utf16('Ubuntu\r\n'))).toBe('Ubuntu\r\n');
  });

  test('plain bytes are UTF-8', () => {
    expect(decodeConsole(Buffer.from('hello\n', 'utf8'))).toBe('hello\n');
  });
});

describe('probeEndpoint', () => {
  /** An OpenAI-shaped /v1/models on a random local port, for one test. */
  async function withServer(
    handler: (req: Request) => Response,
    fn: (url: string) => Promise<void>,
  ): Promise<void> {
    const server = Bun.serve({ port: 0, fetch: handler });
    try {
      await fn(`http://localhost:${server.port}/v1`);
    } finally {
      server.stop(true);
    }
  }

  test('an OpenAI-shaped answer is available, with the models named', async () => {
    await withServer(
      () => Response.json({ object: 'list', data: [{ id: 'rednote-hilab/dots.ocr' }] }),
      async (url) => {
        const probe = await probeEndpoint(url);
        expect(probe.available).toBe(true);
        expect(probe.models).toEqual(['rednote-hilab/dots.ocr']);
        expect(probe.detail).toContain('dots.ocr');
        expect(probe.latencyMs).not.toBeNull();
      },
    );
  });

  test('a server without the "data" list is refused as not OpenAI-compatible', async () => {
    await withServer(
      () => Response.json({ status: 'fine' }),
      async (url) => {
        const probe = await probeEndpoint(url);
        expect(probe.available).toBe(false);
        expect(probe.detail).toContain('not an OpenAI-compatible server');
      },
    );
  });

  test('an HTTP error status is reported by number', async () => {
    await withServer(
      () => new Response('nope', { status: 503 }),
      async (url) => {
        const probe = await probeEndpoint(url);
        expect(probe.available).toBe(false);
        expect(probe.detail).toContain('503');
      },
    );
  });

  test('nothing listening is a miss naming the url, not a throw', async () => {
    // A port from the dynamic range with nothing on it; connection refused is
    // immediate, so the timeout budget is irrelevant.
    const probe = await probeEndpoint('http://127.0.0.1:49999/v1', 2000);
    expect(probe.available).toBe(false);
    expect(probe.detail).toContain('127.0.0.1:49999');
  });
});

describe('probeWslVllm', () => {
  const onWin = process.platform === 'win32' ? test : test.skip;

  test('off Windows it reports the platform, without running anything', async () => {
    if (process.platform === 'win32') return;
    const probe = await probeWslVllm({}, () => {
      throw new Error('must not run');
    });
    expect(probe.available).toBe(false);
    expect(probe.detail).toContain('not win32');
  });

  /** Scripted runner: match on the joined command line, in order of listing. */
  function scripted(script: Array<[needle: string, result: Partial<RunResult>]>): Runner {
    return async (cmd, args) => {
      const line = [cmd, ...args].join(' ');
      for (const [needle, result] of script) {
        if (line.includes(needle)) {
          return { exitCode: 0, stdout: '', stderr: '', ...result };
        }
      }
      throw new Error(`unscripted command: ${line}`);
    };
  }

  onWin('finds the first candidate that can import vllm, and names distro and python', async () => {
    const probe = await probeWslVllm({}, scripted([
      ['-l -q', { stdout: 'Ubuntu\r\n' }],
      ['envs/vllm/bin/python', { exitCode: 0 }],
    ]));
    expect(probe.available).toBe(true);
    expect(probe.distro).toBe('Ubuntu');
    expect(probe.python).toContain('envs/vllm');
  });

  onWin('a miss names every candidate it tried', async () => {
    const probe = await probeWslVllm({}, scripted([
      ['-l -q', { stdout: 'Ubuntu\r\n' }],
      ['python', { exitCode: 3 }],
    ]));
    expect(probe.available).toBe(false);
    expect(probe.detail).toContain('envs/vllm/bin/python');
    expect(probe.detail).toContain('backend.vllmPython');
  });

  onWin('a settings distro that wsl.exe does not list is refused by name', async () => {
    const probe = await probeWslVllm(
      { backend: { wslDistro: 'Debian' } },
      scripted([['-l -q', { stdout: 'Ubuntu\r\n' }]]),
    );
    expect(probe.available).toBe(false);
    expect(probe.detail).toContain('"Debian"');
    expect(probe.detail).toContain('Ubuntu');
  });

  onWin('an explicit vllmPython replaces the candidate list', async () => {
    const probe = await probeWslVllm(
      { backend: { vllmPython: '/opt/my/python' } },
      scripted([
        ['-l -q', { stdout: 'Ubuntu\r\n' }],
        ['/opt/my/python', { exitCode: 0 }],
      ]),
    );
    expect(probe.available).toBe(true);
    expect(probe.python).toBe('/opt/my/python');
  });

  onWin('wsl.exe itself failing is reported as the failure', async () => {
    const probe = await probeWslVllm({}, scripted([
      ['-l -q', { exitCode: null, failure: 'spawn wsl.exe ENOENT' }],
    ]));
    expect(probe.available).toBe(false);
    expect(probe.detail).toContain('ENOENT');
  });
});
