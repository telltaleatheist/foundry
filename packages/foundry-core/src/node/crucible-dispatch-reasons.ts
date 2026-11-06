/**
 * crucible-dispatch-reasons — the words a refused or waiting placement is said in.
 */
import { enginelessServers } from './crucible-registry';
import { type CapabilityRow } from '../shared/engine-settings';
import { type SlotRefusal, type VenueSource } from '../shared/slots';
import { CAPABILITY_WORDS } from './crucible-dispatch-capability';
import type { CapabilityClass } from './crucible-dispatch-capability';
import { UPSTREAM_SETTINGS } from './crucible-dispatch-failure';

/**
 * THE TAIL OF EVERY PARKED SENTENCE — and the ONE thing it has to get right is
 * which control the person should reach for.
 *
 * BookForge's `orAny(source)`, adopted on their advice that it is the single
 * most important thing to copy from their queue. The failure it prevents is
 * silent: every cause a row can park for arises under BOTH sources, the cause
 * does not say which, and telling somebody whose book already says Any to *"set
 * this book to Any"* is telling them to do the thing they have already done. A
 * person who follows that instruction, finds it changes nothing, and reads the
 * same sentence again has been told to fix the wrong control by an app that
 * sounded certain.
 *
 * See {@link VenueSource}. It is a space-prefixed clause rather than a sentence
 * so the caller composes one sentence and not two.
 */
export function orAnyWords(source: VenueSource): string {
  return source === 'dial'
    ? ". Turn the queue's GPU dial to Any to let it run anywhere"
    : '. Set this job to Any to let it run anywhere';
}

/**
 * THE OTHER HALF OF A STANDING REFUSAL: what a person does about it.
 *
 * The server's own `reason` already travels on the wait (the shortfall it
 * measured, the sentence a host-mode engine gives for a class that needs WSL),
 * and that half names the FACT. This names the ROUTES out of it, and there are
 * exactly two: send the class to an upstream from that engine's own settings —
 * the same card `UPSTREAM_SETTINGS` names for a missing credential, because it
 * is the same card — or put the job on a different server with the picker on the
 * row. A third, "buy a bigger card", is real and is not something an app says.
 */
export function whatToDoAbout(capability: CapabilityClass): string {
  return `Nothing here will change that on its own: ${UPSTREAM_SETTINGS} to route ${CAPABILITY_WORDS[capability].noun} `
    + 'work to an upstream, or choose a different server for this job.';
}

/**
 * THE USER'S HALF OF A CAPABILITY REFUSAL — the server's own words, said the way
 * a person reads them rather than the way an operator logs them.
 *
 * Owen, 2026-09-21, twice in one night: a user line should *"say what it's doing
 * generically … no inner workings"*. A class's `reason` is the OPERATOR's field:
 * it carries the door name ("the VLM door"), the backend block ("mlx-darwin")
 * and a leading `disabled:` that only restates the verdict the sentence already
 * gave ("can't read pages") — the double-`disabled:` we were shipping into the
 * user line.
 *
 * So the USER line prefers `row.summary`, the person-first sentence Crucible is
 * adding beside `reason` in the `GET /v1/capability` decision. `reason` is kept
 * full and untouched — it still travels to the logs and to `crucible doctor`.
 * Until Crucible ships `summary` (the vendored SDK type predates it, so
 * `readCapability` threads it through a widening cast and it is simply absent for
 * now) this falls back to `reason` with the redundant `disabled:` prefix
 * stripped, so the line reads on both vintages — the internals only fully leave
 * the user line once the server sends the summary.
 */
export function personReasonOf(row: CapabilityRow): string {
  const summary = row.summary?.trim();
  if (summary) return summary;
  if (row.reason === null) return 'the server did not say why';
  return row.reason.replace(/^\s*disabled:\s*/i, '') || 'no model fits its card';
}

