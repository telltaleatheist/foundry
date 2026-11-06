/**
 * crucible-registry-client — the SDK client this app builds for a server.
 */
import { CrucibleClient } from '@crucible/client';
import { type CrucibleServerEntry } from './app-settings';
import { CRUCIBLE_CLIENT_NAME } from './crucible-registry-read';

// ─────────────────────────────────────────────────────────────────────────────
// Talking to one, for a settings row
// ─────────────────────────────────────────────────────────────────────────────

/** What a caller may say about the client it wants. One field, and it is a clock. */
export interface ClientOptions {
  /**
   * A DEADLINE ON EVERY CALL THIS CLIENT MAKES, in milliseconds.
   *
   * `CrucibleClientOptions.timeoutMs`, new in `@crucible/client` 0.6.0 (packed
   * from crucible `e342fee`). There is no default and none is invented here: a
   * dispatch is a person's press being answered and may wait as long as the
   * platform waits, and a number chosen in this function would cancel somebody's
   * slow-but-working load. The one caller that says a number is
   * `crucible-provider.ts`'s gate probe (`PROBE_TIMEOUT_MS`), because a Mac that
   * is asleep must not put a network timeout behind a tooltip.
   */
  readonly timeoutMs?: number;
}

/**
 * A client for one entry, AT THE ADDRESS THE ENTRY HOLDS. The only place a token
 * meets the SDK.
 *
 * ── AND IT IS NOT THE ONE MOST CALLERS WANT ANY MORE ───────────────────────
 *
 * A registered address may be an ORCHESTRATOR (crucible
 * docs/PHASE17-ORCHESTRATOR.md §1), which serves no job types at all. Anything
 * that talks to the ENGINE — a capability read, a placement, a settings write,
 * coordination — goes through {@link engineClientFor} instead, which follows
 * §6's one hop. This function is what that one is built out of, and what the
 * two callers who genuinely mean *this* address use: the hop resolution itself,
 * and nothing else.
 */
export function clientFor(entry: CrucibleServerEntry, options: ClientOptions = {}): CrucibleClient {
  return new CrucibleClient({
    url: entry.url,
    // `''` is an open server here; the client wants `null`, and sends no
    // Authorization header for it (client 2.0 refuses an empty token).
    token: entry.token === '' ? null : entry.token,
    clientName: CRUCIBLE_CLIENT_NAME,
    timeoutMs: options.timeoutMs,
    queue: CRUCIBLE_QUEUE,
  });
}

/**
 * WAIT IN THE SERVER'S LINE, STATED HERE RATHER THAN INHERITED (crucible 1.0.71+,
 * docs/QUEUE.md). Owen, 2026-09-30: work waits in line when there is a line. The
 * SDK's helpers queue by default for an hour; this app's only helper jobs are the
 * model load and unload a placement makes (crucible-dispatch.ts), and a placement
 * is book work, so it waits as long as the server allows. Each of those jobs is
 * followed on its own event stream, which is what keeps it alive in the line.
 */
export const CRUCIBLE_QUEUE = { maxWaitS: 86_400 } as const;
