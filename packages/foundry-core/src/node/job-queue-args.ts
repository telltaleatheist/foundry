/**
 * job-queue-args — a request as the engine's command line.
 */
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { imagesDirFor, metadataForProduct, projectDirOf } from './projects';
import type { LlmServerKind } from '../shared/pipeline';
import type { AnalysisRankRequest, AnalyzeRequest, CleanRemoval, ConversionKind, SimplifyRequest, TranslateRequest } from '../shared/types';
import { UNPLACED, type Placement } from './crucible-dispatch';
import type { EngineRequest } from './job-queue-state';

/**
 * WHERE AN ANALYSIS RUN'S CHECKLIST IS WRITTEN — the report's own path plus a
 * suffix, and never a rename of it.
 *
 * ── One derivation, three readers ───────────────────────────────────────────
 *
 * `argsFor` puts it on the command line, the spawn writes it, and the settle
 * removes it. Three places that must agree about one path, which is exactly the
 * shape `productOf` one screen up exists to stop being three correct copies — so
 * it is a function, and the three ask.
 *
 * A SUFFIX ON THE WHOLE PATH, `pendingReportPath`'s own spelling (src/analyze/
 * report.ts): a name composed by replacing an extension is a name that can
 * collide with a real file the day somebody's report is called something else,
 * and appending cannot.
 */
export function categoriesFileFor(request: AnalyzeRequest | AnalysisRankRequest): string {
  const report = request.kind === 'analysis-rank' ? request.reportPath : request.outputPath;
  return `${path.resolve(report)}.categories.json`;
}

/**
 * The command line, assembled in ONE place.
 *
 * `--readings` is passed on EVERY job — electron/workspace.ts names the bank,
 * and there is no switch that turns it off. It is what makes an interrupted
 * 300-page run resumable, and foundry decides for itself whether a bank beside a
 * completion marker is a resume or a re-read (README §Reading the pages
 * somewhere else, and only once). This app does not second-guess it.
 *
 * No `--vlm-endpoint`. The settings screen owns which backend reads the pages,
 * the engine reads that same settings.json for itself, and a per-job override
 * here was a second opinion about a decision that has one owner.
 */
/**
 * THE BOOK ON THE COMMAND LINE, or a refusal naming what is missing — the LAST
 * line, not the maker.
 *
 * ── Why the field can be absent at all, and why this guard exists ──────────
 *
 * Since PK6 NO plan makes the book: `materializeAtSpawn` does, inside the run,
 * because a derived book's lifetime is spawn → settle and a path minted at the
 * press outlives its file the moment a row is retried or restored (BookForge's
 * F1/F5, and `TranslateRequest.at` carries the argument). By the time a command
 * line is being assembled the field is therefore always there — and "always" is
 * where this codebase's expensive failures live. A `translate` spelled with no
 * `--book` is a job about no book at all, and the engine's own refusal would name
 * a flag rather than the materialise that never ran.
 *
 * IT THROWS, AND THE CALLER TURNS THAT INTO A FAILED ROW with this sentence on it
 * — the same ending every unmakeable plan in this app has always had.
 */
/**
 * THE RANK FILE ON AN ANALYSIS'S COMMAND LINE, or a refusal — `bookOf`'s twin.
 * A request filed before the ranking existed has none, and an analysis without
 * one has nothing to verify.
 */
export function ranksOf(request: AnalyzeRequest): string {
  if (request.ranksPath === undefined) {
    throw new Error(
      'This analysis was queued by an older Foundry, before an analysis ranked the book on a Crucible '
      + 'first, so there is no ranking for it to read. Remove it and analyse again.',
    );
  }
  return request.ranksPath;
}

export function bookOf(request: { bookPath?: string }): string {
  if (request.bookPath === undefined) {
    throw new Error(
      'The book this run was to read was never made, so there is nothing to hand the model. That '
      + 'is a fault in this app rather than in the book: the run reached its command line without '
      + 'the materialise that happens the moment it starts.',
    );
  }
  return request.bookPath;
}

/**
 * THE LANGUAGE ON THE COMMAND LINE, or a refusal in main's own words —
 * `bookOf`'s twin, for the field a rewrite can promise but not state.
 *
 * A translation's `--to` was typed by a person and is required on the shape. A
 * REWRITE's is read off the chain (`SimplifyRequest.to`), and a rewrite ordered
 * from a promised translation cannot read it until that translation lands — so
 * `materializeAtSpawn` fills it in when the run starts, and this is the guard that says so if
 * it ever did not. A `--rewrite` with a blank `--to` is a run with nothing to tell
 * the model to write in, which is six hours of a model being asked the wrong
 * question rather than a crash.
 */
export function languageOf(request: TranslateRequest | SimplifyRequest): string {
  const said = request.to?.trim() ?? '';
  if (said.length === 0) {
    throw new Error(
      'This rewrite was ordered from a step that had not finished yet, and the language it was to be '
      + 'written in was never resolved — so there is nothing to tell the model to write. Order it '
      + 'again from a step that exists.',
    );
  }
  return said;
}

