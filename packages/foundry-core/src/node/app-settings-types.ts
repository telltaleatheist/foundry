/**
 * app-settings-types — the settings file's shape, and the limits on its lists.
 */
import { type AskPreset } from '../shared/ask-presets';
import { type CloudProviderKind, type NewJobsWaitFor } from '../shared/slots';
import { type CustomAnalysisCategory } from '../shared/analysis-categories';
import type { JobModelKind } from '../shared/job-models';

/**
 * ONE REGISTERED CRUCIBLE, AS IT IS STORED — the only shape in this app that
 * holds a token.
 *
 * It is declared here rather than in `shared/` on the rule that keeps secrets
 * out of the renderer by construction: `shared/` is compiled into the browser
 * bundle, and a type that lives there is a type somebody can reach for on the
 * other side of the preload without noticing. The renderer's shape is
 * `CrucibleServerView` (shared/slots.ts), which has a boolean where this has a
 * secret.
 */
export interface CrucibleServerEntry {
  /** What the picker calls it, and what a row's `waitFor` names. Unique. */
  name: string;
  /** The base URL WITHOUT `/v1`, which is what the SDK wants. No trailing slash. */
  url: string;
  /** The bearer token `crucible token --show` prints on that host. Never logged. */
  token: string;
  /** Off is not a slot at all: no picker entry, no `any` candidate. */
  enabled: boolean;
}

/** How many a person may register. A ceiling so "a list" cannot become a corpus. */
export const CRUCIBLE_SERVER_MAX = 8;

/**
 * ONE CONFIGURED CLOUD PROVIDER, AS IT IS STORED — the second shape in this app
 * that holds a secret, and it is here for the first one's reason exactly.
 *
 * `shared/` is compiled into the browser bundle, so a type carrying an `apiKey`
 * declared there is a type somebody can reach for on the far side of the
 * preload without noticing. The renderer's shape is `CloudProviderView`
 * (shared/slots.ts), which has a boolean where this has a credential.
 *
 * ── WHY THE MODEL IS ON THE ENTRY WHERE A CRUCIBLE HAS NONE ────────────────
 *
 * A Crucible ANSWERS which model it will serve a class with — `GET
 * /v1/capability` probes the card and selects, so a model field on a registry
 * entry would be a second opinion about a decision that has an owner. A provider
 * holds a catalog and has no opinion at all: the engine REFUSES a cloud run with
 * no `--model` (`MODEL_REQUIRED_ON_ANTHROPIC`, and the same argument on the
 * OpenAI door against a listing of dozens), so the id has to come from somewhere
 * and the only thing that knows it is the person paying for it.
 */
export interface CloudProviderEntry {
  /** What the picker calls it, and what a row's `waitFor` names. Unique. */
  name: string;
  /** Which engine door — and therefore which credential header. */
  kind: CloudProviderKind;
  /** The key. Never logged, never in argv, never across an IPC payload. */
  apiKey: string;
  /** The provider's own model id. Not validated against a list — see below. */
  model: string;
  /**
   * An OpenAI-compatible host, or EMPTY for the provider's own address
   * (`CLOUD_PROVIDER_ENDPOINT`). Empty is a real value and is not filled in at
   * rest: resolving it at the placement means a provider that moves its API is
   * one line of this build rather than a migration of everybody's settings file.
   */
  endpoint: string;
  /** Off is not a slot at all: no picker entry, nothing lit in the dock. */
  enabled: boolean;
}

/**
 * And its ceiling, {@link CRUCIBLE_SERVER_MAX}'s reason. Four is smaller than
 * eight because two providers exist and a person with more than a couple of keys
 * for them is doing something this card was not built for.
 */
export const CLOUD_PROVIDER_MAX = 4;

export interface AppSettings {
  /*
   * `keepServerWarmMinutes` AND `pageReaderRemoved` WERE HERE.
   *
   * One held the local reading server alive for a few minutes after the queue
   * drained, so the next book did not pay the model load; the other was the
   * receipt for an automatic removal -- a Crucible on this machine took over
   * page reading, so Foundry deleted its own copy and said so on a card.
   *
   * There is no local reading server and nothing of ours on the disk to
   * remove (2026-09-17). A stored key nothing reads is not harmless: it is a
   * setting somebody can find in the JSON, change, and watch do nothing.
   */

