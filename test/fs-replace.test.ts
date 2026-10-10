import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { replaceFileSync, retryAsync, retrySync } from '../src/fs-replace.js';

/*
 * A replace refused for a moment by another holder of the file (measured on the
 * library's NAS share, 2026-10-10: one replace in seventeen, ~0.1 s) is waited
 * out; a refusal that is not a holder still throws at once.
 */
function scratch(): { from: string; to: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-replace-'));
  const to = path.join(dir, 'product.json');
  fs.writeFileSync(to, 'old');
  fs.writeFileSync(`${to}.partial`, 'new');
  return { from: `${to}.partial`, to };
}

const refusal = (code: string): Error => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });

describe('replacing a file', () => {
  test('a holder that lets go is waited out, and the new file is in place', () => {
    const { from, to } = scratch();
    let refused = 0;
    retrySync((a, b) => {
      if (refused < 2) { refused += 1; throw refusal('EPERM'); }
      fs.renameSync(a, b);
    }, from, to);
    expect(refused).toBe(2);
    expect(fs.readFileSync(to, 'utf8')).toBe('new');
    expect(fs.existsSync(from)).toBe(false);
  });

  test('a refusal that is not a holder throws at once', () => {
    const { from, to } = scratch();
    let tries = 0;
    expect(() => retrySync(() => { tries += 1; throw refusal('ENOENT'); }, from, to)).toThrow(/ENOENT/);
    expect(tries).toBe(1);
  });

  test('the async writers wait the same way', async () => {
    const { from, to } = scratch();
    let refused = 0;
    await retryAsync(async (a, b) => {
      if (refused < 1) { refused += 1; throw refusal('EBUSY'); }
      await fs.promises.rename(a, b);
    }, from, to);
    expect(refused).toBe(1);
    expect(fs.readFileSync(to, 'utf8')).toBe('new');
  });

  test('the real rename, uncontended, replaces', () => {
    const { from, to } = scratch();
    replaceFileSync(from, to);
    expect(fs.readFileSync(to, 'utf8')).toBe('new');
  });
});
