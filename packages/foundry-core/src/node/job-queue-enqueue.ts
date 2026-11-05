/**
 * job-queue-enqueue — putting work in the queue: conversions, text passes, a cleanup with its triage, and analysis.
 */
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { cleanTriageFileFor, analysisRankFileFor } from './projects';
import { REWRITE_LABELS } from '../shared/ledger';
import type { AnalysisRankRequest, AnalyzeRequest, CleanRequest, CleanTriageRequest, Job, JobRequest, TextPassRequest } from '../shared/types';
import { pump } from './job-queue-board';
import { chainedBehind, homeOf, placedBy, productOf, promisedBy } from './job-queue-products';
import { shelfJobs } from './job-queue-shelf';
import { changed, hostQueue, jobs, requests, samePath } from './job-queue-state';

/**
 * A PERSON PRESSED SOMETHING IN THIS WINDOW AND IT WANTS A CONVERSION.
 *
 * ── This is the routed door, and `enqueueHere` is the internal one ──────────
 *
 * With a host queue registered, this hands the request to the host and answers
 * with the host's own row: nothing is minted here, nothing is held here, and the
 * host's pump decides when. With no host queue — standalone Foundry, and every
 * host that has not moved — it is `enqueueHere` and the behaviour below is
 * exactly what it has always been.
 *
 * ── ONLY WHAT A PERSON PRESSED ROUTES, AND THE LINE MATTERS ─────────────────
 *
 * The whole of the rule is written where it is easiest to get wrong — at
 * `exportEpubFromStep`'s enqueue in electron/mount.ts, which calls `enqueueHere`
 * and must never call this. What reaches THIS function is the `queue:*` IPC
 * doors: a person, in the hosted window, pressing Read or Export or Generate.
 *
 * THE ANSWER IS THE HOST'S ROW, UNINSPECTED. It is a `Job` because the host
 * mints it in our shape (`FoundryHostQueue.enqueue`), and it goes straight back
 * out over `queue:enqueue` to the renderer, which compares its id against the
 * mirror to tell an added row from a duplicate. That comparison works on the
 * host's ids for the same reason it works on ours: the mirror is the host's list
 * hosted, so both sides of the comparison come from one place.
 */
export function enqueue(request: JobRequest, parentStep: string | null = null): Job {
  // A PRODUCT PATH THAT IS NOT ABSOLUTE IS REFUSED BY NAME, before either queue
  // sees it. Main resolves a relative path against its own working directory,
  // which is nowhere a person chose — a renderer that built the path with the
  // wrong separator once had a whole EPUB written into the host app's repo
  // (2026-09-07). The renderer is the only place such a string can be minted,
  // and this is the one door every request passes through.
  const product = productOf(request);
  if (!path.isAbsolute(product)) {
    throw new Error(
      `The ${request.kind} request names its output as "${product}", which is not an absolute `
      + 'path on this machine, so it would be written relative to the app\'s working directory. '
      + 'Nothing was queued. (A path with backslashes on macOS/Linux is one relative segment.)',
    );
  }
  const host = hostQueue();
  if (host !== null) {
    // THE CHAIN LINK RIDES ON THE REQUEST — `enqueueTextPass` carries the whole
    // argument. A reading is never deferred (`deferralOf` narrows it away), so
    // the guard here is the compiler's rather than a second rule.
    const after = chainedBehind(request);
    return host.enqueue(
      after !== undefined && request.kind !== 'read' ? { ...request, after } : request,
      parentStep,
    );
  }
  return enqueueHere(request, parentStep);
}

/**
 * Put a conversion in the queue, HELD.
 *
 * THE INTERNAL DOOR: it never routes, whoever is hosting. Foundry's own
 * unattended work comes through here — an export the host ORDERED through the
 * mount seam, which by ordering it has already scheduled — and so does every
 * enqueue when nobody has registered a queue of their own.
 *
 * Returns the EXISTING row when one is already waiting or running to write the
 * same file, which is `enqueueEnvInstall`'s rule applied to the thing it
 * actually protects: two rows writing one output is the worst outcome
 * available — the second run overwrites the first while the first is still
 * reading, and the file on disk ends up neither. The OUTPUT is the identity
 * because that is what collides; the same book converted to an EPUB and to a
 * PDF is two different files and therefore two honest rows.
 */
