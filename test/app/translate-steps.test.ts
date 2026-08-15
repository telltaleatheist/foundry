/**
 * A translation as a step: what identifies it, what it writes, and what a delete
 * of it takes with it.
 *
 * WHAT THESE TESTS ARE PROTECTING, in the order the damage would be felt:
 *
 *   TWO TRANSLATIONS OF ONE BOOK INTO ONE LANGUAGE DO NOT WRITE INTO ONE FILE.
 *   The user's own scenario makes two: translate the reading, strike some blocks,
 *   commit, translate the curation. Both used to be called `<book> (hu).epub` and
 *   both used to bank into `<key>.hu.bank.jsonl`, so the second silently became
 *   the first — one row rendering another row's book, which is the exact failure
 *   the per-step bank paths ended for readings.
 *
 *   AND A RE-TRANSLATION STILL REPLACES. The opposite mistake costs just as much:
 *   asking for English again from the same step is somebody refining THIS
 *   translation, and a branch there would leave two English rows and two banks
 *   where one was asked for — and would re-ask the model for every block, because
 *   the branch's bank is empty.
 *
 *   A DELETED TRANSLATION TAKES ITS ANSWERS. A translate step's payload is the
 *   EPUB; the hours of GPU are in the bank BESIDE it, which no step's payload
 *   names. Nothing but this rule can find that file, and nothing but the
 *   whole-path guard stops it destroying a bank a surviving row is made of.
 *
 *   NOTHING IS EVER DECIDED FROM A FILENAME. The language a step was made into is
 *   read off the step, never out of the parentheses in its payload, and the guard
 *   compares whole project-relative paths and never a basename.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RETENTION_OF,
  StepLedgerError,
  appendStep,
  deleteSubtree,
  destroyedBy,
  emptyLedger,
  id8,
  labelFor,
  languageTagFor,
  orphanedBanks,
  originStep,
  parseLedger,
  pendingBeside,
  reRunTarget,
  recordLanding,
  translatedInto,
  translationBankFileFor,
  translationBankOf,
  translationFileFor,
  translationTarget,
} from '../../app/shared/ledger.ts';
import type { LedgerStep, ProjectLedger } from '../../app/shared/types.ts';

const GENERATION = 'edbd9f11-6a4c-4c02-9d0e-2f4b7a1c8e30';
/** A project key: the book's slug and the eight hex characters of its content hash. */
const KEY = 'book-1a2b3c4d';
const STEM = 'Book';
/** The uuid a plan mints speculatively. Its first eight characters name a branch. */
const MINTED = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

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

/** import → read. Every project in this file starts here. */
function read(): ProjectLedger {
  return appendStep(
    appendStep(emptyLedger(), originStep('s0', 'archive/Book.pdf', 100, 'Imported')),
    step({
      id: 's1', parent: 's0', action: 'read', payload: `readings/${KEY}.jsonl`, createdAt: 200,
      params: { generation: GENERATION, pages: 17 },
    }),
  );
}

/** A translation of the reading, with the files a first translation takes. */
function translated(over: Partial<LedgerStep> = {}, ledger = read()): ProjectLedger {
  return appendStep(ledger, step({
    id: 'hu', parent: 's1', action: 'translate', createdAt: 300,
    payload: `generated/${translationFileFor(STEM, 'hu')}`,
    params: { language: 'hu', bank: `readings/${translationBankFileFor(KEY, 'hu')}` },
    ...over,
  }));
}

/** What a plan asks about a translation of `parent` into `language`. */
function ask(parent: string | null, language = 'hu'): {
  parent: string | null; language: string; stem: string; key: string;
} {
  return { parent, language, stem: STEM, key: KEY };
}

// ═════════════════════════════════════════════════════════════════════════════

