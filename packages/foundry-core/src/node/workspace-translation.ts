/**
 * workspace-translation — which file a translation is, and making it.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { materializeBook } from './book';
import { ProjectError, importDocument, ledgerOf, readManifest, recordsForTextPass } from './projects';
import { positionOf, translationInEffect, translationRecordsOf } from '../shared/ledger';
// A TYPE ONLY, deliberately: shared/pending.ts derives promises from QUEUE ROWS,
// and this module must not learn about a queue. What it is handed is the answer
// (`Deferral`), composed at the door by the side that holds both lists.
import type { Deferral } from '../shared/pending';
import type { ConversionKind, LedgerStep, TranslationPlan } from '../shared/types';
import { newestRecordsInto, readingGenerationOf, sameTag, seedRecordsPath } from './workspace-records';

/**
 * The translation's own words and the language they are in — or a refusal naming
 * what this app will not do.
 *
 * ── What this replaced ──────────────────────────────────────────────────────
 *
 * A second engine run. The book was rendered into a nameless EPUB in the OS temp
 * directory and handed to `translate`, which read it and wrote the real file; an
 * export added a THIRD run to tidy what came back into an edition, because
 * `translate` reads the very stamps an edition withholds. All of that was the cost
 * of a translation being a FILE. It is a records file now, so the translated book
 * is CAST by the same run that assembles every other book — the records go in at
 * the one point where a block's words are written, upstream of the format fork and
 * upstream of the edition rules — and the temp directory, the splice, the tidy and
 * the second bank all go with the change.
 *
 * ── The three refusals, all of them at plan time ────────────────────────────
 *
 * NO FACSIMILE. The PDF route reprints the PAGE — the scan's own photographed
 * lines, set back as type — and there is nowhere in it for a translated paragraph
 * to go; the engine refuses the pair by name for the same reason
 * (src/vlm/convert.ts). What CAN be made from here is the EPUB and the plain text,
 * which is one product more than the two-stage pipeline could offer: that one
 * ended in `translate`, which reads a book and writes a book, so the text route
 * was unreachable through it. Records reach the text emitter because they are
 * substituted before the format fork.
 *
 * A LANGUAGE IT NEVER RECORDED. A translation migrated out of the old catalogue
 * carries no `params.language`, because the language survived only inside a
 * filename and reading a fact out of one is what this codebase's oldest house rule
 * forbids. There is nothing to declare the cast as, and guessing from the
 * parentheses in its name is the one thing this app will not do.
 *
 * A TRANSLATION THAT PREDATES RECORDS. Its answers are a bank keyed by the masked
 * XHTML of a book, and the masking moved a stage earlier when records arrived
 * (`KEY_FORMAT`, src/translate/bank.ts) — so every key in it misses by design, and
 * a run that read it would re-ask the model for the whole book while claiming to
 * be arithmetic. The honest answer is the sentence: that row still has the EPUB it
 * made, standing on it still shows that book, and translating again from the step
 * it was made from puts the project on records for good.
 */
export function translatedWords(
  dir: string,
  translate: LedgerStep,
  kind: ConversionKind,
): { records: string; language: string } {
  if (kind === 'pdf') {
    throw new ProjectError(
      `“${translate.label}” cannot be made into a facsimile. A facsimile reprints the scan's own `
      + 'photographed pages, and there is nowhere on a photograph of a German page to put a '
      + 'Hungarian paragraph — step back to the reading to make a facsimile of the original.',
    );
  }
  const language = translate.params?.language?.trim() ?? '';
  if (language.length === 0) {
    throw new ProjectError(
      `“${translate.label}” does not say which language it was made into, so there is nothing to `
      + 'declare the book as. It was recorded before Foundry kept that, and the way to get a fresh '
      + 'edition is to translate again from the step it was made from.',
    );
  }
  const records = translationRecordsOf(translate);
  if (records === null) {
    throw new ProjectError(
      `“${translate.label}” was made before Foundry kept a translation as records, so its words exist `
      + 'only inside the book that run wrote. That book is still here and standing on that step still '
      + 'shows it — but making anything else from it means translating again from the step it was '
      + 'made from, and everything after that is free.',
    );
  }
  return { records: path.join(dir, ...records.split('/')), language };
}