export function enqueueHere(
  request: JobRequest,
  /**
   * The project's position, RESOLVED BY THE CALLER BEFORE IT CALLED.
   *
   * ── Why it is an argument rather than read in here ──────────────────────────
   *
   * Reading a position means reading a catalogue off the disk, and this function
   * is synchronous on purpose: it returns the row the shelf draws, immediately,
   * so pressing Add cannot leave a moment where nothing has appeared. Making it
   * async to fetch one field would put a file read between a person's click and
   * its own feedback, for a fact the IPC handler is already awaiting things to
   * compose.
   *
   * WHAT MATTERS IS THE MOMENT, AND THE MOMENT IS THE SAME ONE. The handler
   * resolves the position and enqueues in one turn, so this is the position at
   * the press — which is the whole point (`Job.parentStep`). Null for a project
   * with no history yet, and for every caller that has nothing to say.
   */
  parentStep: string | null = null,
): Job {
  /*
   * WHAT THIS JOB PRODUCES, which for a reading is the BANK — asked of
   * `productOf`, which is the only place that rule is written down. The argument
   * for why it is a function rather than the ternary that used to stand here is
   * at `productOf` itself.
   */
  const outputPath = productOf(request);
  const already = pendingFor(outputPath);
  if (already) return already;

  const job: Job = {
    id: randomUUID(),
    inputPath: request.inputPath,
    outputPath,
    /*
     * AN IMPLIED EXPORT SAYS WHAT IT IS FOR, in the host's own words for it.
     * `home` is set by exactly one caller — `exportEpubFromStep(…, { to })`, the
     * EPUB a host makes because somebody pressed Narrate and there was no file
     * (shared/types.ts, `ConversionRequest.home`) — so this is not a guess about
     * intent. BookForge's landing row calls itself "Book for narration", and two
     * rows for one act saying it in different words would be worse than either
     * (their session's request, 2026-09-08). Every other export keeps the
     * filename the shelf has always shown it under.
     */
    ...(homeOf(request) !== null
      ? { title: `Book for narration — ${path.basename(outputPath)}` }
      : {}),
    kind: request.kind,
    /*
     * ── THE HOLD IS FOR THE EXPENSIVE ONE ONLY ──────────────────────────────
     *
     * A reading is held, for every reason the hold was built for: it is hours of
     * GPU against a file the user picked in a dialog they may have picked wrong,
     * and holding is what makes a BATCH possible — queue four books, look them
     * over, press Start once.
     *
     * A RENDERING RUNS THE MOMENT IT IS ASKED FOR, and making it wait would be
     * the hold applied to the thing it was never about. It is arithmetic over
     * answers already on the disk: seconds, offline, no model, no server, and
     * repeatable as often as somebody likes. There is nothing to commit to and
     * nothing to review — and a person who pressed Generate and then had to find
     * a shelf and press Start would be pressing a second button to confirm a
     * decision they made by pressing the first.
     *
     * It still goes THROUGH the queue and still waits behind whatever is
     * running. That is the machine being busy rather than the person being
     * asked, which is the distinction `held` and `queued` have always drawn.
     *
     * A TRANSLATED RENDERING IS STILL A RENDERING, and it did not used to be.
     * This line held a Generate standing under a translation, honestly: that job
     * ran the TRANSLATOR as its second stage, and a seeded bank made it cheap
     * rather than free — text edited since the translation was re-asked of a
     * model, and a cold Ollama made it a translation run in everything but the
     * button that started it. There is no second stage now. A translated book is
     * one `vlm-convert` with the records substituted into the blocks: no model,
     * no socket, seconds, and repeatable as often as somebody likes. So it is
     * queued like every other rendering, and the hold goes back to meaning what
     * it has always meant — nothing expensive starts until the user says so.
     */
    state: request.kind === 'read' ? 'held' : 'queued',
    progress: null,
    parentStep,
    /*
     * CARRIED ONTO THE PUBLIC SHAPE, which almost nothing on a request is. The
     * shelf's row is everything the renderer knows about a job, and this is the
     * one fact that distinguishes a save's own book from the two `epub` jobs a
     * person asks for — which matters there because a finished one opens itself.
     * See `Job.forStep`.
     */
    ...(request.kind !== 'read' && request.forStep !== undefined
      ? { forStep: request.forStep }
      : {}),
    // WHAT THIS ROW WILL PUT IN THE TREE, AND WHAT IT WAITS FOR — see
    // `promisedBy`. Absent for everything but an export and a text pass, which is
    // every row this door has minted since it existed.
    ...placedBy(request.kind),
    ...promisedBy(request),
    createdAt: Date.now(),
  };
  jobs.push(job);
  requests.set(job.id, request);
  changed();
  if (job.state === 'queued') void pump();
  return job;
}

