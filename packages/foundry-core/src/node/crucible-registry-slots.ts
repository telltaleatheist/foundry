/**
 * crucible-registry-slots — which slots the servers offer, and which share an engine.
 */
import { readAppSettings, sameCrucibleAddress, type CrucibleServerEntry } from './app-settings';
import { enabledCloudProviders } from './cloud-providers';
import { ANY_SLOT, type ComputeSlot, type SlotAvailability } from '../shared/slots';
import { engineAbsence, resolvedEngineAddress } from './crucible-registry-engine';
import { readRegistry } from './crucible-registry-read';

// ─────────────────────────────────────────────────────────────────────────────
// The slots
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WHERE A JOB'S COMPUTE CAN GO, in priority order.
 *
 * ── THERE IS NO LOCAL SLOT, AND THAT IS THE WHOLE OF WAVE 66's SLOT HALF ───
 *
 * It used to be first, and it used to be what a person with no Crucible saw:
 * this machine's own Ollama, under the name "This computer", removed for exactly
 * one reason — an enabled entry whose URL was loopback. Owen deleted the slot
 * outright: *"everything goes through a crucible server now, including local…
 * there should be no local gpu listed in the queue"*, and *"one gpu slot in the
 * queue per connected crucible server. including the local crucible, which is
 * indistinguishable from the remote crucible server."*
 *
 * So the GPU slots are the enabled Crucible servers, in registry order, and
 * nothing else. A loopback entry is one of them and replaces nothing. A machine
 * with no server registered has NO slot, which is not a broken app and is not a
 * silent fallback either: a GPU job in that state is refused by name, with the
 * one thing a person can do about it (`placeJob`, crucible-dispatch.ts). CPU work
 * — every export, compile and rasterise — is untouched, because the same ruling
 * says so: *"cpu slots are always local. we dont outsource simple cpu work to
 * crucible."*
 *
 * ── AN ORCHESTRATOR WITH NO ENGINE IS NOT A SLOT ───────────────────────────
 *
 * crucible docs/PHASE17-ORCHESTRATOR.md §6: a registered address may be a tray
 * ORCHESTRATOR that manages an engine, and `resolveEngine` follows that hop once.
 * An orchestrator WITH an engine is a perfectly good slot — one machine, one
 * lane, whichever of its two addresses the person registered. An orchestrator
 * with NO engine serves no job type at all, and a lane for it would be a lane the
 * scheduler could fill with work nothing can answer. BookForge's bench draws no
 * row for one; neither does this list.
 *
 * IT IS READ OUT OF THE RESOLVER'S CACHE AND NEVER ASKED FOR HERE
 * ({@link engineAbsence}). This function is called on every pump pass and behind
 * every picker; a network hop in it would put a round trip in front of the board.
 * A cache that has never been filled answers "unknown", and unknown DRAWS THE
 * LANE — a machine nobody has probed yet is not a machine that has answered.
 *
 * ── THE CLOUD SLOTS COME LAST, AND THE ORDER IS THE WHOLE STATEMENT ────────
 *
 * One per ENABLED cloud provider (docs/SLOTS.md §3, Package F), after every
 * Crucible. The position matters because this list is what `any` walks in rank
 * order — and `any` STEPS PAST a cloud slot by kind rather than taking it
 * (`placeJob`, crucible-dispatch.ts), so putting them last means the walk has
 * already tried every machine that costs nothing before it reaches the ones that
 * cost money and declines them. A person who wants one says so on the row.
 *
 * A DUPLICATE NAME IS DROPPED HERE AS THE LAST WORD. Both writers refuse a name
 * the other list already has, so this cannot happen through the cards; a
 * hand-edited settings file can still produce it, and a picker with two rows
 * called one thing is a row nobody can choose between. The CRUCIBLE keeps the
 * name, because it was in the list first when this feature landed and because a
 * dropped cloud slot costs nothing but a slot nobody picked.
 *
 * ── Hosted, this list is the host's whole answer ───────────────────────────
 *
 * Including the emptiness of it. A host that registers no `slots` provider gets
 * an empty list, and an empty list is no longer a window that quietly runs
 * everything here: since Wave 66 there is no local slot to fall back to, so GPU
 * work in such a window is refused by name (`placeJob`, crucible-dispatch.ts) and
 * CPU work goes on exactly as before. `SlotRefusal` is what says which silence
 * this is, and its sentence says which half of the queue is affected. A host that
 * offers no cloud slot therefore has none —
 * this app's own `cloudProviders` are not merged into a host's list, because the
 * work in a hosted window runs on the host's compute and its bill is the host's.
 */
