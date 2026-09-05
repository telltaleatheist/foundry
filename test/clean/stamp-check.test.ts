/**
 * The stamp is a claim the render door can check — Owen, 2026-09-05.
 *
 * BookForge measured `vlm-compile --narration-stamp` stamping whatever book it
 * was handed, so an EPUB compiled from the UNCLEANED parent carried a perfectly
 * valid claim over text still reading "Dr. Smith". The ruling: *"recompute over
 * the book handed and refuse by name on mismatch."*
 *
 * `checkedNarrationStampMeta` is the one door every stamp goes through on its
 * way into a package document, so it is where the ruling is pinned. What is
 * asserted here is only the ruling: a mismatch REFUSES and NAMES the positions,
 * an absent position is skipped rather than refused, and the package form
 * carries the count and never the map.
 */
import { describe, expect, test } from 'bun:test';

import { blockDigest } from '../../src/clean/digest.js';
import {
  checkedNarrationStampMeta, narrationTextStamp, type NarrationTextStampMeta,
} from '../../src/clean/stamp.js';

/** A cleanup over three blocks, as `clean-text --stamp` would have written it. */
function stampOver(cleaned: Record<string, string>): string {
  return JSON.stringify(narrationTextStamp({
    model: 'qwen3.8:27b',
    at: '2026-09-05T00:00:00.000Z',
    punctuationRefused: 0,
    blocks: new Map(Object.entries(cleaned).map(([at, text]) => [at, blockDigest(text)])),
  }));
}

const CLEANED = {
  'b1-0': 'Doctor Smith paid five thousand dollars.',
  'b1-1': 'The F B I opened a file.',
  'b1-2': 'They were twenty men.',
};

function checkAgainst(texts: Record<string, string>, stamp: string = stampOver(CLEANED)): string {
  return checkedNarrationStampMeta({
    stampJson: stamp,
    stampPath: 'C:/books/one.stamp.json',
    texts: new Map(Object.entries(texts)),
    where: 'C:/books/one.book.jsonl',
    command: 'vlm-compile',
    remedy: 'Compile the position that sits UNDER the clean step.',
    log: () => {},
    fail: (message: string): never => { throw new Error(message); },
  });
}

describe('a stamp recomputed over the book actually handed', () => {
  test('the cleaned book passes, and the package form carries the COUNT', () => {
    const meta = JSON.parse(checkAgainst(CLEANED)) as NarrationTextStampMeta;
    expect(meta.stampVersion).toBe(2);
    expect(meta.blocks).toBe(3);
    expect(typeof meta.textDigest).toBe('string');
    // Never the map: a `<meta content=…>` holding thousands of hashes is not a
    // package document, which is the whole reason `blocks` has two renderings.
    expect(JSON.parse(checkAgainst(CLEANED)).blocks).not.toBeInstanceOf(Object);
  });

  test('the UNCLEANED book refuses, naming the count and the positions', () => {
    let thrown = '';
    try {
      checkAgainst({
        'b1-0': 'Dr. Smith paid $5,000.',
        'b1-1': 'The FBI opened a file.',
        'b1-2': CLEANED['b1-2'],
      });
    } catch (err) {
      thrown = (err as Error).message;
    }
    expect(thrown).toContain('over 3 block(s)');
    expect(thrown).toContain('2 of them do not hold the text that cleanup produced');
    expect(thrown).toContain('b1-0, b1-1');
    expect(thrown).toContain('THE BOOK HANDED IS NOT THE ONE THIS CLEANUP PRODUCED');
    // The block that DID match is not accused of anything.
    expect(thrown).not.toContain('b1-2');
  });

  test('a position the book no longer has is SKIPPED, not refused', () => {
    // Owen's ruling: a struck block is legitimately absent, and refusing that
    // would make any removal invalidate a cleanup still true of everything left.
    const said: string[] = [];
    const meta = checkedNarrationStampMeta({
      stampJson: stampOver(CLEANED),
      stampPath: 'C:/books/one.stamp.json',
      texts: new Map([['b1-0', CLEANED['b1-0']], ['b1-2', CLEANED['b1-2']]]),
      where: 'C:/books/one.book.jsonl',
      command: 'vlm-compile',
      remedy: 'Compile the position that sits UNDER the clean step.',
      log: (line) => said.push(line),
      fail: (message: string): never => { throw new Error(message); },
    });
    expect((JSON.parse(meta) as NarrationTextStampMeta).blocks).toBe(3);
    expect(said.join('\n')).toContain('2 block(s) hold exactly the text');
    expect(said.join('\n')).toContain('1 position(s) the stamp names are not in this book');
  });

  test('not ONE position in common is a stamp about a different book', () => {
    expect(() => checkAgainst({ 'z9-9': 'Something else entirely.' }))
      .toThrow(/was written about a different book/);
  });

  test('a stamp naming no blocks is carried, and the omission is said out loud', () => {
    const legacy = JSON.stringify({
      stampVersion: 2,
      normalizerVersion: 'n6',
      punctuationSpec: 's1',
      model: 'qwen3.5:9b-q8_0',
      at: '2026-09-04T00:00:00.000Z',
      punctuationRefused: 3,
    });
    const said: string[] = [];
    const meta = checkedNarrationStampMeta({
      stampJson: legacy,
      stampPath: 'C:/books/old.stamp.json',
      texts: new Map(),
      where: 'C:/books/one.book.jsonl',
      command: 'vlm-compile',
      remedy: 'Compile the position that sits UNDER the clean step.',
      log: (line) => said.push(line),
      fail: (message: string): never => { throw new Error(message); },
    });
    const carried = JSON.parse(meta) as NarrationTextStampMeta;
    expect(carried.punctuationRefused).toBe(3);
    expect(carried.blocks).toBeUndefined();
    expect(said.join('\n')).toContain('NOTHING WAS RECOMPUTED');
  });
});