describe('what a translate step is allowed to carry, and what it is refused for', () => {
  test('the language it was asked for and the bank it wrote', () => {
    const ledger = parseLedger({
      steps: [
        { id: 's0', parent: null, action: 'import', payload: 'archive/Book.pdf', retention: 'irreplaceable', createdAt: 0, label: 'Imported' },
        {
          id: 'hu', parent: 's0', action: 'translate', payload: 'generated/Book (hu).epub',
          params: { language: 'hu', bank: 'readings/book-1a2b3c4d.hu.bank.jsonl' },
          retention: 'expensive', createdAt: 1, label: 'Translated (hu)',
        },
      ],
    });
    assert.equal(ledger.steps[1]!.params?.bank, 'readings/book-1a2b3c4d.hu.bank.jsonl');
  });

  test('the refusal names both fields, so the next one added has to be sorted', () => {
    const wrong = refusal(() => parseLedger({
      steps: [
        { id: 's0', parent: null, action: 'import', payload: 'archive/Book.pdf', retention: 'irreplaceable', createdAt: 0, label: 'Imported' },
        {
          id: 'hu', parent: 's0', action: 'translate', payload: 'generated/Book (hu).epub',
          params: { pages: 17 }, retention: 'expensive', createdAt: 1, label: 'Translated (hu)',
        },
      ],
    }));
    assert.match(wrong, /is a translate and carries a param called "pages"/);
    assert.match(wrong, /A translate is described by language and bank/);
  });

  test('a bank is a path and never a number', () => {
    assert.match(
      refusal(() => parseLedger({
        steps: [
          { id: 's0', parent: null, action: 'import', payload: 'archive/Book.pdf', retention: 'irreplaceable', createdAt: 0, label: 'Imported' },
          {
            id: 'hu', parent: 's0', action: 'translate', payload: 'generated/Book (hu).epub',
            params: { bank: 7 }, retention: 'expensive', createdAt: 1, label: 'Translated (hu)',
          },
        ],
      })),
      /says "bank": 7, and it is a string/,
    );
  });

  test('a reading carrying a translation bank is a step something wrote wrong', () => {
    const wrong = refusal(() => parseLedger({
      steps: [
        { id: 's0', parent: null, action: 'import', payload: 'archive/Book.pdf', retention: 'irreplaceable', createdAt: 0, label: 'Imported' },
        {
          id: 's1', parent: 's0', action: 'read', payload: 'readings/book.jsonl',
          params: { bank: 'readings/book.hu.bank.jsonl' }, retention: 'expensive', createdAt: 1, label: 'Read',
        },
      ],
    }));
    assert.match(wrong, /is a read and carries a param called "bank"/);
  });

  test('the instructions and the model are not facts a step keeps', () => {
    /*
     * THIS IS THE RULING OF §2, ASSERTED AS AN ABSENCE. A re-translation with
     * different instructions or a different model is the same person refining THIS
     * translation and replaces the row they are standing on — and what makes that
     * true is that neither field exists anywhere in a step, so no comparison can
     * ever see them. If somebody adds one, this refusal stops and they have to
     * decide which pile it goes in.
     */
    assert.match(
      refusal(() => parseLedger({
        steps: [
          { id: 's0', parent: null, action: 'import', payload: 'archive/Book.pdf', retention: 'irreplaceable', createdAt: 0, label: 'Imported' },
          {
            id: 'hu', parent: 's0', action: 'translate', payload: 'generated/Book (hu).epub',
            params: { language: 'hu', instructions: 'keep the footnotes' },
            retention: 'expensive', createdAt: 1, label: 'Translated (hu)',
          },
        ],
      })),
      /carries a param called "instructions"/,
    );
  });
});

describe('identity: the language, scoped to the step you were standing on', () => {
  test('the same language from the same step is the same question, and replaces', () => {
    const ledger = translated();
    const target = reRunTarget(ledger, { action: 'translate', parent: 's1', params: { language: 'hu' } });
    assert.equal(target?.id, 'hu');
  });

  test('a bank the run minted is never compared — that is the generation trap again', () => {
    // The step recorded `readings/<key>.hu.bank.jsonl`; this ask carries a branch's
    // bank. Comparing them would make every re-translation of a moved bank a new
    // question, which is the rule inverted in exactly the way `MINTED_BY_THE_RUN`
    // was named for.
    const target = reRunTarget(translated(), {
      action: 'translate',
      parent: 's1',
      params: { language: 'hu', bank: `readings/${translationBankFileFor(KEY, 'hu', 'aaaaaaaa')}` },
    });
    assert.equal(target?.id, 'hu');
  });

  test('the same language from a DIFFERENT step branches — the user’s own scenario', () => {
    // Strike some blocks, commit, translate the curation: same language, and it is
    // a translation of a different book than the one made from the reading.
    const ledger = appendStep(translated(), step({
      id: 'save', parent: 's1', action: 'curate', payload: 'curations/a.json', createdAt: 400,
      params: { generation: GENERATION, amendments: 12 },
    }));
    assert.equal(
      reRunTarget(ledger, { action: 'translate', parent: 'save', params: { language: 'hu' } }),
      null,
    );
  });

  test('a different language from the same step branches', () => {
    assert.equal(
      reRunTarget(translated(), { action: 'translate', parent: 's1', params: { language: 'en' } }),
      null,
    );
  });

  test('a blank language and none at all are one statement, not two questions', () => {
    assert.deepEqual(translatedInto('  hu  '), { language: 'hu' });
    assert.deepEqual(translatedInto('   '), {});
    assert.deepEqual(translatedInto(undefined), {});
  });
});