/**
 * Where this book's TRANSLATION goes — which is a records file, and no book.
 *
 * IN THE SAME PROJECT AS THE BOOK IT CAME FROM, which is the whole reason this
 * function stopped keying on the input's own content. A German original and its
 * English and French editions are one book with three sets of answers about it,
 * kept in the folder that holds the reading they were all taken of, rather than in
 * three unrelated directories that nothing on disk connects.
 *
 * ── WHAT IT WRITES CHANGED, AND EVERYTHING FOLLOWS FROM THAT ───────────────
 *
 * It wrote `generated/<book> (hu).epub`: a second EPUB, same container, same
 * pictures, translated text inside every stamped element. It writes
 * `readings/<key>.hu[.<id8>].records.jsonl` now — one row per flowing block,
 * keyed by that block's own position in the reading bank — and no document at all.
 * The book a person reads is CAST from those records afterwards, by the same
 * `vlm-convert` that assembles every other book in this app.
 *
 * Three things this function used to owe went with the EPUB. There is no
 * `.epub` extension to keep load-bearing (nothing opens a records file in a tab).
 * There is no previous edition to rotate aside, and therefore no rotation refusal
 * and no self-overwrite case — this run writes into `readings/`, where nothing is
 * ever unpacked and no tab is ever pointed. And there is no separate bank: the
 * records file IS the cache, which is why the engine refuses `--bank` beside
 * `--records` by name.
 *
 * ── AND IT MAY BE A CHAIN, WHICH THE LEDGER DECIDES AND NOBODY ELSE ────────
 *
 * The user: *"if they click the english translation and then click translate to
 * hungarian, it translates from english to hungarian."* Standing under a
 * translation, this run's questions are asked of the PARENT'S answers rather than
 * of the book's own words — `--source-records`, plus `--from` naming the language
 * those answers are in. Both are read off the nearest translate step on the
 * ancestry, HERE, because the renderer holds a mirror of the ledger and a source
 * language taken from a mirror is a prompt that can be told the wrong thing about
 * what it is holding.
 */
