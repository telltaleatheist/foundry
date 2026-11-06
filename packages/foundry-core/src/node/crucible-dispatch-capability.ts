/**
 * crucible-dispatch-capability — the capability classes, which of them place on a slot, and reading a server's GET /v1/capability.
 */
import { engineClientFor } from './crucible-registry';
import { type CrucibleServerEntry } from './app-settings';
import { type CapabilityRecord, type CapabilityRow } from '../shared/engine-settings';
import type { JobKind, ModelClass } from '../shared/types';

/**
 * THE CAPABILITY CLASSES, FROZEN, spelled exactly as Crucible's `capability.py`
 * spells them. The five this app can ask for; the other four (`echo`, `asr`,
 * `rvc`, `align`) belong to somebody else's pipeline.
 *
 * `simplify` and `analysis` are separate classes from `translate` even though
 * they select the same 27B on every card anyone has, and Crucible made them
 * separate on Owen's ruling of 2026-09-13: *"they can't lie to the user and say
 * a translate job is running when it's actually a simplify job."* Folding them
 * would make a client ask about `translate` in order to learn whether it may
 * simplify — which is the old lie, one layer down.
 *
 * ── AND IT IS `ModelClass` UNDER ANOTHER NAME, DELIBERATELY ─────────────────
 *
 * The five words were written out twice — here, and as `ModelClass` in
 * shared/types.ts, which is what the vendored lineup files a model's row under.
 * They were identical, and two spellings of one vocabulary is the defect this
 * repo keeps meeting: the acronym list that was fifteen here and seventeen
 * there, and the translate floor that one catalog declared and another quietly
 * lowered. So this is an ALIAS, and the catalog owns the words.
 *
 * The name stays because it says which question is being asked — `ModelClass`
 * is "what may serve this act", `CapabilityClass` is "what a server says it can
 * do" — and because the day Foundry needs a class Crucible has and no model of
 * ours does (`tts`, `asr`), this is the one that widens, on purpose, with a
 * reason written here rather than by drifting.
 */
export type CapabilityClass = ModelClass;

/**
 * A CAPABILITY CLASS IS A NOUN A SERVER FILES A MODEL UNDER — `pages`, `clean`,
 * `translate` — and it is NOT a verb. A user line built as `"${name}" cannot
 * ${capability}` reads "cannot pages", which is engine grammar and exactly the
 * "inner workings" Owen ruled out of user text twice in one night (2026-09-21:
 * *"say what it's doing generically … no inner workings"*).
 *
 * So every user-facing sentence that names the ACT reads it from here, in two
 * shapes: `verb` for "<server> can't <verb>" / "no server can <verb>", and
 * `noun` for "route <noun> work". ONE map, so the six classes read the same in
 * every sentence — and a new class is a compile error here until someone gives
 * it words a person would say, rather than leaking its token into a screen.
 */
export const CAPABILITY_WORDS: Record<CapabilityClass, { verb: string; noun: string }> = {
  pages: { verb: 'read pages', noun: 'page-reading' },
  clean: { verb: 'clean text', noun: 'text-cleanup' },
  translate: { verb: 'translate', noun: 'translation' },
  simplify: { verb: 'simplify text', noun: 'simplification' },
  analysis: { verb: 'analyse text', noun: 'analysis' },
  /*
   * THE CLEANUP'S TRIAGE AND THE ANALYSIS'S RANKING, the two acts that ask the
   * decide door, in words a person would say: a server that "can't judge text
   * for a cleanup or an analysis" is the true sentence, where "can't decide" is
   * the engine's own word for its door and says nothing to anybody.
   */
  decide: { verb: 'judge text for a cleanup or an analysis', noun: 'triage-and-ranking' },
};

/**
 * THE ACT A JOB IS, as the server names it — and the value of `X-Crucible-Act`.
 *
 * The header is required on our side by Owen's naming ruling and is exactly one
 * of these six words. It is what makes a server's log say which act held the
 * card, rather than "an llm job", which is the same lie the act-prefixed log
 * lines in the engine were built to end.
 *
 * NULL FOR EVERY OTHER KIND. An export, a mint and an environment install put
 * nothing in front of a model; there is no class for them, no slot to place them
 * on, and they take the path they always took.
 */
