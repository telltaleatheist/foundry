/**
 * The one safety property of the Steps accordion, held down.
 *
 * A curation step is a copy of somebody's corrections that must never change
 * again — that is the entire reason a step can point at one and the entire
 * reason clicking its row is worth anything. The disk side already protects it:
 * `locateOverlay` keeps `file` (where a correction goes) and `rendering` (what a
 * Generate reads) as two fields rather than resolving one, so no write can land
 * in a snapshot. What it cannot protect against is the RENDERER letting somebody
 * edit while standing there — the edit would go to the live overlay, the pages
 * are being rendered from the frozen one, and the person would be correcting a
 * book they are not looking at and would not find out until a Generate came back
 * without their strike in it.
 *
 * So the editor is read-only exactly where the two diverge, and these tests
 * assert where that is:
 *
 *   THE ORDINARY PROJECT IS NEVER LOCKED. Nobody has pressed Save, there is no
 *   snapshot for any position to resolve to, and nothing about this app changes.
 *
 *   STANDING ON THE READING WITH A SAVE BESIDE IT IS NOT LOCKED. The reading is
 *   where live editing happens and a save made from it is a sibling, not an
 *   ancestor. Getting this one wrong would take editing away from the state every
 *   curator spends their whole session in.
 *
 *   A TRANSLATION MADE FROM A SAVE IS LOCKED. This is the case the tempting test
 *   ("is the position a curate step") gets wrong, and it is the same divergence
 *   one row further down — `renderingOverlay` walks up to that save, so the pages
 *   are frozen there too.
 *
 *   THE WAY OUT IS NAMED. An editor that has quietly stopped responding to the
 *   Delete key with no account of itself is the failure this sentence exists to
 *   prevent, so the explanation names the save and names the row to click.
 *
 *   AND PRESSING SAVE DOES NOT LOCK THE EDITOR. This is the one the build got
 *   wrong: the pointer used to follow every appended step, so freezing a copy of
 *   somebody's corrections stood them on the frozen copy and took correcting away
 *   as the reward for saving — punishing the exact gesture the whole restore-point
 *   idea depends on people making often, and for nothing, since the live overlay
 *   is byte for byte the file that was just frozen. Standing on a save is a
 *   deliberate act: you click the row.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { curationLock, editingIsHeld, standingOn } from '../../app/shared/curation-lock.ts';
import { RETENTION_OF, appendStep, emptyLedger, labelFor, originStep } from '../../app/shared/ledger.ts';
import type { LedgerStep, ProjectLedger } from '../../app/shared/types.ts';

const GENERATION = 'edbd9f11-6a4c-4c02-9d0e-2f4b7a1c8e30';

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

/**
 * import → read → save → a translation made from the save.
 *
 * The pointer is left wherever the caller puts it. `appendStep` moves it onto the
 * newest for every action BUT a save — a save is retained beside where you are
 * standing — so this ends up on the translation, and a test that wants any other
 * row says so.
 */
function saved(): ProjectLedger {
  let ledger = appendStep(emptyLedger(), originStep('s0', 'archive/Book.pdf', 100));
  ledger = appendStep(ledger, step({
    id: 's1', parent: 's0', action: 'read', payload: 'readings/book.jsonl', createdAt: 200,
    params: { generation: GENERATION, pages: 17 },
  }));
  ledger = appendStep(ledger, step({
    id: 's2', parent: 's1', action: 'curate', payload: 'curations/one.json', createdAt: 300,
    params: { generation: GENERATION, amendments: 23 },
  }));
  return appendStep(ledger, step({
    id: 's3', parent: 's2', action: 'translate', payload: 'translations/book-en.jsonl', createdAt: 400,
    params: { language: 'English' },
  }));
}

// ═════════════════════════════════════════════════════════════════════════════

