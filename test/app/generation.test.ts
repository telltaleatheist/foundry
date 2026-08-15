/**
 * The reading generation — which pass over the pages a curation is about.
 *
 * WHAT THESE TESTS ARE PROTECTING, and it is one thing said five ways: an
 * overlay names blocks as `(page, order)`, those numbers mean different blocks
 * after the model reads the pages again, and the generation is the only thing
 * standing between somebody's four hundred corrections and being silently
 * reapplied to a book where they land on different paragraphs. The id moving at
 * the wrong moment costs a person their work; the id NOT moving at the right
 * moment costs them their work AND says nothing about it.
 *
 * It used to be answered by counting `readings/archived-<stamp>/` folders, and
 * two changes took both legs out from under that proxy at once: a re-read now
 * swaps in a pending bank instead of archiving the old one, and a re-read of a
 * different page range branches into a bank of its own. Neither archives
 * anything, so the count never moves and every reading after the first would
 * have inherited the first one's id. These tests are the five invariants of
 * docs/BANK-LIFECYCLE.md §4.4, which is the fix's spec.
 *
 * THE FUNCTIONS UNDER TEST ARE THE DECISION, NOT THE DISK. `readingGeneration`
 * and `recordReading` live in `electron/projects.ts`, which imports electron at
 * module scope and cannot be loaded here; what they do is read a marker, mint a
 * uuid and write a manifest. The judgement is `generationInEffect` (what a
 * viewer standing somewhere compares against) and `generationForLanding` (what a
 * finished reading is stamped with), both pure, both here.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RETENTION_OF,
  appendStep,
  emptyLedger,
  generationForLanding,
  generationInEffect,
  labelFor,
  originStep,
  readingInEffect,
  recordLanding,
} from '../../app/shared/ledger.ts';
import type {
  LedgerStep,
  ProjectLedger,
  ProjectReading,
} from '../../app/shared/types.ts';

/** Three passes over one book's pages, told apart at a glance in a failure. */
const FIRST = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';
const MINTED = '99999999-9999-4999-8999-999999999999';

/** Two completions, as `markerStamp` hands them over: epoch milliseconds. */
const MONDAY = 1_786_000_000_000;
const TUESDAY = 1_786_086_400_000;

function step(over: Partial<LedgerStep> & Pick<LedgerStep, 'id' | 'parent' | 'action'>): LedgerStep {
  return {
    payload: `payloads/${over.id}`,
    retention: RETENTION_OF[over.action],
    createdAt: 0,
    label: labelFor(over.action, over.params),
    ...over,
  };
}

/** import → read, the shape of every project that has been read once. */
function readOnce(params: LedgerStep['params']): ProjectLedger {
  const ledger = appendStep(emptyLedger(), originStep('s0', 'archive/Book.pdf', 100, 'Imported'));
  return appendStep(ledger, step({
    id: 's1', parent: 's0', action: 'read', payload: 'readings/book.jsonl', createdAt: 200, params,
  }));
}

/** What `readingGeneration` would find on the step it just wrote. */
function paramsOf(ledger: ProjectLedger, id: string): LedgerStep['params'] {
  const found = ledger.steps.find((row) => row.id === id);
  assert.ok(found !== undefined, `no step ${id}`);
  return found.params;
}

/** A first-touch record: minted by the block editor, never by a landing. */
function firstTouch(over: Partial<ProjectReading> = {}): ProjectReading {
  return { generation: FIRST, readAt: 0, pages: 0, ...over };
}

// ═════════════════════════════════════════════════════════════════════════════