  /**
   * The folder this app treats as the user's library.
   *
   * `<libraryDir>/workspace` is where every conversion lands, and it is what
   * the Save pickers open on. It is under Documents rather than under userData
   * because a finished book is the user's property: userData is where an app
   * keeps its own bookkeeping, and a folder a person is expected to open,
   * back up and sync does not belong there.
   *
   * Changing it affects NEW work only. Nothing is migrated and nothing is
   * rewritten — recents hold absolute paths, and moving a hundred books because
   * a text field changed is not a thing a settings screen should do behind
   * somebody's back.
   */
  libraryDir: string;
  /**
   * THE CATEGORIES THIS PERSON WROTE — added in the analysis dialog, kept for
   * every book they ever analyse.
   *
   * Owen, 2026-08-25: *"maybe the user can add more categories - even
   * one-sentence descriptive ones. and they check off which ones they want to
   * search for in this document."* Two different questions, and they are stored
   * in two different places on purpose. WHAT CATEGORIES EXIST is a fact about
   * the reader — somebody who has decided a claim is worth hunting for wants it
   * on the checklist of the next book too — so it lives here, app-level, beside
   * the library folder. WHICH ONES ARE TICKED is a fact about one run, decided
   * in the dialog each time and travelling to the engine in that run's own
   * categories file; nothing about a tick is remembered here, because a
   * remembered tick is a run somebody paid an hour for without choosing to.
   *
   * IT IS NOT A MIRROR OF THE BUILT-INS. `ANALYSIS_CATEGORIES`
   * (shared/analysis-categories.ts) is the engine's own list and is never
   * written here; this holds only the additions, so an engine that grows a
   * thirteenth built-in does not have to reconcile itself with a file.
   */
  analysisCategories: CustomAnalysisCategory[];
  /*
   * ── THREE MODEL SETTINGS STOOD HERE, AND ALL THREE ARE DELETED ────────────
   *
   * `defaultLlmModel` (what Translate, Simplify and Analyse opened with),
   * `cleanTextModel` (Clean text's own, because the cleanup has its own
   * economy — ~9 blocks/min on the 27b against ~50 on the 9b-q8_0) and
   * `ollamaUrl` (where Ollama is).
   *
   * Owen, 2026-09-15: *"we dont have any local models. crucible handles all
   * model orchestration. if theres no connected crucible server then tiles
   * should be disabled."* The model a run uses is named by the ENGINE's own
   * capability record and applied at the spawn, so all three were settings that
   * could not affect a run. The cleanup's measured ratios moved to
   * `DEFAULT_CLEAN_TEXT_MODEL`'s own note (shared/pipeline.ts), which is where
   * the constant they argue for lives.
   *
   * THE ENGINE'S OLLAMA IS A DIFFERENT FACT AND IT SURVIVES: crucible
   * docs/PHASE15-HOST.md §3.2 keeps `upstreams.ollama.url` in the ENGINE's own
   * settings, written through `crucible:engine-settings`. This file's copy was
   * the duplicate, and a duplicate of somebody else's setting is the kind that
   * goes stale silently.
   */
  /**
   * ── THE SERVER REGISTRY — one entry per Crucible, IN PRIORITY ORDER ────────
   *
   * docs/SLOTS.md §3 and §6 (Package C). Each entry becomes one SLOT: a place a
   * compute-heavy job can go, beside the machine's own GPU. A person with none
   * of these never meets a picker at all — Owen: *"foundry should work if they
   * have no idea what theyre doing… but if they do know what theyre doing and
   * they want access to speed, they can use crucible."*
   *
   * THE ARRAY POSITION IS THE RANK. There is no `rank` field and there must not
   * be one; see `CrucibleServerView` (shared/slots.ts) for why two owners of one
   * ordering is a bug rather than a redundancy. A drag rewrites the array.
   *
   * THE TOKEN IS STORED HERE AND NOWHERE ELSE, and it never leaves the main
   * process: the settings card is told only whether one is set, the engine is
   * handed it in a per-spawn environment variable, and no log line, no command
   * line and no IPC payload carries it. The one exception to "stored here" is
   * the LOCAL server, whose token belongs to its own `config.toml` — and even
   * that one is copied into an entry at the moment somebody presses "Add local
   * Crucible", because a registry with a hole in it would mean two code paths
   * for every read below. What is not kept is a SECOND copy: the entry is the
   * copy, it is visible, and it can be replaced by pressing the button again.
   *
   * ── WHAT THIS REPLACED, AND THE MIGRATION, WHICH IS A DELETION ────────────
   *
   * Three keys are retired with this one, and none of them is read any more:
   *
   *   `llmServer: 'ollama' | 'vllm'` — the machine-wide choice of which door the
   *     three language acts spoke to. It is gone because the question moved: the
   *     LOCAL slot is Ollama, always (docs/SLOTS.md §2 — model required, unloaded
   *     always), and an OpenAI-compatible server is now a registry entry rather
   *     than a mode this app can be put into.
   *   `vllmUrl` — where that server was. A stored one becomes NOTHING. It is not
   *     migrated into an entry, and that is Owen's ruling rather than laziness:
   *     *"the plan is to leave VLLM to crucible only"*. An entry minted from this
   *     key would be a bare vLLM with no token, no capability record and no
   *     model listing — every read below would fail on it, and the failure would
   *     look like a broken registry rather than a setting that no longer exists.
   *   `vllmModel` — the served id that went with it. Nothing selects a model by
   *     hand on a Crucible slot: the capability record does (docs/SLOTS.md §5).
   *
   * A hand-edited file may still hold all three. They are simply not read, and
   * `writeAppSettings` preserves unknown keys, so nothing is destroyed by a
   * build that no longer understands them — which is what makes going back to an
   * older build a checkout rather than a restore.
   */
  crucibleServers: CrucibleServerEntry[];
  /**
   * ── THE CLOUD PROVIDERS — one entry per key somebody has connected ─────────
   *
   * docs/SLOTS.md §3 (Package F). Owen: *"give them the option of connecting an
   * api key for openai or claude instead of using the 27b or the 9b… for weaker
   * systems."* Each ENABLED entry becomes one SLOT, after every Crucible slot,
   * and it is never what `any` falls through to — a cloud run costs money, so
   * choosing one is a gesture with a person behind it.
   *
   * THE ORDER IS NOT A RANK here, unlike `crucibleServers`, and the difference is
   * worth naming rather than leaving to be discovered: the rank exists because
   * `any` walks the list, and `any` never reaches these. The array order is
   * simply the order the card draws them in.
   *
   * THE KEY IS STORED HERE AND NOWHERE ELSE, and it never leaves the main
   * process — `crucibleServers`' rule, one array along, with the same three
   * consequences: the card is told only whether one is set, the engine is handed
   * it in a per-spawn environment variable (`FOUNDRY_ENDPOINT_HEADERS`), and no
   * log line, no command line and no IPC payload carries it.
   */
  cloudProviders: CloudProviderEntry[];
  /**
   * WHAT A NEW ROW'S `waitFor` STARTS AS — Owen's *"New jobs wait for: (•)
   * top-ranked slot ( ) any"*.
   *
   * `top` resolves to a slot NAME at the press and writes that name on the row.
   * It deliberately does not write the word "top": a row that said "whatever is
   * ranked first" would change machines when somebody reorders the list while it
   * waits, and docs/SLOTS.md §3 rules the other way — *"queued rows do NOT move
   * when servers are re-ranked."*
   */
  newJobsWaitFor: NewJobsWaitFor;
  /**
   * THE LIVE QUEUE'S OWN MACHINE — Owen's *"global crucible server option"*, a
   * registered server's name or {@link GPU_DIAL_ANY}.
   *
   * ── Why it is here and not in a file of its own ──────────────────────────
   *
   * BookForge keeps theirs in `queue-gpu-dial.json`. This app has ONE settings
   * file with ONE clamping reader, and the dial is the same KIND of fact as the
   * field above it — a standing choice about where work goes, made once, read by
   * the queue. A second file would be a second place to look, a second corrupt-
   * file story and a second migration, for one string.
   *
   * ── AN UNKNOWN NAME IS KEPT, NOT DROPPED, AND THAT IS THE HARD PART ──────
   *
   * {@link clampQueueGpuDial} cannot ask the registry — this module IS the
   * registry's storage and a clamp that read the server list would be a cycle.
   * So a name that is not a server survives the read, and the PLACEMENT says so
   * by name. That is the right division anyway: a dial naming a server somebody
   * has temporarily switched off must keep its value (BookForge accepts a
   * disabled server for exactly this reason — refusing here would force somebody
   * to resolve two controls in one particular order), and "switched off" and
   * "never existed" are not distinguishable at the moment of a file read.
   */
  queueGpuDial: string;
  /**
   * WHICH WSL GUEST THE LOCAL CRUCIBLE LIVES IN — Windows only, and read for
   * exactly one thing: `cat`ting that server's own `config.toml`.
   *
   * Here rather than in the engine's `settings.json` because it stopped being
   * the engine's business. `backend.wslDistro` was the distro a vLLM was
   * launched in, by this app, through a launcher that no longer exists
   * (docs/SLOTS.md §6, Package B); this is the app remembering where to look for
   * a file. Two different facts that happened to share a guest.
   *
   * THERE IS NO DEFAULT AND AN EMPTY VALUE IS REFUSED AT THE READ, not filled
   * in. "The default distro" is whatever `wsl --set-default` last said, and a
   * server read out of the wrong guest is a wrong server — with a wrong token,
   * which is a 401 nobody can explain.
   */
  wslDistro: string;
  /**
   * TRUE ONCE SOMEBODY HAS BEEN THROUGH FIRST-RUN SETUP — finished OR dismissed.
   *
   * The absence of app-settings.json would have served as a first-run signal
   * and it is deliberately not the one used: the file is written the first time
   * anybody changes the library folder or adds an analysis category, so on the
   * machine where somebody poked at settings before setup ran, "no file" would
   * already be false and the wizard would never appear. An explicit marker says
   * the thing that is actually being asked.
   *
   * DISMISSING SETS IT. A wizard that came back every launch until it was
   * completed would be a wizard that punishes somebody for wanting to look at
   * the app first, and every step it offers is re-offered from the settings
   * screen, so nothing is lost by letting it go.
   */
  setupCompleted: boolean;
  /**
   * The steps that were moved past without doing the thing.
   *
   * Kept so the settings screen can say WHICH ones — "you skipped the analysis
   * worker" is actionable and "setup was not completed" is not. Free-form
   * strings rather than a union: a step id that no longer exists is a stale
   * entry the reader ignores, and a schema that refused it would turn renaming
   * a wizard step into a migration.
   */
  setupSkipped: string[];
  /**
   * THE MODEL EACH KIND OF JOB WAS LAST SENT WITH — Owen, 2026-10-25: *"bookforge
   * should use the last used model as the default."*
   *
   * A model id on a server's card, an `<upstream>/<model>`, or `''` for AUTOMATIC
   * (shared/job-models.ts). Written by the dialog after its enqueue succeeds
   * (`rememberJobModel`, electron/crucible-models.ts), read when one opens, and
   * only ever a DEFAULT: a value the list no longer offers — a model removed, a
   * dialog aimed at another server — opens on AUTOMATIC (`defaultJobModel`).
   * So a stale entry is harmless and is kept rather than pruned at the read; an
   * absent kind is a job never sent.
   */
  lastJobModels: Partial<Record<JobModelKind, string>>;
  /**
   * THE SERVER EACH KIND OF JOB WAS LAST SENT TO, by registry name — beside
   * `lastJobModels` and written with it (Owen, 2026-11-02: Ask's picker keeps the
   * last server and model). Only a default: a name no longer registered, or
   * switched off, opens on the top-ranked server.
   */
  lastJobServers: Partial<Record<JobModelKind, string>>;

  /**
   * ASK'S BUTTONS (Owen, 2026-11-02) — the person's own list, in order, or null
   * for "never changed", which draws the shipped defaults
   * (shared/ask-presets.ts). App-wide, not per book: the same jobs are asked
   * of every book. Writing null is "Restore default buttons".
   */
  askPresets: AskPreset[] | null;
  /** Which presets were checked when Send was last pressed, by id; null is never kept (the defaults). */
  askPresetsChecked: string[] | null;
}

/** How many a person may keep. A ceiling so "a list" cannot become a corpus. */
export const CUSTOM_CATEGORY_MAX = 40;
