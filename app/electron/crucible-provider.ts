/**
 * crucible-provider — the one question everything in package D asks about a
 * Crucible, and the one answer it can honestly give today.
 *
 * ── WHY THIS FILE EXISTS AND IS ALMOST EMPTY ─────────────────────────────────
 *
 * Three things landing in Wave 61 need to know whether a LOCAL Crucible server
 * is serving a class of model on this machine:
 *
 *   1. the tiles (act-gates.ts) — a Crucible serving `translate` lights
 *      Translate even where ollama holds nothing at all, because the models are
 *      over there;
 *   2. the inventory row (machine-models.ts) — SLOTS.md §5b's "Models on this
 *      machine" lists a local Crucible's residency beside ollama's store;
 *   3. the deletion rule (machine-models.ts, `pageReaderRemovalOffer`) — Foundry
 *      deletes the dots GGUF it downloaded ONLY when a LOCAL Crucible has taken
 *      over the `pages` class, and never merely because a server was configured.
 *
 * **The registry that would answer it is PACKAGE C** (docs/SLOTS.md §6): the
 * server list with its names, URLs and header maps, the slots the queue
 * dispatches across, and the capability read that says which classes a server
 * actually has resident. That work is being built concurrently and this package
 * must not build a second one — two registries would be two answers to "which
 * servers exist", and the queue would eventually pick the wrong one.
 *
 * ── SO THE ANSWER IS `unknown`, WHICH IS NOT `no` ───────────────────────────
 *
 * Every caller below treats `unknown` as "do not act on this" rather than as a
 * negative, and the difference is load-bearing in exactly one place: the §5b
 * deletion. "No local Crucible serves pages" would authorise deleting three
 * gigabytes of weights; "I cannot tell yet" must not. `unknown` is the only
 * value this file returns until package C replaces the body, and the shape is
 * three-valued precisely so that the replacement cannot quietly turn a silence
 * into a permission.
 *
 * WHAT PACKAGE C (AND E, FOR THE SETTINGS SURFACE) REPLACES: the two function
 * bodies. Nothing above them and no caller changes — that is the point of the
 * seam.
 */
import type { ModelClass } from '../shared/types';

/**
 * Three values, because two would be a lie. `unknown` is the honest state of a
 * machine whose server registry does not exist yet, and it is not `no`.
 */
export type ServedAnswer = 'yes' | 'no' | 'unknown';

/**
 * Is a Crucible ON THIS MACHINE serving this class right now?
 *
 * LOCAL, and the distinction is Owen's (SLOTS.md §5b): *"a REMOTE Crucible
 * removes nothing. It takes nothing from this disk, and configured is not
 * present — the local reader is what works when the Mac is asleep."* A remote
 * server is a slot, not an owner of anything on this disk, so it can light a
 * tile but can never authorise a deletion — which is why callers that delete
 * ask THIS function and not "is any server configured".
 *
 * PACKAGE C owns the body: the registry's loopback entry, its capability read,
 * and the class list that read returns. Until then, `unknown`.
 */
export function localCrucibleServes(cls: ModelClass): ServedAnswer {
  void cls;
  return 'unknown';
}

/**
 * The sentence the "Models on this machine" row prints for the Crucible line,
 * or null when there is nothing to say about one.
 *
 * A SENTENCE RATHER THAN A MODEL LIST, today, because a residency list with no
 * registry behind it would be an empty table claiming a server has nothing
 * resident. PACKAGE C/E: this becomes the server's name, its URL and what it
 * currently holds.
 */
export function localCrucibleSummary(): string | null {
  return null;
}