describe('invariant 1 — a fresh re-read changes the generation its step answers', () => {
  test('the landing mints, the step carries it, and the position answers with it', () => {
    const before = readOnce({ generation: FIRST, pages: 17, completedAt: MONDAY });
    assert.equal(
      generationInEffect(before, null, MONDAY, MINTED).generation,
      FIRST,
      'nothing has happened yet, so the first reading answers',
    );

    // The re-read: same question, same parent, so `recordLanding` REPLACES —
    // same step, same bank path, new contents. This is the case the folder count
    // stopped noticing the day the engine started swapping a pending bank in
    // rather than archiving the old one, and the whole §4.4 fix is that it is
    // noticed here instead, at the landing.
    const minted = generationForLanding(before, null, TUESDAY, SECOND);
    assert.equal(minted, SECOND);
    const landed = recordLanding(before, {
      action: 'read',
      parent: 's0',
      payload: 'readings/book.jsonl',
      params: { generation: minted, pages: 17, completedAt: TUESDAY },
      createdAt: 300,
      id: 'unspent',
    });
    assert.equal(landed.replaced, true, 'a re-read of the same question replaces');
    assert.equal(landed.step.id, 's1', 'and the step keeps its place');

    const after = generationInEffect(landed.ledger, null, TUESDAY, MINTED);
    assert.equal(after.generation, SECOND);
    assert.equal(after.ledger, null, 'the step already says so, so nothing is written');
    assert.notEqual(after.generation, FIRST, 'the overlay bound to the old pass is handed off');
  });

  test('a reading that lands while the project already has one always mints', () => {
    const read = readOnce({ generation: FIRST, pages: 17, completedAt: MONDAY });
    // Even with a first-touch-looking record beside it: the adoption rule below
    // is about a project's FIRST read step and this project has one already.
    assert.equal(generationForLanding(read, firstTouch(), TUESDAY, MINTED), MINTED);
  });
});

describe('invariant 2 — a resume completing the first read adopts what was minted mid-read', () => {
  test('an overlay made against the pages already read survives the run finishing', () => {
    /*
     * The sequence, which is ordinary: OCR starts on a book nobody has read;
     * somebody opens the block editor while it is running; `readingGeneration`
     * mints a first-touch id against the pages banked so far and they begin
     * correcting them. The run then appends the remaining pages to the SAME
     * bank. Nothing they named has moved, so the landing must NOT mint — this is
     * the one case the archive count got right, and losing it would archive
     * their corrections aside as the reward for starting early.
     */
    const imported = appendStep(emptyLedger(), originStep('s0', 'archive/Book.pdf', 100, 'Imported'));
    // No marker was recorded, because there was none: the run had not finished.
    assert.equal(generationForLanding(imported, firstTouch(), TUESDAY, MINTED), FIRST);
  });

  test('a first touch against a bank that had ALREADY completed does not adopt', () => {
    /*
     * The same shape and the opposite answer, which is why the marker stamp is
     * recorded at all. A bank read by `foundry vlm-read` from a terminal is
     * complete; the block editor mints a first-touch id against it and records
     * the marker it was minted against; the user then presses OCR and the engine
     * reads every page again. That lands as this project's first read step with
     * `readAt === 0` — every condition the old rule tested — and the pages
     * underneath are a completely new pass.
     */
    const imported = appendStep(emptyLedger(), originStep('s0', 'archive/Book.pdf', 100, 'Imported'));
    const against = firstTouch({ completedAt: MONDAY });
    assert.equal(generationForLanding(imported, against, TUESDAY, MINTED), MINTED);
    // And the same marker means the same completed bank, so that one adopts.
    assert.equal(generationForLanding(imported, against, MONDAY, MINTED), FIRST);
  });

  test('a record written by a landing is never adopted, however few steps there are', () => {
    const imported = appendStep(emptyLedger(), originStep('s0', 'archive/Book.pdf', 100, 'Imported'));
    // `readAt > 0` with no read step is a project whose reading step was
    // deleted. The bank went with it; what lands now is a new pass.
    const landed: ProjectReading = { generation: FIRST, readAt: MONDAY, pages: 17 };
    assert.equal(generationForLanding(imported, landed, TUESDAY, MINTED), MINTED);
    // And a project with no record at all mints, which is every first reading.
    assert.equal(generationForLanding(imported, null, TUESDAY, MINTED), MINTED);
  });
});