/**
 * A job already waiting or running to write this file, if there is one.
 *
 * `done`, `failed` and `cancelled` rows are deliberately NOT matched: those are
 * a record of something that already happened, and refusing to re-run a
 * conversion because it failed an hour ago would make the shelf's own history
 * the reason the retry is impossible.
 */
/**
 * THE ROW ALREADY WAITING TO MAKE THIS, WHEN "THIS" IS CHAINED ON A PROMISE.
 *
 * ── Why the product path is not enough for a chained pass ───────────────────
 *
 * `pendingFor` dedupes on the product, and for an ordinary press the product is
 * the identity: two presses of "translate to German" from one step name one
 * records file, and the second press finds the first row. A pass chained on a
 * PROMISE breaks that in one case — a deferred simplify carries a PLACEHOLDER
 * product minted fresh at every press (`pendingRecordsFileFor`, shared/ledger.ts,
 * where the eight characters are the step id's), because the real name needs a
 * language the promised chain cannot yet state. Two presses, two placeholders,
 * two rows, and once the parent landed both would resolve to ONE file and the
 * second would fail at spawn with `renameProduct`'s sentence — a refusal an hour
 * late for a mistake made in a second.
 *
 * So a chained pass is deduped on WHAT IT IS rather than on what it will be
 * called: the row it waits on, the act, and the one setting that makes the act
 * this act — the target language of a translation, the mode of a rewrite (a
 * cleanup has neither). Those are exactly the facts `promisedBy` puts on the row
 * (`Job.after`, `Job.into`, `Job.mode`), so the question is asked of the rows
 * and not of the requests, which is what lets it be asked of a HOST's rows the
 * same way — BookForge was asked to key promised passes on the same three
 * (2026-09-07), so both queues answer a double press with one row.
 *
 * ORDINARY PRESSES ARE UNTOUCHED: a request with no `after` is not chained, and
 * this answers undefined before `pendingFor` is asked, exactly as before.
 */
export function pendingChained(request: TextPassRequest): Job | undefined {
  const after = request.after;
  if (after === undefined) return undefined;
  const into = request.kind === 'translate' ? request.to : undefined;
  const mode = request.kind === 'simplify' ? request.rewrite : undefined;
  return jobs.find(
    (job) => (job.state === 'held' || job.state === 'queued' || job.state === 'running')
      && job.after === after
      && job.kind === request.kind
      && job.into === into
      && job.mode === mode,
  );
}

export function pendingFor(outputPath: string): Job | undefined {
  const key = path.resolve(outputPath).toLowerCase();
  return jobs.find(
    (job) => (job.state === 'held' || job.state === 'queued' || job.state === 'running')
      && path.resolve(job.outputPath).toLowerCase() === key,
  );
}

/**
 * Is a live job producing this file right now?
 *
 * Asked by main before "edit transformed text" rewrites a records file whole: a
 * translation appends to that file for hours, and a whole-file swap made in the
 * middle of its run would drop every answer the run lands between the read and
 * the rename. The check and the write are not one atom — a job could start in
 * the millisecond between — but the whole window a run is actually open is
 * caught here, and the sentence names the honest way out: wait, or cancel the
 * run.
 */
export function producing(outputPath: string): boolean {
  return pendingFor(outputPath) !== undefined;
}

