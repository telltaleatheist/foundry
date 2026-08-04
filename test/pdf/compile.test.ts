/**
 * The bun-compile gate.
 *
 * ARCHITECTURE §1: foundry ships as one `bun build --compile` executable. That
 * makes "does this dependency work" a question about the BINARY, not about
 * `bun run`, and the difference is not theoretical — pdf.js runs perfectly
 * under `bun run` and, unshimmed, does not start in a compiled binary at all
 * (it reaches for a native canvas package for `DOMMatrix`, and loads its worker
 * through a dynamic import that is never bundled).
 *
 * So the proof is a real build and a real run. It costs a few seconds and it is
 * the only evidence that means anything.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROBE = join(import.meta.dir, 'compile-probe.ts');

test('pdf.js and pdf-lib work inside a compiled binary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'foundry-compile-'));
  const out = join(dir, process.platform === 'win32' ? 'probe.exe' : 'probe');
  try {
    const build = Bun.spawn([process.execPath, 'build', PROBE, '--compile', '--outfile', out], {
      cwd: join(import.meta.dir, '..', '..'),
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const buildErr = await new Response(build.stderr).text();
    expect(await build.exited).toBe(0);
    expect(buildErr).not.toContain('error');

    const run = Bun.spawn([out], { stdout: 'pipe', stderr: 'pipe' });
    const stdout = await new Response(run.stdout).text();
    const stderr = await new Response(run.stderr).text();
    const code = await run.exited;
    if (code !== 0) throw new Error(`the compiled probe exited ${code}:\n${stderr}`);

    const result = JSON.parse(stdout.trim()) as { pages: number; lines: string[]; bytes: number };
    expect(result.pages).toBe(1);
    expect(result.bytes).toBeGreaterThan(0);
    // Character for character, including the ligature and the em dash — a
    // binary that extracted "finally" would be a binary that reads a different
    // book from the one the tests read.
    expect(result.lines).toEqual([
      'Working Towards the Führer',
      'the treaty col—lapsed “quietly”, ﬁnally',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 300_000);
