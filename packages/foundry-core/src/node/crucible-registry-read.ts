/**
 * crucible-registry-read — this app's client name, and reading the registered servers.
 */
import * as os from 'node:os';
import { readAppSettings, type CrucibleServerEntry } from './app-settings';
import { foundryHost, hosted } from './host';
import { type SlotRefusal } from '../shared/slots';

/**
 * WHAT THE SERVER LOGS AS THE HOLDER OF OUR JOBS — `foundry@<host>`, one name
 * per INSTALL.
 *
 * The SDK puts it in `X-Crucible-Client` and `User-Agent`, and that is what a
 * Crucible reports back to the NEXT client that finds the machine taken. A
 * clientName invented per call site would make one machine look like two apps.
 *
 * THE HOST IS IN IT (Crucible 1.0.76): a queue SESSION is matched to its client
 * by this name, and every request from the client holding the open session is
 * an implicit item of it. Foundry on the Mac and Foundry on the PC (and the
 * copy BookForge hosts) both saying `foundry` would ride each other's sessions
 * ahead of the line. crucible-pc-1, Oct 1 2026: one distinct, stable name per
 * install; nothing on the server keys on the exact string. The spawned engine
 * sends the same name in its header map (`headerMapFor`), so its chats are items
 * of the session the placement opened.
 */
export const CRUCIBLE_CLIENT_NAME = crucibleClientNameFor('foundry');

/** `foundry@my-mac` — the app's name and the short host name. */
export function crucibleClientNameFor(app: string, host: string = os.hostname()): string {
  const short = host.split('.')[0]?.trim().toLowerCase() ?? '';
  return short.length === 0 ? app : `${app}@${short}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The registry
// ─────────────────────────────────────────────────────────────────────────────

/** Every registered server, in priority order. The stored shape, token and all. */
export function crucibleServers(): CrucibleServerEntry[] {
  /*
   * HOSTED, THE REGISTRY IS THE HOST'S — and it is read HERE, at the one
   * function every other reader goes through, rather than at each of them.
   * `computeSlots`, `crucibleServerNamed` and the dispatcher all ask this, so
   * putting the choice anywhere else would be putting it in some of them.
   *
   * IT NEVER FALLS BACK TO THE SETTINGS FILE HOSTED. That file holds an empty
   * list nobody can write to, and reading it would mean a slot drawn from one
   * list and a credential looked up in another — the break `host.ts` describes
   * on `servers?()`. A host with no registry has no servers here, full stop.
   */
  return readRegistry().entries;
}

/** The registry, and the reason it is empty when the reason is not "none". */
export interface RegistryRead {
  entries: CrucibleServerEntry[];
  refusal: SlotRefusal | null;
}

/**
 * THE ONE READ. Standalone it is the settings file; hosted it is the host's
 * own registry and never the settings file, which hosted holds an empty list
 * nobody can write to — reading it would mean a slot drawn from one list and a
 * credential looked up in another, which is the break `host.ts` describes.
 *
 * A THROW IS NOT AN EMPTY REGISTRY. A host that implements the seam and fails
 * the call is saying something is wrong NOW, not that it has no servers, and
 * it may answer on the next read: BookForge throws `registry_snapshot_not_taken`
 * before its first snapshot is taken. Returning [] for that would put "you have
 * added no servers" in front of somebody whose servers are all still there.
 */
export function readRegistry(): RegistryRead {
  if (!hosted()) return { entries: readAppSettings().crucibleServers, refusal: null };
  const provider = foundryHost()?.servers;
  if (provider === undefined) {
    return {
      entries: [],
      refusal: {
        code: 'host_provides_no_registry',
        /*
         * THE SECOND SENTENCE USED TO BE *"Work will run the way it did before
         * servers could be chosen"*, and Wave 66 made it false: there is no
         * local GPU slot to fall back to, so GPU work in a window like this has
         * nowhere to go and is refused by name rather than quietly run here.
         * Exports and compiles are unaffected — they are CPU work, and Owen's
         * ruling keeps that lane local.
         */
        sentence: 'This window is running inside another application, and that application has '
          + 'not offered a list of GPU engines. Translation, simplification, cleanup, analysis '
          + 'and page reading have nowhere to run; exports and compiles are unaffected.',
      },
    };
  }
  try {
    return { entries: cleanHostServers(provider.call(foundryHost()) ?? []), refusal: null };
  } catch (err) {
    const said = err instanceof Error ? err.message : String(err);
    return {
      entries: [],
      refusal: {
        code: 'host_registry_unavailable',
        sentence: `The application this window runs inside could not say which Crucible servers `
          + `there are (${said}). Its list may not be ready yet; nothing here is lost.`,
      },
    };
  }
}

/**
 * The host's registry, cleaned. Empty is a real answer; so is "there is none".
 *
 * A MISSING OR FAILING SEAM IS NOT REPORTED HERE — `readRegistry` above owns
 * both, as typed state the page draws, because a log line the product's
 * behaviour depends on is a log line doing a type's job.
 *
 * WHAT IS LOGGED HERE IS A HOST'S BUG: a row that is not an entry. Name, address
 * and `enabled` are all required, and a row missing any of them is dropped
 * with a line naming the field. `enabled` is required rather than defaulted
 * because a default here would be this code deciding a fact the host owns —
 * and "switched on" is the dangerous direction to guess in. A token may be
 * empty: a server on a trusted network has none, and the request says so
 * itself if it turns out to want one.
 */
export function cleanHostServers(offered: readonly CrucibleServerEntry[]): CrucibleServerEntry[] {
  const seen = new Set<string>();
  const out: CrucibleServerEntry[] = [];
  for (const entry of offered) {
    if (typeof entry !== 'object' || entry === null) continue;
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    const url = typeof entry.url === 'string' ? entry.url.trim() : '';
    const token = typeof entry.token === 'string' ? entry.token : '';
    if (name.length === 0 || url.length === 0 || typeof entry.enabled !== 'boolean') {
      console.error(
        `[slots] the host offered a server this app cannot read and it was dropped: ${
          name.length === 0 ? 'no name' : url.length === 0 ? `"${name}" has no address`
            : `"${name}" does not say whether it is enabled`}.`,
      );
      continue;
    }
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, url, token, enabled: entry.enabled });
  }
  return out;
}

/** One entry by name, or null. Case-insensitive, because the picker is. */
export function crucibleServerNamed(name: string): CrucibleServerEntry | null {
  const key = name.trim().toLowerCase();
  return crucibleServers().find((entry) => entry.name.toLowerCase() === key) ?? null;
}