/**
 * `--model`, `--server` AND `--endpoint`, composed together because they are ONE
 * decision: which machine this act runs on, and in which dialect.
 *
 * ── The three flags used to be spelled in three places, and were one answer ─
 *
 * Each of the branches below spelled `'--endpoint', request.ollama` itself and
 * called `modelArgs` for the other two. That was harmless while the endpoint was
 * always the request's own; with slots it is not — a Crucible placement replaces
 * the endpoint AND the model AND the door together, and three call sites each
 * remembering to apply two thirds of a placement is a translation that runs
 * against the right server with the wrong model. So the placement is applied
 * once, here.
 *
 * ── Where each value comes from ────────────────────────────────────────────
 *
 * The placement wins where it says anything, and null means "the request's own".
 * A Crucible placement carries the server's `<url>/openai` and the model its own
 * capability record selected, and that is now the ONLY thing that ever reaches a
 * real run: `request.model` and `request.ollama` are the declared defaults every
 * dialog fills in, and with no engine connected a text act is refused rather than
 * placed (Owen, 2026-09-15: *"if theres no connected crucible server then tiles
 * should be disabled"*). The null branch survives for the DRY RUN, which has no
 * server to ask — see `argsFor`.
 *
 * ── Why the model can be missing ────────────────────────────────────────────
 *
 * On the OpenAI door a blank field is the ANSWER: the server holds exactly one
 * resident model, and an empty `--model` tells the engine to ask the server, use
 * what it is serving and record that name (src/translate/vllm.ts). Passing
 * `--model ""` would be this file inventing an empty name; leaving the flag off
 * says what is meant. On the Ollama door it is never blank — the request carries
 * a declared default, because an Ollama holds a library and the engine refuses a
 * run that does not say which model it means.
 *
 * ── And `--server` only when it is not the engine's default ─────────────────
 *
 * `openai` is the engine's default (docs/SLOTS.md §2), so writing the flag out
 * for it would put a new word on thousands of command lines to say what they
 * already said. `ollama` is spelled, and so is `anthropic` — the third door
 * (docs/VLLM.md §2), which a CLOUD slot whose provider is Anthropic places onto.
 * A cloud provider of the OpenAI kind places onto the default door and therefore
 * spells nothing, which is right: OpenAI's own API is an OpenAI-compatible
 * server and the only thing that distinguishes it from a vLLM on this line is
 * the endpoint.
 *
 * THE MAPPING IS OVER THE WHOLE UNION AND NOT A TEST FOR ONE VALUE, which is why
 * it is a switch rather than the two ternaries it replaced: the engine refuses
 * an unknown `--server` by name (`--server takes openai, ollama or anthropic,
 * not "x"`), so a fourth door added to `LlmServerKind` without a line here must
 * fail the typecheck rather than silently spawn against the default.
 *
 * NOTHING SECRET IS ON THIS LINE, and that is a rule rather than an observation.
 * A Crucible's token and a provider's API key both travel in the spawn's
 * ENVIRONMENT (`Placement.env`) and never in argv, because argv is spelled into
 * the terminal by `executeJob`, pasted into bug reports, and listed by the
 * process table.
 */
export function doorArgs(
  request: { model: string; ollama: string; concurrency?: number },
  placement: Placement,
): string[] {
  const model = (placement.model ?? request.model).trim();
  return [
    ...(model.length > 0 ? ['--model', model] : []),
    ...serverArgs(placement.door),
    '--endpoint', placement.endpoint ?? request.ollama,
    ...concurrencyArgs(request, placement),
  ];
}

/**
 * `--concurrency`, ON EVERY TEXT ACT THAT MEETS A PLACED SERVER.
 *
 * ── Why it is here and not on three command lines ──────────────────────────
 *
 * It was on ONE: the clean branch pushed it from `request.concurrency`, and
 * translate, simplify and analyse never spelled it at all — so the two longest
 * runs in the app took the engine's own default of twelve, against a Crucible
 * chat door that serves one request at a time. That is BookForge's F3a, and the
 * fix is that the answer travels with the PLACEMENT (see `Placement.concurrency`)
 * through the one function every act's door already goes through.
 *
 * THE PLACEMENT WINS. A depth stated by the server that answered is a fact about
 * that machine; a number on the request is a preference about somebody else's
 * backend, and it survives only where there is no placement to overrule it —
 * which is a dry run (`argsFor` defaults to {@link UNPLACED}) and nothing else.
 *
 * A NON-INTEGER OR A ZERO IS NOT A DEPTH, so it is dropped rather than passed on
 * for the engine to argue with; with neither side saying anything the flag is off
 * the line entirely and the engine's own default stands, which is exactly what a
 * `--dry-run` with no server should print.
 */
/**
 * `--remove-references` / `--remove-also` for a cleanup and its check
 * (`CleanRequest.removal`). ALWAYS SPELLED, so the line says what the run removes:
 * an absent removal is a request from before the field, which asked none, and the
 * engine's own default is on.
 */
export function removalArgs(removal: CleanRemoval | undefined): string[] {
  if (removal === undefined) return ['--remove-references', 'off'];
  const args = ['--remove-references', removal.references ? 'on' : 'off'];
  if (removal.also.trim().length > 0) args.push('--remove-also', removal.also.trim());
  return args;
}

