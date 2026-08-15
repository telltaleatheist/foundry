/**
 * The queue confirm's sentences — the cost of a re-read, held down word by word.
 *
 * WHAT THESE TESTS ARE PROTECTING, in the order the damage would be felt:
 *
 *   A REPLACE IS NEVER SILENT. Reading a book again swaps the bank and stales
 *   every save and every translation made from the old reading. That is the one
 *   expensive irreversible thing this dialog can do, and the whole of `add()`'s
 *   defence against doing it by accident is that this function says "replace"
 *   when the landing will. A false null here is a person losing a reading they
 *   did not know they were spending.
 *
 *   A BRANCH IS NEVER A DIALOG. The opposite mistake is cheaper and it is still
 *   wrong: a re-read with different pages destroys nothing, and a box asking
 *   permission for it teaches somebody to click through the box that mattered.
 *
 *   NO NUMBER IS EVER INVENTED. Every count and every name in these sentences is
 *   read off the ledger — the casualty count from `subtree`, the names from the
 *   steps' own labels. A dialog that said "your 2 saved corrections" over a
 *   project holding three would be the app making up a fact about somebody's
 *   work at the moment they are deciding whether to destroy it.
 *
 *   THE ASK IS NORMALISED EXACTLY AS THE LANDING NORMALISES IT. A blank box and
 *   an absent field are the same statement (`askedOf`), and a confirm that
 *   disagreed with the landing about that would name a branch for a run the
 *   engine files as a replace.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { RETENTION_OF, appendStep, emptyLedger, labelFor, originStep } from '../../app/shared/ledger.ts';
import { BRANCH_SENTENCE, reReadAhead } from '../../app/shared/reread.ts';
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

/** A project with an import and nothing else — the state of every new book. */
function imported(): ProjectLedger {
  return appendStep(emptyLedger(), originStep('s0', 'archive/Book.pdf', 100, 'Imported'));
}

/**
 * Import → read, with the reading parented at the ORIGIN, which is where a
 * reading is always parented (`recordReading`; `originOf`'s header says why).
 */
function read(asked: { skipPages?: string; language?: string } = {}): ProjectLedger {
  return appendStep(imported(), step({
    id: 's1', parent: 's0', action: 'read', payload: 'readings/book.jsonl', createdAt: 200,
    params: { ...asked, generation: GENERATION, pages: 17 },
  }));
}

/** The 17-page reading, with a save of 2 corrections and an English translation on it. */
function readWithWork(): ProjectLedger {
  let ledger = appendStep(read(), step({
    id: 's2', parent: 's1', action: 'curate', payload: 'curations/a.json', createdAt: 300,
    params: { generation: GENERATION, amendments: 2 },
  }));
  ledger = appendStep(ledger, step({
    id: 's3', parent: 's1', action: 'translate', payload: 'translations/book-en.jsonl', createdAt: 400,
    params: { language: 'English' },
  }));
  return ledger;
}

// ═════════════════════════════════════════════════════════════════════════════

describe('a book nobody has read is told nothing, because there is nothing to say', () => {
  test('no ledger at all — the mirror has not answered yet', () => {
    assert.equal(reReadAhead(null, {}), null);
  });

  test('an empty ledger is a document that is not in a project', () => {
    assert.equal(reReadAhead(emptyLedger(), {}), null);
  });

  test('an import and no reading is the first pass through this dialog', () => {
    assert.equal(reReadAhead(imported(), {}), null);
    // And it stays silent whatever the form says: with nothing read, no ask is a
    // second reading of anything.
    assert.equal(reReadAhead(imported(), { skipPages: '3,17', language: 'de' }), null);
  });
});

describe('the same ask again is a replace, and it names what goes stale', () => {
  test('the reading and everything made from it, by their own labels', () => {
    const ahead = reReadAhead(readWithWork(), {});
    assert.ok(ahead !== null && ahead.kind === 'replace');
    assert.equal(ahead.target.id, 's1');
    // THE TARGET IS NOT ONE OF ITS OWN CASUALTIES. `subtree` includes the step
    // asked about, and a confirm that listed the reading among the things made
    // from the reading would be nonsense the user has to decode.
    assert.deepEqual(ahead.casualties.map((one) => one.id), ['s2', 's3']);

    assert.equal(ahead.message.message, 'Read this book again?');
    // The target by its own label — the count in it came from the ledger's
    // `pages`, never from this file.
    assert.match(ahead.message.detail, /^This replaces “Read \(17 pages\)”\./);
    assert.match(ahead.message.detail, /2 steps were made from it and will be marked stale/);
    assert.match(ahead.message.detail, /kept, listed, and dimmed/);
    assert.match(ahead.message.detail, /“Saved corrections \(2\)”, “Translated \(English\)”/);
    // THE SENTENCE THE PENDING BANK PAYS FOR. If this ever stops being true of
    // the disk it has to stop being said.
    assert.match(
      ahead.message.detail,
      /Nothing is destroyed if the run fails: the current reading stays until the new one finishes\./,
    );
  });

  test('one casualty is one step, not "1 steps"', () => {
    const ledger = appendStep(read(), step({
      id: 's2', parent: 's1', action: 'translate', payload: 'translations/book-en.jsonl', createdAt: 300,
      params: { language: 'English' },
    }));
    const ahead = reReadAhead(ledger, {});
    assert.ok(ahead !== null && ahead.kind === 'replace');
    assert.match(ahead.message.detail, /One step was made from it and will be marked stale/);
    assert.match(ahead.message.detail, /“Translated \(English\)”/);
  });

  test('a reading with nothing made from it invents nothing in between', () => {
    const ahead = reReadAhead(read(), {});
    assert.ok(ahead !== null && ahead.kind === 'replace');
    assert.deepEqual(ahead.casualties, []);
    // The first and last sentences, and no middle: no count, no "steps", no
    // dangling "and" — the spec's "nothing invented in between", asserted.
    assert.equal(
      ahead.message.detail,
      'This replaces “Read (17 pages)”. Nothing is destroyed if the run fails: '
      + 'the current reading stays until the new one finishes.',
    );
  });

  test('a reading whose page count nobody recorded is called what its row calls it', () => {
    // `labelFor` says "Read" for a step with no `pages`, and the confirm says the
    // same thing. Filling in the spec's own "17-page" here would be the one
    // failure this file exists to make impossible.
    const ledger = appendStep(imported(), step({
      id: 's1', parent: 's0', action: 'read', payload: 'readings/book.jsonl', createdAt: 200,
      params: { generation: GENERATION },
    }));
    const ahead = reReadAhead(ledger, {});
    assert.ok(ahead !== null && ahead.kind === 'replace');
    assert.match(ahead.message.detail, /^This replaces “Read”\./);
  });
});

