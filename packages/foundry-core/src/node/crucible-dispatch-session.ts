/**
 * crucible-dispatch-session — the queue session a run holds on its server.
 */
import { CrucibleSessionClosed, type CrucibleSession } from '@crucible/client';
import { CRUCIBLE_CLIENT_NAME, clientFor } from './crucible-registry';
import { type CrucibleServerEntry } from './app-settings';
import type { CapabilityClass } from './crucible-dispatch-capability';
import type { PlacementProgress } from './crucible-dispatch-place';

/**
 * The header map for one spawn, as the JSON the engine reads.
 *
 * `X-Crucible-Act` is required on OUR side by Owen's naming ruling and is one of
 * the six class words. The engine neither writes it nor knows about it: to the
 * engine this is an opaque map of headers to send, and the word for anybody's
 * product does not appear anywhere in `src/`.
 *
 * NEVER LOGGED, and the return value is the reason this function is small and
 * has one caller: the string it produces is a credential, and the only thing
 * that is ever done with it is putting it in a child's environment.
 */
export function headerMapFor(entry: CrucibleServerEntry, capability: CapabilityClass): string {
  return JSON.stringify({
    // An open server (token `''`) is sent no Authorization header at all.
    ...(entry.token === '' ? {} : { Authorization: `Bearer ${entry.token}` }),
    'X-Crucible-Api': '1',
    'X-Crucible-Act': capability,
    // THIS INSTALL'S NAME, so the engine's chats and decisions are items of the
    // queue session this placement opened, not strangers waiting behind it
    // (Crucible 1.0.76 matches session membership on the client name).
    'X-Crucible-Client': CRUCIBLE_CLIENT_NAME,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The session — this run's turn holding the machine (Crucible 1.0.76)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A QUEUE SESSION, held while this run is alive.
 *
 * ── What it replaced, and why the hazard is still closed ──────────────────
 *
 * docs/SLOTS.md §5: one model is resident at a time and a load EVICTS. Until
 * Crucible 1.0.76 the claim that kept a book's model on the card was a LEASE
 * (a refusal of other clients' loads, with a ttl and a heartbeat). Leases are
 * gone; Owen: *"we dont need to worry about legacy anything"*. A session is
 * stronger: while it is open NOTHING from any other client runs on that
 * server — their queued work waits, their unqueued work is refused
 * `session_open` — and the server ends it only when we close it, when it has
 * been idle for `idleS`, when an operator ends it, or when the server stops.
 *
 * ── Liveness ──────────────────────────────────────────────────────────────
 *
 * The engine's own chats are activity, but a run has gaps the server cannot see
 * (triage settling into the clean, a chapter written to disk). So the session is
 * TOUCHED every {@link SESSION_TOUCH_MS} for as long as this process holds it —
 * a timestamp in the server's memory. A process that dies stops touching and the
 * machine is handed on within {@link SESSION_IDLE_S}.
 *
 * ── Releasing is not optional ─────────────────────────────────────────────
 *
 * `release()` is called from the queue's SETTLE, which every ending passes
 * through. It is idempotent and swallows its own failure after logging: a
 * session that cannot be closed idles out, and failing a finished job because
 * the tidying failed would be reporting a loss that did not happen.
 */
export interface HeldSession {
  /** The server's id for it (`ses-…`), for the log line and the in-flight ledger. */
  readonly id: string;
  /**
   * The model it opened with: the one named, or the one the server chose for a
   * ceiling ({@link SessionPick}). Null only when the server did not say.
   */
  readonly model: string | null;
  /** Close the session and give the machine back. Idempotent; never throws. */
  release(): Promise<void>;
}

/** The server's own default idle window, stated so nobody has to look it up. */
export const SESSION_IDLE_S = 300;

/** A fifth of the idle window: four touches may be lost before the machine goes. */
export const SESSION_TOUCH_MS = 60_000;

/** How long a session may wait in the server's line: the batch day. */
export const SESSION_MAX_WAIT_S = 86_400;

/**
 * WHICH MODEL A SESSION OPENS WITH: one named, or the server's own pick for the
 * act capped at a ceiling in billions of parameters (Crucible's `max_params_b`,
 * which only ever lowers its pick).
 */
export type SessionPick = { readonly model: string } | { readonly maxParamsB: number };

/**
 * OPEN THE SESSION — wait in the server's line, then keep it present.
 *
 * `entry` IS THE ENGINE-ADDRESSED ONE, resolved by `placeOnCrucible`: a session
 * is a turn on a CARD and an orchestrator has none (PHASE17 §1).
 *
 * `act` IS THE LABEL THE SERVER SHOWS THE RUN UNDER — a placement's capability
 * class, or `ask` for a question about a book (electron/ask-document.ts), which
 * is a run of its own and not one of the six classes; Crucible takes any one
 * lowercase word as a session's act.
 *
 * A REFUSAL PROPAGATES AS A THROW and is read by `interpretFailure` like every
 * other one on this path: a session that never opened throws
 * `CrucibleSessionClosed` with its reason, and an aborted wait (a Stop) throws
 * the abort, having already left the line.
 */
export async function openSession(
  entry: CrucibleServerEntry,
  pick: SessionPick,
  act: string,
  slotName: string,
  say: PlacementProgress,
  signal?: AbortSignal,
  /**
   * THE LEAST CONTEXT THE MODEL MAY START AT, measured from this run's own book
   * (src/node/context-need.ts) and absent for a run that states none. Crucible
   * 2.0.38 starts the model at its default, or at this when it is more, or at the
   * most the card affords below that, but never under it; a card that cannot give
   * it ends the session `insufficient_kv_cache` (`interpretFailure`).
   */
  contextTokens?: number,
): Promise<HeldSession> {
  const client = clientFor(entry);
  const session: CrucibleSession = await client.session({
    act,
    ...pick,
    ...(contextTokens === undefined ? {} : { contextTokens }),
    idleS: SESSION_IDLE_S,
    maxWaitS: SESSION_MAX_WAIT_S,
    onQueue: ({ position, of }) => {
      say(`Waiting for ${slotName}: #${position}${of < position ? '' : ` of ${of}`} in its line`);
    },
    /*
     * FIRST IN LINE AND STILL WAITING: another process holds the card (Crucible
     * 1.0.82+). Without this the row's last word was "#1 in its line", which
     * reads as stuck. The server's sentence names the holder and the next check,
     * and it repeats every minute while that holder stays.
     */
    onWaiting: ({ message }) => {
      say(`Waiting for ${slotName}: ${message}`);
    },
    ...(signal === undefined ? {} : { signal }),
  });
  let ended = false;
  let touching = false;
  const timer = setInterval(() => {
    if (ended || touching) return;
    touching = true;
    session.touch()
      .catch((err: unknown) => {
        if (err instanceof CrucibleSessionClosed) {
          ended = true;
          clearInterval(timer);
          console.error(
            `[slots] ${entry.name} ended this run's session ${session.id} (${err.reason}) — `
            + 'another client may now load over it; the engine refuses by name if it does.',
          );
          return;
        }
        // Weather: four touches fit in one idle window, and the engine's own
        // requests are presence too.
        console.error(
          `[slots] a touch of session ${session.id} on ${entry.name} failed: `
          + `${err instanceof Error ? err.message : String(err)}`,
        );
      })
      .finally(() => { touching = false; });
  }, SESSION_TOUCH_MS);
  timer.unref?.();
  void session.closed.then((end) => {
    if (ended) return;
    ended = true;
    clearInterval(timer);
    if (end.reason !== 'client') {
      console.error(`[slots] ${entry.name} ended this run's session ${session.id} (${end.reason}): ${end.message}`);
    }
  });
  const model = session.model;
  return {
    id: session.id,
    model,
    async release(): Promise<void> {
      if (ended) return;
      ended = true;
      clearInterval(timer);
      try {
        await session.close();
      } catch (err) {
        console.error(
          `[slots] the session on ${model ?? act} at ${entry.name} could not be closed (it idles out in `
          + `${SESSION_IDLE_S}s): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}