export function concurrencyArgs(
  request: { concurrency?: number },
  placement: Placement,
): string[] {
  const said = placement.concurrency ?? request.concurrency;
  return typeof said === 'number' && Number.isInteger(said) && said > 0
    ? ['--concurrency', String(said)]
    : [];
}

/** `--server`, or nothing at all for the engine's default. See `doorArgs`. */
export function serverArgs(door: LlmServerKind): string[] {
  switch (door) {
    case 'openai': return [];
    case 'ollama': return ['--server', 'ollama'];
    case 'anthropic': return ['--server', 'anthropic'];
  }
}

/**
 * EXPORTED FOR ONE CALLER AND ONE PURPOSE: a headless door that wants to print the
 * command line a request WOULD spawn without spawning it (BookForge's
 * `cli/clean-step.js --dry-run`). A dry run that composed its own argv would be a
 * second answer to "what does this request run", and the first time the two drifted
 * the dry run would be reassuring about a command that no longer exists.
 *
 * Nothing here runs anything: it is a pure function of the request.
 */
export function argsFor(
  request: EngineRequest,
  /**
   * The merged metadata patch this product carries, for the ONE route that puts
   * it on the command line rather than stamping it on afterwards — see the
   * compile branch below. Empty for every other job, and for a project whose
   * ancestry recorded nothing.
   */
  metadata: Record<string, string> = {},
  /**
   * WHERE THIS RUN'S COMPUTE GOES — resolved by `executeJob` immediately before
   * the spawn (`placeJob`, electron/crucible-dispatch.ts).
   *
   * DEFAULTED, AND THE DEFAULT IS THE OLD BEHAVIOUR EXACTLY. `UNPLACED` says
   * "Ollama, the request's own endpoint, the request's own model", which is what
   * every line this function composed before slots existed. That keeps the one
   * external caller — BookForge's `cli/clean-step.js --dry-run`, which prints
   * the command a request WOULD spawn — correct without a re-vendor: a dry run
   * has no server to ask and no model to make resident, so the local line is the
   * honest thing for it to print.
   */
  placement: Placement = UNPLACED,
): string[] {
  if (request.kind === 'analysis') {
    /*
     * ── VERIFYING THE RANKED BOOK AGAINST THE CATEGORIES ─────────────────────
     *
     * `foundry analyze --book X --ranks R --out Y [--categories C] [--model M]
     * [--endpoint U]`. It writes a report and no document at all — a header, one
     * row per flagged passage with the verifier's reason, and its own
     * question-keyed cache of every verdict it paid for (docs/ANALYSIS.md §6).
     * `--ranks` is the file the `analysis-rank` row in front of it wrote.
     *
     * `--endpoint`, `--model` and `--server` ARE ALL `doorArgs`' NOW, and the
     * reason they moved is that they are one answer: where this run's compute
     * goes (docs/SLOTS.md §3). The engine's own settings fallback must never be
     * what decides which machine a job runs on, which is why the flag is always
     * on the line whichever slot won.
     *
     * NO `--fresh`. It exists to throw away answers somebody has already paid
     * for, and there is no gesture in this app that means that: a re-analysis
     * from the same step refreshes the report it already has, and every question
     * whose answer is in there is worth exactly what it cost.
     */
    const args = [
      'analyze',
      /*
       * THE POSITION'S OWN BOOK, materialised by main with every op on the way to
       * it replayed in (`planAnalysis`, electron/workspace.ts). A struck row is
       * not in it and a retyped paragraph is in it as the person left it — which
       * is what makes the report's character offsets agree with the paper the
       * panel draws them over.
       */
      '--book', bookOf(request),
      '--ranks', ranksOf(request),
      '--out', request.outputPath,
      ...doorArgs(request, placement),
    ];
    /*
     * THE CHECKLIST, AS A FILE BESIDE THE REPORT — written by `spawnOf` at the
     * moment the child starts rather than composed onto this line.
     *
     * It cannot be a flag value: the engine's `--categories` takes a PATH to a
     * JSON list, and the list carries a name and an enabled flag per entry
     * (`buildPlan`, src/analyze/plan.ts). And it must not be written at plan
     * time, on `seedRecords`' rule: a held job that is removed must leave the
     * project exactly as it found it, and a file written at the plan would sit
     * there named by no step.
     */
    if (request.categories.length > 0) args.push('--categories', categoriesFileFor(request));
    return args;
  }
  if (request.kind === 'analysis-rank') {
    /*
     * ── EVERY SENTENCE, SCORED AGAINST THE CATEGORIES ───────────────────────
     *
     *   foundry analyze-rank --book X --out R --endpoint <crucible> --model M
     *                        [--categories C]
     *
     * The triage's branch below, for every one of its reasons: the decide door
     * needs the ENGINE'S BASE ADDRESS and the model the placement made resident,
     * there is no dialect and no default, and an unplaced ranking is refused by
     * name. `--categories` is the SAME file the analysis behind it reads.
     */
    if (placement.origin === null || placement.model === null) {
      throw new Error(
        'The ranking in front of this analysis was not placed on a Crucible server, so there is no '
        + 'model to ask. It runs only on a Crucible that can make decisions; add or switch on one under '
        + 'Settings › Crucible Servers.',
      );
    }
    return [
      'analyze-rank',
      '--book', bookOf(request),
      '--out', request.outputPath,
      '--endpoint', placement.origin,
      '--model', placement.model,
      ...(request.categories.length > 0 ? ['--categories', categoriesFileFor(request)] : []),
    ];
  }
  if (request.kind === 'clean-triage') {
    /*
     * ── WHICH BLOCKS NEED CLEANING AT ALL ─────────────────────────────────────
     *
     *   foundry clean-triage --book X --out V --endpoint <crucible> --model M
     *
     * NOT `doorArgs`, and the difference is the whole of this branch. `doorArgs`
     * spells a CHAT door — `<engine>/openai`, a `--server` dialect, the request's
     * own model and endpoint when nothing was placed. The triage asks none of
     * those: it POSTs Crucible's `/v1/decide`, which reads the resident model's
     * belief in two letters, so it needs the ENGINE'S BASE ADDRESS
     * (`Placement.origin`) and the id of the model the placement made resident
     * and leased. There is no dialect to name and no default to fall back on.
     *
     * AN UNPLACED TRIAGE IS REFUSED BY NAME, which is the one thing this branch
     * decides. `UNPLACED` is what a dry run hands this function, and for every
     * other act it prints the request's own pair; a triage has no pair of its own
     * (`CleanTriageRequest` carries no model and no endpoint, deliberately), so a
     * line composed without a Crucible would be a command pointed at nothing.
     *
     * `--concurrency` ONLY FROM THE REQUEST. The placement's number is a CHAT
     * door's admission (`Placement.concurrency`) and says nothing about the
     * decide door, which bounds its own questions.
     *
     * THE CREDENTIAL IS IN `placement.env` AND NEVER HERE, on the rule every
     * placed line in this file keeps: the engine reads `FOUNDRY_ENDPOINT_HEADERS`.
     */
    if (placement.origin === null || placement.model === null) {
      throw new Error(
        'This check of which blocks need cleaning was not placed on a Crucible server, so there is '
        + 'no model to ask. It runs only on a Crucible that can judge text; add or switch on one '
        + 'under Settings › Crucible Servers.',
      );
    }
    return [
      'clean-triage',
      '--book', bookOf(request),
      '--out', request.outputPath,
      '--endpoint', placement.origin,
      '--model', placement.model,
      ...concurrencyArgs(request, UNPLACED),
      ...removalArgs(request.removal),
      ...(request.fixedReadings === undefined ? [] : ['--fixed-readings', request.fixedReadings]),
    ];
  }
  if (request.kind === 'clean') {
    /*
     * ── SAYING THE BOOK AGAIN SO A NARRATOR CAN READ IT ───────────────────────
     *
     *   foundry clean-text --book X --records Y --stamp Z [--endpoint U] [--model M]
     *
     * A THIRD COMMAND RATHER THAN A FOURTH FLAG ON `translate`, and the engine's
     * side made that decision: what a cleanup does to a paragraph is not a
     * translation's prompt with different words in it — it normalises punctuation
     * and typography against a spec, and it refuses an edit that changes what the
     * sentence says. A run that can REFUSE ITS OWN ANSWER on grounds a translation
     * has never heard of is a different command.
     *
     * `--book` IS THE POSITION'S OWN, materialised by main with every op replayed
     * in (`planCleanup`, electron/workspace.ts) — the same route `--book` takes on
     * the two lines below this one, and for the same reason: a struck row is not in
     * it, so nothing about a strike crosses the boundary and the records that come
     * back are keyed by the ROWS' OWN IDS.
     *
     * `--records` IS THE CACHE AS WELL AS THE PRODUCT, exactly as it is for a
     * translation: an unchanged block's question is already answered in there and
     * is never asked twice, and every answer is appended the moment it is accepted.
     * A cleanup interrupted at block 900 of 2,000 resumes for the price of the
     * remaining 1,100.
     *
     * `--stamp` IS THE ONE FLAG NO OTHER COMMAND IN THIS FILE HAS. It writes what
     * the run WAS — normaliser version, punctuation spec, model, hour, and whether
     * any edit was refused — beside the answers, so the EPUB compiled from them can
     * carry it into the OPF (`--narration-stamp`, the compile branch below) and a
     * narrator can tell a cleaned book from an uncleaned one without asking this
     * app anything.
     *
     * `--endpoint` AND NOT `--ollama`, which USED TO BE the one place this line
     * differed from its siblings' spelling for the same fact. The engine's own
     * command declares it that way, every text act declares it that way now, and
     * `doorArgs` spells it once for all three — a flag renamed on the way through
     * would be this file having an opinion about somebody else's CLI.
     *
     * NO `--to`, NO `--from`, NO `--rewrite`. A cleanup goes into no language and
     * asks no mode — see `PARAMS_OF.clean` (shared/ledger.ts) for the ledger half
     * of the same sentence.
     */
    /*
     * ── A READINGS-ONLY PASS: THE READINGS, AND NOTHING THAT NEEDS A SERVER ────
     *
     *   foundry clean-text --readings-only --book X --records Y --stamp Z
     *                      --fixed-readings F
     *
     * No endpoint, no model, no removal, no triage: the engine writes the host's
     * readings into the book and asks nobody anything (`CleanRequest.readingsOnly`).
     * A readings pass with no readings is a request composed wrong, refused here
     * by name rather than run as a copy of the book.
     */
    if (request.readingsOnly !== undefined) {
      if (request.fixedReadings === undefined) {
        throw new Error(
          `"${request.readingsOnly.label}" was queued with no readings to write in, so there is nothing `
          + 'for it to do. The host composes this pass with its readings file.',
        );
      }
      return [
        'clean-text', '--readings-only',
        '--book', bookOf(request),
        '--records', request.recordsPath,
        '--stamp', request.stampPath,
        '--fixed-readings', request.fixedReadings,
        ...(request.generation !== undefined && request.generation.length > 0 ? ['--generation', request.generation] : []),
      ];
    }
    const args = [
      'clean-text',
      '--book', bookOf(request),
      '--records', request.recordsPath,
      '--stamp', request.stampPath,
      ...doorArgs(request, placement),
    ];
    /*
     * `--triage` WHEN A TRIAGE RAN IN FRONT OF THIS ROW (`CleanRequest.triagePath`).
     * Only the flagged blocks are asked; the rest are recorded as examined and
     * clean. Absent is today's run exactly — every block put to the cleaner.
     */
    if (request.triagePath !== undefined) args.push('--triage', request.triagePath);
    args.push(...removalArgs(request.removal));
    // The host's book glossary (`CleanRequest.fixedReadings`) — the same file its triage was handed.
    if (request.fixedReadings !== undefined) args.push('--fixed-readings', request.fixedReadings);
    /*
     * `--concurrency` IS `doorArgs`' NOW, with the endpoint and the model it
     * belongs beside — see `concurrencyArgs`. It was pushed here and on no other
     * text line, which is how translate and simplify came to run twelve deep
     * against a serial door.
     */
    /*
     * NO `--keep-model` ANY MORE. The engine neither loads nor unloads a model
     * since Owen's ruling of 2026-09-13 — the operator owns what is resident —
     * so the flag is gone from the engine and a line carrying it would die at
     * its argument parser before a block was read.
     */
    /*
     * The reading these answers are about, written into every row and read by
     * nobody in the engine — `Overlay.generation`'s contract, exactly as the
     * translate line below carries it.
     */
    if (request.generation !== undefined && request.generation.length > 0) {
      args.push('--generation', request.generation);
    }
    return args;
  }
  if (request.kind === 'translate' || request.kind === 'simplify') {
    /*
     * A translation shares nothing with a conversion's command line but the
     * program name. No `--format` and no `--out`: this run writes RECORDS, one
     * row per flowing block keyed by the block's own position in the reading
     * bank, and the engine refuses an `--out` beside `--records` by name because
     * the EPUB it would write is a book nobody would ever open.
     *
     * `--endpoint`, `--model` and `--server` are `doorArgs`' — one answer about
     * where this run's compute goes, applied once (docs/SLOTS.md §3). The
     * engine's settings fallback must never decide which machine a job runs on,
     * so the flag is on the line whichever slot won.
     *
     * `--records` IS THE CACHE AS WELL AS THE PRODUCT, which is why there is no
     * `--bank` on this line any more and why the engine refuses the pair. It was
     * the exact counterpart of `--readings` on a conversion — both hours of a
     * model held as answers — and it stopped being optional the day a 456-block
     * book was killed at block 152 having written nothing at all. Nothing about
     * that is weakened: an unchanged block's question is already answered in the
     * records file and is never asked twice, and every answer is appended the
     * moment it is accepted.
     */
    const args = [
      'translate',
      /*
       * THE BOOK, AND NOT A RENDERING OF IT. `--epub` used to be here, pointed at
       * the position's cast, and everything about that was one hop too far: the
       * words came back out of markup they had been written into, and each block
       * was named by the `data-bf-src` stamped on it rather than by the name it
       * already had. This is the position's book file with its whole chain of
       * changes replayed into it by main (`materializeBook`, electron/book.ts) —
       * so a struck row is not in it, and the records that come back are keyed by
       * the ROWS' OWN IDS, which is what the derived book in the target language
       * is materialised against when this lands (docs/RENDERER.md §4).
       *
       * NO `--source-records` ANY MORE, and the engine refuses it beside this
       * flag: a book file at a position under a translation already holds the
       * parent's words, so a chain is a fact about the file rather than a second
       * path on the command line.
       */
      '--book', bookOf(request),
      '--records', request.recordsPath,
      '--to', languageOf(request),
      ...doorArgs(request, placement),
    ];
    /*
     * ── THE CHAIN, WHICH IS NOW ONE FLAG AND NO MACHINERY AT ALL ──────────────
     *
     * `--from` says which language the words in that book file are in, and the
     * words themselves are the parent translation's because the file IS its
     * derived book. Composed by the plan off the ledger (`planTranslation`,
     * electron/workspace.ts): nothing reads a language out of a file of
     * sentences, and a guess would put "German → Hungarian" on a prompt holding
     * English.
     */
    if (request.from && request.from.trim().length > 0) args.push('--from', request.from.trim());
    /*
     * ── AND THE ONE FLAG THAT MAKES THIS A REWRITE INSTEAD ────────────────────
     *
     * `--rewrite` swaps the prompt and touches nothing else on this line: the same
     * book, the same records file, the same model, the same endpoint. `--to`
     * carries the book's OWN language beside it and the engine is content with a
     * pair that matches, because a rewrite is same-language by design — which is
     * the one thing about this command that would look like a mistake to somebody
     * reading it in a terminal, and is not one.
     *
     * IT IS THE KIND THAT DECIDES IT NOW, where it used to be the presence of a
     * field: `SimplifyRequest.rewrite` is required, so the flag is on this line
     * exactly when the job is a rewrite and never because a mode was left over on
     * a request somebody built by spreading another one.
     */
    if (request.kind === 'simplify') args.push('--rewrite', request.rewrite);
    /*
     * The reading these answers are about, written into every row and read by
     * nobody in the engine — `Overlay.generation`'s contract, one folder over. It
     * is what lets the app tell records made against THIS pass over the pages from
     * records left beside a book that has since been read again.
     */
    if (request.generation !== undefined && request.generation.length > 0) {
      args.push('--generation', request.generation);
    }
    if (request.instructions && request.instructions.trim().length > 0) {
      args.push('--instructions', request.instructions.trim());
    }
    return args;
  }
  /*
   * ── READING THE PAGES ────────────────────────────────────────────────────
   *
   * `foundry vlm-read --pdf X --readings Y`. It fills the bank, drops the
   * completion marker beside it, and writes no document at all.
   *
   * ── ONE FLAG (Wave 41), AND THE ENGINE STILL HAS TWO ───────────────────────
   *
   * This chose between `--pdf` and `--pages` off `ReadRequest.inputKind`, because
   * a captured project's archive was a folder of photographs and the engine had
   * learned to read one at Wave 21. Owen ended the choice: *"if we're building
   * the bank from the images anyway maybe we should just build it from the pdf.
   * why not? it would help maintain provenance, and nothing will be lost."* The
   * mint writes the PDF, so there is one input and one story — bank ← PDF ←
   * pages — and `planReading` states the provenance argument in full.
   *
   * `vlm-read --pages` IS UNTOUCHED AND STAYS. It is a capability of the command
   * and works from a terminal exactly as it did; what retired is the app's
   * selection of it. The engine's own *"a reading is of exactly one thing"*
   * refusal for a run naming both is now unreachable from here twice over.
   *
   * NO `--out` AND NO `--format`, which is the whole of the split on the command
   * line: this run has no opinion about what the book will eventually be, and it
   * cannot be given one. The person who ordered it may generate an EPUB tonight
   * and plain text next week, and neither of those decisions is a fact about the
   * reading — so neither can be asked for while it is being configured.
   */
  if (request.kind === 'read') {
    const args = ['vlm-read', '--pdf', request.inputPath, '--readings', request.readingsPath];
    if (request.skipPages && request.skipPages.trim().length > 0) {
      args.push('--skip-pages', request.skipPages.trim());
    }
    if (request.language && request.language.trim().length > 0) {
      args.push('--language', request.language.trim());
    }
    /*
     * ── A READING THAT WAS PLACED ON A CRUCIBLE SAYS SO ON THE LINE ──────────
     *
     * The note above this function said *"No `--vlm-endpoint`. The settings
     * screen owns which backend reads the pages"*, and that was the whole truth
     * while `CRUCIBLE_READS` was false: there was one reader, the settings file
     * named it, and the engine read the same file. Owen's ruling made pages a
     * dispatched class like any other (crucible-dispatch.ts), so there is a
     * SECOND owner of that question now — the placement — and it wins for the
     * one run it is about. Without these two flags the engine would fall back to
     * `backend.endpointUrl` and post the pages to this machine's own reader,
     * which is a placement nothing honoured and a card nothing accounted for.
     *
     * THE TEXT DOOR'S `--endpoint` AND THIS ONE ARE SPELLED DIFFERENTLY BY THE
     * ENGINE, and that is why `/v1` is appended here rather than stored on the
     * placement. `normaliseVllmEndpoint` (src/translate/vllm.ts) adds the version
     * prefix for the text path; `--vlm-endpoint` is used exactly as given
     * (src/vlm/endpoint.ts composes `<it>/chat/completions`), which is why the
     * local reader's own URL is `http://localhost:8000/v1`. One placement, two
     * dialects, and the difference is said here instead of silently working on
     * one path and 404ing on the other.
     *
     * THE TOKEN IS NOT ON THIS LINE. It is in `placement.env`, as it is for every
     * other act, and `resolveEndpointHeaders` (src/backend/endpoint-headers.ts)
     * is what the reading path already reads it through.
     */
    if (placement.endpoint !== null) {
      args.push('--vlm-endpoint', `${placement.endpoint.replace(/\/+$/, '')}/v1`);
      if (placement.model !== null && placement.model.length > 0) {
        args.push('--vlm-endpoint-model', placement.model);
      }
    }
    return args;
  }

  /*
   * ── COMPILING THE BOOK SOMEBODY EDITED ───────────────────────────────────
   *
   * `foundry vlm-compile --book <derived> --out <product>`, and it is a different
   * command rather than a flag on the one below because it takes a different
   * INPUT: not the bank and a curation, but the book itself, with this position's
   * whole chain of changes already replayed into it by main (`materializeBook`,
   * electron/book.ts). The engine has never heard of the op grammar and never
   * will — the replay lives once, in this process, because the renderer draws
   * from it too (docs/RENDERER.md §9) — so what crosses the boundary is a
   * document and the engine's job is to compile what it is handed.
   *
   * NO `--reuse-readings` and NO `--final`. The first is about
   * a bank this run never opens. The third is about a choice this command does
   * not have: there is no cast to write from a book file, so the edition's rules
   * are the compile's constants (see `vlm-compile`'s own help).
   *
   * THE FACSIMILE NEVER REACHES HERE, and that is by construction rather than by
   * a test: `--format pdf` reprints the scan's own photographed lines from the
   * raw bank, so `planExport` never materialises a book for one and the field
   * that would send it down this branch is absent (docs/RENDERER.md §6).
   */
  if (request.bookPath !== undefined) {
    const args = ['vlm-compile', '--book', request.bookPath, '--out', request.outputPath];
    /*
     * THE FIGURES, WHICH ARE THE READING'S AND NOT THE BOOK FILE'S. A row names
     * its crop by NAME and the directory is composed from the bank the figures
     * were cut beside (`imagesDirFor`, electron/projects.ts) — the same
     * composition the pane serves them through. Passed only when it is there: the
     * engine refuses a directory it cannot open, and a book with no pictures in
     * it has none to be given.
     */
    const figures = imagesDirFor(request.readingsPath);
    if (existsSync(figures)) args.push('--images', figures);
    /*
     * AND THE RECORD THE PERSON TYPED, ON THE PACKAGE ITSELF. The bank route
     * takes its title from the PDF and has the metadata stamped on afterwards;
     * this route has no PDF to ask, so the merged patch reaches the book while it
     * is being made. The stamp still happens after it for an EPUB — the same two
     * commands, unchanged — and this is what makes a compiled `.txt` carry the
     * corrected title too, which nothing before could.
     */
    if (metadata['title'] !== undefined) args.push('--title', metadata['title']);
    if (metadata['creator'] !== undefined) args.push('--author', metadata['creator']);
    /*
     * ── AND THE RECEIPT, WHEN THESE WORDS WERE CLEANED FOR A NARRATOR ─────────
     *
     * `--narration-stamp <that step's stamp.json>` puts `bookforge:narration-text`
     * into the OPF of the EPUB this run writes, so the FILE says what was done to
     * it and a narrator opening it months later needs nothing from this app.
     *
     * COMPOSED BY THE PLAN AND NEVER HERE (`planRendering`, electron/workspace.ts),
     * off `cleanupInEffect` at the step this rendering is about — which is the
     * position for a press and the named row for a host's export. Deciding it here
     * would mean this function walking a ledger it does not have, at spawn time,
     * about a position that may have moved since the button.
     *
     * IT RIDES THE COMPILE ROUTE BECAUSE THAT IS WHERE THE EPUBS ARE. Every epub
     * and txt export materialises and compiles (`planRendering`'s `compiles`), so
     * this branch is the only one that writes a book from a position a cleanup can
     * be in effect at — the branch below reprints a scan's photographed pages,
     * which is a facsimile and has no narration in it.
     *
     * A `.txt` COMPILE CARRIES IT TOO AND IT COSTS NOTHING: there is no OPF in a
     * text file, the engine writes nothing, and withholding the flag from one of
     * the two formats would be this file deciding which products the engine's own
     * command applies to.
     */
    if (request.narrationStamp !== undefined && request.narrationStamp.length > 0) {
      args.push('--narration-stamp', request.narrationStamp);
    }
    return args;
  }

  /*
   * ── RENDERING THE BOOK ───────────────────────────────────────────────────
   *
   * `--reuse-readings` IS THE FLAG THAT MAKES THIS FREE, and it is passed on
   * every generate without a switch anywhere that could turn it off. The bank is
   * complete — nothing reaches this branch until a reading has landed — and
   * without the flag the engine would treat a completed bank beside a marker as
   * a book to read AGAIN, which is three hours of GPU in answer to somebody
   * pressing a button labelled with a file format.
   */
  const args = [
    'vlm-convert',
    '--pdf', request.inputPath,
    '--out', request.outputPath,
    '--readings', request.readingsPath,
    '--reuse-readings',
  ];
  /*
   * ── AND THE TRANSLATION'S OWN WORDS, WHICH IS THE WHOLE OF THE SECOND STAGE ─
   *
   * A rendering standing under a translation used to be TWO spawns: this one into
   * a nameless EPUB in the temp directory, then `translate` reading that file and
   * writing the real one. It is one spawn and two flags now. `--records` puts the
   * translation's per-block answers into the blocks as the book is assembled, and
   * `--language` declares what comes out — a records file is a file of sentences
   * and does not say what language it is in, so without it `dc:language` and every
   * `xml:lang` would keep the source book's answer and the product would lie about
   * itself to every reader that asked.
   *
   * NOT TESTED FOR EXISTENCE, and that is deliberate. An absent records file means
   * the answers this product is MADE OF are gone, and a run that quietly wrote the book in its original language while the
   * row said Hungarian is the worst outcome available here. The engine refuses a
   * `--records` it cannot open, by name, and that refusal is the right one.
   *
   * THEY TRAVEL TOGETHER OR NOT AT ALL — `planRendering` composes both or neither
   * — so a book cast in a language it does not hold is not a state this app can
   * construct.
   */
  if (request.records !== undefined && request.records.length > 0) {
    args.push('--records', request.records);
    if (request.language !== undefined && request.language.length > 0) {
      args.push('--language', request.language);
    }
  }
  // Passed only when it is not the default, so an EPUB job's command line is the
  // one it has always been and a diff of two runs shows what actually differed.
  // The extension the plan chose already agrees with it; the engine
  // refuses the pair outright if it ever stops agreeing.
  if (request.kind !== 'epub') args.push('--format', request.kind);
  /*
   * ── AN EXPORT ASKS FOR THE EDITION, AND A GENERATE NEVER DOES ─────────────
   *
   * `generated/` is the workbench and `final/` is where a finished book is filed
   * (docs/WORKBENCH.md §8), and the two want different documents out of the same
   * bank. The cast keeps its marks because the person curating has to see what
   * they struck: a struck footnote is still in the book wearing `data-bf-cut`,
   * and every element still carries the attributes select mode addresses it by.
   * The edition has none of that — the struck note is not written, its reference
   * numbers keep the digit the page printed and lose their link, and the editing
   * attributes are not emitted at all.
   *
   * ONE FLAG, DECIDED OFF THE ONE FIELD THAT SAYS WHERE THE FILE IS GOING —
   * `export`, the same field `pump()` resolves into `exporting` for the rotation
   * and the landing. It is asked here of the REQUEST THIS FUNCTION WAS HANDED,
   * which is the stored one for every job except an export carrying a metadata
   * record: that one is handed a copy aimed at a temp file, and the copy carries
   * the flag exactly as the stored request does.
   *
   * A CAST'S COMMAND LINE IS UNTOUCHED: no `export`, no flag, and the engine's
   * default is the book it has always written.
   *
   * A TRANSLATED EXPORT GETS IT LIKE ANY OTHER, WHICH IT COULD NOT BEFORE. That
   * job used to be three runs — render, translate, then `epub-final` to tidy what
   * came back — because `translate` reads the very stamps this flag withholds
   * (FINAL_NEEDS_STAMPS, src/translate/book.ts), so the edition could only be made
   * AFTER the translation, from a finished book. Records are substituted at the
   * assembly, upstream of everything `--final` decides, so the edition and the
   * translation are made by one run and the tidy stage is gone.
   */
  if (request.export === true) args.push('--final');
  /*
   * NOTHING ELSE. `--skip-pages` and `--language` used to be here and are gone
   * from this branch: both are statements about READING the book, they were
   * answered when the pages were read, and a rendering that could be handed a
   * different page-skip from the reading it renders would be a rendering of a
   * book nobody read. `--strip-note-markers` went with them — it is BookForge's
   * narration flag and this app has never exposed it (see the OCR dialog).
   */
  return args;
}

