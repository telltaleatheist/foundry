/**
 * `--skip-pages`, the half of it that is pure.
 *
 * The list is somebody's curation of a book — the pages they deleted in a
 * picker — and it arrives as a string on a command line. What this file pins is
 * that every way of typing it wrong is REFUSED BY NAME rather than quietly
 * meaning something else: a skip list that half-parses deletes the wrong pages
 * of somebody's book, and the result is a plausible EPUB with a chapter missing.
 *
 * The other half of the refusals — a page past the end of the document, a list
 * covering the whole book — lives in `vlm_page.py`, because only the process
 * that opened the PDF knows how many pages it has. See the header of
 * `src/vlm/pages.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { UsageError } from '../../src/args.js';
import { parsePageList } from '../../src/vlm/pages.js';

const parse = (raw: string): number[] => parsePageList(raw, '--skip-pages');

test('numbers and ranges, sorted, deduplicated', () => {
  assert.deepEqual(parse('3,17,19-24'), [3, 17, 19, 20, 21, 22, 23, 24]);
  assert.deepEqual(parse('7'), [7]);
  // Order and repetition are the user's, not the book's.
  assert.deepEqual(parse('9,2,9,3-5,4'), [2, 3, 4, 5, 9]);
  // A range of one is a page.
  assert.deepEqual(parse('6-6'), [6]);
});

test('whitespace around the entries is not an error', () => {
  assert.deepEqual(parse(' 3 , 19 - 21 '), [3, 19, 20, 21]);
});

test('a page that is not a number is refused, naming what was typed', () => {
  assert.throws(() => parse('3,abc,7'), (err: unknown) => {
    assert.ok(err instanceof UsageError);
    assert.match(err.message, /--skip-pages does not understand "abc"/);
    return true;
  });
  // The empty entry a trailing comma leaves is named as an empty entry, not as
  // a quoted empty string the reader never typed.
  assert.throws(() => parse('3,'), (err: unknown) => {
    assert.match((err as Error).message, /--skip-pages has an empty entry in "3,"/);
    return true;
  });
  // A half-typed range.
  assert.throws(() => parse('3-'), UsageError);
  assert.throws(() => parse('-5'), UsageError);
  assert.throws(() => parse('1.5'), UsageError);
  assert.throws(() => parse(''), (err: unknown) => {
    assert.match((err as Error).message, /--skip-pages was given no pages/);
    return true;
  });
});

test('page 0 is refused: a PDF\'s pages start at 1', () => {
  // The trap this catches is a caller that counts from zero. It would delete
  // every page one earlier than the person meant, silently.
  assert.throws(() => parse('0'), (err: unknown) => {
    assert.match((err as Error).message, /names page 0, and a PDF's pages start at 1/);
    return true;
  });
  assert.throws(() => parse('0-4'), UsageError);
});

test('a range that runs backwards is refused rather than reversed', () => {
  assert.throws(() => parse('24-19'), (err: unknown) => {
    assert.match((err as Error).message, /names the range 24-19, which runs backwards/);
    return true;
  });
});

test('an absurd range is a message, not a hang', () => {
  // The range is expanded here, so `1-999999999` has to be refused before it is
  // expanded. The real bound is the document's page count, which this side does
  // not know.
  assert.throws(() => parse('1-999999999'), (err: unknown) => {
    assert.match((err as Error).message, /spans 999999999 pages/);
    return true;
  });
});
