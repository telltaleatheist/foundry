/**
 * The step ledger — the brain of a project's history, held down.
 *
 * WHAT THESE TESTS ARE ACTUALLY PROTECTING, in the order the damage would be
 * felt:
 *
 *   NOTHING IS EVER SILENTLY LOST. The whole design exists because acting from
 *   an earlier step must not truncate the steps after it. The user's own
 *   scenario — translate to English, step back to the reading, translate to
 *   Hungarian — is written out here verbatim, and it asserts that BOTH
 *   translations survive and that Hungarian hangs off the reading rather than
 *   off English.
 *
 *   THE RE-RUN DECISION IS EXACT. Same action, same parameters, same parent is a
 *   replace and destroys a payload; anything else is a branch. A false replace
 *   destroys hours of work somebody wanted, a false branch leaves two banks
 *   where one was asked for, and the generation trap — a re-read minting a new
 *   generation, which would make every re-read look like a new question — is the
 *   specific way this gets silently inverted.
 *
 *   A WRONG LEDGER SAYS WHAT IS WRONG. This file is user-writable in principle
 *   and machine-written in practice, so every refusal is asserted by its own
 *   message: a step quietly skipped is a payload the app has forgotten it owns,
 *   sitting in the project folder, invisible to the sweep and to the user.
 *
 *   A MIGRATION IS DETERMINISTIC. It runs on every read of an un-migrated
 *   project, and the ids it mints are what the pointer and the parent chain
 *   point at. Two reads that disagree is a pointer naming a step that no longer
 *   exists.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RETENTION_OF,
  StepLedgerError,
  ancestry,
  appendStep,
  chainsWithout,
  childrenOf,
  chronological,
  curationInEffect,
  currentStandard,
  deleteCost,
  deleteSubtree,
  emptyLedger,
  labelFor,
  markStale,
  migrateLedger,
  orphanedPayloads,
  originOf,
  originStep,
  parseLedger,
  positionOf,
  reRunTarget,
  recordLanding,
  stepOf,
  subtree,
} from '../../app/shared/ledger.ts';
import {
  WHY_HANDMADE,
  WHY_IMPORTED,
  WHY_MODEL_PASS,
  type LedgerParams,
  type LedgerStep,
  type ProjectLedger,
  type ProjectManifest,
  type ProjectStep,
  type ProjectTypeRecord,
  type StepAction,
} from '../../app/shared/types.ts';

const GENERATION = 'edbd9f11-6a4c-4c02-9d0e-2f4b7a1c8e30';

/** A step, spelled the short way, with the retention its action settles. */
function step(over: Partial<LedgerStep> & Pick<LedgerStep, 'id' | 'parent' | 'action'>): LedgerStep {
  const built: LedgerStep = {
    payload: `payloads/${over.id}`,
    retention: RETENTION_OF[over.action],
    createdAt: 0,
    label: labelFor(over.action, over.params),
    ...over,
  };
  return built;
}

/** The message of the refusal a call earned, or a failure saying it earned none. */
function refusal(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    assert.ok(err instanceof StepLedgerError, `expected a StepLedgerError, got ${String(err)}`);
    return (err as Error).message;
  }
  assert.fail('that should have been refused');
}

/**
 * The user's own scenario, built the way the app builds it: append, move the
 * pointer back by hand, append again.
 *
 *   import → read → English, then step back to the read → Hungarian
 */
function branched(): ProjectLedger {
  let ledger = appendStep(emptyLedger(), originStep('s0', 'archive/Book.pdf', 100, 'Imported'));
  ledger = appendStep(ledger, step({
    id: 's1', parent: 's0', action: 'read', payload: 'readings/book.jsonl', createdAt: 200,
    params: { generation: GENERATION, pages: 17 },
  }));
  ledger = appendStep(ledger, step({
    id: 's2', parent: 's1', action: 'translate', payload: 'translations/book-en.jsonl', createdAt: 300,
    params: { language: 'English' },
  }));
  // The click that this whole design exists for: back to the reading, free.
  ledger = { ...ledger, position: 's1' };
  return appendStep(ledger, step({
    id: 's3', parent: 's1', action: 'translate', payload: 'translations/book-hu.jsonl', createdAt: 400,
    params: { language: 'Hungarian' },
  }));
}

// ═════════════════════════════════════════════════════════════════════════════

