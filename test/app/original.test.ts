/**
 * Which row is the BOOK — and the basename match that used to erase projects.
 *
 * `isBook` decides whether the ✕ on a document is a file delete or the whole
 * project's. It compared the tail of a step's project-relative path against the
 * BASENAME of the path being deleted, so `generated/archived-1748…/book.epub`
 * matched `book.epub` — and since a rotation happens every time a rendering is
 * made again, the ✕ on an ordinary document quietly reported itself as the
 * book's and took the readings bank, the overlays and the archived original with
 * it.
 *
 * That is the house rule this codebase already wrote down after the last time —
 * never match by basename across directories — broken in the function where
 * breaking it costs the most. These tests are the rule, held down.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bookRow, isBook, originalOf } from '../../app/shared/original.ts';
import type { ProjectDocument, ProjectStep } from '../../app/shared/types.ts';

const ROOT = 'C:/Users/o/Documents/Foundry/projects/Kershaw-a1b2c3d4';

function step(file: string, retention: ProjectStep['retention'] = 'expensive'): ProjectStep {
  return { file, label: 'a step', appliedAt: 1, kind: 'origin', retention, why: '' };
}

function document(
  over: Partial<ProjectDocument> & Pick<ProjectDocument, 'kind' | 'path'>,
): ProjectDocument {
  return {
    label: over.path.split('/').pop() ?? '',
    at: 1,
    missing: false,
    managed: true,
    steps: [],
    origin: false,
    ...over,
  };
}

/**
 * A real project after one re-generation: a scan whose chain is the archived
 * original, and an EPUB whose previous version was rotated aside — which is what
 * puts two files called `Kershaw.epub` in one folder tree.
 */
const SCAN = document({
  kind: 'pdf',
  path: `${ROOT}/working/Kershaw.pdf`,
  steps: [step('archive/Kershaw.pdf', 'irreplaceable')],
  origin: true,
  managed: false,
});

const BOOK = document({
  kind: 'epub',
  path: `${ROOT}/generated/Kershaw.epub`,
  steps: [step('generated/archived-1748/Kershaw.epub'), step('generated/Kershaw.epub')],
});

const PROJECT = [SCAN, BOOK];

test('the book is the row whose chain starts with what the user handed over', () => {
  assert.equal(bookRow(PROJECT), SCAN);
  assert.equal(originalOf(PROJECT), SCAN);
});

test('the scan IS the book, by its live path and by its archived origin', () => {
  assert.equal(isBook(PROJECT, `${ROOT}/working/Kershaw.pdf`, ROOT), true);
  // An earlier step of the book's own chain is the book too: deleting the
  // archived original is deleting the thing everything else was made from.
  assert.equal(isBook(PROJECT, `${ROOT}/archive/Kershaw.pdf`, ROOT), true);
});

test('THE REGRESSION: a rotated EPUB is not the book because it shares a name', () => {
  // `generated/archived-1748/Kershaw.epub` ends with `Kershaw.epub`. Under the
  // old rule this returned true and the ✕ erased the whole project.
  assert.equal(isBook(PROJECT, `${ROOT}/generated/archived-1748/Kershaw.epub`, ROOT), false);
  assert.equal(isBook(PROJECT, `${ROOT}/generated/Kershaw.epub`, ROOT), false);
});

test('a PDF named like the scan in another layer is not the scan', () => {
  // The reprint and the scan carry ONE filename and differ only by directory,
  // which is exactly the collision the app deliberately never shows the user.
  assert.equal(isBook(PROJECT, `${ROOT}/generated/Kershaw.pdf`, ROOT), false);
  assert.equal(isBook(PROJECT, `${ROOT}/final/Kershaw.pdf`, ROOT), false);
});

test('a file in another project is never this project\'s book', () => {
  const elsewhere = 'C:/Users/o/Documents/Foundry/projects/Other-99999999/archive/Kershaw.pdf';
  assert.equal(isBook(PROJECT, elsewhere, ROOT), false);
});

test('Windows spells a path three ways and they are one path', () => {
  assert.equal(isBook(PROJECT, `${ROOT}\\working\\Kershaw.pdf`, ROOT), true);
  assert.equal(isBook(PROJECT, `${ROOT}/ARCHIVE/kershaw.PDF`, ROOT), true);
});

test('without the project directory, only the live path can match', () => {
  // The honest limit of what a document list alone can say — and it fails SAFE:
  // a delete is never escalated to the project's on a guess.
  assert.equal(isBook(PROJECT, `${ROOT}/working/Kershaw.pdf`), true);
  assert.equal(isBook(PROJECT, `${ROOT}/archive/Kershaw.pdf`), false);
});

test('a project with no book at all says so rather than guessing', () => {
  const orphan = [document({ kind: 'epub', path: `${ROOT}/generated/Kershaw.epub` })];
  assert.equal(bookRow(orphan), null);
  assert.equal(isBook(orphan, `${ROOT}/generated/Kershaw.epub`, ROOT), false);
  // `originalOf` still offers something to open — a project that lost its import
  // is a folder with work in it.
  assert.equal(originalOf(orphan)?.kind, 'epub');
});

test('originalOf skips what cannot be opened', () => {
  const gone = [
    document({ kind: 'pdf', path: `${ROOT}/working/Kershaw.pdf`, origin: true, missing: true }),
    document({ kind: 'txt', path: `${ROOT}/generated/Kershaw.txt` }),
    document({ kind: 'epub', path: `${ROOT}/generated/Kershaw.epub` }),
  ];
  // The book is missing and text has no tab in this app, so the click lands on
  // the one row that opens.
  assert.equal(originalOf(gone)?.kind, 'epub');
});
