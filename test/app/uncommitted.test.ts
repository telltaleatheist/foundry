/**
 * The question asked on the way out of a book, held down.
 *
 * The block editor has no unsaved state — every correction is written into the
 * live curation the instant it is made — so closing a document discards nothing
 * and the obvious warning would be a lie. What a person can genuinely lack is a
 * RESTORE POINT: a curation step they could step back to, which matters because
 * Foundry's step-by-step undo lasts only as long as the book is open. Closing is
 * the moment "undoable" becomes "permanent".
 *
 * So these tests are almost entirely about WHEN NOT TO ASK, because a dialog that
 * appears with nothing at stake is worse than no dialog at all: it is answered
 * without being read, and the day it appears about something real it is dismissed
 * with the same reflex.
 *
 *   A BOOK NOBODY HAS CORRECTED asks nothing, and neither does one whose
 *   corrections a save already holds — which is the state of every person who
 *   pressed Save and then closed, the exact behaviour this feature is trying to
 *   encourage.
 *
 *   CORRECTIONS BEYOND THE NEWEST SAVE ask, and the count is the DIFFERENCE from
 *   that save rather than a total, because "you have 23 corrections" is true of a
 *   book that was saved with all 23 of them.
 *
 *   A CHAIN OF SAVES IS MEASURED AGAINST THE NEWEST ONE. The older rows are still
 *   restore points; they are not the one the app promises a way back to.
 *
 *   STANDING ON A FROZEN SAVE NEEDS NO RULE OF ITS OWN. The editor is read-only
 *   there, so nothing can have been decided while somebody was standing on it, and
 *   the answer falls out of the comparison rather than out of a special case.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { RETENTION_OF, appendStep, emptyLedger, labelFor, originStep } from '../../app/shared/ledger.ts';
import { emptyOverlay, type OverlayFile } from '../../app/shared/overlay.ts';
import {
  restorePointOf,
  uncommittedCuration,
  type SavedCuration,
} from '../../app/shared/uncommitted.ts';
import type { LedgerStep, ProjectLedger } from '../../app/shared/types.ts';

const GENERATION = 'edbd9f11-6a4c-4c02-9d0e-2f4b7a1c8e30';
const REREAD = '7c1f0a3e-55b8-4a2d-9f61-0b3ce8d47a12';

/** A step, spelled the short way, with the retention its action settles. */
function step(over: Partial<LedgerStep> & Pick<LedgerStep, 'id' | 'parent' | 'action'>): LedgerStep {
  return {
    payload: `payloads/${over.id}`,
    retention: RETENTION_OF[over.action],
    createdAt: 0,
    label: labelFor(over.action, over.params),
    ...over,
  };
}

/** import → read. The shape of every project before its first Save. */
function read(): ProjectLedger {
  const ledger = appendStep(emptyLedger(), originStep('s0', 'archive/Book.pdf', 100));
  return appendStep(ledger, step({
    id: 's1', parent: 's0', action: 'read', payload: 'readings/book.jsonl', createdAt: 200,
    params: { generation: GENERATION, pages: 17 },
  }));
}

/** A save made from the reading, which is where every save in this app is made. */
function saveOn(
  ledger: ProjectLedger,
  id: string,
  parent: string,
  createdAt: number,
  amendments: number,
): ProjectLedger {
  return appendStep(ledger, step({
    id, parent, action: 'curate', payload: `curations/${id}.json`, createdAt,
    params: { generation: GENERATION, amendments },
  }));
}

/** A curation that strikes these blocks and decides nothing else. */
function striking(...blocks: readonly string[]): OverlayFile {
  return {
    ...emptyOverlay(GENERATION),
    amendments: blocks.map((block) => {
      const [page, order] = block.split(':').map((piece) => Number(piece));
      return { at: { page: page!, order: order! }, strike: true };
    }),
  };
}

/** The frozen side of the comparison, named as its row reads. */
function frozen(content: OverlayFile, label = 'Saved corrections (2)'): SavedCuration {
  return { label, content };
}

// ═════════════════════════════════════════════════════════════════════════════

describe('a book with nothing decided in it is never asked about', () => {
  test('no amendments, no chapters, no save — there is no state worth keeping', () => {
    assert.equal(uncommittedCuration(emptyOverlay(GENERATION), null), null);
  });

  test('an empty overlay beside an empty save is still nothing', () => {
    assert.equal(
      uncommittedCuration(emptyOverlay(GENERATION), frozen(emptyOverlay(GENERATION))),
      null,
    );
  });

  test('a project with no history at all has no restore point to measure against', () => {
    assert.equal(restorePointOf(emptyLedger()), null);
    assert.equal(restorePointOf(read()), null);
  });
});