/**
 * WHAT THE SHELF CALLS A TEXT-PASS ROW, or nothing at all for the one that keeps
 * its book's name.
 *
 * ── The rule, which is older than the third pass ────────────────────────────
 *
 * A row falls back to the project's title, and that is the right answer while a
 * book can only be in the queue for one reason. It stopped being one the moment
 * two different buttons produced the same kind of job about the same book:
 * somebody who queued a rewrite and a translation of one book would be looking at
 * two identically named rows deciding which to Start.
 *
 * SO THE ACT WINS OVER THE BOOK, for every row that has a choice to explain. What
 * is on screen is a short list of things somebody is about to spend a night of GPU
 * on, and "Clean text" is the fact they are checking; the book is one hover away
 * in the row's paths, where every filename in this shelf already lives.
 *
 * A TRANSLATION IS THE ONE THAT SAYS NOTHING, and that is deliberate rather than
 * an omission. It is the ordinary case — the row that has been named for its book
 * since this queue existed — and the two that speak are the two that would
 * otherwise be indistinguishable from it.
 *
 * "Clean text" IS OWEN'S OWN WORD, said the same in all three places a person
 * meets it (2026-09-05): the tile, this row, and — as *"Cleaned for narration"* —
 * the step in the history, which is read later and by somebody else.
 *
 * ONE FUNCTION BECAUSE TWO DOORS COMPOSE A ROW. `enqueueTextPass` and `runJob`
 * both build one, and the title was spread inline in both — two correct copies of
 * a rule, which `productOf`'s own header calls a defect with a delay on it.
 */
export function titleForTextPass(request: TextPassRequest): { title: string } | Record<string, never> {
  if (request.kind === 'simplify') return { title: `Simplify — ${REWRITE_LABELS[request.rewrite]}` };
  // A readings-only pass is the host's act, and the row says it in the host's words.
  if (request.kind === 'clean') return { title: request.readingsOnly?.label ?? 'Clean text' };
  return {};
}

/**
 * WHAT THE SHELF CALLS A CLEANUP'S TRIAGE ROW — the act first, on
 * `titleForTextPass`'s rule, and the act is Clean text's.
 *
 * The two rows sit together in the list, one behind the other, and a person
 * reading them is checking two things: that this is the cleanup they asked for,
 * and which half of it is running. "Clean text — triage" says both, in the shape
 * the rewrite's row already reads in ("Simplify — plain terms"): the act somebody
 * pressed, then what this row of it is. A constant because two doors mint a
 * triage row (`enqueueCleanTriage`, `runDetached`) and a title spelled twice is
 * `productOf`'s defect with a delay on it.
 */
export const CLEAN_TRIAGE_TITLE = 'Clean text — triage';

/**
 * WHAT THE SHELF CALLS AN ANALYSIS'S RANKING ROW — `CLEAN_TRIAGE_TITLE`'s rule:
 * the act somebody pressed, then which half of it this row is.
 */
export const ANALYSIS_RANK_TITLE = 'Analysis — ranking';

/**
 * Put a TEXT PASS in the queue — a translation, a rewrite or a narration cleanup.
 *
 * Behind whatever is already running, always. The engine holds an Ollama model
 * for the length of a book and a conversion holds a vision model for the length
 * of another; running both means two models resident on one GPU, which on the
 * hardware this is built for is an out-of-memory failure four hours in.
 *
 * IT ROUTES LIKE `enqueue`, and it has no `…Here` twin for one reason: nothing
 * inside this app orders a text pass. Every one of them in Foundry's history
 * arrived from a person filling in a dialog, so this door has exactly one caller
 * per dialog and the branch below IS the door deciding. A second, unrouted door
 * would be a name nobody could prove the need for.
 *
 * ── ONE DOOR FOR THREE KINDS, WHICH IS THE SHAPE OF THE SPLIT ───────────────
 *
 * This was `enqueueTranslate` and it took a `TranslateRequest`, because a rewrite
 * was a translation wearing a mode. Three actions now (Owen, 2026-09-05: *"it
 * isnt a translate job … translate, simplify, and cleanup are all three similar
 * steps"*) and still ONE door, because everything this function does is the same
 * for all three: route to the host if there is one, dedupe on the records file,
 * hold the row, name the act. Three doors with one body is the defect
 * `productOf`'s header is about, arriving at the enqueue instead of at the
 * dedupe.
 *
 * ── AND WHAT ROUTING A `clean` HOSTED MEANS, SAID OUT LOUD ──────────────────
 *
 * It hands the host a request shape whose `kind` its VENDORED SNAPSHOT of
 * `shared/api.ts` may predate (docs/BOOKFORGE-HANDOFF.md §8). That is deliberate
 * and it is not `enqueueAnalysis`'s case: an analysis is refused hosted because
 * nothing over there wants one, where a cleanup exists ONLY on BookForge's behalf
 * (Owen: *"cleanup will only ever be done on behalf of bookforge"*) — the tile is
 * drawn nowhere else, so the only window this door is ever reached from is one
 * whose host asked for the feature. It goes live on the re-vendor, with the
 * handoff doc carrying the note.
 */
