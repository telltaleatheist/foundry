/**
 * app-settings-clamp — each field read from disk, held to what it may be, and the library folder when none is set.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { ANY_SLOT, GPU_DIAL_ANY, slotNameRefusal, tidySlotName, type NewJobsWaitFor } from '../shared/slots';
import { ANALYSIS_CATEGORY_IDS, CUSTOM_CATEGORY_DESCRIPTION_MAX, CUSTOM_CATEGORY_NAME_MAX, customCategoryId, type CustomAnalysisCategory } from '../shared/analysis-categories';
import { JOB_MODEL_KINDS } from '../shared/job-model-offer';
import type { JobModelKind } from '../shared/job-models';
import { CLOUD_PROVIDER_MAX, CRUCIBLE_SERVER_MAX, CUSTOM_CATEGORY_MAX } from './app-settings-types';
import type { CloudProviderEntry, CrucibleServerEntry } from './app-settings-types';

/** `~/Documents/Foundry`. Created on demand, never at startup. */
export function defaultLibraryDir(): string {
  return path.join(os.homedir(), 'Documents', 'Foundry');
}

/**
 * An absolute directory path, or the default.
 *
 * ABSOLUTE is the whole check: a relative path in this field would be resolved
 * against whatever the process's working directory happens to be — the install
 * directory when launched from the Start menu, and something else entirely when
 * launched from a terminal — so the same setting would name two folders.
 */
export function clampLibraryDir(value: unknown, fallback = defaultLibraryDir()): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (trimmed.length === 0 || !path.isAbsolute(trimmed)) return fallback;
  return path.normalize(trimmed);
}

/**
 * ── THE HOST'S LIBRARY WINS, AND IT WINS HERE RATHER THAN AT EACH READER ────
 *
 * Hosted, the books live inside the host's own data directory
 * (docs/BOOKFORGE-HANDOFF.md §8) and `libraryDir` stops being a preference: it
 * is a fact about somebody else's folder layout. The obvious place to honour
 * that was `projectsDir()`, which is what actually composes
 * `<libraryDir>/projects` — but it is not the only reader. The Save-a-copy
 * dialog opens on the library, and `library:dir` answers the settings screen
 * with it, and a version of this that only fixed `projectsDir` would leave those
 * two naming a folder nothing in the app writes to any more.
 *
 * So the override is at the SETTING, and every reader is right for free. It goes
 * through `clampLibraryDir` exactly as a value out of the file does: a host that
 * hands over a relative path gets the same refusal a hand-edited file gets,
 * because the reason — the same setting naming two folders depending on where
 * the process was launched from — has nothing to do with who wrote it.
 *
 * WRITES ARE NOT REDIRECTED, and they do not need to be: the two IPC doors that
 * change this refuse outright while a host is mounted (`library:set`), so what
 * is in the file stays the standalone app's own answer, waiting unharmed for the
 * next time Foundry is run on its own.
 */
/**
 * The user's own categories, cleaned rather than refused.
 *
 * ── CLAMPING AND NOT VALIDATING, which is THIS file's philosophy ────────────
 *
 * The engine's settings.json refuses a write it cannot understand, because that
 * file has other writers whose intent could be destroyed. This one has exactly
 * one writer and no schema anybody else depends on, so the module header's rule
 * applies: *"out-of-range values clamp to something legal rather than
 * throwing"*. An entry with no name or no description is DROPPED rather than
 * throwing the whole list away — a hand-edited file with one bad row should cost
 * that row, not every category the person ever wrote.
 *
 * THREE THINGS ARE ENFORCED AND EACH IS LOAD-BEARING:
 *
 *   * The id is RE-DERIVED from the name and never taken from the file. It is
 *     what the engine is handed and what a report row will say for as long as
 *     the report exists, so it has to be the spelling `customCategoryId`
 *     produces and not whatever a hand edit left there.
 *   * A collision with a BUILT-IN is dropped. `buildPlan` refuses a name asked
 *     for twice (src/analyze/plan.ts) — two plans for one name would score it
 *     twice and file it twice — and a custom "hate" would reach the engine as
 *     exactly that, an hour into a run.
 *   * A collision with an EARLIER CUSTOM one is dropped, first writing wins, for
 *     the same reason and one more: the panel's legend keys off the id, and two
 *     rows sharing one would toggle each other.
 */