export function capabilityClassOf(kind: JobKind): CapabilityClass | null {
  switch (kind) {
    case 'clean': return 'clean';
    case 'translate': return 'translate';
    case 'simplify': return 'simplify';
    case 'analysis': return 'analysis';
    case 'read': return 'pages';
    // THE ONE KIND WHOSE CLASS IS NOT ITS OWN NAME: a triage is asked of the
    // `decide` class, which is what a server files the small yes/no model under
    // and the word Crucible's `X-Crucible-Act` knows (PHASE22).
    case 'clean-triage': return 'decide';
    // AND THE ANALYSIS'S RANKING, on the triage's terms and on its model: Owen,
    // 2026-09-25, *"9b for triage"* — the decide act, the clean row's model
    // (`placeJob`), briefcase's snap ranker in place of the entailment worker.
    case 'analysis-rank': return 'decide';
    default: return null;
  }
}

/**
 * ── READS GO TO A CRUCIBLE NOW — RULED 2026-09-14 ──────────────────────────
 *
 * This was `false` while the local page reader was Package B's and the open
 * question was whether a REMOTE reader may be chosen at all when the local dots
 * server is the thing that works while the Mac is asleep. Owen answered it with
 * the whole phase (crucible docs/PHASE15-HOST.md §0): *"if it uses the GPU (as
 * dots does), it should probably be crucible-side … crucible can decide if the
 * user's system is even capable of running it … it should be a pass-through thin
 * client UI for the crucible engine."* A page reading is model INFERENCE, and
 * inference is Crucible's — on any card, on a CPU, in host mode or in WSL.
 *
 * So a `read` places like every other act: any registered server whose `pages`
 * row is enabled, in rank order, the loopback one first (`computeSlots`).
 *
 * ── THE THREE THINGS THAT HAD TO MOVE WITH IT, ALL IN THIS COMMIT ──────────
 *
 *   1. The reading server is started AFTER the placement and only when the
 *      placement is this machine's (`runInSlot`, electron/job-queue.ts). It used
 *      to be started first, unconditionally, which would have loaded four
 *      gigabytes onto this card for a reading that was about to be sent to
 *      another machine.
 *   2. A Crucible-placed reading gets `--vlm-endpoint` and `--vlm-endpoint-model`
 *      off the placement (`argsFor`). Without it the engine would read
 *      `backend.endpointUrl` out of settings.json and post the pages to whatever
 *      that names, which is the local reader — a placement nothing honoured.
 *   3. §5b's AUTOMATIC removal of Foundry's own dots files arms with this
 *      constant (`applyPageReaderRemoval` and `pageReaderRemovalOffer`,
 *      electron/machine-models.ts; `pageReaderSuperseded`, electron/page-reader.ts).
 *      All three already read it and all three say so. Flipping it without (1)
 *      and (2) would have deleted the thing still doing the work.
 */
export const CRUCIBLE_READS = true;

/**
 * DOES THIS KIND OF JOB GET PLACED AT ALL — the two early returns of
 * {@link placeJob}, asked before the walk instead of discovered inside it.
 *
 * ── Why it is exported, and what was wrong with it being implied ────────────
 *
 * Three callers need the same answer and each of them used to spell it out:
 * `placeJob` (which returns {@link UNPLACED} and never looks at a slot),
 * `placedBy` (which puts no `waitFor` on the row, so no picker is drawn), and —
 * since Package G — the PUMP, which has to know which lane a row will hold
 * before it picks it. A run that is never placed still runs on this machine: an
 * export is this disk, and a reading with `CRUCIBLE_READS` off would be this
 * card. Three copies of one predicate is how a reading ends up holding no lane at
 * all and two of them start on one card, so there is one copy and it is here,
 * beside the switch (`CRUCIBLE_READS`) that decides half of it.
 *
 * FALSE IS NOT "CHEAP" AND IS NOT "NO GPU". An export is false because it never
 * meets a model; a reading would be false because its model is on a path this
 * module does not route — which it now does, so that clause is live only if the
 * constant is ever turned back off. What they share is only that the answer to
 * *whose machine* is already decided — it is this one.
 */
export function placesOnASlot(kind: JobKind): boolean {
  if (capabilityClassOf(kind) === null) return false;
  if (kind === 'read' && !CRUCIBLE_READS) return false;
  return true;
}

/*
 * 503 `capability_undecided` USED TO BE A CLASS OF THIS APP'S. It is the SDK's
 * `CrucibleCapabilityUndecided` now (0.6.0, crucible `e342fee`), raised by
 * `capability()` itself, and the local declaration is gone rather than kept
 * beside it: two types for one 503 is two things to catch, and the one that was
 * never thrown is the one a later edit forgets.
 */

