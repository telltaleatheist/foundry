/**
 * crucible-dispatch-failure — what a failed run says, in a person's words.
 */
import { CrucibleBusy, CrucibleCapabilityUndecided, CrucibleProtocolError, CrucibleRefused, CrucibleSessionClosed, CrucibleSessionHeld, CrucibleUnreachable, isServerSpecificRefusal } from '@crucible/client';
import { CrucibleOrchestratorError } from './crucible-registry';
import type { CapabilityClass } from './crucible-dispatch-capability';
import { standingWait, transientWait } from './crucible-dispatch-placement';
import type { PlacementOutcome } from './crucible-dispatch-placement';

/**
 * ONE THROW, READ AS ONE OF THE THREE VERDICTS.
 *
 * Every branch keeps the server's or the SDK's own words. They name what to fix
 * — "busy: bookforge, tts qwen3.5-9b 62% done", "crucible at http://… is
 * unreachable" — and a word of ours in place of one of those is how a fixable
 * problem becomes an unfixable one.
 */
/**
 * WHERE AN UPSTREAM IS CONFIGURED, spelled once so this file and act-gates.ts
 * send a person to the same place. The keys live in the ENGINE now (PHASE15 §0:
 * *"settings live in the engine and nowhere else"*), and Foundry's card is a
 * window onto that server's settings document (§5.2).
 */
export const UPSTREAM_SETTINGS = 'Open Settings › Servers and its "Where the text work runs" card';