export function clampAnalysisCategories(value: unknown): CustomAnalysisCategory[] {
  if (!Array.isArray(value)) return [];
  const built = new Set(ANALYSIS_CATEGORY_IDS);
  const seen = new Set<string>();
  const out: CustomAnalysisCategory[] = [];
  for (const raw of value) {
    if (out.length >= CUSTOM_CATEGORY_MAX) break;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const name = typeof entry['name'] === 'string'
      ? entry['name'].replace(/\s+/g, ' ').trim().slice(0, CUSTOM_CATEGORY_NAME_MAX)
      : '';
    const description = typeof entry['description'] === 'string'
      ? entry['description'].replace(/\s+/g, ' ').trim().slice(0, CUSTOM_CATEGORY_DESCRIPTION_MAX)
      : '';
    if (name.length === 0 || description.length === 0) continue;
    const id = customCategoryId(name);
    if (id.length === 0 || built.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name, description });
  }
  return out;
}

/**
 * One of the two answers, or `top`. A word this build does not know is not one.
 */
export function clampNewJobsWaitFor(value: unknown): NewJobsWaitFor {
  return value === ANY_SLOT ? ANY_SLOT : 'top';
}

/**
 * THE LIVE QUEUE'S DIAL, or {@link GPU_DIAL_ANY} for anything unreadable.
 *
 * A MISSING RECORD IS "ANY", which is the only safe default: a dial that
 * defaulted to a machine would silently pin every row on a fresh install to
 * whichever server happened to be named, and nobody would have chosen it.
 *
 * The name is put through {@link tidySlotName} so the stored dial is comparable
 * to a stored server name by the same rule the registry stores one under — a
 * dial carrying trailing whitespace would match no slot and park every row with
 * a sentence naming a server that looks exactly right.
 */
export function clampQueueGpuDial(value: unknown): string {
  if (typeof value !== 'string') return GPU_DIAL_ANY;
  const tidied = tidySlotName(value);
  return tidied.length === 0 ? GPU_DIAL_ANY : tidied;
}

/**
 * A WSL distro name, or empty. Empty is a real answer — see `AppSettings`.
 *
 * Whitespace inside is allowed because a distro genuinely may have it
 * (`Ubuntu 22.04` is what `wsl -l -q` prints on plenty of machines) and it is
 * passed as one argv element, never through a shell. What is refused is a value
 * that would make the argument array something other than one name: a leading
 * dash would be read by `wsl.exe` as a flag of its own.
 */
export function clampWslDistro(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().slice(0, 120);
  if (trimmed.length === 0 || trimmed.startsWith('-')) return '';
  return trimmed;
}

/**
 * THE REGISTRY, CLEANED RATHER THAN REFUSED — this file's philosophy, applied to
 * the one list in it that can strand a job.
 *
 * A row is DROPPED, and every drop is a row that could otherwise be picked in a
 * `waitFor` and then fail at the spawn with something unreadable:
 *
 *   * No name or no URL. An EMPTY token is kept: it is an OPEN server
 *     (`[auth] mode = "none"`), which answers like Ollama with no token at all.
 *   * A URL that is not http(s), or that already carries `/v1`. The SDK is
 *     explicit that its `url` is the base WITHOUT the version prefix and refuses
 *     one that has it — better to drop the row here, where the settings card can
 *     say so, than to mint a client that throws a config error at dispatch.
 *   * A name `slotNameRefusal` (shared/slots.ts) has something to say about —
 *     too long, a control character, a `:`, a `/` or a `\`, or one of the two
 *     names the queue has already spent. THAT FUNCTION IS THE RULE AND THIS IS
 *     ONE OF ITS TWO READERS: it used to be two rules, a writer that checked no
 *     length beside this clamp's silent `.slice(0, 60)`, so a long name was
 *     refused by nobody and shortened on the way to disk into something the card
 *     was no longer showing. Dropped here rather than truncated, because a
 *     truncation is a name nobody chose.
 *   * A name already used by an earlier entry, first writing wins — the picker
 *     keys off the name and two rows sharing one would be one row the person
 *     cannot choose between.
 */
export function clampCrucibleServers(value: unknown): CrucibleServerEntry[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: CrucibleServerEntry[] = [];
  for (const raw of value) {
    if (out.length >= CRUCIBLE_SERVER_MAX) break;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const name = tidySlotName(entry['name']);
    const url = clampCrucibleUrl(entry['url']);
    const token = typeof entry['token'] === 'string' ? entry['token'].trim() : '';
    if (slotNameRefusal(name, 'server') !== null || url === null) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, url, token, enabled: entry['enabled'] !== false });
  }
  return out;
}

