/**
 * http-deadlines — this program's deadlines are the only ones on its requests.
 *
 * Every door this engine calls already carries an EXPLICIT total deadline,
 * scaled to how many requests can be queued ahead of it
 * (`requestDeadlineMs` in vlm/endpoint.ts, `deadlineForConcurrency` in
 * translate/transport.ts): a page or a block sent to a batching server gets no
 * bytes back until its batch finishes, and that silence has been measured at
 * ~350 s. Those deadlines were written because a runtime default fired inside
 * the normal wait and killed a 384-page book at page 73.
 *
 * Under Node (the engine runs as `foundry-engine.cjs` inside the app's own
 * Electron since 2026-09-24 — see tools/build-engine.mjs), `fetch` is undici,
 * and undici has TWO defaults of its own: `headersTimeout` and `bodyTimeout`,
 * five minutes each. They are the same trap one runtime along — they would fire
 * at 300 s under a deadline that allows 720 — so they are switched off here and
 * the engine's own deadlines stay the only ones. The connect timeout is left as
 * undici has it: a server that never accepts the socket is a network failure,
 * which the transports already retry.
 *
 * Called once, first thing, by cli.ts. Under Bun (`bun run src/cli.ts`, the
 * tests) `fetch` is Bun's own and the dispatcher is not consulted, which is
 * harmless — Bun's default was already replaced by those explicit deadlines.
 */
import { Agent, setGlobalDispatcher } from 'undici';

export function ownTheFetchDeadlines(): void {
  setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));
}
