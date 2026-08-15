/**
 * Generate, standing anywhere — the ancestry read as a pipeline.
 *
 * WHAT THESE TESTS ARE PROTECTING, in the order the damage would be felt:
 *
 *   THE FIRST THREE ROWS OF THE TABLE DID NOT MOVE. Every project that has never
 *   been translated presses the same button and gets the same single run of
 *   `vlm-convert` with the same overlay and the same bank. A regression here is
 *   this phase's blast radius reaching books it was never about, and the way it
 *   would present is a Generate spawning a translation of a German book into
 *   nothing.
 *
 *   A RE-RENDER OF A TRANSLATION LANDS IN THAT TRANSLATION'S OWN ROW. It is filed
 *   against the row's PARENT, which is the one place in this app where the
 *   landing's parent is not the position — and getting it wrong appends a
 *   translation whose parent is a translation, so the row the user asked to
 *   refresh is untouched and a second one appears beside it for a job they
 *   thought was a re-run.
 *
 *   A CURATION MADE UNDER A TRANSLATION IS A DIFFERENT BOOK. Its strikes are
 *   applied before the translate stage sees a word, so its EPUB is not what the
 *   translation's payload holds; writing it there would leave that row describing
 *   a book with paragraphs missing that nothing in the ledger admits to removing.
 *   It branches — and the SECOND generate from that same save replaces the first,
 *   because the user's walkthrough says re-rendering does not accumulate rows.
 *
 *   THE CHAIN IS REFUSED BY NAME. A translation of a translation is a thing the
 *   ledger records honestly and this pass does not run, and a bound stated as a
 *   sentence is a bound somebody can act on. Silence there would be a Generate
 *   that quietly rendered the wrong language.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RETENTION_OF,
  StepLedgerError,
  appendStep,
  curationInEffect,
  emptyLedger,
  id8,
  labelFor,
  originStep,
  readingInEffect,
  recordLanding,
  translationBankFileFor,
  translationFileFor,
  translationInEffect,
  translationTarget,
} from '../../app/shared/ledger.ts';
import {
  DEFAULT_OLLAMA_ENDPOINT,
  DEFAULT_TRANSLATE_MODEL,
  renderPipeline,
  translationStage,
} from '../../app/shared/pipeline.ts';
import type { LedgerStep, ProjectLedger } from '../../app/shared/types.ts';

const GENERATION = 'edbd9f11-6a4c-4c02-9d0e-2f4b7a1c8e30';
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

/** Wherever the user is standing. The pointer is what every answer here is about. */
function at(ledger: ProjectLedger, position: string): ProjectLedger {
  return { ...ledger, position };
}

/**
 * The project every test in this file works from:
 *
 *   s0 import → s1 read → s2 curate (a save under the reading)
 *                       → hu translate (of the reading)
 *                          → save2 curate (strikes made under the translation)
 */
function project(): ProjectLedger {
  let ledger = appendStep(emptyLedger(), originStep('s0', 'archive/Book.pdf', 100, 'Imported'));
  ledger = appendStep(ledger, step({
    id: 's1', parent: 's0', action: 'read', payload: `readings/${KEY}.jsonl`, createdAt: 200,
    params: { generation: GENERATION, pages: 17, completedAt: 900 },
  }));
  ledger = appendStep(ledger, step({
    id: 's2', parent: 's1', action: 'curate', payload: 'curations/first.json', createdAt: 300,
    params: { generation: GENERATION, amendments: 12 },
  }));
  ledger = appendStep(ledger, step({
    id: 'hu', parent: 's1', action: 'translate', createdAt: 400,
    payload: `generated/${translationFileFor(STEM, 'hu')}`,
    params: { language: 'hu', bank: `readings/${translationBankFileFor(KEY, 'hu')}` },
  }));
  return appendStep(ledger, step({
    id: 'save2', parent: 'hu', action: 'curate', payload: 'curations/second.json', createdAt: 500,
    params: { generation: GENERATION, amendments: 3 },
  }));
}

// ═════════════════════════════════════════════════════════════════════════════

