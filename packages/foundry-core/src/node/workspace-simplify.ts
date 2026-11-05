/**
 * workspace-simplify — which file a simplification is, and making it.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { materializeBook } from './book';
import { ProjectError, importDocument, ledgerOf, readManifest, pendingRecordsForTextPass, recordsForTextPass } from './projects';
import { positionOf, translationInEffect } from '../shared/ledger';
// A TYPE ONLY, deliberately: shared/pending.ts derives promises from QUEUE ROWS,
// and this module must not learn about a queue. What it is handed is the answer
// (`Deferral`), composed at the door by the side that holds both lists.
import type { Deferral } from '../shared/pending';
import type { LedgerStep, ProjectLedger, RewriteMode, TranslationPlan } from '../shared/types';
import { declaredLanguageOf, newestRecordsInto, readingGenerationOf, seedRecordsPath } from './workspace-records';

/**
 * Where this book's SIMPLIFICATION goes — which is `planTranslation`'s answer to
 * `planTranslation`'s question, asked about the book's own language.
 *
 * ── What a rewrite is, and why it borrows all of this ───────────────────────
 *
 * "Say this book again, in the language it is already in, this way." The run is
 * the translate pipeline with one word changed on the command line: the same
 * materialised book, the same records file that is its own cache, the same seed,
 * the same landing, the same derived book afterwards. So this composes the same
 * plan, and everything downstream of it — the queue, the step, the cast, the
 * sweep — never learns that a rewrite exists.
 *
 * ── AND THERE IS NO SAME-LANGUAGE REFUSAL, WHICH IS THE WHOLE DIFFERENCE ────
 *
 * `planTranslation` refuses a target that is the position's own language, because
 * asking a model to render an English book in English is hours spent to say the
 * same thing and a row that means nothing. That is exactly what this run asks
 * for, and it is not the same thing coming back: the words change, the reader
 * changes, and the point of the exercise is that the language does not. The
 * refusal is not relaxed here so much as inapplicable — it was never about the
 * languages matching, it was about a run with no work in it.
 *
 * ── WHICH LANGUAGE, WHICH IS THE ONE QUESTION THIS HAS TO ANSWER ────────────
 *
 * The rewrite happens IN a language and the engine is told which, so the plan has
 * to name it, and there are two places it can honestly come from — in this order:
 *
 *   THE TRANSLATION IN EFFECT, when the person is standing under one. The words
 *   at that position are that row's, and the row recorded what language it made
 *   them in. Nothing else can know it: the derived book's header carries the
 *   READ's declared language, because a derived book is materialised from the
 *   source book's header and its rows are the only thing the records replaced.
 *
 *   THE BOOK'S OWN HEADER otherwise — `--language` as it was declared to the
 *   reading, which is the app's one recorded answer to "what language is this
 *   book in" and is declared, never detected (shared/book.ts).
 *
 * AND IF NEITHER SAYS ANYTHING, THIS REFUSES IN WORDS. A book that never declared
 * its language cannot say what to rewrite it in, and the honest answer is a
 * sentence naming the gap rather than a guess that spends six hours proving
 * itself wrong. It is close to unreachable — `parseBookFile` refuses a header
 * with no language in it — and it is written out because "close to" is where the
 * expensive failures live.
 */