describe('parseLedger refuses a wrong ledger by name rather than guessing at it', () => {
  const ORIGIN = { id: 's0', parent: null, action: 'import', payload: 'archive/Book.pdf', retention: 'irreplaceable', createdAt: 1, label: 'Imported' };
  const READ = { id: 's1', parent: 's0', action: 'read', payload: 'readings/b.jsonl', retention: 'expensive', createdAt: 2, label: 'Read (17 pages)' };

  test('a ledger of nothing is a ledger, not an error', () => {
    assert.deepEqual(parseLedger({ steps: [] }), { steps: [] });
    assert.deepEqual(parseLedger({ steps: [ORIGIN, READ] }).steps.length, 2);
  });

  test('something that is not an object is not a ledger', () => {
    assert.match(refusal(() => parseLedger('the steps')), /which is not a ledger object/);
    assert.match(refusal(() => parseLedger([ORIGIN])), /which is not a ledger object/);
  });

  test('a top-level field nobody declared is a file something else wrote', () => {
    assert.match(
      refusal(() => parseLedger({ steps: [], pointer: 's0' })),
      /carries a field called "pointer", and a ledger is position and steps/,
    );
  });

  test('two steps of one id leave every reference to it unresolvable', () => {
    const twice = refusal(() => parseLedger({ steps: [ORIGIN, { ...READ, id: 's0', parent: null }] }));
    assert.match(twice, /Two steps in this ledger are both called "s0"/);
  });

  test('a parent nobody has is refused rather than dropped', () => {
    const orphan = refusal(() => parseLedger({ steps: [ORIGIN, { ...READ, parent: 'sX' }] }));
    assert.match(orphan, /Step "s1" \(Read \(17 pages\)\) says it was made from "sX"/);
    assert.match(orphan, /not something to guess at/);
  });

  test('a chain that goes in a circle is named as one', () => {
    const loop = refusal(() => parseLedger({
      steps: [ORIGIN, { ...READ, parent: 's2' }, { ...READ, id: 's2', parent: 's1' }],
    }));
    assert.match(loop, /was made from itself, by way of/);
  });

  test('two origins is two projects in one folder', () => {
    const two = refusal(() => parseLedger({ steps: [ORIGIN, { ...ORIGIN, id: 'sB', action: 'import' }] }));
    assert.match(two, /2 steps with no parent \("s0", "sB"\)/);
    assert.match(two, /a project has one origin/);
  });

  test('a ledger with steps and no origin at all says so', () => {
    // Every row claims to be made from another: the circle case with no root
    // outside it, which is a different sentence because it is a different fault.
    const rootless = refusal(() => parseLedger({
      steps: [{ ...ORIGIN, parent: 's1' }, { ...READ, parent: 's0' }],
    }));
    assert.match(rootless, /No step in this ledger is the origin/);
  });

  test('an action this app does not do is not silently ignored', () => {
    const unknown = refusal(() => parseLedger({ steps: [ORIGIN, { ...READ, action: 'summarise' }] }));
    assert.match(unknown, /says "action": "summarise", which is not something this app does/);
    assert.match(unknown, /import, read, curate, translate/);
  });

  test('a retention that is not one of the three answers is refused', () => {
    assert.match(
      refusal(() => parseLedger({ steps: [ORIGIN, { ...READ, retention: 'cheap' }] })),
      /says "retention": "cheap"/,
    );
  });

  test('THE DANGEROUS ONE: a reading calling itself regenerable is refused', () => {
    // A sweep may discard `regenerable` without asking. A stored file that
    // relabels a readings bank as cheap is a file authorising the deletion of
    // hours of GPU, so it is refused rather than quietly corrected.
    const lie = refusal(() => parseLedger({ steps: [ORIGIN, { ...READ, retention: 'regenerable' }] }));
    assert.match(lie, /is a read and calls itself "regenerable". A read is "expensive"/);
    assert.match(lie, /send a sweep after something it must not touch/);
  });

  test('a createdAt that is not a whole number of milliseconds is refused', () => {
    assert.match(refusal(() => parseLedger({ steps: [{ ...ORIGIN, createdAt: 'today' }] })), /says "createdAt": "today"/);
    assert.match(refusal(() => parseLedger({ steps: [{ ...ORIGIN, createdAt: -1 }] })), /says "createdAt": -1/);
    assert.match(refusal(() => parseLedger({ steps: [{ ...ORIGIN, createdAt: 1.5 }] })), /says "createdAt": 1.5/);
  });

  test('a row claiming to predate the row above it breaks the list a person reads', () => {
    const backwards = refusal(() => parseLedger({ steps: [{ ...ORIGIN, createdAt: 900 }, { ...READ, createdAt: 5 }] }));
    assert.match(backwards, /is listed after "s0" and claims to have happened before it/);
  });

  test('two rows stamped in one millisecond are ordinary, not an error', () => {
    // A migration reads one clock for several rows, and two jobs can land in the
    // same millisecond. Equal is legal; only backwards is refused.
    assert.equal(parseLedger({ steps: [{ ...ORIGIN, createdAt: 7 }, { ...READ, createdAt: 7 }] }).steps.length, 2);
  });

  test('a pointer standing on a step that is not here is refused', () => {
    const lost = refusal(() => parseLedger({ steps: [ORIGIN], position: 's9' }));
    assert.match(lost, /pointer stands on "s9", and there is no such step in it/);
    assert.match(refusal(() => parseLedger({ steps: [ORIGIN], position: 4 })), /"position" is 4/);
  });

  test('a param the action has no use for is a step something wrote wrong', () => {
    const wrong = refusal(() => parseLedger({ steps: [ORIGIN, { ...READ, params: { amendments: 23 } }] }));
    assert.match(wrong, /is a read and carries a param called "amendments"/);
    assert.match(wrong, /A read is described by skipPages, language, generation and pages/);
    // And the import is described by nothing at all.
    assert.match(
      refusal(() => parseLedger({ steps: [{ ...ORIGIN, params: { pages: 3 } }] })),
      /A import is described by nothing at all/,
    );
  });

  test('a param of the wrong sort is refused by its own name', () => {
    assert.match(
      refusal(() => parseLedger({ steps: [ORIGIN, { ...READ, params: { pages: '17' } }] })),
      /says "pages": "17", and it is a whole number of 0 or more/,
    );
    assert.match(
      refusal(() => parseLedger({ steps: [ORIGIN, { ...READ, params: { generation: 17 } }] })),
      /says "generation": 17, and it is a string/,
    );
    // A page RANGE is words — "3,17,19-24" — and a step storing a number for it
    // would be a step whose question nothing can compare.
    assert.match(
      refusal(() => parseLedger({ steps: [ORIGIN, { ...READ, params: { skipPages: 17 } }] })),
      /says "skipPages": 17, and it is a string/,
    );
  });

  test('a read carries what it was asked for as well as what it answered', () => {
    const asked = parseLedger({
      steps: [ORIGIN, { ...READ, params: { skipPages: '3,17,19-24', language: 'de', generation: GENERATION, pages: 17 } }],
    });
    assert.deepEqual(asked.steps[1]!.params, {
      skipPages: '3,17,19-24', language: 'de', generation: GENERATION, pages: 17,
    });
  });

  test('a step missing the parts that make it a step is refused by field', () => {
    assert.match(refusal(() => parseLedger({ steps: [{ ...ORIGIN, id: '' }] })), /says "id": ""/);
    assert.match(refusal(() => parseLedger({ steps: [{ ...ORIGIN, payload: '' }] })), /says "payload": ""/);
    assert.match(refusal(() => parseLedger({ steps: [{ ...ORIGIN, label: '' }] })), /says "label": ""/);
    assert.match(refusal(() => parseLedger({ steps: [{ ...ORIGIN, parent: 7 }] })), /says "parent": 7/);
    assert.match(refusal(() => parseLedger({ steps: [{ ...ORIGIN, stale: 'yes' }] })), /says "stale": "yes"/);
    assert.match(refusal(() => parseLedger({ steps: [{ ...ORIGIN, colour: 'red' }] })), /carries a field called "colour"/);
    assert.match(refusal(() => parseLedger({ steps: ['s0'] })), /Step 0 of this ledger is "s0", not a step/);
    assert.match(refusal(() => parseLedger({ steps: 'none' })), /"steps" is "none"/);
  });

  test('a ledger that parses comes back with its pointer and its stale marks', () => {
    const read = parseLedger({ steps: [ORIGIN, { ...READ, stale: true, params: { generation: GENERATION, pages: 17 } }], position: 's0' });
    assert.equal(read.position, 's0');
    assert.equal(read.steps[1]!.stale, true);
    assert.deepEqual(read.steps[1]!.params, { generation: GENERATION, pages: 17 });
    // `stale: false` is the ordinary state and is not written back as a field:
    // absent and false are one claim, and one spelling of it keeps the file small.
    assert.equal('stale' in parseLedger({ steps: [{ ...ORIGIN, stale: false }] }).steps[0]!, false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('the pointer and the shape of the chain', () => {
  test('an empty ledger has nowhere to stand', () => {
    assert.equal(positionOf(emptyLedger()), null);
    assert.deepEqual(currentStandard(emptyLedger()), {});
    assert.deepEqual(chronological(emptyLedger()), []);
  });

  test('no pointer means the newest step, which is where a project mostly is', () => {
    const ledger = branched();
    assert.equal(positionOf({ ...ledger, position: undefined })!.id, 's3');
  });

  test('appending moves the pointer onto what was just made', () => {
    const ledger = branched();
    assert.equal(ledger.position, 's3');
    assert.equal(positionOf(ledger)!.id, 's3');
  });

  test('ancestry runs origin-first and follows parents, not array order', () => {
    const ledger = branched();
    assert.deepEqual(ancestry(ledger, 's3').map((row) => row.id), ['s0', 's1', 's3']);
    // English is a sibling of Hungarian and is nowhere on its chain, though it
    // sits between them in the list.
    assert.deepEqual(ancestry(ledger, 's2').map((row) => row.id), ['s0', 's1', 's2']);
    assert.deepEqual(ancestry(ledger, 's0').map((row) => row.id), ['s0']);
  });

  test('the children of the reading are both translations', () => {
    assert.deepEqual(childrenOf(branched(), 's1').map((row) => row.id), ['s2', 's3']);
    assert.deepEqual(childrenOf(branched(), 's3'), []);
  });

  test('a subtree is the step plus everything made from it, in creation order', () => {
    assert.deepEqual(subtree(branched(), 's1').map((row) => row.id), ['s1', 's2', 's3']);
    assert.deepEqual(subtree(branched(), 's2').map((row) => row.id), ['s2']);
    assert.deepEqual(subtree(branched(), 's0').map((row) => row.id), ['s0', 's1', 's2', 's3']);
  });

  test('a subtree is found by walking down, not by trusting the array order', () => {
    /*
     * Rows stamped in one millisecond are allowed in any order, so a grandchild
     * can be listed above its parent. A single forward pass would miss it — and
     * a delete that missed a descendant would leave a step pointing at a parent
     * it had just destroyed, which is a ledger that refuses to load.
     */
    const jumbled: ProjectLedger = {
      steps: [
        step({ id: 's0', parent: null, action: 'import', createdAt: 0 }),
        step({ id: 's3', parent: 's2', action: 'translate', createdAt: 0 }),
        step({ id: 's1', parent: 's0', action: 'read', createdAt: 0 }),
        step({ id: 's2', parent: 's1', action: 'curate', createdAt: 0 }),
      ],
    };
    assert.equal(parseLedger(JSON.parse(JSON.stringify(jumbled))).steps.length, 4);
    assert.deepEqual(subtree(jumbled, 's1').map((row) => row.id), ['s3', 's1', 's2']);
    // And what a delete removes is therefore the whole branch, leaving nothing
    // pointing at a parent that has gone.
    const { ledger } = deleteSubtree(jumbled, 's1');
    assert.deepEqual(ledger.steps.map((row) => row.id), ['s0']);
  });

  test('asking about a step that is not here is refused, not answered with nothing', () => {
    assert.match(refusal(() => stepOf(emptyLedger(), 's0')), /no step called "s0"/);
    assert.match(refusal(() => ancestry(branched(), 'sX')), /no step called "sX"/);
  });
});

describe('appendStep keeps the ledger a ledger', () => {
  test('a parent nobody has is refused before anything is recorded', () => {
    const ledger = appendStep(emptyLedger(), originStep('s0', 'archive/Book.pdf', 1));
    const bad = refusal(() => appendStep(ledger, step({ id: 's9', parent: 'sX', action: 'read' })));
    assert.match(bad, /says it was made from "sX", and there is no such step/);
  });

  test('a second origin is refused: a project has one import', () => {
    const ledger = appendStep(emptyLedger(), originStep('s0', 'archive/Book.pdf', 1));
    assert.match(
      refusal(() => appendStep(ledger, originStep('sB', 'archive/Other.pdf', 2))),
      /has no parent, and this project already has an origin/,
    );
  });

  test('an id already in use is refused', () => {
    const ledger = branched();
    assert.match(
      refusal(() => appendStep(ledger, step({ id: 's2', parent: 's1', action: 'translate' }))),
      /already has a step called "s2"/,
    );
  });

  test('the ledger it was given is not touched', () => {
    const before = appendStep(emptyLedger(), originStep('s0', 'archive/Book.pdf', 1));
    const after = appendStep(before, step({ id: 's1', parent: 's0', action: 'read', createdAt: 2 }));
    assert.equal(before.steps.length, 1);
    assert.equal(after.steps.length, 2);
    assert.equal(before.position, 's0');
  });

  test('a clock that stepped backwards is clamped rather than costing the payload', () => {
    // An NTP correction between two runs must not refuse to record a job that
    // has already finished and already written its bank.
    const ledger = appendStep(
      appendStep(emptyLedger(), originStep('s0', 'archive/Book.pdf', 5_000)),
      step({ id: 's1', parent: 's0', action: 'read', createdAt: 12 }),
    );
    assert.equal(ledger.steps[1]!.createdAt, 5_000);
    // And what came out is still a ledger this app would read back.
    assert.equal(parseLedger(JSON.parse(JSON.stringify(ledger))).steps.length, 2);
  });

  test('the origin carries the retention nothing else in a project has', () => {
    const origin = originStep('s0', 'archive/Book.pdf', 1);
    assert.equal(origin.parent, null);
    assert.equal(origin.action, 'import');
    assert.equal(origin.retention, 'irreplaceable');
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe("the user's scenario: two translations, one reading, nothing lost", () => {
  const ledger = branched();

  test('both translations survive stepping back and translating again', () => {
    assert.deepEqual(ledger.steps.map((row) => row.id), ['s0', 's1', 's2', 's3']);
    assert.equal(stepOf(ledger, 's2').params?.language, 'English');
    assert.equal(stepOf(ledger, 's3').params?.language, 'Hungarian');
  });

  test("Hungarian's parent is the reading, not the English translation", () => {
    assert.equal(stepOf(ledger, 's3').parent, 's1');
    assert.deepEqual(childrenOf(ledger, 's1').map((row) => row.id), ['s2', 's3']);
  });

  test('the list is chronological: Hungarian is last because it happened last', () => {
    assert.deepEqual(chronological(ledger).map((row) => row.step.label), [
      'Imported',
      'Read (17 pages)',
      'Translated (English)',
      'Translated (Hungarian)',
    ]);
  });

  test('only Hungarian needs the "from …" annotation, and it names the reading', () => {
    /*
     * The whole concession to the tree, and this asserts which rows actually
     * need it: the origin has no parent; the reading's parent IS the row above
     * it; English's parent is the reading, which is also the row above it; and
     * Hungarian's parent is the reading with English sitting in between — the
     * one place the flat list would otherwise be misleading about what was made
     * from what.
     */
    assert.deepEqual(chronological(ledger).map((row) => row.from), [
      null,
      null,
      null,
      'Read (17 pages)',
    ]);
  });

  test('standing on Hungarian, the current translation is the Hungarian one', () => {
    // English is a sibling and not on the path from the import to here, so a
    // derived "the translation" row must not show it.
    const standard = currentStandard(ledger);
    assert.equal(standard.translate?.id, 's3');
    assert.equal(standard.read?.id, 's1');
    assert.equal(standard.import?.id, 's0');
  });

  test('clicking back to English makes English the current translation again', () => {
    const standard = currentStandard({ ...ledger, position: 's2' });
    assert.equal(standard.translate?.id, 's2');
    // And standing on the reading, there is no current translation at all.
    assert.equal(currentStandard({ ...ledger, position: 's1' }).translate, undefined);
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('reRunTarget: the branch-or-replace decision, which destroys a payload', () => {
  const ledger = branched();

  test('the same language from the same step is the same question asked twice', () => {
    const target = reRunTarget(ledger, { action: 'translate', parent: 's1', params: { language: 'English' } });
    assert.equal(target?.id, 's2');
  });

  test('another language is a branch, however identical everything else is', () => {
    assert.equal(reRunTarget(ledger, { action: 'translate', parent: 's1', params: { language: 'German' } }), null);
  });

  test('the same language from a different step is a branch', () => {
    // Translating from a curation commit is translating the curated book, which
    // is a different document however much the language matches.
    assert.equal(reRunTarget(ledger, { action: 'translate', parent: 's0', params: { language: 'English' } }), null);
  });

  test('another action from the same step is never a re-run', () => {
    assert.equal(reRunTarget(ledger, { action: 'read', parent: 's1', params: { pages: 17 } }), null);
  });

  test('THE GENERATION TRAP: a re-read matches the reading it replaces', () => {
    /*
     * A re-read MINTS a new generation — that is what the generation is for.
     * Comparing it would mean the second reading of a book never matched the
     * first, every re-read would append beside the reading it was meant to
     * replace, and the user would be left with two banks and no way to say which
     * is current. The comparison is over what was ASKED, not what came back.
     */
    const again = reRunTarget(ledger, {
      action: 'read',
      parent: 's0',
      params: { generation: 'a-brand-new-uuid', pages: 17 },
    });
    assert.equal(again?.id, 's1');
  });

  test('THE PAGE-COUNT TRAP: a count that came back different is the same reading', () => {
    /*
     * `pages` is counted off the finished bank, so it is an ANSWER — and it used
     * to decide identity, where it worked by accident until it did not. A run
     * resumed after dying at page 200 comes home with a bigger count for the very
     * bank the first step names, and treating that as a new question left two
     * `read` steps pointing at one file.
     */
    assert.equal(reRunTarget(ledger, { action: 'read', parent: 's0', params: { pages: 40 } })?.id, 's1');
  });

  test('the same read request asked again is the same question, however it is spelled', () => {
    // Nothing was skipped and no language was declared, in either run: the plain
    // question, which is also what a migrated project's reading asks.
    assert.equal(reRunTarget(ledger, { action: 'read', parent: 's0' })?.id, 's1');
    assert.equal(reRunTarget(ledger, { action: 'read', parent: 's0', params: {} })?.id, 's1');
    assert.equal(
      reRunTarget(ledger, { action: 'read', parent: 's0', params: { skipPages: undefined } })?.id,
      's1',
    );
  });

  test('A DIFFERENT PAGE RANGE IS A DIFFERENT READING, which is the point of asking', () => {
    assert.equal(
      reRunTarget(ledger, { action: 'read', parent: 's0', params: { skipPages: '3,17,19-24' } }),
      null,
    );
    // And a different declared language is a different reading too: the model is
    // being shown the same pixels and asked to expect something else on them.
    assert.equal(reRunTarget(ledger, { action: 'read', parent: 's0', params: { language: 'de' } }), null);
  });

  test('the same page range asked twice replaces, whatever the run then answered', () => {
    let skipped = appendStep(emptyLedger(), originStep('s0', 'archive/Book.pdf', 100, 'Imported'));
    skipped = appendStep(skipped, step({
      id: 'r1', parent: 's0', action: 'read', payload: 'readings/book.jsonl', createdAt: 200,
      params: { skipPages: '3,17', generation: GENERATION, pages: 15 },
    }));
    assert.equal(
      reRunTarget(skipped, {
        action: 'read',
        parent: 's0',
        params: { skipPages: '3,17', generation: 'a-second-pass', pages: 15 },
      })?.id,
      'r1',
    );
    // And dropping the skips is a different question, so it branches beside it.
    assert.equal(reRunTarget(skipped, { action: 'read', parent: 's0' }), null);
    // The string IS the question. This app does not claim to know that "17,3"
    // names the same pages as "3,17", so it treats it as a different one.
    assert.equal(reRunTarget(skipped, { action: 'read', parent: 's0', params: { skipPages: '17,3' } }), null);
  });

  test('params compare by field and not by the order JSON happened to spell them', () => {
    let asked = appendStep(emptyLedger(), originStep('s0', 'archive/Book.pdf', 100, 'Imported'));
    asked = appendStep(asked, step({
      id: 'r1', parent: 's0', action: 'read', payload: 'readings/book.jsonl', createdAt: 200,
      params: { skipPages: '3,17', language: 'de', generation: GENERATION, pages: 15 },
    }));
    const forwards: LedgerParams = { skipPages: '3,17', language: 'de' };
    const backwards: LedgerParams = { language: 'de', skipPages: '3,17' };
    assert.equal(reRunTarget(asked, { action: 'read', parent: 's0', params: forwards })?.id, 'r1');
    assert.equal(reRunTarget(asked, { action: 'read', parent: 's0', params: backwards })?.id, 'r1');
    // One field of the pair changed is a different question, both ways round.
    assert.equal(
      reRunTarget(asked, { action: 'read', parent: 's0', params: { skipPages: '3,17', language: 'hu' } }),
      null,
    );
    assert.equal(
      reRunTarget(asked, { action: 'read', parent: 's0', params: { skipPages: '3', language: 'de' } }),
      null,
    );
  });

  test('a field set to undefined said nothing, and matches a step that omitted it', () => {
    let plain = appendStep(emptyLedger(), originStep('s0', 'archive/Book.pdf', 1));
    plain = appendStep(plain, step({ id: 's1', parent: 's0', action: 'translate', createdAt: 2 }));
    assert.equal(reRunTarget(plain, { action: 'translate', parent: 's0', params: {} })?.id, 's1');
    assert.equal(
      reRunTarget(plain, { action: 'translate', parent: 's0', params: { language: undefined } })?.id,
      's1',
    );
    assert.equal(reRunTarget(plain, { action: 'translate', parent: 's0' })?.id, 's1');
  });

  test('IRREPLACEABLE IS NEVER A TARGET: two saves are two saves', () => {
    /*
     * Replacing means destroying, and the retention rule says a person's labour
     * is never destroyed by a re-run. So a second curation commit from the same
     * parent with the same generation appends rather than overwriting the first,
     * which is what the spec says a second save is — and it falls out of the
     * retention rule rather than being restated as a special case.
     */
    let ledgerWithSave = appendStep(emptyLedger(), originStep('s0', 'archive/Book.pdf', 1));
    ledgerWithSave = appendStep(ledgerWithSave, step({
      id: 's1', parent: 's0', action: 'read', createdAt: 2, params: { generation: GENERATION, pages: 17 },
    }));
    ledgerWithSave = appendStep(ledgerWithSave, step({
      id: 's2', parent: 's1', action: 'curate', createdAt: 3, params: { generation: GENERATION, amendments: 23 },
    }));
    assert.equal(
      reRunTarget(ledgerWithSave, {
        action: 'curate', parent: 's1', params: { generation: GENERATION, amendments: 23 },
      }),
      null,
    );
    // And so is the import, for the same reason and without a rule of its own.
    assert.equal(reRunTarget(ledgerWithSave, { action: 'import', parent: null }), null);
  });

  test('a stale step IS a target: re-running it is how a branch is brought back', () => {
    const stale = markStale(branched(), 's1');
    assert.equal(stale.steps.find((row) => row.id === 's3')!.stale, true);
    const target = reRunTarget(stale, { action: 'translate', parent: 's1', params: { language: 'Hungarian' } });
    assert.equal(target?.id, 's3');
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('markStale: what a replaced payload does to everything under it', () => {
  /** import → read → curate → translate → curate again: four levels deep. */
  function deep(): ProjectLedger {
    let ledger = appendStep(emptyLedger(), originStep('s0', 'archive/Book.pdf', 1));
    const rows: [string, string, StepAction, LedgerParams | undefined][] = [
      ['s1', 's0', 'read', { generation: GENERATION, pages: 17 }],
      ['s2', 's1', 'curate', { generation: GENERATION, amendments: 23 }],
      ['s3', 's2', 'translate', { language: 'English' }],
      ['s4', 's3', 'curate', { generation: GENERATION, amendments: 4 }],
    ];
    rows.forEach(([id, parent, action, params], index) => {
      ledger = appendStep(ledger, step({ id, parent, action, createdAt: index + 2, params }));
    });
    return ledger;
  }

  test('every descendant goes stale, however many levels down it is', () => {
    const after = markStale(deep(), 's1');
    assert.deepEqual(
      after.steps.map((row) => [row.id, row.stale === true]),
      [['s0', false], ['s1', false], ['s2', true], ['s3', true], ['s4', true]],
    );
  });

  test('the replaced step itself is fresh — its payload was just swapped', () => {
    const after = markStale(deep(), 's1');
    assert.equal('stale' in after.steps[1]!, false);
  });

  test('a step that was already stale is un-stalled when it is the one re-run', () => {
    // A re-read of a bank that had itself gone stale is how a branch is brought
    // back to current, and leaving the mark on would say the new reading is old.
    const twice = markStale(markStale(deep(), 's1'), 's3');
    assert.equal(twice.steps.find((row) => row.id === 's3')!.stale, undefined);
    assert.equal(twice.steps.find((row) => row.id === 's4')!.stale, true);
    // s2 is not under s3, so the first re-run's mark on it stands.
    assert.equal(twice.steps.find((row) => row.id === 's2')!.stale, true);
  });

  test('a sibling branch is untouched: nothing was replaced under it', () => {
    const after = markStale(branched(), 's2');
    assert.equal(after.steps.find((row) => row.id === 's3')!.stale, undefined);
  });

  test('nothing is deleted and no payload is named — stale is a display state', () => {
    const after = markStale(deep(), 's1');
    assert.equal(after.steps.length, 5);
    assert.deepEqual(after.steps.map((row) => row.payload), deep().steps.map((row) => row.payload));
  });

  test('a stale step is not the current standard of anything', () => {
    const after = markStale(branched(), 's1');
    // Standing on Hungarian, which has gone stale under a replaced reading: the
    // reading itself is current again, and the translation is not current at all.
    const standard = currentStandard(after);
    assert.equal(standard.read?.id, 's1');
    assert.equal(standard.translate, undefined);
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('deleteSubtree: the cascade, the pointer, and the one refusal', () => {
  test('the origin is refused by name, because deleting it is deleting the project', () => {
    const refused = refusal(() => deleteSubtree(branched(), 's0'));
    assert.match(refused, /is the document this project was made from/);
    assert.match(refused, /taking it is deleting the project/);
  });

  test('a leaf takes only itself', () => {
    const { ledger, removed } = deleteSubtree(branched(), 's2');
    assert.deepEqual(removed.map((row) => row.id), ['s2']);
    assert.deepEqual(ledger.steps.map((row) => row.id), ['s0', 's1', 's3']);
  });

  test('a step with descendants names every casualty for the confirm', () => {
    const { ledger, removed } = deleteSubtree(branched(), 's1');
    assert.deepEqual(removed.map((row) => row.id), ['s1', 's2', 's3']);
    assert.deepEqual(removed.map((row) => row.payload), [
      'readings/book.jsonl',
      'translations/book-en.jsonl',
      'translations/book-hu.jsonl',
    ]);
    assert.deepEqual(ledger.steps.map((row) => row.id), ['s0']);
  });

  test('the pointer moves to the deleted step\'s parent when it was standing inside', () => {
    // Standing on Hungarian and deleting the reading: everything under the
    // reading goes, and the pointer lands on the import.
    const { ledger } = deleteSubtree(branched(), 's1');
    assert.equal(ledger.position, 's0');
    assert.equal(positionOf(ledger)!.id, 's0');
  });

  test('a pointer standing elsewhere is left exactly where it was', () => {
    const standing = { ...branched(), position: 's2' };
    const { ledger } = deleteSubtree(standing, 's3');
    assert.equal(ledger.position, 's2');
  });

  test('AN ABSENT POINTER IS NOT NO POINTER: it means the newest, which just went', () => {
    /*
     * Left alone, an absent pointer would silently land on whatever is newest
     * among the survivors — some unrelated branch, rather than the place the
     * deleted work came from. So it is resolved first, then written down.
     */
    const implicit = { steps: branched().steps };
    assert.equal(positionOf(implicit)!.id, 's3');
    const { ledger } = deleteSubtree(implicit, 's3');
    assert.equal(ledger.position, 's1');
  });

  test('the ledger it was given is not touched, and what comes out still parses', () => {
    const before = branched();
    const { ledger } = deleteSubtree(before, 's1');
    assert.equal(before.steps.length, 4);
    assert.equal(parseLedger(JSON.parse(JSON.stringify(ledger))).steps.length, 1);
  });
});

describe('deleteCost says what the loss IS, in the retention rule\'s own words', () => {
  test('an expensive payload is named as a paid run to remake', () => {
    const said = deleteCost(stepOf(branched(), 's2'));
    assert.match(said, /Translated \(English\)/);
    assert.match(said, /costs a paid run to undo/);
    assert.ok(said.includes(WHY_MODEL_PASS), said);
  });

  test('the import is named as the only copy in the world', () => {
    const said = deleteCost(stepOf(branched(), 's0'));
    assert.ok(said.includes(WHY_IMPORTED), said);
    assert.match(said, /nowhere to fetch it back from/);
  });

  test('a curation commit is named as labour no run remakes', () => {
    const save = step({
      id: 'c1', parent: 's1', action: 'curate', params: { generation: GENERATION, amendments: 23 },
    });
    const said = deleteCost(save);
    assert.match(said, /Saved corrections \(23\)/);
    assert.ok(said.includes(WHY_HANDMADE), said);
    assert.match(said, /at any price/);
  });

  test('a regenerable payload says out loud that it is free', () => {
    const free: LedgerStep = { ...stepOf(branched(), 's2'), retention: 'regenerable' };
    assert.match(deleteCost(free), /costs nothing/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('migrateLedger: a project that predates all of this', () => {
  function manifest(over: Partial<ProjectManifest>): ProjectManifest {
    return {
      version: 2,
      key: 'Kershaw-d3f7ae65',
      title: 'Working Towards The Fuhrer',
      stem: 'Working Towards The Fuhrer. Kershaw, Ian. (1993)',
      createdAt: 1_786_000_000_000,
      archive: null,
      documents: [],
      working: { trees: [], files: [] },
      final: [],
      reading: null,
      ...over,
    };
  }

  function chainStep(over: Partial<ProjectStep> & Pick<ProjectStep, 'file' | 'kind'>): ProjectStep {
    return {
      label: 'An earlier version',
      appliedAt: 1_786_100_000_000,
      retention: 'expensive',
      why: WHY_MODEL_PASS,
      ...over,
    };
  }

  /**
   * A v1-SHAPED project as `migrateToSteps` hands it over: a scan, cast to an
   * EPUB and then translated, with no `reading` record at all — that field
   * postdates every project of this vintage.
   */
  const V1 = manifest({
    version: 1,
    archive: { file: 'Kershaw.pdf', kind: 'pdf', contentKey: 'd3f7ae65', originPath: null },
    documents: [
      {
        kind: 'pdf',
        steps: [chainStep({
          file: 'archive/Kershaw.pdf', kind: 'origin', label: 'The scan you imported',
          retention: 'irreplaceable', why: WHY_IMPORTED, appliedAt: 0,
        })],
      },
      {
        kind: 'epub',
        steps: [
          chainStep({ file: 'generated/Kershaw.epub', kind: 'origin', label: 'Cast from the scan', appliedAt: 1_786_100_000_000 }),
          chainStep({ file: 'generated/Kershaw (en).epub', kind: 'translate', label: 'Translated', appliedAt: 1_786_200_000_000 }),
        ],
      },
    ],
  });

  /** A v2 project: the same book, with a reading actually recorded. */
  const V2 = manifest({
    archive: { file: 'Kershaw.pdf', kind: 'pdf', contentKey: 'd3f7ae65', originPath: null },
    reading: { generation: GENERATION, passes: 0, readAt: 1_786_050_000_000, pages: 317 },
    documents: [
      {
        kind: 'pdf',
        steps: [chainStep({
          file: 'archive/Kershaw.pdf', kind: 'origin', label: 'The scan you imported',
          retention: 'irreplaceable', why: WHY_IMPORTED, appliedAt: 0,
        })],
      },
      {
        kind: 'epub',
        steps: [chainStep({ file: 'generated/Kershaw.epub', kind: 'origin', label: 'Cast from the scan' })],
      },
    ],
  });

  test('a v2 project comes out as import → read, with the reading it recorded', () => {
    const ledger = migrateLedger(V2);
    assert.deepEqual(ledger.steps.map((row) => row.action), ['import', 'read']);
    assert.equal(ledger.steps[0]!.payload, 'archive/Kershaw.pdf');
    assert.equal(ledger.steps[0]!.label, 'The scan you imported');
    assert.equal(ledger.steps[1]!.payload, 'readings/Kershaw-d3f7ae65.jsonl');
    assert.equal(ledger.steps[1]!.label, 'Read (317 pages)');
    assert.deepEqual(ledger.steps[1]!.params, { generation: GENERATION, pages: 317 });
    assert.equal(ledger.steps[1]!.parent, 'm0');
  });

  test('a v1 project still comes out with a sane import → read chain', () => {
    // No `reading` record exists at this vintage. The evidence is that the
    // engine MADE something: a cast EPUB cannot exist without a bank.
    const ledger = migrateLedger(V1);
    assert.deepEqual(ledger.steps.map((row) => row.action), ['import', 'read', 'translate']);
    assert.equal(ledger.steps[1]!.label, 'Read');
    // And it does not invent a generation it never knew, nor write an empty bag
    // that looks like a record of one.
    assert.equal(ledger.steps[1]!.params, undefined);
  });

  test('a translation becomes a step on the reading, keeping the payload it has', () => {
    const ledger = migrateLedger(V1);
    const translation = ledger.steps[2]!;
    assert.equal(translation.parent, ledger.steps[1]!.id);
    // The retained payload is the EPUB, because that IS what was retained; the
    // per-block translation bank is a later invention no old project has.
    assert.equal(translation.payload, 'generated/Kershaw (en).epub');
    assert.equal(translation.label, 'Translated');
    // NO LANGUAGE. It is legible only in the filename, and reading a fact out of
    // a filename is what this codebase's oldest house rule forbids.
    assert.equal(translation.params, undefined);
  });

  test('renderings do not become steps', () => {
    // The cast EPUB is a rendering of the bank, free to make again. A step for
    // it would put a filename where an action belongs.
    const payloads = migrateLedger(V1).steps.map((row) => row.payload);
    assert.equal(payloads.includes('generated/Kershaw.epub'), false);
  });

  test('DETERMINISM: the same manifest twice is the same ledger, byte for byte', () => {
    // This runs on every read of an un-migrated project, and the ids in it are
    // what the pointer and every parent point at. A uuid or a clock reading here
    // would give a project a different history on every open.
    for (const fixture of [V1, V2]) {
      assert.deepEqual(migrateLedger(fixture), migrateLedger(fixture));
      assert.equal(JSON.stringify(migrateLedger(fixture)), JSON.stringify(migrateLedger(fixture)));
    }
    assert.deepEqual(migrateLedger(V1).steps.map((row) => row.id), ['m0', 'm1', 'm2']);
  });

  test('what comes out is a ledger this app would read back', () => {
    for (const fixture of [V1, V2]) {
      const round = parseLedger(JSON.parse(JSON.stringify(migrateLedger(fixture))));
      assert.deepEqual(round, migrateLedger(fixture));
    }
  });

  test('the pointer is left absent, which lands on the last thing that happened', () => {
    const ledger = migrateLedger(V1);
    assert.equal(ledger.position, undefined);
    assert.equal(positionOf(ledger)!.action, 'translate');
  });

  test('a project imported and never converted is its import and nothing else', () => {
    const untouched = manifest({
      archive: { file: 'Kershaw.pdf', kind: 'pdf', contentKey: 'd3f7ae65', originPath: null },
      documents: [{
        kind: 'pdf',
        steps: [chainStep({
          file: 'archive/Kershaw.pdf', kind: 'origin', label: 'The scan you imported',
          retention: 'irreplaceable', why: WHY_IMPORTED, appliedAt: 0,
        })],
      }],
    });
    assert.deepEqual(migrateLedger(untouched).steps.map((row) => row.action), ['import']);
  });

  test('a project started from an EPUB gets no reading: it has no pages to read', () => {
    const book = manifest({
      archive: { file: 'Orwell.epub', kind: 'epub', contentKey: 'aaaaaaaa', originPath: null },
      documents: [{
        kind: 'epub',
        steps: [chainStep({
          file: 'archive/Orwell.epub', kind: 'origin', label: 'The book you imported',
          retention: 'irreplaceable', why: WHY_IMPORTED, appliedAt: 0,
        })],
      }],
    });
    assert.deepEqual(migrateLedger(book).steps.map((row) => row.action), ['import']);
  });

  test('a project adopted with no import hangs off the origin it does have', () => {
    const adopted = manifest({
      documents: [{
        kind: 'epub',
        steps: [chainStep({ file: 'generated/Kershaw.epub', kind: 'origin', label: 'Cast from the scan' })],
      }],
    });
    const ledger = migrateLedger(adopted);
    assert.equal(ledger.steps[0]!.payload, 'generated/Kershaw.epub');
    assert.equal(ledger.steps[0]!.action, 'import');
    // It is still evidence of a bank, so the reading step is still minted.
    assert.deepEqual(ledger.steps.map((row) => row.action), ['import', 'read']);
  });

  test('a project with nothing recorded at all yields an empty ledger, not a refusal', () => {
    assert.deepEqual(migrateLedger(manifest({})), { steps: [] });
  });

  test('a manifest with no reading FIELD AT ALL is read as having no reading', () => {
    /*
     * `readManifest` always writes the field, so this is unreachable through it —
     * and the test was `!== null`, which is true of `undefined` and walked
     * straight into reading a generation off it. Unreachable today is not a reason
     * to be wrong: the next caller assembling a manifest by hand is the one who
     * finds out, and what they get should be a ledger rather than a TypeError.
     */
    const absent = { ...V2, reading: undefined } as unknown as ProjectManifest;
    assert.deepEqual(migrateLedger(absent).steps.map((row) => row.action), ['import', 'read']);
    // The evidence of a bank is still there — an EPUB was cast from one — so the
    // reading step stands, saying nothing about itself rather than inventing.
    assert.equal(migrateLedger(absent).steps[1]!.params, undefined);
    assert.equal(migrateLedger(absent).steps[1]!.label, 'Read');
    // And the same is true of an archive nobody wrote down: it takes the adopted
    // path — the first origin the chains have — rather than reading `.file` off
    // a field that is not there.
    const noArchive = { ...V2, archive: undefined } as unknown as ProjectManifest;
    assert.equal(migrateLedger(noArchive).steps[0]!.payload, 'archive/Kershaw.pdf');
    assert.equal(migrateLedger(noArchive).steps[0]!.action, 'import');
  });

  test('A MIGRATED READING ASKS THE PLAIN QUESTION, so a plain re-read replaces it', () => {
    /*
     * No old catalogue recorded which pages a reading was told to skip, and
     * nothing on disk can answer it afterwards. So a migrated reading is the whole
     * book with no language declared — which means somebody pressing OCR again
     * without touching the form REPLACES it, rather than being left with two
     * readings and no way to say which is current.
     */
    const migrated = migrateLedger(V2);
    const origin = migrated.steps[0]!.id;
    assert.equal(reRunTarget(migrated, { action: 'read', parent: origin })?.id, 'm1');
    assert.equal(
      reRunTarget(migrated, {
        action: 'read', parent: origin, params: { generation: 'a-new-pass', pages: 400 },
      })?.id,
      'm1',
    );
    // And asking for something the old reading cannot have been asked for is a
    // new question, which branches beside it.
    assert.equal(
      reRunTarget(migrated, { action: 'read', parent: origin, params: { skipPages: '3,17' } }),
      null,
    );
  });

  test('a catalogue whose times run backwards still produces a readable list', () => {
    // A v1 `madeAt` was whatever the clock said, and one of them being earlier
    // than the import is a thing that happens.
    const crooked = manifest({
      archive: { file: 'Kershaw.pdf', kind: 'pdf', contentKey: 'd3f7ae65', originPath: null },
      createdAt: 9_000,
      documents: [{
        kind: 'epub',
        steps: [
          chainStep({ file: 'generated/Kershaw.epub', kind: 'origin', label: 'Cast from the scan', appliedAt: 40 }),
          chainStep({ file: 'generated/Kershaw (en).epub', kind: 'translate', label: 'Translated', appliedAt: 5 }),
        ],
      }],
    });
    const ledger = migrateLedger(crooked);
    assert.deepEqual(ledger.steps.map((row) => row.createdAt), [9_000, 9_000, 9_000]);
    assert.equal(parseLedger(JSON.parse(JSON.stringify(ledger))).steps.length, 3);
  });
});

describe('labelFor names a step in words, never in filenames', () => {
  test('a count that was recorded is in the row; one that was not is not invented', () => {
    assert.equal(labelFor('read', { pages: 17 }), 'Read (17 pages)');
    assert.equal(labelFor('read'), 'Read');
    assert.equal(labelFor('curate', { amendments: 23 }), 'Saved corrections (23)');
    assert.equal(labelFor('curate'), 'Saved corrections');
    assert.equal(labelFor('translate', { language: 'Hungarian' }), 'Translated (Hungarian)');
    assert.equal(labelFor('translate'), 'Translated');
    assert.equal(labelFor('import'), 'Imported');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// A run that landed
// ═════════════════════════════════════════════════════════════════════════════

describe('recordLanding decides append-or-replace once, for every job that finishes', () => {
  /** import → read, which is where every landing after the first starts. */
  function read(): ProjectLedger {
    const imported = appendStep(emptyLedger(), originStep('s0', 'archive/Book.pdf', 100, 'Imported'));
    return appendStep(imported, step({
      id: 's1', parent: 's0', action: 'read', payload: 'readings/book.jsonl', createdAt: 200,
      params: { generation: GENERATION, pages: 17 },
    }));
  }

  test('a first translation appends, spends the id it was given, and stales nothing', () => {
    const landed = recordLanding(read(), {
      action: 'translate', parent: 's1', payload: 'generated/Book (en).epub',
      params: { language: 'English' }, createdAt: 300, id: 'new',
    });
    assert.equal(landed.replaced, false);
    assert.equal(landed.step.id, 'new');
    assert.equal(landed.step.label, 'Translated (English)');
    assert.equal(landed.step.retention, 'expensive');
    assert.deepEqual(landed.stale, []);
    assert.equal(landed.displaced, null);
    // The pointer follows what was just made — that is what the viewers show.
    assert.equal(landed.ledger.position, 'new');
  });

  test('a second language from the same step is a branch, not a replace', () => {
    const first = recordLanding(read(), {
      action: 'translate', parent: 's1', payload: 'generated/Book (en).epub',
      params: { language: 'English' }, createdAt: 300, id: 'en',
    });
    const second = recordLanding(first.ledger, {
      action: 'translate', parent: 's1', payload: 'generated/Book (hu).epub',
      params: { language: 'Hungarian' }, createdAt: 400, id: 'hu',
    });
    assert.equal(second.replaced, false);
    assert.deepEqual(second.ledger.steps.map((row) => row.id), ['s0', 's1', 'en', 'hu']);
  });

  test('the same language from the same step again replaces, and adds no row', () => {
    const first = recordLanding(read(), {
      action: 'translate', parent: 's1', payload: 'generated/Book (en).epub',
      params: { language: 'English' }, createdAt: 300, id: 'en',
    });
    const again = recordLanding(first.ledger, {
      action: 'translate', parent: 's1', payload: 'generated/Book (en).epub',
      params: { language: 'English' }, createdAt: 999, id: 'unused',
    });
    assert.equal(again.replaced, true);
    assert.equal(again.step.id, 'en');
    assert.deepEqual(again.ledger.steps.map((row) => row.id), ['s0', 's1', 'en']);
    // The id offered for an append is not spent, and nothing in the ledger has it.
    assert.equal(again.ledger.steps.some((row) => row.id === 'unused'), false);
  });

  test('a replaced step keeps its place and its date, because the list is the chronology', () => {
    // Stamping the new time on a row that sits in the middle of the array would
    // produce exactly the file `parseLedger` refuses: rows running backwards.
    const first = recordLanding(read(), {
      action: 'translate', parent: 's1', payload: 'generated/Book (en).epub',
      params: { language: 'English' }, createdAt: 300, id: 'en',
    });
    const branchedOff = recordLanding(first.ledger, {
      action: 'translate', parent: 's1', payload: 'generated/Book (hu).epub',
      params: { language: 'Hungarian' }, createdAt: 400, id: 'hu',
    });
    const again = recordLanding(branchedOff.ledger, {
      action: 'translate', parent: 's1', payload: 'generated/Book (en).epub',
      params: { language: 'English' }, createdAt: 5_000, id: 'unused',
    });
    assert.equal(again.step.createdAt, 300);
    assert.deepEqual(again.ledger.steps.map((row) => row.createdAt), [100, 200, 300, 400]);
    // And the file it produced is still one this app would load back.
    assert.equal(parseLedger(JSON.parse(JSON.stringify(again.ledger))).steps.length, 4);
  });

  test('THE GENERATION TRAP: a re-read replaces even though its generation is new', () => {
    // A re-read mints a fresh generation by design. Comparing it would make every
    // re-read a new branch and leave the project holding two banks, one stale,
    // forever — the rule inverted by the very field that protects the overlay.
    const landed = recordLanding(read(), {
      action: 'read', parent: 's0', payload: 'readings/book.jsonl',
      params: { generation: 'a-completely-different-uuid', pages: 17 },
      createdAt: 900, id: 'unused',
    });
    assert.equal(landed.replaced, true);
    assert.equal(landed.step.id, 's1');
    assert.equal(landed.step.params?.generation, 'a-completely-different-uuid');
  });

  test('A RE-READ OF THE SAME REQUEST REPLACES, and the project keeps one bank', () => {
    // The whole book read again, with the same page skips asked for. The counts
    // differ because the model answered differently the second time, which is an
    // answer and not a question.
    let asked = appendStep(emptyLedger(), originStep('s0', 'archive/Book.pdf', 100, 'Imported'));
    asked = appendStep(asked, step({
      id: 'r1', parent: 's0', action: 'read', payload: 'readings/book.jsonl', createdAt: 200,
      params: { skipPages: '3,17', generation: GENERATION, pages: 15 },
    }));
    const landed = recordLanding(asked, {
      action: 'read', parent: 's0', payload: 'readings/book.jsonl',
      params: { skipPages: '3,17', generation: 'second-pass', pages: 16 },
      createdAt: 900, id: 'unused',
    });
    assert.equal(landed.replaced, true);
    assert.equal(landed.step.id, 'r1');
    assert.equal(landed.step.label, 'Read (16 pages)');
    assert.deepEqual(landed.ledger.steps.map((row) => row.id), ['s0', 'r1']);
  });

  test('A RE-READ ASKING FOR DIFFERENT PAGES BRANCHES, because it is a different question', () => {
    let asked = appendStep(emptyLedger(), originStep('s0', 'archive/Book.pdf', 100, 'Imported'));
    asked = appendStep(asked, step({
      id: 'r1', parent: 's0', action: 'read', payload: 'readings/book.jsonl', createdAt: 200,
      params: { skipPages: '3,17', generation: GENERATION, pages: 15 },
    }));
    const landed = recordLanding(asked, {
      action: 'read', parent: 's0', payload: 'readings/book.jsonl',
      params: { skipPages: '3,17,19-24', generation: 'second-pass', pages: 9 },
      createdAt: 900, id: 'r2',
    });
    assert.equal(landed.replaced, false);
    assert.deepEqual(landed.ledger.steps.map((row) => row.id), ['s0', 'r1', 'r2']);
    /*
     * BOTH ROWS NAME THE ONE BANK the engine writes, which is why a delete asks
     * `orphanedPayloads` rather than unlinking what a subtree named: destroying
     * the older reading must not take the bank the newer one is made of.
     */
    assert.deepEqual(orphanedPayloads(deleteSubtree(landed.ledger, 'r1')), []);
  });

  test('a re-read stales the saves and the translations made from the bank it replaced', () => {
    let ledger = read();
    ledger = appendStep(ledger, step({
      id: 'save', parent: 's1', action: 'curate', payload: 'curations/one.json', createdAt: 300,
      params: { generation: GENERATION, amendments: 23 },
    }));
    ledger = appendStep(ledger, step({
      id: 'en', parent: 'save', action: 'translate', payload: 'generated/Book (en).epub',
      createdAt: 400, params: { language: 'English' },
    }));
    const landed = recordLanding(ledger, {
      action: 'read', parent: 's0', payload: 'readings/book.jsonl',
      params: { generation: 'second-pass', pages: 17 }, createdAt: 500, id: 'unused',
    });
    assert.deepEqual(landed.stale.map((row) => row.id), ['save', 'en']);
    // Stale is a display state: both rows are still in the list, with their payloads.
    assert.deepEqual(landed.ledger.steps.map((row) => row.id), ['s0', 's1', 'save', 'en']);
    assert.equal(stepOf(landed.ledger, 'save').payload, 'curations/one.json');
  });

  test('a re-run un-stales the step it re-ran, which is how a branch is brought current', () => {
    const stale = markStale(read(), 's0');
    assert.equal(stepOf(stale, 's1').stale, true);
    const landed = recordLanding(stale, {
      action: 'read', parent: 's0', payload: 'readings/book.jsonl',
      params: { generation: 'fresh', pages: 17 }, createdAt: 600, id: 'unused',
    });
    assert.equal(landed.step.stale, undefined);
  });

  test('a re-run onto the same path displaces nothing, which is the ordinary case', () => {
    // The engine archived the previous bank and wrote the same path again, so
    // there is no file left for main to unlink.
    const landed = recordLanding(read(), {
      action: 'read', parent: 's0', payload: 'readings/book.jsonl',
      params: { generation: 'again', pages: 17 }, createdAt: 700, id: 'unused',
    });
    assert.equal(landed.displaced, null);
  });

  test('a re-run onto a new path names the file nothing points at any more', () => {
    const landed = recordLanding(read(), {
      action: 'read', parent: 's0', payload: 'readings/book-v2.jsonl',
      params: { generation: 'again', pages: 17 }, createdAt: 700, id: 'unused',
    });
    assert.equal(landed.displaced, 'readings/book.jsonl');
  });

  test('a displaced payload another step still names is NOT offered for destruction', () => {
    // Two steps are allowed to name one file. Unlinking on the strength of one of
    // them would destroy the payload the other is made of.
    const shared = appendStep(read(), step({
      id: 'twin', parent: 's1', action: 'translate', payload: 'readings/book.jsonl',
      createdAt: 250, params: { language: 'English' },
    }));
    const landed = recordLanding(shared, {
      action: 'read', parent: 's0', payload: 'readings/book-v2.jsonl',
      params: { generation: 'again', pages: 17 }, createdAt: 700, id: 'unused',
    });
    assert.equal(landed.displaced, null);
  });

  test('an empty params bag is not written, so a step says nothing rather than claiming nothing', () => {
    const landed = recordLanding(read(), {
      action: 'translate', parent: 's1', payload: 'generated/Book.epub',
      params: {}, createdAt: 300, id: 'plain',
    });
    assert.equal('params' in landed.step, false);
    assert.equal(landed.step.label, 'Translated');
  });
});

describe('orphanedPayloads names only the files a delete really leaves nobody holding', () => {
  test('a leaf delete offers its own payload', () => {
    const imported = appendStep(emptyLedger(), originStep('s0', 'archive/Book.pdf', 100, 'Imported'));
    const ledger = appendStep(imported, step({
      id: 's1', parent: 's0', action: 'read', payload: 'readings/book.jsonl', createdAt: 200,
    }));
    assert.deepEqual(orphanedPayloads(deleteSubtree(ledger, 's1')), ['readings/book.jsonl']);
  });

  test('a subtree delete offers every casualty, in creation order', () => {
    assert.deepEqual(orphanedPayloads(deleteSubtree(branched(), 's1')), [
      'readings/book.jsonl',
      'translations/book-en.jsonl',
      'translations/book-hu.jsonl',
    ]);
  });

  test('THE DANGEROUS ONE: a payload a surviving step still names is left alone', () => {
    // Two `read` steps from one parent, branched rather than replaced, both
    // naming the single bank the engine writes. Deleting the older must not
    // destroy the bank the newer one is made of.
    let ledger = appendStep(emptyLedger(), originStep('s0', 'archive/Book.pdf', 100, 'Imported'));
    ledger = appendStep(ledger, step({
      id: 'first', parent: 's0', action: 'read', payload: 'readings/book.jsonl', createdAt: 200,
      params: { pages: 17 },
    }));
    ledger = appendStep(ledger, step({
      id: 'second', parent: 's0', action: 'read', payload: 'readings/book.jsonl', createdAt: 300,
      params: { pages: 12 },
    }));
    assert.deepEqual(orphanedPayloads(deleteSubtree(ledger, 'first')), []);
  });

  test('one file named twice inside the doomed subtree is offered once', () => {
    let ledger = appendStep(emptyLedger(), originStep('s0', 'archive/Book.pdf', 100, 'Imported'));
    ledger = appendStep(ledger, step({
      id: 's1', parent: 's0', action: 'read', payload: 'readings/book.jsonl', createdAt: 200,
    }));
    ledger = appendStep(ledger, step({
      id: 's2', parent: 's1', action: 'translate', payload: 'readings/book.jsonl', createdAt: 300,
    }));
    assert.deepEqual(orphanedPayloads(deleteSubtree(ledger, 's1')), ['readings/book.jsonl']);
  });

  test('paths are compared whole, so one layer is never mistaken for another', () => {
    const imported = appendStep(emptyLedger(), originStep('s0', 'archive/Book.pdf', 100, 'Imported'));
    const ledger = appendStep(imported, step({
      id: 's1', parent: 's0', action: 'read', payload: 'generated/Book.pdf', createdAt: 200,
    }));
    // `Book.pdf` twice, in two layers. The archive survives; the reprint goes.
    assert.deepEqual(orphanedPayloads(deleteSubtree(ledger, 's1')), ['generated/Book.pdf']);
  });
});

describe('chainsWithout takes the per-type row down with the payload it named', () => {
  function chain(kind: ProjectTypeRecord['kind'], files: readonly string[]): ProjectTypeRecord {
    return {
      kind,
      steps: files.map((file, at): ProjectStep => ({
        file,
        label: at === 0 ? 'The scan you imported' : 'Translated',
        appliedAt: at,
        kind: at === 0 ? 'origin' : 'translate',
        retention: at === 0 ? 'irreplaceable' : 'expensive',
        why: at === 0 ? WHY_IMPORTED : WHY_MODEL_PASS,
      })),
    };
  }

  test('THE GHOST ROW: the file a delete destroyed is not left as a chain step', () => {
    // The bug this exists for: deleting a translation struck the ledger step,
    // destroyed the EPUB, and left the document row behind — which `summarise`
    // then drew as `missing`, so a clean absence came out as a broken row.
    const documents = [
      chain('pdf', ['archive/Kershaw.pdf']),
      chain('epub', ['generated/Kershaw.epub', 'generated/Kershaw (en).epub']),
    ];
    const after = chainsWithout(documents, ['generated/Kershaw (en).epub']);
    assert.deepEqual(after.map((record) => record.steps.map((row) => row.file)), [
      ['archive/Kershaw.pdf'],
      ['generated/Kershaw.epub'],
    ]);
  });

  test('a chain left with no steps is dropped, not kept as an empty husk', () => {
    // `summarise` skips a record whose steps are empty, so a husk is a document
    // the app will never draw again — and the type says a record is never empty.
    const after = chainsWithout([chain('epub', ['generated/Kershaw (en).epub'])], [
      'generated/Kershaw (en).epub',
    ]);
    assert.deepEqual(after, []);
  });

  test('a payload some surviving step still names keeps its row', () => {
    // `orphanedPayloads` is what this is given, so a file that is still on disk
    // because another step is made of it is a row that is still true.
    const documents = [chain('epub', ['generated/Kershaw.epub', 'generated/Kershaw (en).epub'])];
    assert.deepEqual(chainsWithout(documents, []), documents);
  });

  test('paths are compared whole, so one layer is never struck for another', () => {
    // `Book.pdf` in three layers is three documents. A comparison that had thrown
    // the layer away would strike the scan for a delete aimed at a reprint.
    const documents = [chain('pdf', ['archive/Book.pdf', 'generated/Book.pdf'])];
    const after = chainsWithout(documents, ['generated/Book.pdf']);
    assert.deepEqual(after[0]!.steps.map((row) => row.file), ['archive/Book.pdf']);
  });

  test('what it was given is not touched, and untouched chains come back as they were', () => {
    const documents = [
      chain('pdf', ['archive/Kershaw.pdf']),
      chain('epub', ['generated/Kershaw.epub', 'generated/Kershaw (en).epub']),
    ];
    const after = chainsWithout(documents, ['generated/Kershaw (en).epub']);
    assert.equal(documents[1]!.steps.length, 2);
    // The record nothing happened to is the very same object, not a copy of it.
    assert.equal(after[0], documents[0]);
  });
});

describe('curationInEffect says which overlay a rendering at the position is made with', () => {
  /** import → read → save → a translation OF that save. */
  function curated(): ProjectLedger {
    let ledger = appendStep(emptyLedger(), originStep('s0', 'archive/Book.pdf', 100, 'Imported'));
    ledger = appendStep(ledger, step({
      id: 'read', parent: 's0', action: 'read', payload: 'readings/book.jsonl', createdAt: 200,
    }));
    ledger = appendStep(ledger, step({
      id: 'save', parent: 'read', action: 'curate', payload: 'curations/one.json', createdAt: 300,
      params: { generation: GENERATION, amendments: 23 },
    }));
    return appendStep(ledger, step({
      id: 'en', parent: 'save', action: 'translate', payload: 'generated/Book (en).epub',
      createdAt: 400, params: { language: 'English' },
    }));
  }

  test('standing on a save renders that save', () => {
    assert.equal(curationInEffect({ ...curated(), position: 'save' })?.payload, 'curations/one.json');
  });

  test('standing on the reading renders the LIVE overlay, not a sibling save', () => {
    // The save is a sibling of where the user is standing, not an ancestor. The
    // reading step is where live editing happens.
    assert.equal(curationInEffect({ ...curated(), position: 'read' }), null);
  });

  test('standing on the import renders the live overlay', () => {
    assert.equal(curationInEffect({ ...curated(), position: 's0' }), null);
  });

  test('a chain of saves resolves to the one being stood on', () => {
    const ledger = appendStep(curated(), step({
      id: 'save2', parent: 'save', action: 'curate', payload: 'curations/two.json', createdAt: 500,
      params: { generation: GENERATION, amendments: 41 },
    }));
    assert.equal(curationInEffect({ ...ledger, position: 'save2' })?.payload, 'curations/two.json');
    assert.equal(curationInEffect({ ...ledger, position: 'save' })?.payload, 'curations/one.json');
  });

  test('a translate step falls back to the nearest ancestor that has one', () => {
    // Rendering a translation's own bank is a second rendering path this app does
    // not have yet; until it does, the honest answer is the state it was taken of.
    assert.equal(curationInEffect({ ...curated(), position: 'en' })?.payload, 'curations/one.json');
  });

  test('a translation made straight from the reading renders the live overlay', () => {
    const ledger = appendStep(curated(), step({
      id: 'hu', parent: 'read', action: 'translate', payload: 'generated/Book (hu).epub',
      createdAt: 600, params: { language: 'Hungarian' },
    }));
    assert.equal(curationInEffect({ ...ledger, position: 'hu' }), null);
  });

  test('a project nobody has ever saved in behaves exactly as it always did', () => {
    assert.equal(curationInEffect(branched()), null);
    assert.equal(curationInEffect(emptyLedger()), null);
  });

  test('the walk stops at the reading, so a save from an earlier bank is not reached', () => {
    // Two readings from the import, a save under the first, standing under the
    // second. That save names blocks by numbers that mean different blocks here.
    let ledger = appendStep(emptyLedger(), originStep('s0', 'archive/Book.pdf', 100, 'Imported'));
    ledger = appendStep(ledger, step({
      id: 'r1', parent: 's0', action: 'read', payload: 'readings/book.jsonl', createdAt: 200,
      params: { pages: 17 },
    }));
    ledger = appendStep(ledger, step({
      id: 'save', parent: 'r1', action: 'curate', payload: 'curations/one.json', createdAt: 300,
    }));
    ledger = appendStep(ledger, step({
      id: 'r2', parent: 's0', action: 'read', payload: 'readings/book.jsonl', createdAt: 400,
      params: { pages: 12 },
    }));
    assert.equal(curationInEffect({ ...ledger, position: 'r2' }), null);
  });
});

describe('originOf is what a reading is parented at, wherever the pointer is', () => {
  test('it finds the one step with no parent, and nothing in an empty ledger', () => {
    assert.equal(originOf(branched())?.id, 's0');
    assert.equal(originOf(emptyLedger()), null);
  });

  test('THE RE-READ TRAP: parented at the import, a second reading replaces the first', () => {
    // Somebody standing on their reading presses OCR again — the ordinary way a
    // book gets re-read. Parented at the POSITION this would append a reading
    // made from a reading, `reRunTarget` would never match it, and the project
    // would collect a chain of read steps all naming the one bank file the engine
    // writes, every one but the newest describing a bank that has been archived
    // out from under it.
    const ledger = { ...branched(), position: 's1' };
    const atThePosition = recordLanding(ledger, {
      action: 'read', parent: 's1', payload: 'readings/book.jsonl',
      params: { generation: 'second', pages: 17 }, createdAt: 500, id: 'wrong',
    });
    assert.equal(atThePosition.replaced, false);
    assert.equal(atThePosition.ledger.steps.length, 5);

    const atTheImport = recordLanding(ledger, {
      action: 'read', parent: originOf(ledger)!.id, payload: 'readings/book.jsonl',
      params: { generation: 'second', pages: 17 }, createdAt: 500, id: 'unused',
    });
    assert.equal(atTheImport.replaced, true);
    assert.equal(atTheImport.step.id, 's1');
    assert.equal(atTheImport.ledger.steps.length, 4);
    // And both translations of the old bank are dimmed rather than destroyed.
    assert.deepEqual(atTheImport.stale.map((row) => row.id), ['s2', 's3']);
  });
});