describe('corrections a save already holds ask nothing', () => {
  test('the live curation is byte for byte the save that was just made', () => {
    // Press Save, then close. This is the behaviour the whole feature is trying to
    // encourage, and interrupting it would be the app punishing the gesture it
    // asked for.
    const live = striking('7:14', '9:2', '9:3');
    assert.equal(uncommittedCuration(live, frozen(striking('7:14', '9:2', '9:3'))), null);
  });

  test('the same decisions written in a different order are the same decisions', () => {
    // The comparison is over what each file SAYS about each block, never over the
    // order two writers happened to list them in.
    const live = striking('9:3', '7:14', '9:2');
    assert.equal(uncommittedCuration(live, frozen(striking('7:14', '9:2', '9:3'))), null);
  });

  test('a strike made and then taken back leaves the book in the state that was saved', () => {
    /*
     * A CHANGE COUNTER WOULD HAVE ASKED HERE, and it would have been asking about
     * a book that is identical to its own save. The comparison is by content for
     * exactly this: an afternoon spent undoing your own mistakes ends where it
     * began, and the app has nothing to warn anybody about.
     */
    const saved = striking('7:14', '9:2');
    const live: OverlayFile = { ...saved, amendments: [...saved.amendments] };
    assert.equal(uncommittedCuration(live, frozen(saved)), null);
  });

  test('an amendment that decides nothing is not a decision', () => {
    // `amendmentsOf` never writes one — a block whose last field was cleared drops
    // out of the file — so a `{}` here came from an older build or a hand edit, and
    // counting it would report a difference between a book and itself.
    const live: OverlayFile = {
      ...emptyOverlay(GENERATION),
      amendments: [{ at: { page: 7, order: 14 } }],
    };
    assert.equal(uncommittedCuration(live, frozen(emptyOverlay(GENERATION))), null);
  });
});

describe('corrections beyond the newest save are what the question is about', () => {
  test('three blocks struck since the save, counted as three', () => {
    const at = uncommittedCuration(
      striking('7:14', '9:2', '9:3', '11:1'),
      frozen(striking('7:14')),
    );
    assert.deepEqual(at, { blocks: 3, chapters: false, since: 'Saved corrections (2)' });
  });

  test('a block brought BACK since the save counts, because that is a decision too', () => {
    // Unstriking drops the amendment entirely, so the live file says less than the
    // save does. A comparison that only counted additions would call an afternoon
    // spent putting paragraphs back no work at all.
    const at = uncommittedCuration(striking('7:14'), frozen(striking('7:14', '9:2')));
    assert.deepEqual(at, { blocks: 1, chapters: false, since: 'Saved corrections (2)' });
  });

  test('a block decided DIFFERENTLY counts once, not twice', () => {
    const live: OverlayFile = {
      ...emptyOverlay(GENERATION),
      amendments: [{ at: { page: 7, order: 14 }, category: 'Caption' }],
    };
    const saved: OverlayFile = {
      ...emptyOverlay(GENERATION),
      amendments: [{ at: { page: 7, order: 14 }, category: 'Footnote' }],
    };
    assert.equal(uncommittedCuration(live, frozen(saved))?.blocks, 1);
  });

  test('with no save at all, every corrected block is at stake and nothing is named', () => {
    const at = uncommittedCuration(striking('7:14', '9:2'), null);
    assert.deepEqual(at, { blocks: 2, chapters: false, since: null });
  });
});

describe('the spine is labour, and is asked about as one', () => {
  test('a chapter list nobody has saved', () => {
    const live: OverlayFile = {
      ...emptyOverlay(GENERATION),
      chapters: [{ at: { page: 3, order: 0 }, title: 'Chapter 1 — The Windmill' }],
    };
    assert.deepEqual(uncommittedCuration(live, null), { blocks: 0, chapters: true, since: null });
  });

  test('“this book does not divide” is a decision, and absent is not the same as empty', () => {
    /*
     * ABSENT means nobody has touched the chapters and the engine's own detection
     * decides; an EMPTY LIST is a person saying out loud that this book has no
     * divisions. Folding the two together would close on somebody who had just
     * made that statement without a word about it.
     */
    const live: OverlayFile = { ...emptyOverlay(GENERATION), chapters: [] };
    assert.deepEqual(uncommittedCuration(live, frozen(emptyOverlay(GENERATION))), {
      blocks: 0,
      chapters: true,
      since: 'Saved corrections (2)',
    });
  });

  test('a spine the save already holds asks nothing', () => {
    const spine = [{ at: { page: 3, order: 0 }, title: 'One' }, { at: { page: 40, order: 2 }, title: 'Two' }];
    const live: OverlayFile = { ...emptyOverlay(GENERATION), chapters: spine };
    const saved: OverlayFile = {
      ...emptyOverlay(GENERATION),
      chapters: [{ at: { page: 3, order: 0 }, title: 'One' }, { at: { page: 40, order: 2 }, title: 'Two' }],
    };
    assert.equal(uncommittedCuration(live, frozen(saved)), null);
  });

  test('a chapter renamed since the save is a difference', () => {
    const live: OverlayFile = {
      ...emptyOverlay(GENERATION),
      chapters: [{ at: { page: 3, order: 0 }, title: 'Chapter 4 — The Windmill' }],
    };
    const saved: OverlayFile = {
      ...emptyOverlay(GENERATION),
      chapters: [{ at: { page: 3, order: 0 }, title: 'IV' }],
    };
    assert.equal(uncommittedCuration(live, frozen(saved))?.chapters, true);
  });
});