export async function identifySimplification(
  inputPath: string,
  mode: RewriteMode,
  /** The row this pass is made from. `planTranslation`'s own argument, verbatim. */
  at: LedgerStep | null = null,
  /**
   * THE ROW THIS REWRITE IS MADE FROM HAS NOT LANDED — and this is the one plan of
   * the three that cannot always NAME its own file. See the branch below.
   */
  deferral?: Deferral,
  /** The id a press already promised. `planTranslation`'s argument, verbatim. */
  minted?: string,
): Promise<TranslationPlan> {
  const { dir, key } = await importDocument(inputPath, 'epub');
  const manifest = await readManifest(dir);
  const ledger = ledgerOf(manifest);

  /*
   * ── THE DEFERRED REWRITE, AND THE ONE SHAPE OF IT THAT CANNOT NAME ITS FILE ─
   *
   * A rewrite happens IN a language and the file it writes is NAMED after that
   * language. Under a promised CLEANUP that is no obstacle at all — a cleanup says
   * the same book again with narratable punctuation and the words stay in the
   * language they were in — so the ordinary case, which is Owen's own chain, is
   * planned exactly as a rewrite under its landed ancestor and names its file now.
   *
   * A PROMISED TRANSLATION OR REWRITE DOES change it, and records the answer in
   * `params.language` — which a promise does not carry (`pendingStepOf` argues why:
   * the row's title is a SENTENCE and this codebase does not read facts back out of
   * sentences).
   *
   * ── AND THAT USED TO BE A REFUSAL, WHICH OWEN OVERRULED ────────────────────
   *
   * Owen, 2026-09-07: *"I'd like to make it possible to chain anything and have it
   * pick up required settings from the last step after it finishes. So I should be
   * able to chain translate -> simplify -> tts -> assembly. Everything should come
   * together logically and work."* Wave 56 threw here by name — *wait for the row
   * above to land and press Simplify again* — which is a correct sentence about a
   * feature whose whole purpose is not having to wait.
   *
   * WHAT WAS ACTUALLY IMPOSSIBLE WAS THE FILENAME AND NOTHING ELSE. The step id is
   * mintable now (it is a uuid), the parent is in hand, the mode was chosen, the
   * seed and the book were always going to be composed at spawn. So the plan admits
   * the one thing it cannot say, wears a placeholder keyed to its own minted id
   * (`pendingRecordsForTextPass`), and `materializeAtSpawn` asks `materializeSimplification`
   * AGAIN at spawn with the landed row and that same id — where the language is a
   * fact and the name composes itself.
   *
   * `from` IS ABSENT WITH IT, and it has to be: the dialog reads that field for the
   * request's `to` (see the landed return below), and both ends of a rewrite are the
   * one language this branch could not resolve. `SimplifyRequest.to` is optional for
   * exactly this window, and the spawn fills both ends from the re-plan.
   *
   * THE LANGUAGE IS READ AT THE LANDED ANCESTOR when the chain declares none, and
   * the book made to read it is thrown away. That is a real cost — one materialise
   * for one header field — and it is the cheapest honest answer: `declaredLanguageOf`
   * reads a book file, the only book file that can be made on this chain is the
   * landed row's, and inventing a way to read a header without assembling the book
   * would be a second implementation of the materialise.
   */
  if (deferral !== undefined) {
    const moved = deferral.through.find((action) => action === 'translate' || action === 'simplify');
    if (moved !== undefined) {
      const promised = await pendingRecordsForTextPass(dir, 'simplify', mode);
      await fsp.mkdir(path.join(dir, 'readings'), { recursive: true });
      return {
        key,
        sourcePath: inputPath,
        recordsPath: promised.recordsPath,
        stepId: promised.stepId,
        deferred: { from: deferral.from, namesAtSpawn: true },
      };
    }
    const language = await rewriteLanguage(dir, ledger, deferral.landed);
    const promised = await recordsForTextPass(dir, 'simplify', language, mode, deferral.from);
    await fsp.mkdir(path.join(dir, 'readings'), { recursive: true });
    return {
      key,
      sourcePath: inputPath,
      recordsPath: promised.recordsPath,
      stepId: promised.stepId,
      // BOTH ENDS ARE THE SAME LANGUAGE and the dialog reads this field for the
      // request's `to` — see the landed return below, where the same sentence is
      // argued in full. It is deterministic, so it survives the deferral.
      from: language,
      deferred: { from: deferral.from },
    };
  }

  /*
   * THE BOOK COMES FIRST HERE, where a translation names its file first, and the
   * order is not arbitrary: the book is where the language comes from when the
   * position is not under a translation, and the language is what the file is
   * named after. `planTranslation` is handed its language by the person, so it
   * can name the file before it has read anything.
   *
   * Everything else about it is that plan's, verbatim: the position's own book
   * file with every op on the way to it replayed in, materialised AT PLAN TIME so
   * a pointer moved while the job waits cannot change which book was meant, into
   * the OS temp directory and swept by the hand that settles the job.
   */
  const language = await rewriteLanguage(dir, ledger, at);
  const planned = await recordsForTextPass(
    dir, 'simplify', language, mode, at === null ? undefined : at.id, minted,
  );
  await fsp.mkdir(path.join(dir, 'readings'), { recursive: true });
  return {
    key,
    sourcePath: inputPath,
    recordsPath: planned.recordsPath,
    stepId: planned.stepId,
    at: at?.id ?? positionOf(ledger)?.id ?? null,
    /*
     * BOTH ENDS ARE THE SAME LANGUAGE AND BOTH ARE SAID. `from` is what the words
     * in that book file are in and `to` is what they are to come back as, and for
     * a rewrite those are one fact — the dialog reads this field for the request's
     * `to`, so the two cannot be composed apart. Telling the model what it is
     * holding is worth a flag even when it can see it: the alternative is inviting
     * a guess about a fact the ledger recorded.
     */
    from: language,
  };
}