export async function identifyTranslation(
  inputPath: string,
  targetLanguage: string,
  /**
   * THE ROW THIS PASS IS MADE FROM, when the press did not come from the pointer.
   *
   * Owen's pending-node ruling put acts on rows the position is not standing on:
   * clicking a promised step makes it the renderer's STANDING without moving the
   * ledger's pointer (main refuses `ledger:go` to a step that does not exist, and
   * is right to). A person can also press an act on a landed row that is not the
   * position, and this is what carries that. Null and absent both mean the
   * position, which is every press this door had before.
   *
   * IT IS A STEP AND NOT AN ID, because everything it feeds takes a step —
   * `translationInEffect`, `materializeBook` — and resolving an id here would be a
   * second `stepOf` refusal beside the one the door already makes.
   */
  at: LedgerStep | null = null,
  /**
   * THE ROW THIS PASS IS MADE FROM HAS NOT LANDED — see `Deferral`
   * (shared/pending.ts) and `WorkspacePlan.deferred` for the whole argument.
   *
   * Mutually exclusive with `at` in practice and not enforced here: the door
   * composes exactly one of them (`deferralFor` answers null for a step the ledger
   * holds), and a guard would be this function re-deriving a decision it was told
   * about.
   */
  deferral?: Deferral,
  /**
   * THE STEP ID THIS PLAN MUST SPEND RATHER THAN MINT — the id a press already
   * promised, handed back by the re-plan at spawn.
   *
   * `recordsForTextPass`'s own parameter, carried through the three plan doors so
   * that a deferred pass planned twice is planned about ONE step both times. See
   * that function (electron/projects.ts) for the whole argument, and
   * `materializeAtSpawn` (electron/job-queue.ts) for the only caller that passes
   * it. Absent is every press.
   */
  minted?: string,
): Promise<TranslationPlan> {
  const { dir, key } = await importDocument(inputPath, 'epub');
  const manifest = await readManifest(dir);
  const ledger = ledgerOf(manifest);
  /*
   * ── THE DEFERRED PLAN: THE NAMES, AND NOTHING THAT NEEDS A CHAIN ───────────
   *
   * `recordsForTextPass` is asked with the PROMISED step as the parent, which is
   * the whole of what makes this file's name right: an id no existing step is
   * parented to is a branch, and a translation of a book that has not been cleaned
   * yet is exactly that. The step id it mints is the one the landing will append
   * under, and it is also what the tree draws this row's own promise as.
   *
   * NO BOOK, NO SEED, NO GENERATION, NO `--from`. Every one of those is read off a
   * chain or a file that will not exist until the parent lands, and every one is
   * composed by this act's `materialize*` at spawn (`materializeAtSpawn`,
   * electron/job-queue.ts).
   *
   * AND NO SAME-LANGUAGE REFUSAL, which is the one guard this branch loses. It
   * compares the target against the language of the translation in effect, and the
   * promised chain above this row may put a translation there that nothing can name
   * yet (a promise carries no params). So the refusal is made at SPAWN instead,
   * where this function runs again with the real row and every fact in hand — a
   * failed job with main's own sentence on it rather than an hour of a model saying
   * an English book in English.
   */
  if (deferral !== undefined) {
    const promised = await recordsForTextPass(dir, 'translate', targetLanguage, undefined, deferral.from);
    await fsp.mkdir(path.join(dir, 'readings'), { recursive: true });
    return {
      key,
      sourcePath: inputPath,
      recordsPath: promised.recordsPath,
      stepId: promised.stepId,
      /*
       * AND NO `namesAtSpawn`, WHICH IS THE ONE THING A TRANSLATION NEVER NEEDS.
       * The fact this file is named after — the target language — was TYPED BY THE
       * PERSON in the dialog that reached this function, so it is in hand however
       * little the chain above can say. A rewrite's language is read off that chain
       * and is the reason the field exists (`DeferredPlan.namesAtSpawn`).
       *
       * The re-plan at spawn may still move the name, and that is a different thing:
       * a re-run target that could not match at press (nothing is parented to a
       * promise) can match once the parent lands, and then this run aims at the step
       * that already exists and takes ITS path. That is replace semantics arriving
       * late rather than a placeholder being resolved, and `materializeAtSpawn`
       * handles the two in one line.
       */
      deferred: { from: deferral.from },
    };
  }
  /*
   * ── WHICH TRANSLATION THIS IS, AND THEREFORE WHAT ITS FILE IS CALLED ──────
   *
   * This used to compose `<stem> (<tag>).epub` from the stem and the language
   * alone — one name per book per language, forever — which was true while a book
   * could hold one translation into a language and became a collision the moment
   * the ledger let it hold two. The user's own scenario is exactly that: translate
   * the reading, strike some blocks, commit, translate the curation. Two steps,
   * two sets of answers, and one filename holding whichever ran last.
   *
   * So the plan asks the ledger instead (`recordsForTextPass` →
   * `translationTarget`, shared/ledger.ts): a re-translation from the same step
   * aims at that step's own records — which is what makes it nearly free, every
   * unchanged block already answered in there — and a translation from a DIFFERENT
   * step mints `<name>.<id8>.jsonl`, `id8` being the front of the step's uuid.
   *
   * THE STEP ID IS MINTED HERE AND TRAVELS WITH THE JOB (`TranslateRequest.stepId`),
   * for `planReading`'s reason: the file is named after a step that will not exist
   * for hours, and minting a second id at the landing would leave it named after a
   * row nobody created.
   */
  /*
   * ── AND IT NO LONGER REFUSES OVER APPLIED CHANGES ──────────────────────────
   *
   * It used to, in `refuseOverEdits`'s own words: a translation read a CAST of
   * the position's book, and a cast of a position with applied changes on its
   * path is the document those changes are missing from — so the run would
   * faithfully translate the paragraphs somebody had struck and hand back a
   * German edition of them.
   *
   * The root fix is the same one the export took (docs/RENDERER.md §9, R5): main
   * materialises the position's book — every op on the way to it replayed in, so
   * a struck row is simply not in the file — and the engine translates THAT
   * (`translate --book`). Nothing about a strike, an overlay or a curation
   * crosses the boundary; what crosses is a document.
   */
  const planned = await recordsForTextPass(
    dir, 'translate', targetLanguage, undefined, at === null ? undefined : at.id, minted,
  );
  /*
   * ── WHAT THIS RUN IS ASKED OF, WHICH IS TWO SEPARATE FACTS ────────────────
   *
   * The nearest translate step above the position, if there is one. It decides two
   * things that are not the same thing, and folding them into one flag was wrong
   * in a way worth writing down.
   *
   * `--from` IS ABOUT THE WORDS THE MODEL WILL BE SHOWN, and standing anywhere
   * under a translation those words are that row's. The engine is handed the
   * position's own document — for a records row its CAST, for a row made before
   * records the book that run wrote — and either way what is inside it is that
   * translation's text. So the source language is that row's `params.language`,
   * recorded rather than guessed, and it is said for BOTH kinds of parent. Left
   * out, the model is told to work the language out from the text, which is a
   * needless guess about a fact the ledger is holding.
   *
   * `--source-records` IS ABOUT WHERE THE WORDS COME FROM, and only a records row
   * has such a file. It makes each question about the parent's newest row for that
   * position rather than about the book's own text — which is what makes correcting
   * one English record re-ask exactly the Hungarian blocks that record feeds, and
   * nothing else. A row made before records has no file to point at, and pointing
   * at nothing is not a state the engine admits.
   *
   * SO A PRE-RECORDS PARENT STILL CHAINS, and the chain is honest: the run reads
   * that row's own book and is told which language it is in. What it does not get
   * is the re-ask precision above, because the words it consumed live inside an
   * EPUB rather than in rows a person can correct.
   */
  // ASKED ABOUT THE ROW THIS PRESS NAMED, which is the position unless a card
  // further up the tree was the thing clicked. `nearestUpward`'s own `from`
  // argument, reached from this door for the first time.
  const parent = translationInEffect(ledger, at);
  const parentLanguage = parent?.params?.language?.trim() ?? '';
  /*
   * ASKING FOR THE PARENT'S OWN LANGUAGE IS NOT A TRANSLATION AND IS REFUSED HERE
   * AS WELL AS IN THE DIALOG.
   *
   * It would spend hours asking a model to say an English book in English, and file
   * the result as a row that means nothing. The dialog says so before the button
   * (`sameLanguage`) because a refusal met before a press is worth more than the
   * same refusal after one — and main says it too, because a renderer's guard is a
   * courtesy and this one is the rule. The comparison is the same fold on the same
   * pair, so the two cannot come to different answers about what was pressed.
   *
   * REDOING A TRANSLATION IS A DIFFERENT GESTURE and the sentence names it: stand
   * on the step it was made FROM and ask for that language again, which
   * `reRunTarget` resolves to the row that already exists and fills its own file.
   */
  refuseSameLanguage(parent, parentLanguage, targetLanguage);
  const source = parentLanguage.length > 0 ? parentLanguage : null;
  /*
   * ── `--source-records` IS GONE FROM THIS PLAN, AND THE CHAIN IS NOT ────────
   *
   * That flag existed because the engine read a CAST: the cast is a rendering of
   * the SOURCE book, so a chain had to be told where the parent's words were and
   * to prefer them per position. A book file at a position under a translation
   * IS the parent's words — main materialised it that way when that translation
   * landed (docs/RENDERER.md §4) — so the words this run is handed are already
   * English, and the question keys already hash English. The precision the flag
   * bought is unchanged and now falls out of the file: correcting one English
   * record changes one row of the derived book, which changes one question, which
   * re-asks exactly the Hungarian block that record feeds.
   *
   * The engine refuses the pair by name for the same reason (`--book` with
   * `--source-records`), so this cannot be got wrong from either side. `--from`
   * stays: which language the words are IN is a fact the ledger holds and a file
   * of sentences does not declare.
   */
  /*
   * ── AND THE SEED: WHAT THIS RUN STARTS LIFE HOLDING ───────────────────────
   *
   * A BRANCH IS A SECOND TRANSLATION INTO ONE LANGUAGE FROM A DIFFERENT STEP, and
   * the user's own scenario produces one: translate the reading into English,
   * strike some blocks on the book, apply, then translate THAT save into English.
   * Two rows, two files, one language — which is the branch `translationTarget`
   * mints an `<id8>` for. An EMPTY file there would make the second run a full
   * re-translation of a book that is already translated, when the whole promise of
   * a question-keyed record is that an unchanged block is never asked twice.
   *
   * SO THE SEED IS THE NEWEST OTHER TRANSLATION INTO THIS LANGUAGE, wherever it
   * hangs, and NOT the parent. That distinction is the whole of the fix. The
   * sibling case above is the common one and no walk from the position can reach
   * it: a save made under the READING has the English translation as a SIBLING,
   * off the same reading, and `translationInEffect` correctly refuses to find it —
   * it is not on the path from the import to where that save stands.
   *
   * IT IS SAFE FOR THE PARENT'S OWN REASON: a records row is keyed by the block's
   * own text and remembered by the block's own position, so a sibling's answer
   * about page 12 block 3 is the same true answer about the same paragraph. Struck
   * blocks are simply never looked up, and text edited since asks a new question
   * and gets a new key.
   *
   * NEVER WHEN THIS RUN IS ASKED OF ANOTHER LANGUAGE, which is where the two halves
   * of this paragraph meet. A chain's questions are asked of the PARENT'S words, so
   * a sibling's answers — true as they are about the German — are keyed to
   * questions this run will not ask, and every one of them would be re-asked
   * anyway. Copying a file to gain nothing is a file copied for nothing.
   *
   * THE SEED IS A PATH AND NOT A COPY. It is copied at SPAWN (`pump()`), because a
   * plan is not a commitment: a held job that is removed must leave `readings/`
   * exactly as it found it, and a file seeded here would sit there named by no step,
   * invisible to the sweep, forever. A replace never spends it — its own file is
   * already there, holding its own answers, and the copy is skipped by existence.
   */
  await fsp.mkdir(path.join(dir, 'readings'), { recursive: true });
  /*
   * ── AND THAT IS THE WHOLE OF A PRESS (PK6) ────────────────────────────────
   *
   * What used to follow — the seed, the generation and the materialised book —
   * are all SPAWN answers now and live in `materializeTranslation` below. The
   * argument is `TranslateRequest.at`'s: a derived book's lifetime is spawn →
   * settle, and a path minted here outlives the file it names the moment a row is
   * retried, resumed or restored (BookForge's F1/F5). What crosses is the ROW.
   *
   * `sourcePath` IS THE INPUT, VERBATIM, and it stays a field because it is the
   * answer to "which file did this plan admit" — what main's allow-list added and
   * what the queue re-checks (`queue:enqueue-translate`), not what the engine reads.
   */
  return {
    key,
    sourcePath: inputPath,
    recordsPath: planned.recordsPath,
    stepId: planned.stepId,
    // THE ROW THIS PASS IS MADE FROM, pinned here so a pointer moved while the job
    // waits cannot change which book the spawn makes. See `TranslationPlan.at`.
    at: at?.id ?? positionOf(ledger)?.id ?? null,
    // The language the words are IN, said for any parent translation. Where they
    // come OUT of is the book the spawn materialises.
    ...(source !== null ? { from: source } : {}),
  };
}

