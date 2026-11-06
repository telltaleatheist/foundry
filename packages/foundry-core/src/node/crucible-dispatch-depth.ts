/**
 * crucible-dispatch-depth — how many chat requests a server takes at once.
 */
import { clientFor } from './crucible-registry';
import { type CrucibleServerEntry } from './app-settings';
import type { CapabilityClass } from './crucible-dispatch-capability';
import type { PlacementProgress } from './crucible-dispatch-place';

/**
 * HOW MANY BLOCKS IN FLIGHT ON A CRUCIBLE CHAT DOOR — Owen's ruling 4, 2026-09-20.
 *
 * *"4 in flight on the Crucible chat door until the server states a number (Sep 8
 * measurement: knee at 4)."* It is a ceiling on OUR side of a proxy that serves
 * one request at a time on the card behind it; the engine's own twelve was
 * measured against a vLLM that batches, and a number measured on one backend is
 * not a number about another.
 *
 * THE ONE PLACE. When a capability row starts stating a depth, it is read here and
 * nowhere else — see `Placement.concurrency`.
 */
export const CRUCIBLE_CHAT_CONCURRENCY = 4;

/**
 * HOW LONG THE DEPTH READ MAY TAKE. A status read in front of a placement that
 * has already made three round trips; a server too slow to answer this in ten
 * seconds will be named by the placement itself a moment later, with a better
 * sentence. A cut-off is `null`, which is the same answer as "it did not say".
 */
export const CHAT_DEPTH_TIMEOUT_MS = 10_000;

/**
 * WHAT THIS SERVER WILL ADMIT AT ONCE ON ITS CHAT DOOR — `chat.max_in_flight`.
 *
 * ── The fact, and why it outranks the knee ────────────────────────────────
 *
 * Crucible 1.0.10 bounds chat completions per engine and publishes the bound on
 * `/v1/activity`. On the Mac's serial `mlx-lm` it is 2 (engine concurrency 1,
 * plus one); a vLLM batches, states nothing, and is not bounded. Past the bound
 * a request is not queued — it is refused `503 chat_queue_full`. So this is not
 * a second opinion about throughput to be weighed against {@link
 * CRUCIBLE_CHAT_CONCURRENCY}'s measured knee: it is what the other end will
 * ACCEPT, and a placement that asks for more spends the run retrying. That is
 * the defect of 2026-09-20 (BUG-HUNT §A): four out, two admitted, two refused,
 * and the clean pass died on the refusals.
 *
 * ── Null is "it did not say", never a zero ────────────────────────────────
 *
 * No engine resident, an engine that does not bound chats, a Crucible older
 * than 1.0.10, an unreachable server, a cut-off — all one answer to a caller,
 * and that answer is `CRUCIBLE_CHAT_CONCURRENCY`. Nothing here throws: the
 * placement's own calls decide whether this server can be used, with sentences
 * built for that, and a courtesy read must not be the thing that fails a row.
 *
 * ── AND IT IS THE SDK'S NOW, WHICH IT WAS NOT WHEN IT WAS WRITTEN ──────────
 *
 * This was the one Crucible route in this file spoken by a hand-rolled `fetch`,
 * under a docstring that said so and promised to switch *"the moment the SDK
 * carries the field"*: `@crucible/client` 1.0.10's `Activity.chat` parsed
 * `in_flight` and `rows` and dropped `max_in_flight`, so `client.activity()`
 * could not hand back a number it never read. 1.0.13 carries `maxInFlight` and
 * `maxInFlightBasis`, so the promise is kept and the fetch is gone. One reader
 * of this wire, and it is the SDK's — a second parse of a document the SDK
 * already parses is exactly the shape that goes stale in silence.
 *
 * ── A DOCUMENT THIS BUILD CANNOT FULLY READ IS ALSO "IT DID NOT SAY" ────────
 *
 * The SDK is strict, so a server older or newer than this build can answer 200
 * with a document the SDK refuses as a {@link CrucibleProtocolError}. That was
 * `CrucibleTooOld` — the placement REFUSED, "update it" — until Owen, 2026-09-24:
 * *"dont require any particular crucible server. if it can make the call to the
 * crucible server then it should work."* A courtesy read of the admission bound
 * is not a call the placement needs to succeed: without the number, the run takes
 * {@link CRUCIBLE_CHAT_CONCURRENCY}, and a server that admits fewer answers the
 * overflow `503 chat_queue_full`, which the engine already waits out. So it is
 * the same null as a 404, and `chatDepthFor` says which number it settled on.
 */
export async function statedChatDepth(engine: CrucibleServerEntry): Promise<number | null> {
  try {
    const activity = await clientFor(engine, { timeoutMs: CHAT_DEPTH_TIMEOUT_MS }).activity();
    // A document with no `chat` block states no depth — the same null as a
    // missing number (SDK 1.0.25 reads an absent block as null).
    if (activity.chat === null) return null;
    const stated = activity.chat.maxInFlight;
    if (stated === null || !Number.isFinite(stated) || stated < 1) return null;
    return Math.floor(stated);
  } catch (err) {
    /*
     * NOTHING IS LOGGED FROM THE CATCH, and that is not silence about a failure:
     * the caller says which number it settled on and why, in one line, on every
     * path (`chatDepthFor`). A second line here would report the same decision
     * twice and would put a network message in front of a person whose placement
     * is about to succeed.
     */
    return null;
  }
}

/**
 * THE NUMBER THAT GOES ON THE PLACEMENT, and the line that says where it is from.
 *
 * The server's own admission limit when it states one, {@link
 * CRUCIBLE_CHAT_CONCURRENCY} when it does not — and it SAYS WHICH, because a run
 * at four against a server admitting two looks exactly like a run that asked and
 * was told four. `pages` states none at all: `--vlm-concurrency` is the page
 * reader's own flag, taken from the server that serves the pages, so a chat
 * depth on a reading placement would be a number about the wrong door.
 */
export async function chatDepthFor(
  engine: CrucibleServerEntry,
  capability: CapabilityClass,
  say: PlacementProgress,
): Promise<number | null> {
  /*
   * NEITHER OF THE TWO ACTS THAT DO NOT CHAT HAS A CHAT DEPTH. A reading takes its
   * number from the server that serves the pages (`--vlm-concurrency`), and the
   * cleanup's triage asks Crucible's decide door, which bounds its own questions
   * against the engine's admission on the server side (PHASE22). Reading the chat
   * door's number for either would put "decide runs with 4 requests in flight" in
   * front of a person about a door the run never uses.
   */
  if (capability === 'pages' || capability === 'decide') return null;
  const stated = await statedChatDepth(engine);
  if (stated === null) {
    say(
      `${engine.name} states no chat depth, so ${capability} runs with `
      + `${CRUCIBLE_CHAT_CONCURRENCY} requests in flight.`,
    );
    return CRUCIBLE_CHAT_CONCURRENCY;
  }
  say(`${engine.name} admits ${stated} chat${stated === 1 ? '' : 's'} at once.`);
  return stated;
}