describe('the table, which is the contract', () => {
  test('standing on the import is one run, with nothing above it to find', () => {
    const pipeline = renderPipeline(at(project(), 's0'));
    assert.equal(pipeline.translate, null);
    assert.equal(pipeline.landsUnder, null);
    assert.equal(pipeline.curation, null);
    // The revert row is about the untouched original and about no bank at all.
    assert.equal(pipeline.reading, null);
  });

  test('standing on the reading is one run with the live overlay — unchanged', () => {
    const pipeline = renderPipeline(at(project(), 's1'));
    assert.equal(pipeline.translate, null);
    // Null is the live overlay, which is what a caller composes when it gets one.
    assert.equal(pipeline.curation, null);
    assert.equal(pipeline.reading?.id, 's1');
  });

  test('standing on a save under the reading is one run with that snapshot — unchanged', () => {
    const pipeline = renderPipeline(at(project(), 's2'));
    assert.equal(pipeline.translate, null);
    assert.equal(pipeline.curation?.id, 's2');
  });

  test('standing on the translation is two runs: the ancestor curation, then translate', () => {
    const pipeline = renderPipeline(at(project(), 'hu'));
    assert.equal(pipeline.translate?.id, 'hu');
    // The save hanging off the reading is a SIBLING of the translation, not an
    // ancestor, so it is correctly not found — this renders the book the
    // translation was actually taken of.
    assert.equal(pipeline.curation, null);
    assert.equal(pipeline.reading?.id, 's1');
  });

  test('standing on a save made under the translation renders THAT snapshot, then translates', () => {
    const pipeline = renderPipeline(at(project(), 'save2'));
    assert.equal(pipeline.translate?.id, 'hu');
    assert.equal(pipeline.curation?.id, 'save2');
    assert.equal(pipeline.reading?.id, 's1');
  });

  test('the two halves are the walks the ledger already made, and not a second opinion', () => {
    for (const position of ['s0', 's1', 's2', 'hu', 'save2']) {
      const ledger = at(project(), position);
      const pipeline = renderPipeline(ledger);
      assert.equal(pipeline.curation, curationInEffect(ledger), position);
      assert.equal(pipeline.reading, readingInEffect(ledger), position);
      assert.equal(pipeline.translate, translationInEffect(ledger), position);
    }
  });

  test('a project with no history at all is one run and no refusal', () => {
    const pipeline = renderPipeline(emptyLedger());
    assert.deepEqual(pipeline, { curation: null, reading: null, translate: null, landsUnder: null });
  });
});

describe('which row the product is filed under', () => {
  test('standing ON the translation files against the translation’s own parent', () => {
    // The one place in this app where the landing's parent is not the position.
    // Filing it at the position would make a translation whose parent is a
    // translation: a second row beside the one the user asked to refresh.
    assert.equal(renderPipeline(at(project(), 'hu')).landsUnder, 's1');
  });

  test('standing on a save under it files against the save', () => {
    assert.equal(renderPipeline(at(project(), 'save2')).landsUnder, 'save2');
  });
});

describe('one hop, stated rather than discovered', () => {
  /** Hungarian, then English out of the Hungarian — which the ledger allows. */
  function chained(): ProjectLedger {
    return appendStep(project(), step({
      id: 'en', parent: 'hu', action: 'translate', createdAt: 600,
      payload: `generated/${translationFileFor(STEM, 'en')}`,
      params: { language: 'en', bank: `readings/${translationBankFileFor(KEY, 'en')}` },
    }));
  }

  test('a translation of a translation is refused by name, with the way out in it', () => {
    const said = refusal(() => renderPipeline(at(chained(), 'en')));
    assert.match(said, /“Translated \(en\)” was made from “Translated \(hu\)”/);
    assert.match(said, /one translation deep/);
    assert.match(said, /Stand on “Translated \(hu\)”/);
  });

  test('and so is a save made under one, because it is the same pipeline', () => {
    const ledger = appendStep(chained(), step({
      id: 'save3', parent: 'en', action: 'curate', payload: 'curations/third.json', createdAt: 700,
      params: { generation: GENERATION, amendments: 1 },
    }));
    assert.match(refusal(() => renderPipeline(at(ledger, 'save3'))), /one translation deep/);
  });

  test('the first translation in the chain still renders perfectly well', () => {
    // Which is what the refusal tells them to do, so it had better be true.
    const pipeline = renderPipeline(at(chained(), 'hu'));
    assert.equal(pipeline.translate?.id, 'hu');
    assert.equal(pipeline.landsUnder, 's1');
  });

  test('a translation made from a SAVE is one hop, wherever the save hangs', () => {
    /*
     * THE SHAPE THE WALKTHROUGH ITSELF PRODUCES, and the reason the bound is
     * tested against the parent rather than against the whole ancestry. Strike,
     * commit — the save hangs under the translation — Generate: the row that
     * lands has two translate steps above it on the chain and is nevertheless one
     * vlm run and one translate run, because the save it was made from is
     * corrections to the SCAN's blocks and re-bases the render on the pages.
     */
    const ledger = appendStep(project(), step({
      id: 'hu2', parent: 'save2', action: 'translate', createdAt: 600,
      payload: `generated/${translationFileFor(STEM, 'hu', 'aaaaaaaa')}`,
      params: { language: 'hu', bank: `readings/${translationBankFileFor(KEY, 'hu', 'aaaaaaaa')}` },
    }));
    const pipeline = renderPipeline(at(ledger, 'hu2'));
    assert.equal(pipeline.translate?.id, 'hu2');
    assert.equal(pipeline.curation?.id, 'save2', 'the strikes that made it a different book');
    assert.equal(pipeline.reading?.id, 's1', 'and the scan’s own bank underneath');
    assert.equal(pipeline.landsUnder, 'save2');
  });

  test('a SIBLING translation is not a chain — two languages off one reading are fine', () => {
    const ledger = appendStep(project(), step({
      id: 'en', parent: 's1', action: 'translate', createdAt: 600,
      payload: `generated/${translationFileFor(STEM, 'en')}`,
      params: { language: 'en', bank: `readings/${translationBankFileFor(KEY, 'en')}` },
    }));
    assert.equal(renderPipeline(at(ledger, 'en')).translate?.id, 'en');
    assert.equal(renderPipeline(at(ledger, 'hu')).translate?.id, 'hu');
  });
});