/**
 * THE SAME TRANSLATION, AT THE SPAWN — the book, the seed and the generation.
 *
 * ── Why the plan is in two halves (PK6, BookForge's F1/F5/F8) ──────────────
 *
 * Everything above is IDENTITY: which file the answers go in, which step they
 * land under, which language they come out of. All of it is composed from the
 * project's catalogue and a ledger walk, none of it touches a byte of scratch,
 * and it has to be settled at the press because it is what the person chose and
 * what the tree draws a card for.
 *
 * Everything here is a FILE OR A FACT ABOUT ONE, and each has a lifetime shorter
 * than the row's:
 *
 *   THE BOOK — `derived/<uuid>.book.jsonl`, unlinked by `sweepDerivedBook` at
 *   EVERY ending and by `sweepStaleDerived` after a day. Minted at the press it
 *   was gone before half the rows that name it ever ran: Retry, Start after a
 *   stop, and a queue restored from disk all replayed a path the settle had
 *   deleted, and the engine said `--book … (ENOENT)`.
 *
 *   THE SEED — the newest other records file into this language. Resolved at the
 *   press it could name a file a Start-over or a deleted step had since removed,
 *   and the copy silently did nothing: a full re-translation at full price, which
 *   is the exact defect the seed exists to prevent (F8). Resolved here it is true
 *   at the moment it is spent, and an absent one is said out loud.
 *
 *   THE GENERATION — read off the reading step in effect. It is cheap, it is a
 *   fact about the chain, and it belongs with the two above for one reason: they
 *   are the answers a DEFERRED plan could never make, and having one function that
 *   makes all three is what stopped the deferred path being a second plan
 *   (`materializeDeferred`, deleted with this).
 *
 * IT IS THE SAME FUNCTION FOR BOTH PATHS. A deferral is an `at` that did not
 * exist at the press, so the spawn resolves the row and asks this — which is why
 * the seeding rule and the same-language refusal have one implementation and
 * cannot drift between the two askings.
 *
 * `minted` IS THE PRESS'S OWN STEP ID, always. `recordsForTextPass` spends it on
 * a branch, so the second asking mints nothing new and the file, the row and the
 * card on the tree go on agreeing about which translation this is.
 */