/**
 * `GET /v1/capability` THROUGH THE SDK — and the two reasons it could not be,
 * until this pack.
 *
 * This route was the last one on this wire still called by hand. A private
 * `crucibleRequest` fetch served it, under a standing note to switch the moment
 * the tarball could answer both of these, and `@crucible/client` 0.6.0 re-packed
 * from crucible `e342fee` answers both:
 *
 *   1. **It had no clock.** `CrucibleClientOptions` was url/token/clientName, so
 *      `readCapability(entry, timeoutMs)` could not be expressed through it.
 *      `timeoutMs` is now a CONSTRUCTION option, which is why {@link clientFor}
 *      takes one and this function passes its own straight through — the gate
 *      probe (`crucible-provider.ts`) still asks with `PROBE_TIMEOUT_MS` on it,
 *      and a Mac that is asleep still must not put a network timeout behind a
 *      tooltip.
 *   2. **It refused a pre-PHASE-15 document outright.** The old reader took
 *      `route` through `str()`, so a row without one was a
 *      `CrucibleProtocolError` and the whole record was unreadable — measured
 *      against the WSL Crucible at 127.0.0.1:7100, which sends eleven rows and
 *      no `route` on any of them. 0.6.0 reads the VINTAGE ONCE FOR THE WHOLE
 *      DOCUMENT, exactly as §3.3's last bullet states it: no row carries
 *      `route` → the server predates phase 15 and every class on it IS local;
 *      some rows carry it and one does not → `capability_route_missing`, naming
 *      the row; a value that is neither word → `capability_route_unknown`. The
 *      document-level rule this app used to keep is now the SDK's entire, so
 *      Foundry's copy of it is GONE rather than kept beside it (R1).
 *
 * WHAT IS LEFT HERE IS THE MIRROR, and it stays on purpose. `CapabilityRow` and
 * `CapabilityRecord` live in shared/engine-settings.ts because the setup
 * wizard's routes step draws a row's `reason` and a RENDERER cannot import from
 * `electron/` — nor should a renderer bundle pull a main-process SDK in to read
 * two numbers and a word. So this is the one place the SDK's record is copied
 * into the app's, field for field, and the copy is a rename of nothing: every
 * field means what the SDK's means. `desktopAllowanceBytes` is deliberately not
 * carried, because nothing in this app draws it.
 *
 * EXPORTED FOR THE SETTINGS SIDE (`crucible-provider.ts`, Wave 61 package E) and
 * for coordination (`crucible-coordinate.ts`, which resolves the module's
 * CLASSES through it — crucible PHASE15-HOST.md §5.3a). ONE READER OF THIS
 * ROUTE, because the shape of a capability record is exactly the kind of thing
 * that is written twice and then only fixed once.
 */
export async function readCapability(
  entry: CrucibleServerEntry,
  timeoutMs?: number,
): Promise<CapabilityRecord> {
  /*
   * THROUGH THE ENGINE, NEVER THE ORCHESTRATOR. An orchestrator READS its
   * engine's capability block through onto its own `/v1/info` (PHASE17 §3.2) but
   * has no `/v1/capability` of its own, and this is the route every gate, every
   * tile and every placement in this app decides on. `engineClientFor` follows
   * §6's one hop; the clock travels with it, so the gate probe's
   * `PROBE_TIMEOUT_MS` still bounds BOTH reads rather than only the second.
   */
  const record = await (await engineClientFor(entry, { timeoutMs })).capability();
  return {
    backendKind: record.backendKind,
    totalBytes: record.totalBytes,
    classes: record.classes.map((row): CapabilityRow => ({
      capability: row.capability,
      enabled: row.enabled,
      selected: row.selected,
      reason: row.reason,
      /*
       * THE PERSON-FIRST HALF, WHEN THE SERVER SENDS IT. Crucible is adding a
       * `summary` beside `reason` in the per-class decision — a plain sentence
       * for a user, with `reason` kept full for operators and `crucible doctor`.
       * The `@crucible/client` type this build vendors predates the field, so it
       * is read through a widening cast and is `undefined` until the server
       * ships it; `personReasonOf` prefers it over `reason` for the composed
       * refusal and falls back to `reason`, so this reads on both vintages.
       */
      summary: (row as { summary?: string }).summary,
      shortfallBytes: row.shortfallBytes,
      route: row.route,
    })),
  };
}