describe('a project nobody has saved in is never locked', () => {
  test('an empty ledger has nothing to stand on and nothing to obey', () => {
    assert.equal(curationLock(emptyLedger()), null);
    assert.equal(editingIsHeld(emptyLedger()), false);
    assert.equal(standingOn(emptyLedger()), null);
  });

  test('import → read, the shape of every project before its first Save', () => {
    let ledger = appendStep(emptyLedger(), originStep('s0', 'archive/Book.pdf', 100));
    ledger = appendStep(ledger, step({ id: 's1', parent: 's0', action: 'read', createdAt: 200 }));
    assert.equal(curationLock(ledger), null);
    assert.equal(editingIsHeld(ledger), false);
    assert.equal(standingOn(ledger)?.id, 's1');
  });

  test('standing on the import shows the untouched original and still is not a save', () => {
    const ledger = { ...saved(), position: 's0' };
    assert.equal(curationLock(ledger), null);
  });
});

describe('the reading is where live editing happens, whatever hangs off it', () => {
  test('standing on the reading with a save beside it leaves the editor alone', () => {
    // The save is a SIBLING of the position, not an ancestor. This is the state a
    // curator spends the whole session in, and locking it would take the mode
    // away from everybody who ever pressed Save once.
    const ledger = { ...saved(), position: 's1' };
    assert.equal(curationLock(ledger), null);
    assert.equal(editingIsHeld(ledger), false);
  });

  test('two saves off one reading still leave the reading editable', () => {
    let ledger = saved();
    ledger = appendStep(ledger, step({
      id: 's4', parent: 's1', action: 'curate', payload: 'curations/two.json', createdAt: 500,
      params: { generation: GENERATION, amendments: 4 },
    }));
    assert.equal(curationLock({ ...ledger, position: 's1' }), null);
  });
});

describe('standing where a rendering is frozen holds the editor', () => {
  test('the save itself', () => {
    const lock = curationLock({ ...saved(), position: 's2' });
    assert.ok(lock !== null);
    assert.equal(lock.snapshot.id, 's2');
    assert.equal(lock.back?.id, 's1');
    assert.equal(editingIsHeld({ ...saved(), position: 's2' }), true);
  });

  test('a translation MADE FROM the save — the case "is the position a curate" misses', () => {
    // `renderingOverlay` resolves this position to s2's snapshot, so the pages are
    // frozen here exactly as they are one row up. An editor that let somebody
    // strike a paragraph here would write it into the live curation, which is not
    // what any rendering from this row reads.
    const ledger = saved();
    assert.equal(standingOn(ledger)?.id, 's3');
    const lock = curationLock(ledger);
    assert.ok(lock !== null);
    assert.equal(lock.snapshot.id, 's2');
    assert.equal(lock.back?.id, 's1');
  });

  test('a chain of saves names the one being stood on, not the first', () => {
    let ledger = saved();
    ledger = appendStep(ledger, step({
      id: 's4', parent: 's2', action: 'curate', payload: 'curations/two.json', createdAt: 500,
      params: { generation: GENERATION, amendments: 41 },
    }));
    // Stood on by hand, because making it did not stand anybody on it.
    const lock = curationLock({ ...ledger, position: 's4' });
    assert.equal(lock?.snapshot.id, 's4');
    assert.equal(lock?.back?.id, 's1');
  });
});