describe('invariant 3 — a branch mints its own, and each position answers its own', () => {
  /** import → read (whole book) and read (skipping pages), side by side. */
  function branched(): ProjectLedger {
    const ledger = readOnce({ generation: FIRST, pages: 17, completedAt: MONDAY });
    return appendStep(ledger, step({
      id: 's2',
      parent: 's0',
      action: 'read',
      payload: 'readings/book.abcd1234.jsonl',
      createdAt: 400,
      params: { generation: SECOND, pages: 14, completedAt: TUESDAY, skipPages: '3,17' },
    }));
  }

  test('standing on either reading compares the overlay against THAT reading', () => {
    const ledger = branched();
    const first = { ...ledger, position: 's1' };
    const second = { ...ledger, position: 's2' };
    assert.equal(readingInEffect(first)?.id, 's1');
    assert.equal(generationInEffect(first, null, MONDAY, MINTED).generation, FIRST);
    assert.equal(generationInEffect(second, null, TUESDAY, MINTED).generation, SECOND);
    // Neither answer writes anything: both steps already record their own pass.
    assert.equal(generationInEffect(first, null, MONDAY, MINTED).ledger, null);
    assert.equal(generationInEffect(second, null, TUESDAY, MINTED).ledger, null);
  });

  test('the branch was minted rather than inherited, which is what makes that true', () => {
    // The plan for the branch is a landing like any other, and the project
    // already holds a read step, so nothing is adopted.
    const before = readOnce({ generation: FIRST, pages: 17, completedAt: MONDAY });
    assert.equal(generationForLanding(before, firstTouch(), TUESDAY, SECOND), SECOND);
  });

  test('standing on the import answers the project record and never a branch', () => {
    /*
     * The revert row is about the untouched original and about no bank at all,
     * so the walk finds no reading and the project-wide record answers. It must
     * NOT compare a marker here: with two banks and one record, the comparison
     * would disagree on every repaint and re-mint a generation for no event —
     * archiving somebody's live curation aside every time they clicked step 0.
     */
    const ledger = { ...branched(), position: 's0' };
    const record: ProjectReading = { generation: FIRST, readAt: MONDAY, pages: 17, completedAt: MONDAY };
    const answer = generationInEffect(ledger, record, TUESDAY, MINTED);
    assert.equal(answer.generation, FIRST);
    assert.equal(answer.ledger, null);
    assert.equal(answer.reading, null);
  });
});

describe('invariant 4 — a re-render never re-mints, because there is no landing', () => {
  test('asking twice about an unchanged bank writes nothing and answers the same', () => {
    /*
     * Generate is a rendering: bank plus overlay, offline, no step, no landing.
     * Every block stays exactly where it was, which is the entire reason the
     * generation is not simply minted per job — the person who converts their
     * curated EPUB to plain text must not be told their corrections have been
     * archived for a run that changed nothing.
     */
    const ledger = readOnce({ generation: FIRST, pages: 17, completedAt: MONDAY });
    for (const _ of [1, 2, 3]) {
      const answer = generationInEffect(ledger, null, MONDAY, MINTED);
      assert.equal(answer.generation, FIRST);
      assert.equal(answer.ledger, null);
      assert.equal(answer.reading, null);
    }
  });

  test('a translation landing beside the reading leaves the reading alone', () => {
    const ledger = readOnce({ generation: FIRST, pages: 17, completedAt: MONDAY });
    const landed = recordLanding(ledger, {
      action: 'translate',
      parent: 's1',
      payload: 'translations/book-en.jsonl',
      params: { language: 'English' },
      createdAt: 500,
      id: 's2',
    });
    // Standing on the translation, the walk falls through to the reading it was
    // made from, and answers with that reading's own id.
    assert.equal(generationInEffect(landed.ledger, null, MONDAY, MINTED).generation, FIRST);
    assert.equal(paramsOf(landed.ledger, 's1')?.generation, FIRST);
  });
});