describe('a re-translation lands in the row it re-ran', () => {
  test('the step keeps its id, its place and its date, and takes the new answers', () => {
    const ledger = appendStep(translated(), step({
      id: 'save', parent: 'hu', action: 'curate', payload: 'curations/b.json', createdAt: 400,
      params: { generation: GENERATION, amendments: 3 },
    }));
    const landing = recordLanding(ledger, {
      action: 'translate',
      parent: 's1',
      payload: `generated/${translationFileFor(STEM, 'hu')}`,
      params: { language: 'hu', bank: `readings/${translationBankFileFor(KEY, 'hu')}` },
      createdAt: 900,
      id: MINTED,
    });
    assert.equal(landing.replaced, true);
    assert.equal(landing.step.id, 'hu');
    assert.equal(landing.step.createdAt, 300, 'a re-run swaps a payload; it does not move a row');
    assert.equal(landing.ledger.steps.length, 4, 'and it appends nothing');
    assert.equal(landing.step.params?.bank, `readings/${translationBankFileFor(KEY, 'hu')}`);
    // Nothing to unlink: the plan aimed the run at the step's own file.
    assert.equal(landing.displaced, null);
    // The save made FROM the translation was made from blocks that have moved.
    assert.deepEqual(landing.stale.map((one) => one.id), ['save']);
  });

  test('a bank that moved between the plan and the landing is displaced honestly', () => {
    // The one case the paths can drift: planned as a branch, landed as a replace.
    // The row keeps its place and takes the minted files; the ledger reports the
    // payload it left behind, and `recordGenerated` destroys the bank beside it.
    const landing = recordLanding(translated(), {
      action: 'translate',
      parent: 's1',
      payload: `generated/${translationFileFor(STEM, 'hu', 'aaaaaaaa')}`,
      params: { language: 'hu', bank: `readings/${translationBankFileFor(KEY, 'hu', 'aaaaaaaa')}` },
      createdAt: 900,
      id: MINTED,
    });
    assert.equal(landing.replaced, true);
    assert.equal(landing.displaced, `generated/${translationFileFor(STEM, 'hu')}`);
  });

  test('a translation from another step appends, and both survive', () => {
    const ledger = appendStep(translated(), step({
      id: 'save', parent: 's1', action: 'curate', payload: 'curations/a.json', createdAt: 400,
      params: { generation: GENERATION, amendments: 12 },
    }));
    const landing = recordLanding(ledger, {
      action: 'translate',
      parent: 'save',
      payload: `generated/${translationFileFor(STEM, 'hu', 'aaaaaaaa')}`,
      params: { language: 'hu', bank: `readings/${translationBankFileFor(KEY, 'hu', 'aaaaaaaa')}` },
      createdAt: 900,
      id: MINTED,
    });
    assert.equal(landing.replaced, false);
    assert.equal(landing.step.id, MINTED, 'the id the files were named after is the one spent');
    assert.deepEqual(landing.ledger.steps.map((one) => one.id), ['s0', 's1', 'hu', 'save', MINTED]);
    assert.equal(landing.step.label, 'Translated (hu)');
  });
});