describe('the landing, which is the pipeline’s answer handed to translationTarget', () => {
  /** What the plan asks, with the parent the pipeline settled. */
  function ask(ledger: ProjectLedger): { parent: string | null; language: string; stem: string; key: string } {
    const pipeline = renderPipeline(ledger);
    assert.ok(pipeline.translate !== null, 'this fixture is supposed to have a translate stage');
    return {
      parent: pipeline.landsUnder,
      language: pipeline.translate.params?.language ?? '',
      stem: STEM,
      key: KEY,
    };
  }

  test('re-rendering the translation aims at its own EPUB and its own bank', () => {
    // Which is what makes it nearly free: every block whose masked source has not
    // changed is a cache hit and is never asked of the model again.
    const ledger = at(project(), 'hu');
    const target = translationTarget(ledger, ask(ledger), MINTED);
    assert.equal(target.replaces?.id, 'hu');
    assert.equal(target.stepId, 'hu', 'the minted id is not spent on a replace');
    assert.equal(target.output, `generated/${translationFileFor(STEM, 'hu')}`);
    assert.equal(target.bank, `readings/${translationBankFileFor(KEY, 'hu')}`);
  });

  test('and the landing swaps into that row rather than appending beside it', () => {
    const ledger = at(project(), 'hu');
    const target = translationTarget(ledger, ask(ledger), MINTED);
    const landing = recordLanding(ledger, {
      action: 'translate',
      parent: renderPipeline(ledger).landsUnder!,
      payload: target.output,
      params: { language: 'hu', bank: target.bank },
      createdAt: 1000,
      id: MINTED,
    });
    assert.equal(landing.replaced, true);
    assert.equal(landing.step.id, 'hu');
    assert.equal(landing.ledger.steps.length, 5, 'a re-render appends nothing');
    // The save made UNDER the translation was made from blocks this run remade.
    assert.deepEqual(landing.stale.map((one) => one.id), ['save2']);
  });

  test('a translation of a step that predates recorded banks still finds its bank', () => {
    // Reused rather than respelled: `translationBankOf`'s legacy fallback is the
    // one place that knows what a translation made before `params.bank` wrote.
    let ledger = appendStep(emptyLedger(), originStep('s0', 'archive/Book.pdf', 100));
    ledger = appendStep(ledger, step({
      id: 's1', parent: 's0', action: 'read', payload: `readings/${KEY}.jsonl`, createdAt: 200,
      params: { generation: GENERATION, pages: 17 },
    }));
    ledger = appendStep(ledger, step({
      id: 'hu', parent: 's1', action: 'translate', createdAt: 400,
      payload: `generated/${translationFileFor(STEM, 'hu')}`,
      params: { language: 'hu' },
    }));
    const target = translationTarget(at(ledger, 'hu'), ask(at(ledger, 'hu')), MINTED);
    assert.equal(target.bank, `readings/${translationBankFileFor(KEY, 'hu')}`);
  });

  test('a save under the translation branches: its own EPUB, its own bank, its own row', () => {
    const ledger = at(project(), 'save2');
    const target = translationTarget(ledger, ask(ledger), MINTED);
    assert.equal(target.replaces, null);
    assert.equal(target.output, `generated/${translationFileFor(STEM, 'hu', id8(MINTED))}`);
    assert.equal(target.bank, `readings/${translationBankFileFor(KEY, 'hu', id8(MINTED))}`);

    const landing = recordLanding(ledger, {
      action: 'translate',
      parent: 'save2',
      payload: target.output,
      params: { language: 'hu', bank: target.bank },
      createdAt: 1000,
      id: MINTED,
    });
    assert.equal(landing.replaced, false);
    assert.equal(landing.step.parent, 'save2');
    // THE TRANSLATION'S OWN ROW IS UNTOUCHED, which is the whole point: the
    // stricken book is a different book and saying otherwise would make that row
    // describe contents it does not have.
    assert.equal(landing.ledger.steps.find((one) => one.id === 'hu')?.payload,
      `generated/${translationFileFor(STEM, 'hu')}`);
  });

  test('and doing it twice replaces rather than accumulating rows', () => {
    // The user's own walkthrough: click that entry, Generate, look at it, Generate
    // again. Two rows for two presses of one button would be the history panel
    // filling up with the same book.
    const first = renderPipeline(at(project(), 'save2'));
    const landed = recordLanding(at(project(), 'save2'), {
      action: 'translate',
      parent: first.landsUnder!,
      payload: `generated/${translationFileFor(STEM, 'hu', id8(MINTED))}`,
      params: { language: 'hu', bank: `readings/${translationBankFileFor(KEY, 'hu', id8(MINTED))}` },
      createdAt: 1000,
      id: MINTED,
    }).ledger;

    // The landing moved the pointer onto what it made, so the second press is
    // made from THERE — and files against that row's parent, which is the save.
    assert.equal(landed.position, MINTED);
    const again = renderPipeline(landed);
    assert.equal(again.translate?.id, MINTED, 'the newest translation is the one in effect now');
    assert.equal(again.landsUnder, 'save2');
    const target = translationTarget(landed, {
      parent: again.landsUnder, language: 'hu', stem: STEM, key: KEY,
    }, 'ffffffff-1111-4222-8333-444444444444');
    assert.equal(target.replaces?.id, MINTED);
    assert.equal(target.output, `generated/${translationFileFor(STEM, 'hu', id8(MINTED))}`);

    // And clicking back to the save and pressing Generate is the same answer, so
    // the two routes to "do that again" cannot come apart.
    const fromTheSave = renderPipeline(at(landed, 'save2'));
    assert.equal(fromTheSave.landsUnder, 'save2');
    assert.equal(
      translationTarget(at(landed, 'save2'), {
        parent: 'save2', language: 'hu', stem: STEM, key: KEY,
      }, MINTED).replaces?.id,
      MINTED,
    );
  });
});

