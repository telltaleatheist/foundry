import { describe, expect, test } from 'bun:test';
import { defaultLocalPythonCandidates } from '../src/backend/probe.js';

/*
 * The rasteriser's interpreter list names BookForge's tools env by its CURRENT
 * directory. It kept the old `e2a-env` name after BookForge renamed it
 * (2026-10-03), and every PDF read from the picker failed with "no Python for
 * this mode was found" on a machine whose tools env had PyMuPDF in it.
 */
describe('defaultLocalPythonCandidates', () => {
  test("names BookForge's tools env", () => {
    const candidates = defaultLocalPythonCandidates();
    expect(candidates.some((c) => /[\\/]bookforge[\\/]runtime[\\/]tools-env[\\/]/.test(c))).toBe(true);
  });

  test('names no retired e2a env', () => {
    for (const c of defaultLocalPythonCandidates()) {
      expect(c).not.toMatch(/e2a-env|ebook2audiobook/);
    }
  });
});