describe('the files a translation writes, decided before the job is enqueued', () => {
  test('the first translation into a language keeps the plain names', () => {
    const target = translationTarget(read(), ask('s1'), MINTED);
    assert.equal(target.replaces, null);
    assert.equal(target.stepId, MINTED);
    assert.equal(target.output, 'generated/Book (hu).epub');
    assert.equal(target.bank, 'readings/book-1a2b3c4d.hu.bank.jsonl');
  });

  test('a re-translation aims at the step’s own files, which is what makes it cheap', () => {
    const target = translationTarget(translated(), ask('s1'), MINTED);
    assert.equal(target.replaces?.id, 'hu');
    assert.equal(target.stepId, 'hu', 'the minted id is not spent on a replace');
    assert.equal(target.output, 'generated/Book (hu).epub');
    assert.equal(target.bank, 'readings/book-1a2b3c4d.hu.bank.jsonl');
  });

  test('a re-translation of a step that predates recorded banks finds its bank anyway', () => {
    // Every translation made before `params.bank` existed wrote the one name
    // `planTranslation` could compose. Answering "no bank" for those would send the
    // run to an empty file and re-ask the model for every block of the book.
    const legacy = translated({ params: { language: 'hu' } });
    const target = translationTarget(legacy, ask('s1'), MINTED);
    assert.equal(target.replaces?.id, 'hu');
    assert.equal(target.bank, 'readings/book-1a2b3c4d.hu.bank.jsonl');
  });

  test('a branch mints both names from its own step id, before the extension', () => {
    const ledger = appendStep(translated(), step({
      id: 'save', parent: 's1', action: 'curate', payload: 'curations/a.json', createdAt: 400,
      params: { generation: GENERATION, amendments: 12 },
    }));
    const target = translationTarget(ledger, ask('save'), MINTED);
    assert.equal(target.replaces, null);
    assert.equal(target.stepId, MINTED);
    assert.equal(target.output, `generated/Book (hu).${id8(MINTED)}.epub`);
    assert.equal(target.bank, `readings/book-1a2b3c4d.hu.${id8(MINTED)}.bank.jsonl`);
    // IT STILL ENDS IN `.epub`: main admits a finished file by its extension, so a
    // suffix after it would be a book no tab could ever open.
    assert.ok(target.output.endsWith('.epub'));
  });

  test('a branch beside a translation that recorded no bank still branches both', () => {
    // The legacy step names the plain bank without saying so, and a branch that
    // wrote into it would put two rows’ answers in one file — harmless for cache
    // hits, and fatal the day either row is deleted.
    const ledger = appendStep(translated({ params: { language: 'hu' } }), step({
      id: 'save', parent: 's1', action: 'curate', payload: 'curations/a.json', createdAt: 400,
      params: { generation: GENERATION, amendments: 12 },
    }));
    const target = translationTarget(ledger, ask('save'), MINTED);
    assert.equal(target.output, `generated/Book (hu).${id8(MINTED)}.epub`);
    assert.equal(target.bank, `readings/book-1a2b3c4d.hu.${id8(MINTED)}.bank.jsonl`);
  });

  test('either name being taken branches both, so the pair always belongs to one row', () => {
    // A row holding the plain EPUB and a branch’s bank, and its mirror. Neither is
    // reachable by an ordinary sequence; both are reachable by a plan and a landing
    // disagreeing about the parent, and a run that took the free half of a pair
    // would file its answers under another row’s book.
    const output = translationTarget(
      translated({ params: { language: 'hu', bank: 'readings/book-1a2b3c4d.hu.99999999.bank.jsonl' } }),
      ask('s0'),
      MINTED,
    );
    assert.equal(output.output, `generated/Book (hu).${id8(MINTED)}.epub`);
    assert.equal(output.bank, `readings/book-1a2b3c4d.hu.${id8(MINTED)}.bank.jsonl`);

    const bank = translationTarget(
      translated({ payload: 'generated/Book (hu).99999999.epub' }),
      ask('s0'),
      MINTED,
    );
    assert.equal(bank.output, `generated/Book (hu).${id8(MINTED)}.epub`);
    assert.equal(bank.bank, `readings/book-1a2b3c4d.hu.${id8(MINTED)}.bank.jsonl`);
  });

  test('another language on the same book is a first translation, not a branch', () => {
    const target = translationTarget(translated(), ask('s1', 'en'), MINTED);
    assert.equal(target.output, 'generated/Book (en).epub');
    assert.equal(target.bank, 'readings/book-1a2b3c4d.en.bank.jsonl');
  });

  test('the language reaches two filenames, reduced the one way', () => {
    assert.equal(languageTagFor('pt-BR'), 'pt-BR');
    assert.equal(languageTagFor('  hu  '), 'hu');
    // A file called `Book ().epub` is a file nobody can tell from a mistake.
    assert.equal(languageTagFor('  '), 'translated');
    assert.equal(translationFileFor('Kershaw, Ian. (1993)', 'en'), 'Kershaw, Ian. (1993) (en).epub');
    assert.equal(translationBankFileFor(KEY, 'pt-BR', 'deadbeef'), 'book-1a2b3c4d.pt-BR.deadbeef.bank.jsonl');
  });

  test('the id8 is the front of the uuid, hyphens and all', () => {
    assert.equal(id8(MINTED), 'aaaaaaaa');
    assert.equal(id8('aaaaaaaabbbb4ccc8dddeeeeeeeeeeee'), 'aaaaaaaa');
  });
});