export function enqueueTextPass(
  request: TextPassRequest,
  /** The position at the press. See `enqueue` above and `Job.parentStep`. */
  parentStep: string | null = null,
): Job {
  const host = hostQueue();
  /*
   * ── THE CHAIN LINK IS COMPOSED BEFORE THE ROUTING, AND HAS TO BE ───────────
   *
   * `chainedBehind` reads `shelfJobs()`, which hosted is the HOST's rows — so the
   * id it answers is one the host minted and one the host's own pump can schedule
   * against. It is put on the REQUEST rather than passed as a third argument
   * because `FoundryHostQueue.enqueue` takes two, and widening a seam somebody
   * else's vendored snapshot declares is a re-vendor; a field on a request shape
   * they already destructure is not (`FoundryJobRow` carries the note).
   *
   * A HOST THAT IGNORES IT gets today's behaviour, which for a promised chain is
   * wrong in the one way that matters — the cleanup and its export race — and is
   * exactly why the handoff doc names the two fields rather than leaving them to be
   * discovered.
   */
  const after = chainedBehind(request);
  const chained: TextPassRequest = after === undefined ? request : { ...request, after };
  if (host !== null) return host.enqueue(chained, parentStep);
  /*
   * WHAT THIS JOB PRODUCES, which for every text pass is the RECORDS — the same
   * question `enqueueHere` asks about a reading and its bank, asked of the same
   * function so the two can never answer it differently. See `productOf`.
   */
  const outputPath = productOf(request);
  const already = pendingChained(chained) ?? pendingFor(outputPath);
  if (already) return already;

  const job: Job = {
    id: randomUUID(),
    inputPath: request.inputPath,
    outputPath,
    // THE KIND IS THE REQUEST'S OWN, where it used to be the literal `'translate'`
    // for all of them. The row is what the shelf lanes, labels and counts, and a
    // cleanup filed as a translation is a row telling the truth only as far as its
    // own title (`JobKind`, shared/types.ts).
    kind: request.kind,
    state: 'held',
    progress: null,
    ...titleForTextPass(request),
    /*
     * A TRANSLATION IS THE STEP THIS FIELD WAS BUILT FOR. It is the one action a
     * person routinely runs from an earlier row — translate from the reading,
     * click back, translate again into another language — and it is the one that
     * runs for hours, which is exactly the window in which a pointer moves. The
     * user's own scenario in the design document is this job twice.
     */
    parentStep,
    // The step this row will land, and the row it waits behind. See `promisedBy`.
    ...placedBy(chained.kind),
    ...promisedBy(chained),
    createdAt: Date.now(),
  };
  jobs.push(job);
  requests.set(job.id, chained);
  changed();
  // Held, like every other engine job. See this file's header.
  return job;
}

/**
 * THE ROW ALREADY WAITING TO WRITE THIS FILE, IN WHICHEVER QUEUE OWNS THE SHELF.
 *
 * `pendingFor`'s question asked of `shelfJobs()` rather than `jobs`, because the
 * one caller has to ask it BEFORE it knows which queue it is talking to: hosted,
 * `jobs` holds none of the host's rows, and a triaged cleanup already sitting in
 * BookForge's queue would be invisible to the other function. Standalone the two
 * lists are the same array and the two answers are the same row.
 */
export function liveOnTheShelf(product: string): Job | undefined {
  return shelfJobs().find(
    (job) => (job.state === 'held' || job.state === 'queued' || job.state === 'running')
      && samePath(job.outputPath, product),
  );
}

/**
 * Put a cleanup's TRIAGE in the queue — the inner door, one row, routed.
 *
 * `enqueueTextPass`'s arrangement exactly: the link composed first and carried on
 * the request, the host handed the request if there is one, and otherwise a HELD
 * row of our own, deduped on its product. Held because it is expensive in the way
 * everything held is — a model on a card for the length of a book — and because
 * the cleanup behind it is held too, so Start commits to the pair together.
 *
 * NOT EXPORTED. Nothing orders a triage on its own: its whole purpose is the
 * cleanup behind it, and a triage row with no cleanup chained to it would spend a
 * model writing a file nothing reads. {@link enqueueTriagedCleanup} is the door.
 */
