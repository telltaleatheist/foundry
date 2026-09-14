/**
 * SLOTS — the places a job's compute can go, as both programs name them.
 *
 * The plan of record is docs/SLOTS.md, and Owen's sentence is the whole design:
 * *"the friend sees a single gpu slot if theyre local — their GPU slot. if
 * theyre using crucible on their local machine, the local GPU disappears… or
 * they can add a remote crucible server, like to the mac… itll show the mac's
 * gpu slot as open and usable, plus their local GPU."*
 *
 * ── WHY THIS IS `ComputeSlot` AND NOT `Slot` ────────────────────────────────
 *
 * Because `Slot` is taken, twice, by a different idea that is already right.
 * `shared/queue-board.ts` counts LANES — one GPU lane, two CPU lanes — and
 * `electron/job-queue.ts` calls one lane's claim a `Slot`. That board answers
 * *how many things may run at once on this machine*; this file answers *whose
 * machine*. They are orthogonal: a translate row takes the GPU lane whether it
 * runs against the Ollama on this desk or against a Crucible in another room.
 * One word for two questions is how a scheduler starts believing a remote job
 * is holding the local card, so the longer name is deliberate and the UI still
 * says "slot", because that is the word Owen used for the thing a person sees.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
 *
 * No token, ever. A registry entry's token lives in the app's own settings file
 * and is read in the main process by the one module that builds a client with
 * it; nothing on this wire carries it and nothing in the renderer has ever seen
 * it. {@link CrucibleServerView.tokenSet} is the only thing the settings card
 * is told about it, which is the whole of what a person needs to know to decide
 * whether to type a new one.
 *
 * No capability answers either. What a server can and cannot do is a fact with
 * a clock on it — a card gets swapped, a model is deleted, somebody starts
 * narrating — so it is asked at the moment it is acted on (dispatch) or at the
 * moment somebody presses a button (Test connection) and never cached into a
 * shape like this, where a stale copy would be indistinguishable from a fresh
 * one.
 */

/**
 * The value of a row's `waitFor` that means "the first slot that will take it".
 *
 * A RESERVED NAME rather than `null` or an absent field, because absent already
 * means something else on `Job.waitFor`: a row minted before this existed, or by
 * a host that has not re-vendored, which falls back to the standing default
 * (`AppSettings.newJobsWaitFor`) rather than to any particular slot. The
 * registry refuses a server called this, so the two can never be confused.
 */
export const ANY_SLOT = 'any';

/**
 * What the machine's own GPU is called in the picker.
 *
 * It is a NAME and not a `kind` test at the call sites for one reason: a row's
 * `waitFor` is a string, it is written down the moment somebody picks it, and it
 * has to keep meaning the same thing afterwards. The registry refuses a server
 * with this name for the same reason it refuses {@link ANY_SLOT}.
 */
export const LOCAL_SLOT_NAME = 'This computer';

/**
 * Whose compute a slot is.
 *
 * `cloud` IS THE SEAM AND IS NOT BUILT — docs/SLOTS.md §6, Package F. It is
 * declared here rather than added later because every walk in the dispatcher has
 * to know that a cloud slot is *never* what `any` falls through to (SLOTS.md §3:
 * *"a deliberate per-job choice, never something `any` falls through to"*), and
 * a `kind` union that gains a member later would make every one of those walks a
 * place somebody has to remember. Nothing constructs one today; `computeSlots`
 * never returns one, and the one walk that would have to exclude it already
 * does.
 */
export type ComputeSlotKind = 'local' | 'crucible' | 'cloud';

/** One place a job's compute can go. */
export interface ComputeSlot {
  /**
   * What a row's `waitFor` names, and what every sentence about the wait says.
   * Unique across the list: the local slot's is {@link LOCAL_SLOT_NAME} and a
   * Crucible slot's is the registry entry's own name.
   */
  name: string;
  kind: ComputeSlotKind;
  /**
   * A Crucible slot's base URL, without `/v1` — for the settings row, for the
   * "unreachable" sentence, and for composing the engine's `--endpoint`. Absent
   * on the local slot, which has no one address: its text acts go to Ollama and
   * its page reading to whatever the reader owns.
   */
  url?: string;
}

/**
 * A registered Crucible server, as the renderer is allowed to see it.
 *
 * THE ARRAY POSITION IS THE RANK. There is no `rank` field and there must not be
 * one: a rank kept beside the order is two owners of one fact, and the first
 * time a drag reorders one and not the other the picker and the `any` walk
 * disagree about which machine is first. Reordering is rewriting the array.
 */
export interface CrucibleServerView {
  name: string;
  /** Base URL without `/v1`, as stored. */
  url: string;
  /** Off means it is not a slot at all: no picker entry, no `any` candidate. */
  enabled: boolean;
  /** Whether a token is stored. The token itself never crosses this wire. */
  tokenSet: boolean;
  /**
   * Is this the Crucible on this very machine? Derived from the URL rather than
   * stored, so a person who edits the address does not leave a flag behind
   * claiming otherwise. A loopback entry that is enabled HIDES the local slot —
   * Owen: *"if theyre using crucible on their local machine, the local GPU
   * disappears"* — one card, one owner.
   */
  loopback: boolean;
}

/**
 * One entry as the settings card hands it back. The whole array is sent, in
 * order, and replaces the whole registry — see {@link CrucibleServerView}.
 */
