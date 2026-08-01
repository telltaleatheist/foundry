/**
 * Binary resolution — and specifically, what it REFUSES to do.
 *
 * The interesting assertions here are negative ones. A resolver that finds the
 * binary is easy; the property worth protecting is that it never quietly finds
 * a DIFFERENT binary, because an unknown llama.cpp revision may ignore the
 * multi-LoRA flags and answer anyway, with no adapter applied — a quality
 * regression that reads as a bad model.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  llamaBinaryName,
  llamaSearchRoots,
  llamaVendorPlatformDir,
  resolveLlamaServer,
  vendoredLlamaCandidates,
} from '../../src/serve/llama-binary.js';

let tmpDir: string;
let fakeBinary: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-llama-bin-'));
  fakeBinary = path.join(tmpDir, 'llama-server');
  fs.writeFileSync(fakeBinary, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(fakeBinary, 0o755);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('vendored layout', () => {
  test('the platform directory carries arch, not just platform', () => {
    // darwin-arm64 and darwin-x64 are different files and package.json builds
    // both, so platform alone cannot name the right one.
    expect(llamaVendorPlatformDir('darwin', 'arm64')).toBe('darwin-arm64');
    expect(llamaVendorPlatformDir('linux', 'x64')).toBe('linux-x64');
  });

  test('the binary is .exe on Windows only', () => {
    expect(llamaBinaryName('win32')).toBe('llama-server.exe');
    expect(llamaBinaryName('darwin')).toBe('llama-server');
    expect(llamaBinaryName('linux')).toBe('llama-server');
  });

  test('candidates sit under vendor/llama/<platform>-<arch>/', () => {
    const [candidate] = vendoredLlamaCandidates(['/opt/foundry']);
    expect(candidate).toBe(
      path.join('/opt/foundry', 'vendor', 'llama', llamaVendorPlatformDir(), llamaBinaryName()),
    );
  });

  test('search roots cover both the installed binary and the source checkout', () => {
    const roots = llamaSearchRoots();
    expect(roots.length).toBeGreaterThan(0);
    expect(roots).toContain(path.dirname(process.execPath));
    // Running from source, the repo root is derived from this module and is a
    // real directory, so it is offered too.
    expect(roots).toContain(path.resolve(import.meta.dir, '..', '..'));
    expect(new Set(roots).size).toBe(roots.length);
  });
});

describe('--llama-server override', () => {
  test('an executable file is accepted and returned absolute', () => {
    expect(resolveLlamaServer(fakeBinary)).toBe(path.resolve(fakeBinary));
  });

  test('a relative override is resolved', () => {
    const rel = path.relative(process.cwd(), fakeBinary);
    expect(resolveLlamaServer(rel)).toBe(path.resolve(fakeBinary));
  });

  test('a missing override throws naming the path — it does not fall through', () => {
    // Falling back to the vendored binary here is the specific bug: someone who
    // names a path is telling you which binary they want, and running a
    // different one silently measures the wrong build.
    const missing = path.join(tmpDir, 'not-here', 'llama-server');
    expect(() => resolveLlamaServer(missing)).toThrow(new RegExp(escape(missing)));
    expect(() => resolveLlamaServer(missing)).toThrow(/not there/);
  });

  test('a directory is not a binary', () => {
    expect(() => resolveLlamaServer(tmpDir)).toThrow(/not a file/);
  });

  test('a non-executable file is rejected', () => {
    // ExFAT and some network mounts report every file as executable, so there
    // is nothing to assert on those. Skipped rather than weakened.
    const plain = path.join(tmpDir, 'plain-file');
    fs.writeFileSync(plain, 'not a program');
    fs.chmodSync(plain, 0o644);
    let executableBitHonoured = true;
    try {
      fs.accessSync(plain, fs.constants.X_OK);
      executableBitHonoured = false;
    } catch {
      /* the filesystem does track the bit */
    }
    if (!executableBitHonoured) return;
    expect(() => resolveLlamaServer(plain)).toThrow(/not executable/);
  });

  test('a blank override is not an override', () => {
    // Falls through to the vendored search, which on a dev checkout has no
    // binary — so this must be the "no llama-server found" error, listing the
    // paths it looked at.
    expect(() => resolveLlamaServer('   ')).toThrow(/No llama-server binary found/);
  });
});

describe('no PATH fallback, ever', () => {
  test('a llama-server on PATH is not used', () => {
    // The rule from ARCHITECTURE §5's sibling reasoning, asserted directly:
    // put a perfectly good llama-server first on PATH and confirm the resolver
    // still refuses to see it.
    const original = process.env['PATH'];
    process.env['PATH'] = `${tmpDir}${path.delimiter}${original ?? ''}`;
    try {
      let resolved: string | null = null;
      try {
        resolved = resolveLlamaServer();
      } catch (err) {
        expect((err as Error).message).toMatch(/No llama-server binary found/);
        expect((err as Error).message).toMatch(/does not search PATH/);
      }
      // If a vendored binary genuinely exists on this machine it may resolve —
      // but never to the one we just planted on PATH.
      if (resolved !== null) expect(resolved).not.toBe(fakeBinary);
    } finally {
      process.env['PATH'] = original;
    }
  });

  test('the failure names every path it checked', () => {
    let message = '';
    try {
      resolveLlamaServer();
    } catch (err) {
      message = (err as Error).message;
    }
    if (!message) return; // a real vendored binary is installed here
    for (const candidate of vendoredLlamaCandidates()) {
      expect(message).toContain(candidate);
    }
    expect(message).toContain('--llama-server');
  });
});

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