describe('invariant 5 — a bank swapped by the CLI behind the app\'s back is caught', () => {
  test('a marker that disagrees with the step re-mints, and the step records it', () => {
    /*
     * `foundry vlm-read` from a terminal reads the pages again and swaps a new
     * bank into the same path. The app watched none of it: no job landed, no
     * step was written, and every block in that file is renumbered. What DID
     * change is the completion marker beside the bank, which is why the landing
     * records its stamp.
     */
    const ledger = readOnce({ generation: FIRST, pages: 17, completedAt: MONDAY });
    const answer = generationInEffect(ledger, null, TUESDAY, MINTED);
    assert.equal(answer.generation, MINTED, 'the pass is a different pass');
    assert.ok(answer.ledger !== null, 'and the step has to be told, or this fires forever');
    assert.deepEqual(paramsOf(answer.ledger, 's1'), {
      generation: MINTED, pages: 17, completedAt: TUESDAY,
    });
    // Told once: the next viewer agrees with the disk and writes nothing.
    assert.equal(generationInEffect(answer.ledger, null, TUESDAY, MINTED).ledger, null);
  });

  test('a marker nobody recorded is ADOPTED, never treated as a change', () => {
    /*
     * The backfill, and it is the same call `treeGeneration` makes: a step
     * landed before stamps were recorded has no record for a marker to disagree
     * with, and inventing a re-read out of that would archive the curation of
     * every project in the library the first time it was opened.
     */
    const ledger = readOnce({ generation: FIRST, pages: 17 });
    const answer = generationInEffect(ledger, null, MONDAY, MINTED);
    assert.equal(answer.generation, FIRST, 'the id does not move');
    assert.ok(answer.ledger !== null, 'but the stamp is written down, so the next one can tell');
    assert.deepEqual(paramsOf(answer.ledger, 's1'), {
      generation: FIRST, pages: 17, completedAt: MONDAY,
    });
    // From here a genuine swap is visible, which is the point of backfilling.
    assert.equal(generationInEffect(answer.ledger, null, TUESDAY, MINTED).generation, MINTED);
  });

  test('no marker is not evidence of anything', () => {
    /*
     * There is a window inside the swap where the old marker is deleted and the
     * new one is not written yet, and a bank can outlive its marker for reasons
     * nobody chose. "I cannot see one" must never mean "the bank was replaced".
     */
    const ledger = readOnce({ generation: FIRST, pages: 17, completedAt: MONDAY });
    const answer = generationInEffect(ledger, null, null, MINTED);
    assert.equal(answer.generation, FIRST);
    assert.equal(answer.ledger, null);
  });

  test('a project with no read step at all is watched through its own record', () => {
    /*
     * A bank filled from a terminal on a project this app only ever imported has
     * no read step for a stamp to live on. The project-wide record answers, and
     * the same three rules apply to it — with one guard: it is only compared
     * where there is no read step ANYWHERE, because one record cannot be about
     * two banks (see the import-position test above).
     */
    const imported = appendStep(emptyLedger(), originStep('s0', 'archive/Book.pdf', 100, 'Imported'));
    const swapped = generationInEffect(imported, firstTouch({ completedAt: MONDAY }), TUESDAY, MINTED);
    assert.equal(swapped.generation, MINTED);
    assert.equal(swapped.ledger, null);
    assert.deepEqual(swapped.reading, { generation: MINTED, readAt: 0, pages: 0, completedAt: TUESDAY });

    const backfilled = generationInEffect(imported, firstTouch(), MONDAY, MINTED);
    assert.equal(backfilled.generation, FIRST, 'an unrecorded marker is adopted here too');
    assert.deepEqual(backfilled.reading, { generation: FIRST, readAt: 0, pages: 0, completedAt: MONDAY });
  });

  test('a project with no record anywhere mints one and records what it minted against', () => {
    const imported = appendStep(emptyLedger(), originStep('s0', 'archive/Book.pdf', 100, 'Imported'));
    const first = generationInEffect(imported, null, MONDAY, MINTED);
    assert.deepEqual(first.reading, { generation: MINTED, readAt: 0, pages: 0, completedAt: MONDAY });
    // And mid-read, with no marker yet, it records no stamp — which is what
    // invariant 2's adoption then keys on.
    assert.deepEqual(
      generationInEffect(imported, null, null, MINTED).reading,
      { generation: MINTED, readAt: 0, pages: 0 },
    );
  });

  test('a re-mint leaves the app\'s own record of when it last read this book', () => {
    /*
     * `readAt` is what the library row means by "read" and what the adoption
     * rule keys on. Zeroing it here would tell the next landing in this app that
     * it may inherit an id minted against somebody else's bank — the exact
     * confusion this test's own scenario is about.
     */
    const imported = appendStep(emptyLedger(), originStep('s0', 'archive/Book.pdf', 100, 'Imported'));
    const record: ProjectReading = { generation: FIRST, readAt: MONDAY, pages: 17, completedAt: MONDAY };
    const answer = generationInEffect(imported, record, TUESDAY, MINTED);
    assert.deepEqual(answer.reading, {
      generation: MINTED, readAt: MONDAY, pages: 17, completedAt: TUESDAY,
    });
    assert.equal(generationForLanding(imported, answer.reading, TUESDAY, SECOND), SECOND);
  });
});