export interface CrucibleServerEdit {
  name: string;
  url: string;
  enabled: boolean;
  /**
   * A NEW token, or `null` to keep whatever is stored.
   *
   * The field is write-only in both directions of this pair: it comes back from
   * the card filled in only when somebody typed one, and the view that goes out
   * never carries it. `null` and `''` are different answers — `''` would be a
   * person clearing the field, which is a server that can no longer be reached
   * and is refused at the door rather than stored.
   */
  token: string | null;
}

/**
 * What a new row's `waitFor` starts as — Owen's *"New jobs wait for"* setting.
 *
 * `top` is the top-ranked ENABLED slot at the moment of the press, resolved then
 * and written onto the row, because a row that said "whatever is first" would
 * change machines when somebody reorders the list while it waits. `any` is the
 * reserved name and genuinely means "the first that will take it", decided at
 * dispatch.
 */
export type NewJobsWaitFor = 'top' | 'any';

/** What `Test connection` learned, as the card draws it. */
export type CrucibleProbe =
  | {
    outcome: 'ok';
    /** `info().server.name` — what the server calls itself. */
    serverName: string;
    version: string;
    /** `cuda-linux`, `mlx-darwin`. Windows is never a backend. */
    backend: string;
    /** The card, in the server's own words. */
    gpu: string;
  }
  | {
    /**
     * Everything else, in the SDK's own sentence.
     *
     * One arm rather than one per error type, deliberately: the card prints the
     * sentence and offers nothing to press, so five arms would be five spellings
     * of the same row. The SDK's errors already name what to fix ("crucible at X
     * is unreachable", "crucible refused the token"), and replacing one of those
     * with a word of ours is how a fixable problem becomes an unfixable one. The
     * dispatcher, which has to ACT differently per error, switches on the SDK's
     * error types instead of on this.
     */
    outcome: 'failed';
    message: string;
  };

/**
 * What "Add local Crucible" answered — the entry it made, or why it could not.
 *
 * THE TOKEN IS NOT IN HERE. The whole point of reading the local server's own
 * `config.toml` is that the file is the single owner of that token (BookForge
 * reached this first and paid for the lesson: a copied token goes stale the next
 * time `crucible init --force` runs, and the first symptom is a 401 with nothing
 * saying why). Main reads the file, writes the entry, and answers with the view;
 * nothing about the token crosses the preload, and no second copy is kept beyond
 * the entry the person can see.
 */
export type LocalCrucibleAdd =
  | { outcome: 'added'; servers: CrucibleServerView[]; serverName: string; url: string; configPath: string }
  | { outcome: 'failed'; code: LocalCrucibleFailure; message: string };

/**
 * Why the local server could not be read. Each is a different thing to do about
 * it, which is why they are told apart rather than collapsed into one sentence.
 */
export type LocalCrucibleFailure =
  /** No config.toml where the local server would keep one. A STATE, not a fault. */
  | 'no_local_config'
  /** Windows, and nothing has said which WSL distro to look in. */
  | 'no_wsl_distro'
  /** `wsl.exe` would not run, or the guest failed for some other reason. */
  | 'wsl_read_failed'
  /** The file is there and is not something this reader understands. */
  | 'config_unreadable'
  /** It parses and lacks a key the server itself requires. */
  | 'config_missing_key'
  /** It reads, and an entry for that address is already in the registry. */
  | 'already_registered';

/**
 * Everything the Servers card draws in one read.
 *
 * One shape rather than three calls because the three answers are one picture
 * and a card assembled from three round trips draws a list that disagrees with
 * its own slot preview for a frame.
 */
export interface CrucibleSettingsView {
  servers: CrucibleServerView[];
  /** The slot list as it stands — what the pickers will show. */
  slots: ComputeSlot[];
  newJobsWaitFor: NewJobsWaitFor;
  /**
   * The WSL distro the local-Crucible read looks in. Empty means unset, and
   * unset is refused rather than defaulted: *"the default distro"* is whatever
   * `wsl --set-default` last said, and a server read from the wrong guest is a
   * wrong server. Only meaningful on Windows.
   */
  wslDistro: string;
  /**
   * Hosted, the slot list is the HOST's and this window neither adds nor removes
   * one (docs/SLOTS.md §3). The card draws the list read-only and says so.
   */
  hosted: boolean;
}

/**
 * Is this URL's host the machine it is read on?
 *
 * Shared because two programs ask it: main, to decide whether an entry hides the
 * local slot, and the settings card, to draw the "this replaces your local GPU
 * slot" line as somebody types. `0.0.0.0` and `::` are in the set because they
 * are bind addresses that a person pastes out of a config file, and a client
 * that dialled either of them would be dialling this machine.
 */
export function isLoopbackUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost'
    || host === '0.0.0.0'
    || host === '::'
    || host === '::1'
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
    || host.endsWith('.localhost');
}

/**
 * The slot a row's `waitFor` names, or null when nothing in the list does.
 *
 * Null is NOT an error here and the callers read it as two different facts: the
 * dispatcher reads it as "the row is waiting for a slot that is switched off or
 * gone" and holds the row saying so, and the picker reads it as "draw the stored
 * name greyed, beside the live ones" so that a person can see what their row is
 * actually waiting for before they change it.
 */
export function slotNamed(slots: readonly ComputeSlot[], name: string): ComputeSlot | null {
  return slots.find((slot) => slot.name === name) ?? null;
}