/**
 * THE SAME REWRITE, AT THE SPAWN — `materializeTranslation`'s half, one act over.
 *
 * Everything that function's header argues applies here unchanged: the book, the
 * seed and the generation are files or facts about files, and each has a lifetime
 * shorter than the row that names it. What is different is the seed's RULE, and
 * it is the difference between a rewrite and a chain.
 */
export async function materializeSimplification(
  inputPath: string,
  mode: RewriteMode,
  at: LedgerStep | null,
  minted?: string,
): Promise<TranslationPlan> {
  const { dir, key } = await importDocument(inputPath, 'epub');
  const manifest = await readManifest(dir);
  const ledger = ledgerOf(manifest);
  const language = await rewriteLanguage(dir, ledger, at);
  const planned = await recordsForTextPass(
    dir, 'simplify', language, mode, at === null ? undefined : at.id, minted,
  );
  /*
   * ── THE SEED, WHICH A REWRITE SPENDS WHERE A CHAIN WOULD NOT ───────────────
   *
   * `materializeTranslation` refuses to seed a CHAIN: its questions are asked of
   * the parent's words, so a sibling's answers about the book's own words are
   * keyed to questions that run will never ask. A rewrite is never a chain in
   * that sense. It reads the book at the row and asks about the paragraphs in
   * front of it, exactly as a first translation does, so a sibling rewrite of the
   * same language in the same mode holds true answers about the same paragraphs
   * and is worth every block it saves.
   *
   * SAME LANGUAGE AND SAME MODE, and the mode is the half that is easy to lose.
   * See `newestRecordsInto`: the keys hash the source paragraph and not the
   * prompt, so a plain-terms file seeded into an easy-language run would answer
   * the whole book with somebody else's rewrite and never ask.
   */
  const seed = seedRecordsPath(
    dir, newestRecordsInto(ledger, language, planned.records, mode), 'rewrite',
  );
  const generation = readingGenerationOf(ledger, manifest);
  await fsp.mkdir(path.join(dir, 'readings'), { recursive: true });
  const derived = await materializeBook(dir, at);
  if (!derived.ok) throw new ProjectError(derived.reason);
  return {
    key,
    sourcePath: inputPath,
    bookPath: derived.path,
    recordsPath: planned.recordsPath,
    stepId: planned.stepId,
    at: at?.id ?? null,
    from: language,
    ...(seed !== null ? { seedRecords: seed } : {}),
    ...(generation !== null ? { generation } : {}),
  };
}

/**
 * WHAT LANGUAGE A REWRITE HAPPENS IN — the ledger's answer, else the book's own.
 *
 * ── Two places can honestly say it, in this order ──────────────────────────
 *
 * THE TRANSLATION IN EFFECT, when the row stands under one. The words there are
 * that row's and the row recorded what language it made them in. Nothing else can
 * know it: a derived book's header carries the READ's declared language, because
 * a derived book is materialised from the source book's header and its rows are
 * the only thing the records replaced.
 *
 * THE BOOK'S OWN HEADER otherwise — `--language` as it was declared to the
 * reading, which is this app's one recorded answer to "what language is this book
 * in" and is declared, never detected (shared/book.ts).
 *
 * AND THE BOOK MADE TO READ IT IS THROWN AWAY. That is a real cost — one
 * materialise for one header field — and it is the cheapest honest answer:
 * `declaredLanguageOf` reads a book file, the only book file that can be made on
 * this chain is this row's, and inventing a way to read a header without
 * assembling the book would be a second implementation of the materialise. The
 * deferred branch has always paid it; since PK6 the press pays it too, because a
 * book made at the press is a path that outlives its file (`TranslateRequest.at`).
 *
 * IF NEITHER SAYS ANYTHING, THIS REFUSES IN WORDS. A book that never declared its
 * language cannot say what to rewrite it in, and the honest answer is a sentence
 * naming the gap rather than a guess that spends six hours proving itself wrong.
 */
export async function rewriteLanguage(
  dir: string,
  ledger: ProjectLedger,
  at: LedgerStep | null,
): Promise<string> {
  const standing = translationInEffect(ledger, at)?.params?.language?.trim() ?? '';
  let language = standing;
  if (language.length === 0) {
    const read = await materializeBook(dir, at);
    if (!read.ok) throw new ProjectError(read.reason);
    language = await declaredLanguageOf(read.path);
    await fsp.rm(read.path, { force: true }).catch(() => undefined);
  }
  if (language.length === 0) {
    throw new ProjectError(
      'This book has never said what language it is in, and a rewrite happens IN a language — so '
      + 'there is nothing to tell the model to write. Read the pages again with the language '
      + 'declared, or translate the book into a language you name, and the rewrite has an answer '
      + 'to work from.',
    );
  }
  return language;
}
