/**
 * crucible-registry-write — writing, adding and removing registered servers, and refusing a change a host owns.
 */
import { readAppSettings, writeAppSettings, clampCrucibleUrl, sameCrucibleAddress, CRUCIBLE_SERVER_MAX, type CrucibleServerEntry } from './app-settings';
import { hosted } from './host';
import { slotNameRefusal, tidySlotName, type CrucibleServerEdit, type CrucibleServerView } from '../shared/slots';
import { crucibleServers } from './crucible-registry-read';
import { crucibleServerViews } from './crucible-registry-views';

/**
 * REPLACE THE WHOLE REGISTRY — add, remove, rename, reorder and enable, all at
 * once, in one door.
 *
 * ── Why one door and not five ───────────────────────────────────────────────
 *
 * Because four of the five are the same operation on an ordered array, and the
 * fifth (reorder) IS the array. A `crucible:reorder` that moved an index while
 * `crucible:rename` changed a name would be two writers of one list, and a drag
 * that landed between them would write one of the two changes. The card holds
 * the list it is editing and sends it whole; the last write wins, which is what
 * a settings card means.
 *
 * ── The token is carried by its ABSENCE ─────────────────────────────────────
 *
 * `token: null` on an incoming entry means "keep what is stored", and it is what
 * the card sends for every row nobody retyped — because the card has never been
 * told the token and so cannot send it back. The match is by NAME against the
 * stored list, which is why a rename and a new token in the same gesture is the
 * one case the card must send a token for: the old name is gone and there is
 * nothing to carry forward from. It is refused by name rather than silently
 * dropping the server.
 */
export function writeCrucibleServers(edits: readonly CrucibleServerEdit[]): CrucibleServerView[] {
  refuseHostedRegistryChange();
  const stored = new Map(crucibleServers().map((entry) => [entry.name.toLowerCase(), entry]));
  /*
   * THE OTHER REGISTRY'S NAMES, read here for the reason `writeCloudProviders`
   * reads this one: two arrays with two clamps cannot see each other, and a slot
   * list with two rows called one thing is a row nobody can choose between. The
   * refusal is by name rather than a silent drop, because somebody who typed a
   * name meant something by it and deserves to be told what already has it.
   */
  const cloud = new Set(
    readAppSettings().cloudProviders.map((entry) => entry.name.toLowerCase()),
  );
  const next: CrucibleServerEntry[] = [];
  for (const edit of edits.slice(0, CRUCIBLE_SERVER_MAX)) {
    const name = tidySlotName(edit.name);
    const url = clampCrucibleUrl(edit.url);
    /*
     * THE NAME RULE HAS ONE OWNER and it is `slotNameRefusal` (shared/slots.ts),
     * which says what is wrong in a sentence this can throw verbatim. It used to
     * be two rules — this writer refused an empty name and nothing else, while
     * `clampCrucibleServers` silently cut at 60 — so a long name got past here
     * and arrived on disk as something the card was no longer showing.
     */
    const wrongName = slotNameRefusal(name, 'server');
    if (wrongName !== null) throw new Error(wrongName);
    if (cloud.has(name.toLowerCase())) {
      throw new Error(
        `"${name}" is already the name of a cloud provider. Two slots with one name is a row `
        + 'nobody can choose between — give this one a different name.',
      );
    }
    if (url === null) {
      throw new Error(
        `"${name}" needs an address like http://192.0.2.20:7100 — the server's base URL, `
        + 'without /v1 on the end.',
      );
    }
    const carried = stored.get(name.toLowerCase());
    // An EMPTY token is an OPEN server (`[auth] mode = "none"`), which answers
    // like Ollama and is protected by its firewall (Owen, 2026-10-22: "it should
    // just connect if it isnt behind a firewall").
    const token = typeof edit.token === 'string' && edit.token.trim().length > 0
      ? edit.token.trim()
      : carried?.token ?? '';
    next.push({ name, url, token, enabled: edit.enabled !== false });
  }
  /*
   * THE CLAMP IS THE SECOND READER AND THE LAST WORD. Everything above refuses
   * by name so the card can say what to fix; `clampCrucibleServers` (inside
   * `writeAppSettings`) drops what it cannot store — a duplicate name, a
   * reserved one — and the answer is read back OUT of the file rather than
   * returned from this array, on this app's standing rule that a settings door
   * answers with what was stored and never with what was sent.
   */
  writeAppSettings({ crucibleServers: next });
  return crucibleServerViews();
}