/**
 * THE SENTENCE FOR A BOARD WITH NO GPU SLOT ON IT — the one refusal that is
 * about the app's configuration rather than about any server.
 *
 * THREE SILENCES, TOLD APART, because they want three different things done. A
 * host that offered no registry (or could not be asked) already carries its own
 * sentence on {@link SlotRefusal}, and it is used verbatim rather than reworded —
 * a hosted window's person cannot open this app's Settings. Every enabled server
 * that resolved to an orchestrator with nothing behind it says so in the
 * resolver's own words, which name the machine and what to install on it.
 * Otherwise the list is genuinely empty and the fix is one screen away.
 */
export function noEngineReason(refusal: SlotRefusal | null): string {
  if (refusal !== null) return refusal.sentence;
  const absent = enginelessServers();
  if (absent.length > 0) {
    return `${absent.map((server) => server.sentence).join(' ')} There is no other GPU engine `
      + 'connected — add one in Settings › Servers.';
  }
  return 'No GPU engine is connected — add one in Settings › Servers. Translation, '
    + 'simplification, cleanup, analysis and page reading all run on a Crucible now, including '
    + 'a Crucible on this machine.';
}

/**
 * A WARMING LINE WITH THE ENGINE'S LOG TAIL TAKEN OFF, and the whole thing logged.
 *
 * ── What he was reading in a row four inches wide ───────────────────────────
 *
 * Owen, 2026-09-18: *"its putting logs in the gpu slot. they dont belong there,
 * they belong in the console, which is where they are. we can put human readable
 * logs where the logs are in the slot currently but they shouldnt be showing the
 * user the underlying technical stuff."* What the slot held was
 *
 *     Loading qwen3.5-9b on crucible@example-pc-wsl: vllm loading; 16s elapsed,
 *     886s before give-up — (APIServer pid=233320) INFO 09-18 01:29:35
 *     [kernel.py:369] Final IR op priority after setting platform defaults:
 *     IrOpPriorityConfig(rms_norm=['native'], fused_add_rms_norm=['native'])
 *
 * and early in a vLLM load the tail is not even a log line — it is the log
 * file's own header, which is the entire spawn command including the model path
 * and `--gpu-memory-utilization`.
 *
 * ── THE TAIL IS THE ENGINE'S AND IT IS NOT WRONG TO SEND ────────────────────
 *
 * Crucible's `warming_message` (crucible/engines/base.py) appends `log_tail(1)`
 * after an em dash, and that is genuinely what an operator wants when a load is
 * STUCK: the last thing the engine said before it stopped saying anything. So
 * nothing here is a defect in the engine, and nothing asks it to send less. WHERE
 * IT GOES is a display decision, and a display decision belongs on this side.
 *
 * The slot gets the sentence; the console gets the whole line, once per frame,
 * where a developer can read it and a person watching their queue cannot.
 *
 * ── SPLIT ON THE ENGINE'S OWN SEPARATOR, AND ONLY EVER ON THAT ──────────────
 *
 * ` — ` is the delimiter `warming_message` composes with, so it is the one
 * character sequence that reliably means "the sentence ended and the tail began".
 * A message WITHOUT one is passed through whole rather than trimmed at some
 * guessed length: no em dash means no tail, which means the sentence is all there
 * is, and shortening it would be this file inventing a truncation the engine
 * never asked for.
 *
 * ── IT IS BOOKFORGE'S FUNCTION, COPIED RATHER THAN APPROXIMATED ─────────────
 *
 * `warmingHeadline`, BookForgeApp electron/crucible/job.ts, committed there as
 * bdacf45a the same day and after the same complaint about ITS slots. The two
 * apps read the same frames off the same server, so the two answers have to be
 * the same answer — and the way that goes wrong is one of them growing a second
 * rule about where to cut. Copied whole, including the pass-through, on
 * `shared/records.ts`' grow-together rule: if Crucible's separator ever moves,
 * both move, in one commit.
 *
 * WARMING ONLY, which is BookForge's scope and not a narrowing of it. A
 * `progress` frame carries the SERVER's own fraction and message and has no
 * documented tail; splitting one on an em dash it was allowed to contain as
 * ordinary punctuation would cut a human sentence in half to solve a problem it
 * does not have.
 */
export function warmingHeadline(message: string): string {
  const cut = message.indexOf(' — ');
  if (cut < 0) return message;
  console.log(`[slots] warming: ${message}`);
  return message.slice(0, cut);
}
