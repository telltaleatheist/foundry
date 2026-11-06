/**
 * crucible-coordinate-missing — what a server still lacks for Foundry's work.
 */
import { type CatalogRow } from '@crucible/client';
import type { CapabilityRecord } from '../shared/engine-settings';
import type { CrucibleMissingEntry, CrucibleUnmetClass } from '../shared/coordinate-wire';
import { foundryModuleForBackend } from './crucible-coordinate-module';

// ─────────────────────────────────────────────────────────────────────────────
// The comparison — the whole of "does this server have what Foundry needs"
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the module asks for that this server has not got, and what it will never
 * have.
 *
 * PURE, over the three reads, so that the thing that decides whether to post a
 * task and the thing that says what is being prepared are one function rather
 * than two that can come to disagree.
 *
 * ── THE MODULE NAMES CLASSES NOW, AND THE CLASSES ARE RESOLVED HERE ────────
 *
 * crucible `docs/PHASE15-HOST.md` §5.3a (crucible `e342fee`; the ruling was
 * found by this app's own measurement against the Mac). `foundry.module.json`
 * used to carry `qwen3.8-27b-4bit` and `dots-ocr` as resolved ids, because
 * `gen-modules.py` turned a class into ONE id at generation time — the
 * cuda-linux answer — and then said `dots-ocr` to a Mac that has no block for it
 * and `qwen3.8-27b-4bit` to a Mac whose capability had selected `qwen3.8-27b`.
 * The generator was a second owner of a decision that is the SERVER's. So the
 * module now carries `needs: [{class}]` unresolved, and this function asks the
 * engine's own capability record what each class means ON THAT MACHINE before it
 * looks in that machine's catalog.
 *
 * Per class, and each arm is a different kind of news:
 *
 *   * **No row for it at all** — that engine's capability record has never heard
 *     of the class. UNMET, with the absence itself as the reason: it is the only
 *     one of these sentences this app composes, because there is no row to quote.
 *   * **`enabled: false`** — UNMET, carrying the row's own `reason` verbatim.
 *     *"A class this backend has DISABLED is not a refusal"* (§5.3a): the module
 *     is still posted for everything else, the task still finishes `done`, and
 *     the row says "not on this engine".
 *   * **Enabled, routed UPSTREAM** — nothing to pull and nothing missing. The
 *     work runs on the operator's account at Anthropic, OpenAI or an Ollama
 *     (§3.3), and there are no weights on that machine to be short of. `route`
 *     is the field that says so and `selected` carrying a slash is the same fact
 *     said twice (§1: *"a local model id never contains `/`"*); both are read,
 *     because a pre-phase-15 document has no `route` and a routed one always
 *     has the slash, and the cost of agreeing with ourselves is one `includes`.
 *   * **Enabled, local, nothing selected** — the engine decided it can serve the
 *     class and then found nothing that fits. UNMET: there is no id to look up,
 *     and a catalog search for `""` would report the empty string as a missing
 *     download.
 *   * **Enabled, local, with a selection** — `selected` IS the subject id, and
 *     the class is missing exactly when that machine's catalog says it is not
 *     installed. The catalog row's `name`, `kind` and `expectedBytes` travel
 *     with it, as they always have; `kind` is the catalog's word, `model` on
 *     every backend. Native Windows also needs the separate `llama-cpp` engine
 *     subject, even when the selected model weights are already installed.
 *
 * **Job types are compared on the TYPE alone**, not on the narrator engine, and
 * that is the server's own rule rather than a shortcut: a `module`'s install
 * entry is skipped when the job type is installed (PHASE13 §3.3), and
 * `/v1/info`'s `capabilities[].jobType` is the list PHASE13 §3.2 names as the
 * one a client compares against. A second opinion here — "installed, but with
 * the wrong engine" — would be this app deciding something the server decides.
 *
 * **Explicit `subjects` keep the comparison they always had.** §5.3a keeps them
 * for *"genuine app choices"* — a voice, a whisper size — and the asymmetry is
 * the point: a class is "give me whatever serves this", which a machine may
 * answer "nothing here does"; an id is "give me this one", which it may not, so
 * an explicit id a backend cannot hold is still `unknown_subject` and still
 * refuses the whole module. Foundry's module lists none today.
 */
export function missingForFoundry(
  installedJobTypes: readonly string[],
  catalog: readonly CatalogRow[],
  capability: CapabilityRecord,
): { missing: CrucibleMissingEntry[]; unmet: CrucibleUnmetClass[] } {
  const missing: CrucibleMissingEntry[] = [];
  const unmet: CrucibleUnmetClass[] = [];
  const localJobTypes = new Set<string>();
  const module = foundryModuleForBackend(capability.backendKind);

  for (const entry of module.job_types) {
    if (installedJobTypes.includes(entry.type)) continue;
    missing.push({
      what: 'job-type',
      jobType: entry.type,
      narratorEngine: entry.narrator_engine === undefined ? null : entry.narrator_engine,
    });
  }

  for (const need of module.needs) {
    const row = capability.classes.find((item) => item.capability === need.class);
    if (row === undefined) {
      unmet.push({
        class: need.class,
        /*
         * NO FULL STOP, because every other reason on this type is a capability
         * row's own `reason` and those are clauses rather than sentences — the
         * words join several of them into one line, and one of them ending early
         * would read as the line ending early.
         */
        reason: 'this engine\'s capability record does not mention it, so nothing there has '
          + 'decided whether it can serve it',
      });
      continue;
    }
    if (!row.enabled) {
      unmet.push({ class: need.class, reason: row.reason });
      continue;
    }
    if (row.route === 'upstream' || row.selected.includes('/')) continue;
    if (row.selected.length === 0) {
      unmet.push({ class: need.class, reason: row.reason });
      continue;
    }
    const subject = catalog.find(
      (item) => item.id === row.selected && (item.kind === 'model' || item.kind === 'engine'),
    );
    // A catalog row that states no job type (null since SDK 1.0.25) adds none:
    // it cannot be matched to the engine that serves it.
    if (subject !== undefined && subject.jobType !== null) localJobTypes.add(subject.jobType);
    if (subject !== undefined && subject.installed) continue;
    missing.push({
      what: 'class',
      class: need.class,
      id: row.selected,
      kind: subject === undefined ? null : subject.kind,
      name: subject === undefined ? null : subject.name,
      jobType: subject === undefined ? null : subject.jobType,
      expectedBytes: subject === undefined ? null : subject.expectedBytes,
      inCatalog: subject !== undefined,
    });
  }

  // A model's weights and the executable that serves them are separate catalog
  // subjects. Restoring weights after reinstalling Crucible must still restore
  // the native engine, even when /info already advertises the llm job type.
  for (const engine of catalog) {
    if (engine.kind !== 'engine' || engine.installed) continue;
    // An engine row that states no job type cannot be tied to a class this
    // module needs, so it is not asked for — nothing is guessed (2026-09-24).
    if (engine.jobType === null || !localJobTypes.has(engine.jobType)) continue;
    missing.push({
      what: 'subject', kind: engine.kind, id: engine.id, name: engine.name,
      jobType: engine.jobType, expectedBytes: engine.expectedBytes, inCatalog: true,
    });
  }

  for (const subject of module.subjects) {
    const row = catalog.find((item) => item.kind === subject.kind && item.id === subject.id);
    if (row !== undefined && row.installed) continue;
    if (missing.some(item => item.what === 'subject' && item.kind === subject.kind && item.id === subject.id)) continue;
    missing.push({
      what: 'subject',
      kind: subject.kind,
      id: subject.id,
      name: row === undefined ? null : row.name,
      jobType: row === undefined ? null : row.jobType,
      expectedBytes: row === undefined ? null : row.expectedBytes,
      inCatalog: row !== undefined,
    });
  }

  return { missing, unmet };
}