/**
 * ADD ONE SERVER, for a caller that is not editing the list.
 *
 * The Servers card sends the whole registry because it holds the whole registry;
 * the setup wizard holds three text boxes and has never seen the list, and
 * making it read one in order to append to it would be a second reader of the
 * order with a window between the read and the write. So this reads, appends and
 * hands the result to {@link writeCrucibleServers} — THE SAME ONE WRITER, with
 * every refusal it makes, rather than a second path into the settings file.
 *
 * AN EXISTING NAME IS REPLACED IN PLACE, keeping its position and its enabled
 * state, which is `addLocalCrucible`'s rule for the same reason: somebody
 * re-adding a server they already have is fixing its token, and a second entry
 * beside the first would leave the stale one in the picker.
 *
 * ── AND A SECOND NAME FOR ONE ADDRESS IS REFUSED, SINCE 2026-09-15 ────────
 *
 * This door compared NAMES and nothing else, so a registry already holding
 * `127.0.0.1:7100` as "3090 Ti" would take a second row for the same address
 * under any other name and hand the queue two GPU lanes over one card.
 * `addLocalCrucible` has always compared addresses, which made it worse than a
 * missing rule: a person who pressed the local button got a safety that a
 * person who pasted a connect code did not, for a reason nobody could infer
 * from either screen. One rule now ({@link sameCrucibleAddress}), consulted by
 * both, which is the shape the slot-name fix took for the same kind of split.
 *
 * REPLACING THE ROW AT THAT ADDRESS IS STILL FINE — that is the token refresh
 * above, and it is why the test excludes the row this call is replacing rather
 * than asking whether the address is present at all.
 *
 * It THROWS, like every other refusal this file makes, because the doors that
 * call it already print what they catch. There is no arm for "added it anyway".
 */
export function addCrucibleServer(name: string, url: string, token: string | null): CrucibleServerView[] {
  const label = tidySlotName(name);
  // A pairing's `null` is an OPEN server; this registry spells that `''`.
  const stored = token ?? '';
  const clash = crucibleServers().find(
    (entry) => entry.name.toLowerCase() !== label.toLowerCase()
      && sameCrucibleAddress(entry.url, url),
  );
  if (clash !== undefined) {
    throw new Error(
      `${url} is already registered as "${clash.name}". One engine wants one entry — `
      + 'two would give the queue two GPU slots over the same card. Rename that entry, '
      + 'or remove it if this is meant to replace it.',
    );
  }
  let replaced = false;
  const updated = crucibleServers()
    .map((entry): CrucibleServerEdit => {
      if (entry.name.toLowerCase() === label.toLowerCase()) {
        replaced = true;
        return { name: entry.name, url, enabled: entry.enabled, token: stored };
      }
      return {
      name: entry.name,
      url: entry.url,
      enabled: entry.enabled,
      // Null, so the stored token is carried forward — this function has no
      // business handling the tokens of servers it was not asked about.
      token: null,
      };
    });
  if (!replaced) updated.push({ name: label, url, enabled: true, token: stored });
  return writeCrucibleServers(updated);
}

/**
 * DROP ONE SERVER BY NAME, for a caller that is not editing the list.
 *
 * {@link addCrucibleServer}'s twin and written the same way, for the same
 * reason: read, change, hand the whole thing to the ONE writer, so that every
 * refusal and every clamp still applies and there is no second path into the
 * settings file. A name that is not there is not an error — the answer is the
 * list, which is what the caller wanted to know.
 *
 * THE ONE CALLER TODAY is the uninstall door (electron/crucible-uninstall.ts,
 * crucible `docs/INSTALL-UNINSTALL.md` §6.4): a real uninstall takes
 * `config.toml` with it, so the entry pointing at that engine is an entry
 * holding a token that no longer opens anything. Leaving it would leave a slot
 * in the picker that fails every job placed on it.
 */
export function removeCrucibleServer(name: string): CrucibleServerView[] {
  const key = tidySlotName(name).toLowerCase();
  const kept = crucibleServers()
    .filter((entry) => entry.name.toLowerCase() !== key)
    .map((entry): CrucibleServerEdit => ({
      name: entry.name,
      url: entry.url,
      enabled: entry.enabled,
      // Null, so the stored token is carried forward — see addCrucibleServer.
      token: null,
    }));
  return writeCrucibleServers(kept);
}

/**
 * HOSTED, THE REGISTRY IS SOMEBODY ELSE'S — `library:set`'s refusal, for the
 * same reason (docs/SLOTS.md §3: *"The vendored (BookForge-hosted) app takes its
 * slot list from the host"*).
 *
 * A refusal rather than a hidden card: the card IS hidden hosted, and this is
 * the door behind it. Something that can be reached by an IPC message must
 * refuse at the door as well, or the hiding is a decoration.
 */
export function refuseHostedRegistryChange(): void {
  if (!hosted()) return;
  throw new Error(
    'The servers are the host application\'s while Foundry is running inside it. '
    + 'Change them there.',
  );
}