export function slotAvailability(): SlotAvailability {
  /*
   * THE ONE PLACE THAT KNOWS WHY THERE IS NO PICKER. `computeSlots()` below is
   * this function's `.slots` and nothing else, so the two cannot drift: one
   * reads the registry and derives, the other does the same and throws the
   * reason away. Both exist because most callers — the lanes, the stored-name
   * check, the cards — want the list and behave identically either way, while
   * the two that speak to a person, the picker and a placement's refusal, have
   * to say which of the silences this is.
   */
  const read = readRegistry();
  return { slots: slotsFrom(read.entries), refusal: read.refusal };
}

export function computeSlots(): ComputeSlot[] {
  return slotsFrom(readRegistry().entries);
}

/**
 * The slots a registry implies — the ONE derivation, used by both readers.
 *
 * `computeSlots()` throws the refusal away and `slotAvailability()` keeps it;
 * neither computes a slot the other would not, because there is one function
 * here that turns servers into slots and both call it.
 */
/**
 * WHICH ENTRIES LOST THE MERGE, by lower-cased name, and to whom.
 *
 * Written by {@link slotsFrom} because that is where the decision is made, and
 * read by the Servers card so a row that draws no slot can say WHY. A merge
 * nobody can see is the app quietly disagreeing with somebody's registry.
 *
 * It is a snapshot of the LAST derivation rather than a durable fact: the hop
 * cache expires, a server is switched off, and the answer changes. Every reader
 * of it re-derives the slots first, which is what keeps the two in step.
 */
export let sharesEngineWith = new Map<string, string>();

/** Whose engine this entry turned out to share, or null. See {@link sharesEngineWith}. */
export function engineSharedWith(name: string): string | null {
  return sharesEngineWith.get(name.toLowerCase()) ?? null;
}