describe('a different question is a branch, and a branch is a statement', () => {
  test('different skip-pages reads different pages, so it is a second reading', () => {
    const ahead = reReadAhead(read(), { skipPages: '3,17,19-24' });
    assert.deepEqual(ahead, { kind: 'branch', sentence: BRANCH_SENTENCE });
    assert.equal(BRANCH_SENTENCE, 'This will be a second reading beside the current one.');
  });

  test('a different declared language is a different question too', () => {
    const ahead = reReadAhead(read({ language: 'de' }), { language: 'en' });
    assert.ok(ahead !== null && ahead.kind === 'branch');
  });

  test('dropping a skip range the reading was made with also branches', () => {
    // The mirror of the first case, and the one somebody hits by clearing the
    // box: "read the whole book this time" is not the question that was asked.
    const ahead = reReadAhead(read({ skipPages: '3' }), {});
    assert.ok(ahead !== null && ahead.kind === 'branch');
  });
});

describe('the ask is normalised exactly as the landing normalises it (askedOf)', () => {
  test('whitespace around an answer is not a different question', () => {
    const ahead = reReadAhead(read({ skipPages: '3,17', language: 'de' }), {
      skipPages: '  3,17  ',
      language: ' de ',
    });
    assert.ok(ahead !== null && ahead.kind === 'replace', 'a trimmed ask is the same ask');
  });

  test('a blank box and an absent field are the same statement', () => {
    // The cursor-left-behind case: `read()` recorded no `skipPages` at all, and
    // the form hands back ''. Two spellings of "the whole book" that branched
    // would leave somebody with two banks for one question.
    const ahead = reReadAhead(read(), { skipPages: '', language: '   ' });
    assert.ok(ahead !== null && ahead.kind === 'replace');
    assert.equal(ahead.target.id, 's1');
  });

  test('an ask given no fields at all is the plain question', () => {
    const ahead = reReadAhead(read(), {});
    assert.ok(ahead !== null && ahead.kind === 'replace');
  });
});

describe('stale changes what a row looks like, never what a re-read costs', () => {
  test('a stale reading is still a replace — re-running a branch refreshes it', () => {
    // `reRunTarget` targets a stale step deliberately: a reading that went stale
    // because another one replaced it is exactly the thing somebody re-runs to
    // make current again, and refusing would leave no way to refresh it but a
    // delete. The confirm has to agree, or the app would offer a branch for a run
    // that replaces.
    const ledger = appendStep(imported(), step({
      id: 's1', parent: 's0', action: 'read', payload: 'readings/book.jsonl', createdAt: 200,
      params: { generation: GENERATION, pages: 17 }, stale: true,
    }));
    const ahead = reReadAhead(ledger, {});
    assert.ok(ahead !== null && ahead.kind === 'replace');
    assert.equal(ahead.target.id, 's1');
  });

  test('a stale casualty is still a casualty, and is still named', () => {
    // Staleness is a display state, not a deletion (`markStale`): the save is
    // kept, listed and dimmed, and a second re-read stales it again. Leaving it
    // out of the list would be the confirm quietly deciding that work somebody
    // already had marked old is work they no longer care about.
    const ledger = appendStep(read(), step({
      id: 's2', parent: 's1', action: 'curate', payload: 'curations/a.json', createdAt: 300,
      params: { generation: GENERATION, amendments: 23 }, stale: true,
    }));
    const ahead = reReadAhead(ledger, {});
    assert.ok(ahead !== null && ahead.kind === 'replace');
    assert.deepEqual(ahead.casualties.map((one) => one.id), ['s2']);
    assert.match(ahead.message.detail, /“Saved corrections \(23\)”/);
  });
});

describe('the whole subtree is the cost, not just the children', () => {
  test('a translation of a save made from the reading goes stale as well', () => {
    let ledger = appendStep(read(), step({
      id: 's2', parent: 's1', action: 'curate', payload: 'curations/a.json', createdAt: 300,
      params: { generation: GENERATION, amendments: 2 },
    }));
    ledger = appendStep(ledger, step({
      id: 's3', parent: 's2', action: 'translate', payload: 'translations/book-hu.jsonl', createdAt: 400,
      params: { language: 'Hungarian' },
    }));
    const ahead = reReadAhead(ledger, {});
    assert.ok(ahead !== null && ahead.kind === 'replace');
    assert.deepEqual(ahead.casualties.map((one) => one.id), ['s2', 's3']);
    assert.match(ahead.message.detail, /2 steps were made from it/);
    assert.match(ahead.message.detail, /“Saved corrections \(2\)”, “Translated \(Hungarian\)”/);
  });
});