describe('which bank a step MEANS, which is the whole of the guard', () => {
  test('what it recorded, when it recorded one', () => {
    const recorded = step({
      id: 'hu', parent: 's1', action: 'translate', payload: 'generated/Book (hu).epub',
      params: { language: 'hu', bank: 'readings/book-1a2b3c4d.hu.aaaaaaaa.bank.jsonl' },
    });
    assert.equal(translationBankOf(recorded, KEY), 'readings/book-1a2b3c4d.hu.aaaaaaaa.bank.jsonl');
  });

  test('the path its language composes, when it landed before banks were recorded', () => {
    const legacy = step({
      id: 'hu', parent: 's1', action: 'translate', payload: 'generated/Book (hu).epub',
      params: { language: 'hu' },
    });
    assert.equal(translationBankOf(legacy, KEY), 'readings/book-1a2b3c4d.hu.bank.jsonl');
  });

  test('nothing at all for a migrated step, because its language is only in a filename', () => {
    // `migrateLedger` deliberately records no language: it survives only inside
    // `… (en).epub`, and reading a fact out of a filename is what this codebase’s
    // oldest house rule forbids. So there is no tag to compose with, and the honest
    // answer leaves the file alone rather than guessing which one to destroy.
    const migrated = step({
      id: 'm2', parent: 'm1', action: 'translate', payload: 'generated/Kershaw (en).epub',
      label: 'Translated',
    });
    assert.equal(translationBankOf(migrated, KEY), null);
    assert.equal(translationBankOf(step({ id: 's1', parent: 's0', action: 'read' }), KEY), null);
  });
});