describe('pressing Save leaves the editor exactly as it was', () => {
  /**
   * The bug this whole rule is the fix for, written as the gesture that hit it:
   * correcting a scan, pressing Save, and finding the Delete key dead.
   */
  test('freezing a copy while standing on the reading does not stand you on it', () => {
    let ledger = appendStep(emptyLedger(), originStep('s0', 'archive/Book.pdf', 100));
    ledger = appendStep(ledger, step({ id: 's1', parent: 's0', action: 'read', createdAt: 200 }));
    assert.equal(standingOn(ledger)?.id, 's1');

    ledger = appendStep(ledger, step({
      id: 's2', parent: 's1', action: 'curate', payload: 'curations/one.json', createdAt: 300,
      params: { generation: GENERATION, amendments: 23 },
    }));
    assert.equal(standingOn(ledger)?.id, 's1');
    assert.equal(curationLock(ledger), null);
    assert.equal(editingIsHeld(ledger), false);
  });

  test('a second save from the same place is still a save, and still leaves you there', () => {
    // Somebody who saves often is the person this design is for, and every one of
    // those presses has to be free. Two saves, two rows, and the editor never went
    // read-only in between.
    let ledger = appendStep(emptyLedger(), originStep('s0', 'archive/Book.pdf', 100));
    ledger = appendStep(ledger, step({ id: 's1', parent: 's0', action: 'read', createdAt: 200 }));
    for (const [id, at] of [['s2', 300], ['s3', 400]] as const) {
      ledger = appendStep(ledger, step({
        id, parent: 's1', action: 'curate', payload: `curations/${id}.json`, createdAt: at,
        params: { generation: GENERATION, amendments: 4 },
      }));
      assert.equal(curationLock(ledger), null);
    }
    assert.deepEqual(ledger.steps.map((row) => row.id), ['s0', 's1', 's2', 's3']);
    assert.equal(standingOn(ledger)?.id, 's1');
  });

  test('a project with NO pointer written down does not acquire one by saving', () => {
    /*
     * THE BACK DOOR THIS RULE HAD TO CLOSE. An absent pointer means THE NEWEST
     * STEP, and appending is exactly what makes a save the newest — so a ledger
     * that never wrote its position down would have had the pointer follow the
     * save anyway, silently, through the field that exists to spare the manifest a
     * line. The position is written out on a save for precisely this.
     */
    let ledger = appendStep(emptyLedger(), originStep('s0', 'archive/Book.pdf', 100));
    ledger = { ...ledger, position: undefined };
    ledger = appendStep(ledger, step({ id: 's1', parent: 's0', action: 'read', createdAt: 200 }));
    ledger = { ...ledger, position: undefined };
    ledger = appendStep(ledger, step({
      id: 's2', parent: 's1', action: 'curate', payload: 'curations/one.json', createdAt: 300,
      params: { generation: GENERATION, amendments: 1 },
    }));
    assert.equal(ledger.position, 's1');
    assert.equal(standingOn(ledger)?.id, 's1');
    assert.equal(curationLock(ledger), null);
  });

  test('standing on the save is still one click away, and still locks', () => {
    // The point is not that a save can never be stood on — it is that standing
    // there is a deliberate act rather than the consequence of saving.
    const lock = curationLock({ ...saved(), position: 's2' });
    assert.equal(lock?.snapshot.id, 's2');
  });
});

describe('the explanation names the save, the way out, and no filenames', () => {
  test('both labels are in the sentence, in the app’s own words', () => {
    const lock = curationLock({ ...saved(), position: 's2' });
    assert.ok(lock !== null);
    assert.match(lock.why, /Saved corrections \(23\)/);
    assert.match(lock.why, /Read \(17 pages\)/);
    assert.match(lock.why, /Click .Read \(17 pages\). in Steps/);
  });

  test('no payload path ever reaches it — steps are named by action, in words', () => {
    const lock = curationLock({ ...saved(), position: 's2' });
    assert.ok(lock !== null);
    for (const spelling of ['curations/', 'readings/', '.json', '.jsonl', 'archive/']) {
      assert.ok(!lock.why.includes(spelling), `the explanation leaked ${spelling}`);
    }
  });

  test('a save hanging straight off the import still has a way out named', () => {
    let ledger = appendStep(emptyLedger(), originStep('s0', 'archive/Book.pdf', 100));
    ledger = appendStep(ledger, step({
      id: 's1', parent: 's0', action: 'curate', payload: 'curations/one.json', createdAt: 200,
      params: { amendments: 2 },
    }));
    // Stood on deliberately: making the save left the pointer on the import.
    const lock = curationLock({ ...ledger, position: 's1' });
    assert.equal(lock?.back?.id, 's0');
    assert.match(lock!.why, /Imported/);
  });
});