export function enqueueCleanTriage(request: CleanTriageRequest, parentStep: string | null): Job {
  const host = hostQueue();
  // The promise the triage waits on, when its cleanup was pressed on a greyed
  // card — the same composition `enqueueTextPass` makes, for its reason.
  const after = chainedBehind(request);
  const chained: CleanTriageRequest = after === undefined ? request : { ...request, after };
  if (host !== null) return host.enqueue(chained, parentStep);
  const outputPath = productOf(chained);
  const already = pendingFor(outputPath);
  if (already) return already;
  const job: Job = {
    id: randomUUID(),
    inputPath: chained.inputPath,
    outputPath,
    kind: 'clean-triage',
    state: 'held',
    progress: null,
    title: CLEAN_TRIAGE_TITLE,
    parentStep,
    ...placedBy('clean-triage'),
    ...promisedBy(chained),
    createdAt: Date.now(),
  };
  jobs.push(job);
  requests.set(job.id, chained);
  changed();
  return job;
}

/**
 * PUT A TRIAGED CLEANUP IN THE QUEUE — the triage, then the cleanup chained
 * behind it, as one gesture.
 *
 * ── The ruling (Owen, 2026-09-23) ───────────────────────────────────────────
 *
 * *"we create a list of blocks that need to be cleaned with snap and then we bring
 * snap down and load the full normal cleaning logic."* Two rows, in that order,
 * each on its own model: the triage holds a small `decide` model and writes the
 * verdicts; the cleanup waits behind it and hands the verdicts to `clean-text
 * --triage`, which asks its big model only about what was flagged.
 *
 * ── Why ONE door for the pair, and not the text-pass door twice ────────────
 *
 * Because the pair is only correct if three facts agree, and all three are main's:
 * the verdicts path (named from the cleanup's records file, `cleanTriageFileFor`),
 * the row the book is made from (the same `at`, or the same promise, on both), and
 * the link (the cleanup's `after` is the triage's ROW id, which exists only once
 * the triage is enqueued). A window composing two requests and a link between two
 * IPC calls would be the renderer naming a file and minting a chain — two things
 * this app has only ever let main do — with a moment between the calls in which a
 * Start could release a cleanup chained to nothing. So the window sends the
 * cleanup it already composes, and main makes the pair in one turn.
 *
 * IT IS NOT `queue:enqueue-translate` WITH A FLAG ON IT, either. That door answers
 * with ONE row, and the dialog has to hold both: a server picked in the dialog is
 * pinned on BOTH rows and Start releases BOTH, and a door that returned only the
 * cleanup would leave the triage parked with nobody holding its id.
 *
 * ── A DEFERRED CLEANUP DEFERS ITS TRIAGE ON THE SAME PROMISE ───────────────
 *
 * A cleanup pressed on a greyed card is made from a step that has not landed. Its
 * triage must read that step's book too, so it carries the same `deferred` and
 * waits behind the promising row; the cleanup waits behind the TRIAGE, not the
 * promise, because a row has one parent and the triage's parent already is that
 * promise. The chain is promise → triage → cleanup, and a loss anywhere in it
 * takes everything after it (`cascadeFrom`, or the host's own cascade).
 *
 * ── A CLEANUP ALREADY WAITING TO WRITE THESE ANSWERS IS THE ANSWER ─────────
 *
 * Asked FIRST, before a triage is minted, because a triage minted in front of a
 * cleanup that is not chained to it would spend a model on a file nothing reads.
 * The row already making these records is the work the person asked for — pressed
 * earlier, with or without a triage — and it comes back with whatever triage it
 * waits behind, so the dialog can say "already queued" and watch the real rows.
 *
 * HOSTED, THE HOST'S QUEUE IS THE ONE ASKED, by the same doors: `host.enqueue`
 * twice, the cleanup carrying the host's own id for the triage row as its `after`.
 * A host that honours `after` has implemented the whole of this; one that ignores
 * it runs the two side by side and the cleanup finds no verdicts file, which the
 * engine refuses by name — docs/BOOKFORGE-HANDOFF.md carries the note.
 */