describe('a save about a different reading is not a save of these corrections', () => {
  test('the generations disagree, so nothing is comparable and everything is at stake', () => {
    /*
     * Amendments name blocks as `(page, order)` and those numbers mean different
     * blocks after the pages are read again. A diff between two files bound to
     * different readings is arithmetic over two different books, so the honest
     * answer is that this book has no restore point — and `since` says so by being
     * null rather than naming a row that cannot serve.
     */
    const saved: OverlayFile = { ...striking('7:14', '9:2'), generation: REREAD };
    const at = uncommittedCuration(striking('7:14', '9:2'), frozen(saved));
    assert.deepEqual(at, { blocks: 2, chapters: false, since: null });
  });
});

describe('which save the corrections are measured against', () => {
  test('a save made from the reading is found, even though it is not on the position’s ancestry', () => {
    /*
     * THE STATE EVERY CURATOR SPENDS THEIR SESSION IN. A commit does not move the
     * pointer, so a person standing on the reading with a save behind them has a
     * save that is a SIBLING of where they stand. Asked for "the newest curation on
     * my ancestry", the app would tell somebody who had just pressed Save that they
     * had never saved.
     */
    const ledger = saveOn(read(), 's2', 's1', 300, 23);
    assert.equal(ledger.position, 's1');
    assert.equal(restorePointOf(ledger)?.id, 's2');
  });

  test('a chain of saves is measured against the newest of them', () => {
    let ledger = saveOn(read(), 's2', 's1', 300, 5);
    ledger = saveOn(ledger, 's3', 's1', 400, 12);
    ledger = saveOn(ledger, 's4', 's1', 500, 23);
    assert.equal(restorePointOf(ledger)?.id, 's4');
    // And the same when the saves were made from each other rather than side by
    // side, which is what committing while standing on a save produces.
    let chained = saveOn(read(), 's2', 's1', 300, 5);
    chained = saveOn(chained, 's3', 's2', 400, 12);
    assert.equal(restorePointOf(chained)?.id, 's3');
  });

  test('a stale save is not a way back, because the book it describes is gone', () => {
    // Its `(page, order)` pairs name blocks that mean different blocks now. It is
    // kept and it is listed; it is not a state this book can be returned to.
    const ledger = saveOn(read(), 's2', 's1', 300, 23);
    const stale = { ...ledger, steps: ledger.steps.map((row) => (row.id === 's2' ? { ...row, stale: true } : row)) };
    assert.equal(restorePointOf(stale), null);
  });

  test('a save under another branch’s reading is not this reading’s save', () => {
    // A re-read that asked a different question branches beside the first, and the
    // saves under the old reading are about the old reading's blocks.
    let ledger = saveOn(read(), 's2', 's1', 300, 23);
    ledger = appendStep(ledger, step({
      id: 's3', parent: 's0', action: 'read', payload: 'readings/book.jsonl', createdAt: 400,
      params: { generation: REREAD, skipPages: '3,17', pages: 15 },
    }));
    assert.equal(ledger.position, 's3');
    assert.equal(restorePointOf(ledger), null);
    // Step back to the first reading and the save under it is a way back again.
    assert.equal(restorePointOf({ ...ledger, position: 's1' })?.id, 's2');
  });
});

describe('standing on a frozen save has nothing to ask, without a rule of its own', () => {
  test('press Save, click the row it made, close — the ordinary way to arrive', () => {
    /*
     * The editor is read-only while standing there (`curation-lock.ts`), so nothing
     * can have been decided since; and the live overlay is byte for byte the file
     * that was frozen. Both halves of the answer fall out of the ordinary
     * comparison: the save under this reading is found, and it says what the live
     * curation says.
     */
    const ledger = saveOn(read(), 's2', 's1', 300, 3);
    const standing = { ...ledger, position: 's2' };
    const point = restorePointOf(standing);
    assert.equal(point?.id, 's2');
    const live = striking('7:14', '9:2', '9:3');
    assert.equal(uncommittedCuration(live, frozen(striking('7:14', '9:2', '9:3'), point!.label)), null);
  });

  test('and a translation made from that save is the same story one row down', () => {
    let ledger = saveOn(read(), 's2', 's1', 300, 3);
    ledger = appendStep(ledger, step({
      id: 's3', parent: 's2', action: 'translate', payload: 'translations/book-en.jsonl', createdAt: 400,
      params: { language: 'English' },
    }));
    assert.equal(ledger.position, 's3');
    assert.equal(restorePointOf(ledger)?.id, 's2');
  });
});

describe('the answer never carries a filename', () => {
  test('what it names is the row’s label, in the app’s own words', () => {
    const at = uncommittedCuration(striking('7:14', '9:2'), frozen(striking('7:14'), 'Saved corrections (1)'));
    assert.equal(at?.since, 'Saved corrections (1)');
    for (const spelling of ['curations/', 'overlays/', '.json']) {
      assert.ok(!(at?.since ?? '').includes(spelling), `the answer leaked ${spelling}`);
    }
  });
});
