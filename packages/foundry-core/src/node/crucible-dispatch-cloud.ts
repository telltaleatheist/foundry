/**
 * crucible-dispatch-cloud — placing on a cloud provider.
 */
import { cloudEndpointOf, cloudHeaderMapFor, cloudProviderNamed } from './cloud-providers';
import { type ComputeSlot } from '../shared/slots';
import { CAPABILITY_WORDS } from './crucible-dispatch-capability';
import type { CapabilityClass } from './crucible-dispatch-capability';
import { CRUCIBLE_CHAT_CONCURRENCY } from './crucible-dispatch-depth';
import { transientWait } from './crucible-dispatch-placement';
import type { PlacementOutcome } from './crucible-dispatch-placement';

/**
 * A CLOUD PROVIDER — and it is the shortest placement in this module, because
 * almost everything the Crucible path does has no counterpart here.
 *
 * ── What is deliberately absent, each for its own reason ───────────────────
 *
 *   * NO CAPABILITY READ. A provider has no card to measure and no class rows;
 *     which models a key may use is `Test`'s question, asked once on a settings
 *     card rather than before every run.
 *   * NO RESIDENCY AND NO LEASE. Nothing is loaded and nothing can be evicted,
 *     so there is nothing to claim — `lease: null`, and the settle has nothing
 *     to release.
 *   * NO BUSY, AND THEREFORE NO `wait` ARM AT ALL. A provider's queue is
 *     somebody else's and its way of saying "later" is a 429, which the ENGINE
 *     waits out (docs/VLLM.md §2a: `retry-after` honoured, else 2 s doubling to
 *     30 s, six attempts, each wait logged). Parking the row here for a fact
 *     this app cannot observe would be a second waiter over one queue.
 *   * NO NETWORK CALL OF ANY KIND. This function does not check that the
 *     provider is reachable, on `interpretFailure`'s posture one door along: a
 *     reachability probe before every spawn would put a round trip in front of
 *     every row and still tell the run nothing it will not learn in its first
 *     request, with a better sentence.
 *
 * ── And the one refusal it does make ───────────────────────────────────────
 *
 * TEXT ACTS ONLY (docs/SLOTS.md §3). A `pages` job pinned to a provider is
 * refused BY NAME and not waited on, because it will be refused identically
 * every time: page reading is a VLM pass over rendered images through this app's
 * own reader or a Crucible, and no cloud text door in this build serves it.
 */
export function placeOnCloud(slot: ComputeSlot, capability: CapabilityClass): PlacementOutcome {
  const entry = cloudProviderNamed(slot.name);
  if (entry === null) {
    return transientWait(`"${slot.name}" is no longer configured`);
  }
  if (capability === 'pages') {
    return {
      verdict: 'refuse',
      reason: `${entry.name} can't ${CAPABILITY_WORDS[capability].verb}; page reading stays on this machine or a Crucible.`,
    };
  }
  return {
    verdict: 'go',
    placement: {
      slot,
      /*
       * OpenAI'S OWN API IS AN OpenAI-COMPATIBLE SERVER, so a provider of that
       * kind takes the door that already existed and Anthropic takes the dialect
       * of its own. The engine refuses an unknown `--server` value by name, so
       * this mapping is total by construction rather than by a default.
       */
      door: entry.kind === 'anthropic' ? 'anthropic' : 'openai',
      endpoint: cloudEndpointOf(entry),
      // A PROVIDER IS NOT A CRUCIBLE, so there is no decide door behind it and no
      // engine address to state. See `Placement.origin`.
      origin: null,
      /*
       * `--model` IS REQUIRED ON BOTH CLOUD DOORS and there is no default to
       * fall back on — a provider holds a catalog. The id is the one the person
       * typed on the card and `Test` proved against the provider's own listing;
       * nothing here second-guesses it, on `clampCloudModel`'s argument that a
       * table of hosted model names compiled into a build is wrong by the next
       * release.
       */
      model: entry.model,
      env: { FOUNDRY_ENDPOINT_HEADERS: cloudHeaderMapFor(entry) },
      session: null,
      /*
       * A PROVIDER RATIONS BY AN ACCOUNT'S RATE LIMIT, not by a card, and nobody
       * has measured a number for one — so this states the same four the Crucible
       * chat door states (ruling 4) rather than letting the engine's twelve, which
       * was measured against a batching vLLM, decide for somebody's billing.
       */
      concurrency: CRUCIBLE_CHAT_CONCURRENCY,
      /*
       * NULL, AND THAT IS NOT THE SAME SHAPE AS AN UPSTREAM ROUTE. `via` says
       * "a Crucible forwarded this on the operator's account" and puts the run
       * in that server's `[cloud]` lane. This slot IS the provider — it has a
       * lane of its own and an app-held key, which is exactly what PHASE15 §5.3
       * deletes (Package L).
       */
      via: null,
    },
  };
}