describe('deleting a translation takes the answers it was assembled from', () => {
  test('the bank beside the EPUB, which no payload in the project names', () => {
    const deletion = deleteSubtree(translated(), 'hu');
    assert.deepEqual(orphanedBanks(deletion, KEY), ['readings/book-1a2b3c4d.hu.bank.jsonl']);
    assert.deepEqual(destroyedBy(deletion, KEY), [
      'generated/Book (hu).epub',
      'readings/book-1a2b3c4d.hu.bank.jsonl',
    ]);
  });

  test('a translation that recorded no bank still takes the one its language composes', () => {
    const deletion = deleteSubtree(translated({ params: { language: 'hu' } }), 'hu');
    assert.deepEqual(orphanedBanks(deletion, KEY), ['readings/book-1a2b3c4d.hu.bank.jsonl']);
  });

  test('a migrated translation takes nothing but its own EPUB', () => {
    const ledger = translated({ params: undefined, label: 'Translated' });
    const deletion = deleteSubtree(ledger, 'hu');
    assert.deepEqual(orphanedBanks(deletion, KEY), []);
    assert.deepEqual(destroyedBy(deletion, KEY), ['generated/Book (hu).epub']);
  });

  test('a bank a surviving row still means is never destroyed', () => {
    /*
     * TWO ROWS, ONE BANK, and it is a state real projects are in: every translation
     * made before `params.bank` existed composed one name per book per language, so
     * a pre-strikes and a post-strikes Hungarian both mean
     * `readings/<key>.hu.bank.jsonl`. Deleting either one used to be able to take
     * the answers the other is made of.
     */
    let ledger = translated({ params: { language: 'hu' } });
    ledger = appendStep(ledger, step({
      id: 'save', parent: 's1', action: 'curate', payload: 'curations/a.json', createdAt: 400,
      params: { generation: GENERATION, amendments: 12 },
    }));
    ledger = appendStep(ledger, step({
      id: 'hu2', parent: 'save', action: 'translate', payload: 'generated/Book (hu).2.epub',
      params: { language: 'hu' }, createdAt: 500,
    }));
    const deletion = deleteSubtree(ledger, 'hu');
    assert.deepEqual(orphanedBanks(deletion, KEY), []);
    assert.deepEqual(destroyedBy(deletion, KEY), ['generated/Book (hu).epub']);
  });

  test('two branches with banks of their own lose exactly one of them', () => {
    // Which is the whole reason a branch mints its own: sharing would be harmless
    // for cache hits and would make the case above the normal one.
    let ledger = translated();
    ledger = appendStep(ledger, step({
      id: 'save', parent: 's1', action: 'curate', payload: 'curations/a.json', createdAt: 400,
      params: { generation: GENERATION, amendments: 12 },
    }));
    ledger = appendStep(ledger, step({
      id: 'hu2', parent: 'save', action: 'translate', payload: 'generated/Book (hu).aaaaaaaa.epub',
      params: { language: 'hu', bank: 'readings/book-1a2b3c4d.hu.aaaaaaaa.bank.jsonl' }, createdAt: 500,
    }));
    assert.deepEqual(
      orphanedBanks(deleteSubtree(ledger, 'hu2'), KEY),
      ['readings/book-1a2b3c4d.hu.aaaaaaaa.bank.jsonl'],
    );
    assert.deepEqual(
      orphanedBanks(deleteSubtree(ledger, 'hu'), KEY),
      ['readings/book-1a2b3c4d.hu.bank.jsonl'],
    );
  });

  test('the whole subtree’s banks go, because the whole subtree goes', () => {
    let ledger = translated();
    ledger = appendStep(ledger, step({
      id: 'en', parent: 's1', action: 'translate', payload: 'generated/Book (en).epub',
      params: { language: 'en', bank: 'readings/book-1a2b3c4d.en.bank.jsonl' }, createdAt: 500,
    }));
    // Delete the reading: the bank it IS goes, and so do both translations' banks.
    assert.deepEqual(orphanedBanks(deleteSubtree(ledger, 's1'), KEY), [
      `readings/${KEY}.jsonl`,
      'readings/book-1a2b3c4d.hu.bank.jsonl',
      'readings/book-1a2b3c4d.en.bank.jsonl',
    ]);
  });

  test('a reading’s bank is named as a bank, and named once', () => {
    // It is its step’s payload, so `orphanedPayloads` already had it — this says it
    // is a BANK, which is what sends the engine’s pending debris after it, and the
    // union must not list it twice or the second unlink is a reported failure.
    const deletion = deleteSubtree(read(), 's1');
    assert.deepEqual(orphanedBanks(deletion, KEY), [`readings/${KEY}.jsonl`]);
    assert.deepEqual(destroyedBy(deletion, KEY), [`readings/${KEY}.jsonl`]);
  });

  test('a reading’s bank another reading still names survives, as it always did', () => {
    // Two read steps naming one bank: the branch `MINTED_BY_THE_RUN` made
    // deliberate. `orphanedPayloads` guards the payload and this guards the same
    // file in its other character.
    const ledger = appendStep(read(), step({
      id: 's2', parent: 's0', action: 'read', payload: `readings/${KEY}.jsonl`, createdAt: 300,
      params: { generation: 'other', pages: 9, skipPages: '3' },
    }));
    assert.deepEqual(orphanedBanks(deleteSubtree(ledger, 's2'), KEY), []);
  });

  test('the pending pair beside a translation bank is named the engine’s way', () => {
    // `<bank>.pending` is what `src/translate/bank.ts` writes under `--fresh-bank`;
    // the request sidecar is a readings-bank thing and simply will not exist, which
    // the sweep’s existence test already handles.
    assert.deepEqual(pendingBeside('readings/book-1a2b3c4d.hu.bank.jsonl'), [
      'readings/book-1a2b3c4d.hu.bank.jsonl.pending',
      'readings/book-1a2b3c4d.hu.bank.jsonl.pending.request',
    ]);
  });
});