/**
 * THE RECORD A PRODUCT SHOULD CARRY, or nothing at all.
 *
 * Two lines over `projectDirOf` and `metadataForProduct`: the module that knows
 * where a project's files live answers the question, and this is the bridge from
 * a path a job holds to that answer. A product outside every project — there is no such export today, and
 * the type system cannot say so — carries nothing, which is the honest answer for
 * a file with no ledger behind it.
 *
 * ASKED OF THE STEP THE JOB CAPTURED, never of the position now. A pointer move
 * made while an export waited in the queue must not change which corrections the
 * book that comes out of it carries — the same rule `readingsPath` obeys one layer
 * up, and `metadataInEffect` falls back to the position for a captured step that
 * has since been deleted.
 */
export async function recordFor(
  outputPath: string,
  kind: ConversionKind,
  parentStep: string | null,
  /** The request's own project, for a file written outside it (`homeOf`). */
  home: string | null = null,
): Promise<Record<string, string>> {
  const dir = home ?? projectDirOf(outputPath);
  if (dir === null) return {};
  return metadataForProduct(dir, kind === 'pdf' ? 'pdf' : 'epub', parentStep);
}

/**
 * A merged patch as flags — `--title "…" --creator "…"`, in the order the engine
 * declares its fields.
 *
 * ONE LINE PER FIELD AND NO INTERPRETATION. Both metadata commands take exactly
 * this shape, and both refuse a blank value by name (an empty `dc:title` is a book
 * claiming to be called nothing) — so an empty one is dropped here rather than
 * turned into a failed export. `mergedMetadata` has already dropped them; this is
 * the second half of one rule stated where the command line is composed, because
 * this is the last place anything can still be wrong.
 */
export function metaFlagsFor(record: Record<string, string>): string[] {
  const flags: string[] = [];
  for (const [field, value] of Object.entries(record)) {
    if (typeof value !== 'string' || value.trim().length === 0) continue;
    flags.push(`--${field}`, value);
  }
  return flags;
}