/**
 * THE CLOUD PROVIDERS, CLEANED RATHER THAN REFUSED — `clampCrucibleServers`'
 * philosophy, applied to the other list that can strand a job.
 *
 * A row is DROPPED when it could not be used, and every drop is a row that would
 * otherwise be pickable in a `waitFor` and then fail at the spawn:
 *
 *   * No name, no key, or no model. A provider has no anonymous mode and holds a
 *     catalog rather than one resident model, so an entry missing either is not
 *     something the engine could ever be spawned against — `--model` is REQUIRED
 *     on both cloud doors and the run would die at the argument parser.
 *   * A `kind` this build does not know. The kind decides the credential header
 *     and the `--server` word; a value read leniently would put an
 *     `Authorization` on a wire that wants `x-api-key`.
 *   * An `endpoint` that is not http(s). Empty is kept as empty, which MEANS the
 *     provider's own address and is the ordinary case.
 *   * A name `slotNameRefusal` (shared/slots.ts) has something to say about, by
 *     `clampCrucibleServers`' argument and through the same one function: the
 *     two lists feed ONE picker and one lane string, so a name legal in one card
 *     and not the other would be a rule a person has to learn twice.
 *   * A name that collides with an earlier cloud entry, or with a registered
 *     Crucible — the picker keys off the name and a slot list with two rows
 *     called one thing is a row the person cannot choose between. THE CRUCIBLE
 *     HALF OF THAT TEST IS NOT
 *     HERE: this function is handed one array and `clampCrucibleServers` is
 *     handed the other, so neither can see the other's names at the clamp. The
 *     refusal is at the two WRITERS (electron/cloud-providers.ts and
 *     electron/crucible-registry.ts), which read both lists, and `computeSlots`
 *     drops a duplicate as its last word.
 */
export function clampCloudProviders(value: unknown): CloudProviderEntry[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: CloudProviderEntry[] = [];
  for (const raw of value) {
    if (out.length >= CLOUD_PROVIDER_MAX) break;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const entry = raw as Record<string, unknown>;
    const name = tidySlotName(entry['name']);
    const kind = entry['kind'] === 'openai' || entry['kind'] === 'anthropic'
      ? entry['kind']
      : null;
    const apiKey = typeof entry['apiKey'] === 'string' ? entry['apiKey'].trim() : '';
    const model = clampCloudModel(entry['model']);
    const endpoint = clampCloudEndpoint(entry['endpoint']);
    if (slotNameRefusal(name, 'provider') !== null) continue;
    if (kind === null || apiKey.length === 0 || model.length === 0) continue;
    if (endpoint === null) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, kind, apiKey, model, endpoint, enabled: entry['enabled'] !== false });
  }
  return out;
}

/**
 * A provider model id, or empty when there is not one.
 *
 * NOT VALIDATED AGAINST A LIST — hosted
 * line-ups change monthly, so a table compiled into this build would refuse the
 * model somebody is paying for. The shape check is all there is — a non-empty
 * single token — and the PROOF is the Test button, which lists the provider's
 * own `/v1/models` and says whether this id is among them.
 *
 * EMPTY RATHER THAN A FALLBACK: there is no sensible
 * default model for somebody else's account, and an entry with no model is one
 * `clampCloudProviders` drops rather than one that spawns a run the engine
 * refuses by name.
 */
export function clampCloudModel(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed.length === 0 || /\s/.test(trimmed)) return '';
  return trimmed.slice(0, 120);
}

/**
 * A provider endpoint: empty (meaning the provider's own), or an http(s) base.
 *
 * NULL IS "NOT AN ADDRESS AT ALL" and drops the row — `clampCrucibleUrl`'s
 * posture, for its reason: there is no default address for somebody else's
 * gateway, and inventing one would point a key at a server nobody named. Unlike
 * that function, `/v1` is NOT stripped: the OpenAI door wants it and adds it
 * back when it is missing, so a person who pasted the URL their provider prints
 * gets exactly what they pasted.
 */
export function clampCloudEndpoint(value: unknown): string | null {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\/+$/, '');
  if (trimmed.length === 0) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.hostname.length === 0) return null;
    return trimmed;
  } catch {
    return null;
  }
}