export async function materializeTranslation(
  inputPath: string,
  targetLanguage: string,
  /** The row this pass is made from, resolved from the request's `at`. */
  at: LedgerStep | null,
  /** The step id the press promised. See `recordsForTextPass`'s own parameter. */
  minted?: string,
): Promise<TranslationPlan> {
  const { dir, key } = await importDocument(inputPath, 'epub');
  const manifest = await readManifest(dir);
  const ledger = ledgerOf(manifest);
  /*
   * THE SAME-LANGUAGE REFUSAL, ASKED AGAIN — and for a DEFERRED pass this is the
   * first time it can be asked at all: nothing is parented to a promise, so the
   * press had no parent to compare against. `refuseSameLanguage` is the one
   * comparison; the press makes it too, where a refusal is worth more.
   */
  const parent = translationInEffect(ledger, at);
  const parentLanguage = parent?.params?.language?.trim() ?? '';
  refuseSameLanguage(parent, parentLanguage, targetLanguage);
  const source = parentLanguage.length > 0 ? parentLanguage : null;
  const planned = await recordsForTextPass(
    dir, 'translate', targetLanguage, undefined, at === null ? undefined : at.id, minted,
  );
  /*
   * ── THE SEED: WHAT THIS RUN STARTS LIFE HOLDING ───────────────────────────
   *
   * A BRANCH IS A SECOND TRANSLATION INTO ONE LANGUAGE FROM A DIFFERENT STEP, and
   * an EMPTY file there would make it a full re-translation of a book that is
   * already translated. So the seed is the newest other translation into this
   * language, wherever it hangs, and NOT the parent — a records row is keyed by
   * the block's own text, so a sibling's answer about page 12 block 3 is the same
   * true answer about the same paragraph.
   *
   * NEVER WHEN THIS RUN IS ASKED OF ANOTHER LANGUAGE: a chain's questions are
   * asked of the PARENT'S words, so a sibling's answers are keyed to questions
   * this run will not ask and every one of them would be re-asked anyway.
   *
   * IT IS A PATH AND NOT A COPY. The copy happens beside the spawn
   * (`executeJob`), because a row that never commits must leave `readings/`
   * exactly as it found it.
   */
  const seed = source !== null ? null : seedRecordsPath(
    dir, newestRecordsInto(ledger, targetLanguage, planned.records), 'translation',
  );
  const generation = readingGenerationOf(ledger, manifest);
  await fsp.mkdir(path.join(dir, 'readings'), { recursive: true });
  /*
   * THE BOOK THE ENGINE ACTUALLY TRANSLATES — the row's own book file with its
   * whole chain replayed into it (`openBookAtPosition`, electron/book.ts). A
   * struck row is not in it, a retyped paragraph is in it as the person left it,
   * and under a translation it is that translation's derived book, which is how a
   * chain's parent words reach the model without a second path on the line.
   */
  const derived = await materializeBook(dir, at);
  /*
   * A REFUSAL HERE IS THE PERSON'S OWN SENTENCE: `materializeBook` answers in
   * words for everything somebody can be told about, and what it will not do is
   * spend hours of GPU on a book it could not assemble — answers keyed to blocks
   * nobody can put back.
   */
  if (!derived.ok) throw new ProjectError(derived.reason);
  return {
    key,
    sourcePath: inputPath,
    bookPath: derived.path,
    recordsPath: planned.recordsPath,
    stepId: planned.stepId,
    at: at?.id ?? null,
    ...(source !== null ? { from: source } : {}),
    ...(seed !== null ? { seedRecords: seed } : {}),
    /*
     * THE READING THESE ANSWERS ARE ABOUT, carried into every row and interpreted
     * by nobody — `Overlay.generation`'s contract, one folder over. Read off the
     * step rather than minted: minting a generation is something a LANDING does.
     */
    ...(generation !== null ? { generation } : {}),
  };
}