describe('the second stage, composed as the request it is', () => {
  test('every flag the translate command line needs, and no more', () => {
    const stage = translationStage(
      { to: 'hu', bank: '/p/readings/book.hu.bank.jsonl', model: 'qwen3:32b', ollama: 'http://x', parent: 's1' },
      '/tmp/foundry/job.epub',
      '/p/generated/Book (hu).epub',
    );
    assert.deepEqual(stage, {
      kind: 'translate',
      inputPath: '/tmp/foundry/job.epub',
      outputPath: '/p/generated/Book (hu).epub',
      to: 'hu',
      model: 'qwen3:32b',
      ollama: 'http://x',
      bankPath: '/p/readings/book.hu.bank.jsonl',
    });
  });

  test('blank instructions are absent, because the engine refuses an empty one', () => {
    const then = {
      to: 'hu', bank: 'b', model: 'm', ollama: 'o', parent: null, instructions: '   ',
    };
    assert.equal('instructions' in translationStage(then, 'in.epub', 'out.epub'), false);
    assert.equal(
      translationStage({ ...then, instructions: 'keep the footnotes' }, 'in.epub', 'out.epub').instructions,
      'keep the footnotes',
    );
  });

  test('the defaults are the engine’s own, in the one place both askers read them', () => {
    // Two copies of a model id is two answers the day somebody bumps one, and the
    // failure is a re-render asking a different model than the translation was
    // made with — the same bank, filled in a second voice.
    assert.equal(DEFAULT_TRANSLATE_MODEL, 'qwen3:32b');
    assert.equal(DEFAULT_OLLAMA_ENDPOINT, 'http://localhost:11434');
  });
});