/**
 * THE CHECK IN FRONT OF A CLEANUP, composed from the cleanup's own request — the
 * one place the pair is made to agree about what they read and what they ask.
 */
export function triageRequestFor(request: CleanRequest): CleanTriageRequest {
  return {
    kind: 'clean-triage',
    inputPath: request.inputPath,
    outputPath: cleanTriageFileFor(request.recordsPath),
    // THE SAME ROW THE CLEANUP'S BOOK IS MADE FROM, so the two books are one
    // content. Copied as the request states it: an absent `at` stays absent,
    // because absence and null are different claims (`CleanRequest.at`).
    ...(request.at !== undefined ? { at: request.at } : {}),
    ...(request.deferred !== undefined ? { deferred: request.deferred } : {}),
    // THE SAME REMOVAL, so the check asks the criteria the cleanup will act on —
    // clean-text refuses verdicts asked about a different one.
    ...(request.removal !== undefined ? { removal: request.removal } : {}),
  };
}

export function enqueueTriagedCleanup(
  request: CleanRequest,
  /** The position at the press. See `enqueue` above and `Job.parentStep`. */
  parentStep: string | null = null,
): { triage: Job | null; clean: Job } {
  const standing = liveOnTheShelf(request.recordsPath);
  if (standing !== undefined) {
    const behind = standing.after === undefined
      ? undefined
      : shelfJobs().find((row) => row.id === standing.after && row.kind === 'clean-triage');
    return { triage: behind ?? null, clean: standing };
  }
  const check = triageRequestFor(request);
  const triage = enqueueCleanTriage(check, parentStep);
  const clean = enqueueTextPass({ ...request, triagePath: check.outputPath, after: triage.id }, parentStep);
  return { triage, clean };
}

/**
 * Put an analysis in the queue.
 *
 * `enqueueTextPass`'s shape, line for line, and the same three decisions:
 *
 *   IT ROUTES, and it has no `…Here` twin. Nothing inside this app orders an
 *   analysis — every one of them arrives from a person filling in the Analysis
 *   dialog — so this door has exactly one caller and the branch below IS the door
 *   deciding. A second, unrouted door would be a name nobody could prove the need
 *   for.
 *
 *   IT IS HELD, like everything expensive. An analysis is a ranking of every
 *   sentence in the book on a decide model followed by one model call per ranked
 *   passage; a person who queued one and a translation wants to look them both
 *   over and press Start once (docs/ANALYSIS.md §7).
 *
 *   IT DEDUPES ON THE REPORT, which is `productOf`'s answer and therefore the
 *   same rule the reading's bank and the translation's records obey. Two analyses
 *   of one book against one checklist from one step are one job, and the file they
 *   would both write is what says so — and it matters more here than anywhere
 *   else, because that file is also the CACHE: two runs appending verdicts into
 *   one report would interleave two processes' answers into one line-delimited
 *   file.
 */