/**
 * ASKING FOR THE PARENT'S OWN LANGUAGE IS NOT A TRANSLATION — the refusal, once.
 *
 * It would spend hours asking a model to say an English book in English, and file
 * the result as a row that means nothing. The dialog says so before the button
 * (`sameLanguage`), the PRESS says it wherever it has a parent to compare, and the
 * SPAWN says it for a pass ordered from a row that had not landed — where nothing
 * was parented to a promise, so no comparison was possible. One fold on one pair,
 * so the three cannot come to different answers about what was pressed.
 *
 * REDOING A TRANSLATION IS A DIFFERENT GESTURE and the sentence names it: stand on
 * the step it was made FROM and ask for that language again, which `reRunTarget`
 * resolves to the row that already exists and fills its own file.
 */
export function refuseSameLanguage(
  parent: LedgerStep | null,
  parentLanguage: string,
  targetLanguage: string,
): void {
  if (parentLanguage.length === 0 || !sameTag(parentLanguage, targetLanguage)) return;
  throw new ProjectError(
    `“${parent?.label ?? 'That step'}” is already in ${parentLanguage}, so translating it into `
    + `${targetLanguage} would ask the model to say the same thing again. To make that `
    + 'translation afresh, stand on the step it was made from and translate there — that '
    + 'replaces the one you have rather than adding a second.',
  );
}