export function interpretFailure(err: unknown, slotName: string, capability: CapabilityClass): PlacementOutcome {
  if (err instanceof CrucibleOrchestratorError) {
    /*
     * PHASE17 §6's two, and both are STANDING. An orchestrator with no engine
     * has nothing to install its way out of on a timer, and a chained pair is a
     * misconfiguration nobody's queue can unpick; each is a thing a PERSON fixes
     * on that machine, and the SDK-adjacent sentence already says which. Still a
     * WAIT for the walk, because the next machine in the ranking is a different
     * question — see {@link PlacementWait}.
     */
    return standingWait(`"${slotName}": ${err.message}`);
  }
  if (err instanceof CrucibleUnreachable) {
    return transientWait(`"${slotName}" is unreachable`);
  }
  if (err instanceof CrucibleBusy) {
    /*
     * 409 `server_busy`. The SDK renders the one sentence a person reads, and it
     * says WHO — `holder` is the busy job's recorded User-Agent, and null means
     * the client did not say, which the SDK renders as "an unnamed client"
     * rather than a guess. That is the rule the server itself keeps: a bench
     * must never be confidently wrong about whose render is on the card.
     */
    return transientWait(`"${slotName}" is ${err.busyLine}`);
  }
  if (err instanceof CrucibleRefused) {
    if (err.code === 'engine_in_use') {
      /*
       * 409 `engine_in_use`: a STREAMING session holds the resident engine
       * without occupying the lane at all, which is the state a bench used to
       * read as an idle machine while the browser extension was reading from it.
       * On a load it means, in plain words, that somebody is narrating there.
       */
      return transientWait(`someone is narrating on "${slotName}"`);
    }
    if (err instanceof CrucibleSessionHeld) {
      /*
       * Another client's queue session holds the machine (Crucible 1.0.76) and a
       * request of ours went without `queue`. A WAIT: the next machine in the
       * ranking is a different question, and this one frees when it closes.
       */
      return transientWait(`"${slotName}" is ${err.heldLine}`);
    }
    if (err instanceof CrucibleSessionClosed) {
      /*
       * THE SESSION NEVER OPENED, by its reason. `expired` / `server_restart`:
       * nobody decided against it — wait and ask again. `load_failed`: the model
       * would not load there; server-specific codes travel to the next machine,
       * anything else is about the model. Anything else (`operator`, or a reason
       * a newer server invents) is a person's decision: refused by name, never
       * re-sent by itself (crucible docs/QUEUE.md).
       */
      if (err.reason === 'expired' || err.reason === 'server_restart') {
        return transientWait(`"${slotName}" let this run's turn go from its line (${err.reason})`);
      }
      if (err.reason === 'load_failed') {
        const code = (err.details as { error?: { code?: unknown } } | null)?.error?.code;
        return typeof code === 'string' && isServerSpecificRefusal(code)
          ? transientWait(`"${slotName}" could not load the model: ${err.serverMessage}`)
          : { verdict: 'refuse', reason: `"${slotName}" could not load the model: ${err.serverMessage}` };
      }
      return {
        verdict: 'refuse',
        reason: `this run's turn was removed from "${slotName}"'s line (${err.reason}): ${err.serverMessage}`,
      };
    }
    /*
     * ── THE THREE PHASE15 REFUSALS, BY NAME (crucible §3.4) ─────────────────
     *
     * They arrive on the PLACEMENT path only through a capability read or a
     * lease; the CHAT itself is the engine's socket, and an upstream refusal
     * mid-book is the engine's own sentence on the row. Named here anyway,
     * because the day a settings write or a probe raises one, "refused translate
     * work: …" would be this app shrugging at a fact it has a word for.
     */
    if (err.code === 'upstream_unconfigured') {
      /*
       * 409. The route names an upstream the server has no key or url for —
       * §3.2 promises that cannot be STORED, so reaching it means the operator
       * removed the key after the route was set, or the config was hand-edited.
       *
       * A **STANDING** WAIT, AND IT USED TO BE A FLAT REFUSAL. The refusal had
       * the right ending and the wrong scope: every attempt on THAT server says
       * the same thing until somebody opens its settings, which is exactly what
       * standing means — but a flat `refuse` stopped the WALK, so an `any` row
       * failed on the first machine with a missing key while the second machine
       * sat there able to do the work. Standing keeps the ending for a pinned
       * row (and for a walk where every machine says this) and gives `any` the
       * step-past it should always have had.
       */
      return standingWait(
        `"${slotName}" routes ${capability} to an upstream it has no credential for: `
        + err.serverMessage,
      );
    }
    if (err.code === 'upstream_rejected' || err.code === 'upstream_unreachable') {
      /*
       * 502 either way. The upstream refused the operator's key, or could not be
       * reached from that machine — both are facts about THAT SERVER'S network
       * and account, so the same job on the next machine in the ranking is a
       * different question and `any` steps past it. The upstream's own words are
       * kept verbatim: they name what to fix, and a word of ours in their place
       * is how a fixable problem becomes an unfixable one.
       */
      // TRANSIENT, exactly as built: a network and an account both come back.
      return transientWait(`"${slotName}" could not reach its upstream: ${err.serverMessage}`);
    }
    if (err.code === 'upstream_never_resident') {
      /*
       * §3.4: *"an upstream model is never resident; send the chat."* Nothing
       * should ever reach this — `placeOnCrucible` reads the route first and the
       * upstream path opens no session at all. So it is OUR BUG, said out loud on
       * the row rather than dressed as a server problem, and refused rather than
       * retried because retrying a dispatcher defect would hide it behind a
       * backoff.
       */
      return {
        verdict: 'refuse',
        reason: `Foundry asked for an upstream model to be resident on "${slotName}", which it never is `
          + `— that is a defect in this app's dispatcher, not a fault on that server. ${err.serverMessage}`,
      };
    }
    if (err.code === 'model_not_resident') {
      /*
       * On the CHAT door this is the end of a run — the engine refuses by name
       * and never spins. Reaching it HERE, from a load, is the other half of
       * SLOTS.md §5's pair: the model is not resident and the engine will not be
       * given up, because a stream is holding it. Waited on, not failed.
       */
      return transientWait(`"${slotName}" is holding a different model for someone else`);
    }
    /*
     * `isServerSpecificRefusal` IS THE SDK'S AND STAYS THE ARBITER, and every
     * code it calls server-specific is about a machine's state RIGHT NOW — which
     * is the transient half by definition. The standing ones are named above,
     * one branch each, because "only a person can change this" is a judgement
     * about a code and not something a list of server-specific names encodes.
     */
    return isServerSpecificRefusal(err.code)
      ? transientWait(`"${slotName}" refused ${capability} work: ${err.serverMessage}`)
      : { verdict: 'refuse', reason: `"${slotName}" refused ${capability} work: ${err.serverMessage}` };
  }
  if (err instanceof CrucibleCapabilityUndecided) {
    /*
     * 503 `capability_undecided` — nothing has probed that card yet. ABSENT AND
     * "NOTHING FIT" ARE OPPOSITE NEWS and are rendered as opposites: this one
     * names the command that decides it, where a disabled class names the
     * shortfall. It waits, because running `crucible capability --write` there is
     * a thing somebody can go and do.
     *
     * TRANSIENT, and deliberately so even though a person is involved: a server
     * that has not measured its card YET is one that will — `crucible install`
     * and the operator console both write the record, and the machine is
     * otherwise working. Reading it as standing would fail a row on a server
     * that is minutes from being able to run it.
     */
    return transientWait(
      `"${slotName}" has not measured its card yet — run \`crucible capability --write\` there`,
    );
  }
  if (err instanceof CrucibleProtocolError) {
    /*
     * THE SERVER ANSWERED AND THE DOCUMENT IS WRONG — which, on this path, is
     * `capability_route_missing` or `capability_route_unknown` out of the SDK's
     * own reader (crucible PHASE15-HOST.md §3.3; the two codes are in the
     * detail, which is why the sentence carries it verbatim).
     *
     * REFUSED BY NAME, not waited on, and that is the behaviour this app had
     * when it raised the two codes itself as `CrucibleRefused`: a half-routed
     * capability document says nothing trustworthy about where a class runs, it
     * will say the same thing on the next pass, and a `local` guessed into the
     * gap is this app deciding — silently — whether an hour of somebody's book
     * runs on a card they own or an account they are billed for. It names the
     * server rather than the class for the same reason `any` steps past a
     * server-specific refusal and stops at this one: the defect is THAT
     * machine's document, and every class on it is equally unreadable.
     */
    return {
      verdict: 'refuse',
      reason: `"${slotName}" answered about ${capability} work with a document this build cannot `
        + `read: ${err.detail}`,
    };
  }
  /*
   * A THROW THIS FUNCTION HAS NOT ANTICIPATED. Transient, which is the safe
   * direction: an unrecognised failure that turns out to be permanent costs a
   * parked row somebody can cancel, and one read as permanent would fail a run
   * over a blip nobody named.
   */
  return transientWait(
    `"${slotName}" could not be asked about ${capability} work: `
    + `${err instanceof Error ? err.message : String(err)}`,
  );
}