/**
 * A Crucible base URL, or null when it is not one.
 *
 * NULL RATHER THAN A FALLBACK, which is the one place this file departs from its
 * clamping habit and has to: there is no default address for somebody else's
 * machine. A URL that cannot be understood is an entry that cannot exist, and
 * the caller drops the row instead of inventing a server.
 *
 * The trailing slash and the `/v1` suffix are both normalised away rather than
 * refused for the suffix, because pasting the URL a person has in their
 * clipboard — the one the CLI prints, with `/v1` on it — is the ordinary
 * mistake, and the SDK's own refusal of it is a config error with no card to
 * show it on.
 */
export function clampCrucibleUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
  if (trimmed.length === 0) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.hostname.length === 0) return null;
    return trimmed;
  } catch {
    return null;
  }
}

/**
 * ARE THESE TWO ENTRIES THE SAME ADDRESS? The registry's one duplicate rule.
 *
 * ── The fact it guards ────────────────────────────────────────────────────
 *
 * Since the slot wave, EVERY enabled entry draws its own GPU lane
 * (electron/crucible-registry.ts `slotsFrom`). Two enabled rows at one address
 * therefore tell the queue it has two cards when it has one, and it schedules
 * both lanes onto the same GPU — the machine is oversubscribed and nothing on
 * screen says so, because two rows is exactly what two machines looks like.
 *
 * ── Why the string compare it replaces was not enough ─────────────────────
 *
 * {@link clampCrucibleUrl} answers the TRIMMED ORIGINAL, not a normal form: it
 * drops a trailing slash and a `/v1`, and stops. So `http://LOCALHOST:7100` and
 * `http://localhost:7100` are two different strings and were two different
 * servers. `URL.origin` settles the rest for free — it lower-cases the host and
 * drops a port that is the scheme's default, so `http://host:80` and
 * `http://host` are one address.
 *
 * ── `localhost` AND `127.0.0.1` ARE DELIBERATELY NOT FOLDED ───────────────
 *
 * They can genuinely differ — a hosts-file entry, a server bound to IPv6 only —
 * and folding them would be this app making a guess about somebody's machine
 * and then refusing a row on the strength of it. BookForge took the same
 * decision for the same reason (bookforge e70f30f6), so one registry rule holds
 * across both apps. The ordinary version of that mistake is caught anyway: it
 * arrives under the same name, and the name rule has always refused it.
 *
 * ── ON ADD, NEVER ON READ ─────────────────────────────────────────────────
 *
 * Nothing calls this while loading a settings file, and nothing re-validates
 * one at startup. A registry that ALREADY holds a duplicate keeps working
 * exactly as it did — badly, with two lanes over one card, but unchanged — and
 * no file becomes unopenable because this rule arrived. That is what makes the
 * rule additive rather than a migration: fixing the registries that already
 * have one is the lane half, which is a separate decision.
 */
export function sameCrucibleAddress(a: string, b: string): boolean {
  const origin = (value: string): string | null => {
    try {
      return new URL(value).origin;
    } catch {
      return null;
    }
  };
  const left = origin(a);
  const right = origin(b);
  // An address neither side can parse is compared as written. Both doors clamp
  // before they get here, so reaching this means something stored a row this
  // build cannot read, and guessing two of those are the same machine is worse
  // than letting a duplicate through.
  if (left === null || right === null) return a === b;
  return left === right;
}

/** Step ids, deduplicated and capped. A stale id is harmless; a corpus is not. */
export function clampSkipped(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const id = entry.trim().slice(0, 40);
    if (id.length === 0) continue;
    seen.add(id);
    if (seen.size >= 20) break;
  }
  return [...seen];
}

/**
 * The four kinds this build knows, each a model id of sane length (or `''`,
 * AUTOMATIC). A kind this build does not know, or a value that is not a string,
 * is not one — the next press writes the kind again. Not trimmed: an id is
 * compared exactly against the server's list, and a space is not ours to drop.
 */
export function clampLastJobModels(value: unknown): Partial<Record<JobModelKind, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const out: Partial<Record<JobModelKind, string>> = {};
  for (const kind of JOB_MODEL_KINDS) {
    const id = raw[kind];
    if (typeof id === 'string' && id.length <= 200) out[kind] = id;
  }
  return out;
}
