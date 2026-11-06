/**
 * DISPATCH — which slot this job goes to, and what has to be true before the
 * engine is spawned against it.
 *
 * docs/SLOTS.md §5 states the rule this whole module exists to honour: **THE
 * OPERATOR LOADS, THE ENGINE NEVER DOES.** The engine speaks an OpenAI dialect
 * to whatever is at `--endpoint` and refuses by name when the model it was told
 * to use is not the one that server is holding; it has no verb for "make it
 * resident" and must not grow one, because a machine's residency is a fact about
 * a shared card and the thing spending an hour on it is not the thing that gets
 * to decide. So this app — the operator, the thing with a person in front of it
 * — reads what the server can serve, makes the model resident if it is not, and
 * only then spawns.
 *
 * ── The shape of every answer here is three-way, and that is the design ────
 *
 * A placement can be `go`, `wait` or `refuse`, and the difference between the
 * last two is the whole reason this module is not a boolean:
 *
 *   `wait`   — this is about the SERVER's state and will be different later, or
 *              on another machine. Somebody is narrating on it; the lane is
 *              taken; it is switched off; it is unreachable. The row goes back
 *              to the queue wearing the sentence, and is tried again with a
 *              backoff. Crucible does not queue — a second submission is refused
 *              rather than admitted — so the waiting is ours to own, and the SDK
 *              says so explicitly rather than hiding a retry loop nobody chose.
 *   `refuse`  — this is about the REQUEST and will be refused identically
 *              everywhere. The model is not one this server has ever heard of;
 *              the class is off. The row fails with the reason, once, rather
 *              than four times over four machines.
 *
 * `isServerSpecificRefusal` (the SDK) is what decides which, because the fact
 * has exactly one honest owner: the server that emitted the code.
 *
 * ── AND A WAIT NOW SAYS WHETHER TIME WILL EVER END IT ──────────────────────
 *
 * A `wait` carries `standing` ({@link PlacementWait}). Transient is everything
 * above and parks for ever, exactly as it always has; STANDING is "that server's
 * record says this class cannot run there", which no backoff will change. The
 * walk steps past both alike — the next machine is a different question — but a
 * PINNED row whose one slot answers standing, and an `any` row where every slot
 * did, now FAIL by name instead of parking. BookForge found the row that neither
 * failed nor finished and Owen ruled it a defect.
 *
 * ── Never a tight poll ────────────────────────────────────────────────────
 *
 * Nothing in here loops. One pass is one answer, and the BACKOFF lives on the
 * queue side (`job-queue.ts`) where the row is, because that is where the row
 * can be drawn while it waits and where a person can take it away.
 */
import { type CapabilityRecord, type CapabilityRow } from '../shared/engine-settings';

export { capabilityClassOf, CRUCIBLE_READS, placesOnASlot, readCapability } from './crucible-dispatch-capability';
export type { CapabilityClass } from './crucible-dispatch-capability';
export { UNPLACED } from './crucible-dispatch-placement';
export type { Placement, PlacementOutcome, PlacementWait } from './crucible-dispatch-placement';
export { CRUCIBLE_CHAT_CONCURRENCY } from './crucible-dispatch-depth';
export { placeJob } from './crucible-dispatch-place';
export type { PlacementProgress, LaneClaim } from './crucible-dispatch-place';
export { warmingHeadline } from './crucible-dispatch-reasons';
export { openSession } from './crucible-dispatch-session';
export type { HeldSession, SessionPick } from './crucible-dispatch-session';

// ─────────────────────────────────────────────────────────────────────────────
// GET /v1/capability — the last route on this wire to become the SDK's
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE CAPABILITY RECORD'S SHAPE MOVED TO shared/, AND IS RE-EXPORTED HERE.
 *
 * Wave 62 package I: the setup wizard's routes step draws a capability row's
 * `reason` (crucible docs/PHASE15-HOST.md §5.2 — *"for each llm class that is
 * `enabled: false` locally it says the class's reason"*), and a RENDERER cannot
 * import from `electron/`. The two interfaces are unchanged in every field;
 * they live in shared/engine-settings.ts now, and these re-exports mean every
 * importer that reaches for `CapabilityRow` here still finds it. ONE
 * declaration, two doors onto it — the alternative was a second spelling of the
 * same record in shared/, which is the exact defect this repo keeps meeting.
 */
export type { CapabilityRecord, CapabilityRow } from '../shared/engine-settings';