export function enqueueAnalysis(
  request: AnalyzeRequest,
  /** The position at the press. See `enqueue` above and `Job.parentStep`. */
  parentStep: string | null = null,
): { rank: Job | null; analysis: Job } {
  /*
   * ── IT ROUTES, AS THE TRIAGED CLEANUP ROUTES (2026-10-30) ──────────────────
   *
   * Until this date the act was gated off hosted, because the host's queue had
   * never heard of an analysis and a row it could not label or lane was worse
   * than no row. Owen, 2026-10-30: *"analysis is grayed out in
   * foundry/bookforge"* — so the host learned the two kinds (BookForge's
   * foundry-host-queue.ts and queue-steps/foundry-job.ts: `analysis-rank` on the
   * decide act, `analysis` on the analysis act) and the pair is handed over the
   * way `enqueueTriagedCleanup` hands its pair: the ranking first, then the
   * analysis with the HOST'S id for the ranking as its `after`, so the host's
   * own pump runs them in order and a failed ranking takes the check with it.
   *
   * THE SECOND PRESS IS ANSWERED FROM THE HOST'S ROWS (`liveOnTheShelf`), the
   * cleanup's rule: the report is the product and the cache, and two runs
   * appending verdicts into one file would interleave two processes' answers.
   */
  const host = hostQueue();
  if (host !== null) {
    const product = productOf(request);
    const standing = liveOnTheShelf(product);
    if (standing !== undefined) {
      const behind = standing.after === undefined
        ? undefined
        : shelfJobs().find((row) => row.id === standing.after && row.kind === 'analysis-rank');
      return { rank: behind ?? null, analysis: standing };
    }
    const hostRanks = analysisRankFileFor(product);
    const rank = host.enqueue({
      kind: 'analysis-rank',
      inputPath: request.inputPath,
      outputPath: hostRanks,
      reportPath: product,
      categories: request.categories,
      ...(request.at !== undefined ? { at: request.at } : {}),
    }, parentStep);
    const analysis = host.enqueue({ ...request, ranksPath: hostRanks, after: rank.id }, parentStep);
    return { rank, analysis };
  }
  const outputPath = productOf(request);
  const already = pendingFor(outputPath);
  if (already) {
    // The pair that is already waiting, both halves — `enqueueTriagedCleanup`'s
    // answer to a second press, so the dialog can pin and release the two rows it
    // would have made.
    const behind = already.after === undefined
      ? undefined
      : jobs.find((row) => row.id === already.after && row.kind === 'analysis-rank');
    return { rank: behind ?? null, analysis: already };
  }

  /*
   * ── THE RANKING GOES IN FRONT, AS THE TRIAGE GOES IN FRONT OF A CLEANUP ────
   *
   * Owen, 2026-09-25: briefcase's snap ranker replaces the entailment worker,
   * and *"9b for triage"* — so the ranking is its own row on the decide act (the
   * server's clean model, `placeJob`), and the analysis waits behind it on the
   * analysis class. Two rows, each on its own model, one gesture: the press makes
   * both, held, so Start commits to the pair.
   *
   * THE RANK FILE IS NAMED FROM THE REPORT (`analysisRankFileFor`), so the two
   * rows agree on it without asking each other, and the categories file both
   * read is named from the report too (`categoriesFileFor`). A ranking that
   * fails takes the analysis with it (`cascadeFrom`), which is the honest ending:
   * there would be nothing to verify.
   */
  const ranksPath = analysisRankFileFor(outputPath);
  const rankRequest: AnalysisRankRequest = {
    kind: 'analysis-rank',
    inputPath: request.inputPath,
    outputPath: ranksPath,
    reportPath: outputPath,
    categories: request.categories,
    ...(request.at !== undefined ? { at: request.at } : {}),
  };
  const rank: Job = {
    id: randomUUID(),
    inputPath: request.inputPath,
    outputPath: ranksPath,
    kind: 'analysis-rank',
    state: 'held',
    progress: null,
    title: ANALYSIS_RANK_TITLE,
    parentStep,
    ...placedBy('analysis-rank'),
    createdAt: Date.now(),
  };
  jobs.push(rank);
  requests.set(rank.id, rankRequest);
  request = { ...request, ranksPath, after: rank.id };

  const job: Job = {
    id: randomUUID(),
    inputPath: request.inputPath,
    outputPath,
    kind: 'analysis',
    state: 'held',
    progress: null,
    /*
     * THE ROW NAMES THE ACT, on the rewrite's argument one door up. A book can be
     * in this queue for several reasons at once — read it, translate it, analyse
     * it — and a row falling back to the project's title would leave somebody
     * looking at two identically named rows deciding which to Start. What is on
     * screen is a short list of things about to spend a night of GPU, and which
     * act each one is is the fact being checked; the book is one hover away in
     * the row's paths, where every filename in this shelf already lives.
     */
    title: 'Analysis',
    /*
     * THE STEP THE REPORT WILL BE FILED UNDER. An analysis is ordered from a row
     * and runs for an hour, which is exactly the window in which a pointer moves
     * — and where somebody is standing when it lands is nobody's decision, so the
     * press is what the landing appends against.
     */
    parentStep,
    // AND WHICH SLOT IT WILL WAIT FOR, resolved at the press for the same
    // reason `parentStep` is — see `placedBy`.
    ...placedBy('analysis'),
    // Behind its ranking — the one link this pair has, spelled on the row.
    after: rank.id,
    createdAt: Date.now(),
  };
  jobs.push(job);
  requests.set(job.id, request);
  changed();
  return { rank, analysis: job };
}