export function slotsFrom(entries: readonly CrucibleServerEntry[]): ComputeSlot[] {
  /*
   * ── ONE LIST, ONE DERIVATION, BOTH WAYS ───────────────────────────────────
   *
   * Hosted, the entries handed in are the HOST's registry (`readRegistry`), so
   * the slots below are derived from them by this same code rather than handed
   * over as a second list. That is what stops a host and this app computing
   * different slots from the same servers, and it is what makes a credential
   * lookup impossible to miss: every slot named here came from an entry that
   * `crucibleServerNamed` will find.
   *
   * NOTHING IS SUPPRESSED HOSTED ANY MORE, and it used to be two things and then
   * one. The one was the local slot — BookForge requires Crucible and has no
   * ollama fallback (SLOTS.md §1) — and there is no local slot on either side of
   * that seam now, so the branch that hid it is gone rather than kept as a test
   * of something that cannot happen.
   *
   * CLOUD SLOTS ARE DRAWN HOSTED, and the reverse was a mistake that
   * contradicted a ruling. Owen: *"if a user can't run a 27b for translation,
   * the only way the translate/simplify cards can light up is if we connect a
   * cloud model."* A person running BookForge on a laptop IS that user, and
   * suppressing the cloud here left them no path at all — translate and
   * simplify dark, with the sentence naming a card this window did not draw.
   * The argument for suppressing was that the bill is the host's; it is not.
   * The key is the host USER's own, typed into this card by the person who
   * will pay for it, and there is no third party anywhere in it.
   */
  const servers = entries.filter((entry) => entry.enabled && engineAbsence(entry) === null);
  /*
   * ── TWO DOORWAYS ONTO ONE MACHINE ARE ONE SLOT ────────────────────────────
   *
   * Owen, 2026-09-15: *"the windows crucible instance should act as a
   * passthrough for the WSL crucible … it's just a passthrough to the real
   * engine."* So the Windows tray and the WSL engine behind it are one card
   * reachable two ways, and a registry holding both entries would otherwise
   * draw TWO GPU LANES OVER ONE CARD — the queue would believe it had two
   * machines and start two jobs on one, where the 27B needs 20.1 of the 21 GiB
   * that card has free. Slower than running them in turn, and often a failure.
   *
   * THE ADDRESS RULE IS WAVE 70's, the third caller of it: a doorway is the same
   * doorway whatever its host case or its default port
   * ({@link sameCrucibleAddress}). What is compared is the RESOLVED address, so
   * the tray at `:7101` and the engine at `:7100` land on one key.
   *
   * FIRST IN REGISTRY ORDER WINS, because the order is the person's own drag
   * rank (Wave 66) and nothing else here is entitled to rank two entries. The
   * loser is not deleted, not disabled and not renamed — it keeps its row on the
   * Servers card, which says which entry it shares a machine with.
   *
   * AN UNRESOLVED ENTRY IS NEVER MERGED. `resolvedEngineAddress` answers null
   * for a machine nobody has asked yet, and every null is its own key, so a slot
   * is hidden only on a fact and never on ignorance — `engineAbsence`'s rule one
   * line above, which this now sits beside.
   */
  const byEngine: CrucibleServerEntry[] = [];
  const merged = new Map<string, string>();
  for (const entry of servers) {
    const address = resolvedEngineAddress(entry);
    const first = address === null
      ? undefined
      : byEngine.find((kept) => {
        const keptAt = resolvedEngineAddress(kept);
        return keptAt !== null && sameCrucibleAddress(keptAt, address);
      });
    if (first === undefined) byEngine.push(entry);
    else merged.set(entry.name.toLowerCase(), first.name);
  }
  sharesEngineWith = merged;
  const out: ComputeSlot[] = byEngine.map(
    (entry): ComputeSlot => ({ name: entry.name, kind: 'crucible', url: entry.url }),
  );
  const taken = new Set(out.map((slot) => slot.name.toLowerCase()));
  for (const provider of enabledCloudProviders()) {
    if (taken.has(provider.name.toLowerCase())) continue;
    taken.add(provider.name.toLowerCase());
    /*
     * NO `url` ON A CLOUD SLOT, deliberately, and `ComputeSlot.url` carries the
     * whole argument: `localLane` reads that field to decide which lane is this
     * machine's own card, and an OpenAI-compatible endpoint at localhost would
     * be adopted as the local lane. The address is on the provider entry, which
     * is what the placement composes `--endpoint` from.
     */
    out.push({ name: provider.name, kind: 'cloud' });
  }
  return out;
}

/**
 * WHAT A NEW ROW SHOULD WAIT FOR — resolved at the press, never at the spawn.
 *
 * `top` becomes the NAME of the top-ranked enabled slot, because docs/SLOTS.md
 * §3 rules that *"queued rows do NOT move when servers are re-ranked"* and a row
 * carrying the word "top" would move. `any` stays the reserved word, which is
 * the one answer that genuinely means "decide later".
 *
 * UNDEFINED WHEN THERE IS NOTHING TO DECIDE — no slots at all, or exactly one. A
 * row with no `waitFor` is every row this queue has ever held; writing a name
 * onto it would put a fact on the wire that the picker is not even drawn to show.
 * With one slot the walk finds that slot anyway, and with none the placement
 * refuses by name — neither is a decision this function has to pre-empt.
 *
 * AND `top` IS THE TOP NON-CLOUD SLOT (docs/SLOTS.md §3: a cloud provider is *"a
 * deliberate per-job choice, never something `any` falls through to"*). The
 * ordering in `computeSlots` already puts every cloud slot last, so the filter
 * changes nothing today — it is here so that a later reordering cannot make a
 * standing preference start billing somebody by default. The same sentence in
 * two places is the point: `any` steps past them in the walk, and `top` cannot
 * name one here.
 */
export function waitForOfNewJob(): string | undefined {
  const slots = computeSlots();
  if (slots.length < 2) return undefined;
  if (readAppSettings().newJobsWaitFor === ANY_SLOT) return ANY_SLOT;
  return slots.find((slot) => slot.kind !== 'cloud')?.name;
}
