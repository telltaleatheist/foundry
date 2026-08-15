/**
 * The step ledger — a project's history as a tree that a person reads as a list.
 *
 * ── The failure this exists to prevent ──────────────────────────────────────
 *
 * Photoshop's History panel truncates. Step back three states, do anything at
 * all, and the three states after it are gone — which is correct for a filter
 * applied to pixels that can be applied again in a second, and catastrophic
 * here. Every payload in this app is hours of GPU or hours of a person's
 * judgement: a readings bank is a vision model over three hundred pages, a
 * translation is a model over every block of the book, a curation snapshot is
 * somebody's decisions about four hundred blocks. Truncating that history is
 * throwing away the only copies of things nobody can cheaply make again, in
 * response to a gesture — clicking an earlier row — that every user of every
 * history panel believes is free.
 *
 * So this one APPENDS. Every step records which step it was made FROM, and
 * acting while standing on an earlier step adds a step whose parent is the one
 * you were standing on. Translate to English, click back to the reading,
 * translate to Hungarian: the ledger reads import → reading → English →
 * Hungarian, Hungarian last because it happened last, its parent the reading.
 * Nothing was lost and nothing was asked.
 *
 * ── Structurally a tree, experientially a ledger ────────────────────────────
 *
 * That parent chain makes this a tree, and a tree UI would be the wrong answer
 * to a question nobody asked: people do not want to reason about a graph of
 * their book, they want to see what they have done and click back to any of it.
 * So `chronological` is the shape the UI gets — a flat list in creation order —
 * and the ONE concession to the tree is a quiet "from Read" on a row whose
 * parent is not the row immediately above it. A project worked straight through
 * has no annotations at all.
 *
 * ── Why every function here is pure ─────────────────────────────────────────
 *
 * Deleting a step destroys payload files; a re-run destroys the payload it
 * replaces; the migration rewrites the shape of every project on every user's
 * disk. That is the code in this app most worth covering with tests, and the
 * code that historically could not be reached by one, because it lived beside
 * `import { app } from 'electron'` (see the header of shared/steps.ts, which is
 * the same lesson learned the same way). So: no `fs`, no `path`, no `electron`,
 * no clock, no randomness. This module maps a ledger to a ledger, and answers
 * questions about one. Everything that touches a disk — reading the manifest,
 * unlinking the payloads a delete named, swapping a bank in on success — is the
 * main process's job, and stays there.
 *
 * `parseLedger` takes `unknown` rather than text for the same reason: reading a
 * file is the caller's business, including whatever it does about byte-order
 * marks and torn writes. This module's business starts at "here is a value that
 * claims to be a ledger", and its answer is either the ledger or a refusal that
 * names what is wrong with it.
 *
 * ── And the refusals are strict ─────────────────────────────────────────────
 *
 * Exactly as `shared/overlay.ts` is strict, and for the same reason one layer
 * up. This file is written whole by one program, so anything wrong with it is a
 * bug in that program — and a ledger half-read is worse than no ledger at all.
 * A step whose parent id is a typo, guessed at, is a book whose history says it
 * was translated from a reading it was not translated from. Every refusal names
 * the row and the field, so that the person who has to fix it can.
 */

import {
  WHY_HANDMADE,
  WHY_IMPORTED,
  WHY_MODEL_PASS,
  type LedgerParams,
  type LedgerStep,
  type ProjectLedger,
  type ProjectManifest,
  type ProjectReading,
  type ProjectStep,
  type ProjectTypeRecord,
  type StepAction,
  type StepRow,
} from './types';

/**
 * Refusals from this module, named so a caller can tell them from anything else.
 *
 * `StepLedgerError` rather than `LedgerError` because this app already has a
 * ledger — the block editor's undo history (`LedgerRow`, electron/history.ts) —
 * and an error class called after the word both of them use is an error class
 * whose message tells you nothing about which one broke.
 */
export class StepLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StepLedgerError';
  }
}

/** Every action there is, in the order a project meets them. */
export const STEP_ACTIONS = ['import', 'read', 'curate', 'translate'] as const;

/**
 * WHAT IT WOULD COST TO GET THIS PAYLOAD BACK, per action — the retention rule
 * as one table.
 *
 * The rule, settled: an imported file is irreplaceable because it is the only
 * copy in the world and only the user knows where it came from; a model pass is
 * expensive because a machine can make it again at a price somebody would feel;
 * and A USER'S EDITS ARE IRREPLACEABLE REGARDLESS OF MACHINE COST, which is the
 * part a two-state "is this expensive" field got wrong. Freezing an overlay
 * costs nothing in CPU and cannot be reproduced by any amount of it.
 *
 * It is a table rather than four `if`s at four call sites because four passes
 * ask this question — the sweep, the delete confirm, the re-run decision, the
 * row — and a rule re-derived at each of them is a rule that drifts.
 */
export const RETENTION_OF: Readonly<Record<StepAction, LedgerStep['retention']>> = {
  import: 'irreplaceable',
  read: 'expensive',
  curate: 'irreplaceable',
  translate: 'expensive',
};

/**
 * Which params each action is allowed to carry. Anything else is refused by name.
 *
 * This is where the action-specificity that a discriminated union would have
 * given at the type level actually lives (see `LedgerParams`). A read carrying an
 * `amendments` count is not a read with a harmless extra field — it is a step
 * something wrote wrong, and the interesting question is which program wrote it.
 *
 * A READ CARRIES WHAT THE OCR DIALOG ASKED FOR AND WHAT THE RUN ANSWERED, in that
 * order of importance: `skipPages` and `language` are the question (`ReadRequest`
 * has exactly those two fields the user fills in), and `generation`, `pages` and
 * `completedAt` are what came back. Both piles are recorded; only the question is
 * compared. See `MINTED_BY_THE_RUN`, which is where that split is enforced.
 */
export const PARAMS_OF: Readonly<Record<StepAction, readonly (keyof LedgerParams)[]>> = {
  import: [],
  read: ['skipPages', 'language', 'generation', 'pages', 'completedAt'],
  curate: ['generation', 'amendments'],
  translate: ['language'],
};

/**
 * ACTIONS THAT LEAVE YOU WHERE YOU WERE — a step retained BESIDE the position
 * rather than under it.
 *
 * ── The gesture this table exists to stop being punished ────────────────────
 *
 * Every other action moves the pointer onto what it just made, and that is
 * right for all of them: a reading and a translation are new states of the book,
 * and a person who queued one and then found the panes still showing the old one
 * would have watched an action produce nothing visible. A SAVE IS NOT ONE OF
 * THOSE. It does not make a new state; it retains the state you are already in
 * and hands it back to you unchanged.
 *
 * Moving the pointer onto a snapshot made the block editor read-only THE INSTANT
 * SOMEBODY PRESSED SAVE (`curationInEffect` → `curationLock`), which punished the
 * one gesture the whole restore-point idea depends on people making often — and
 * punished it for nothing, because at that instant the live overlay is byte for
 * byte the file that was just frozen, and the live one is the editable one. The
 * user pressed Save and the app took correcting away.
 *
 * Standing on a frozen save stays a deliberate act: you click the row. What
 * changes is only that the app never does it FOR you as the reward for saving.
 *
 * ── A TABLE, and the same shape as `RETENTION_OF` for the same reason ───────
 *
 * Two functions decide where the pointer lands — the append and the swap in
 * `recordLanding` — and a third would arrive the day another action is added.
 * A rule re-derived at a call site is a rule that drifts, and the way this one
 * drifts is that `overlay:commit` grows an `if` nothing else knows about.
 */
export const RETAINED_BESIDE_YOU: Readonly<Record<StepAction, boolean>> = {
  import: false,
  read: false,
  curate: true,
  translate: false,
};

/**
 * Params the RUN MINTED rather than params the run was ASKED FOR.
 *
 * ── The bug this table is the fix for ───────────────────────────────────────
 *
 * A re-run is "the same action, the same parameters, the same parent", and a
 * re-run means REPLACE. Read the same pages again and the new bank swaps in for
 * the old one; read a different book, or read from a different step, and it is a
 * new branch. That rule is the whole of `reRunTarget`.
 *
 * Compare a reading's params naively and the rule inverts itself. A re-read
 * MINTS A NEW GENERATION — that is what a generation is for, it is the app's
 * defence against amendments from a previous pass naming blocks in this one
 * (see `ProjectReading`) — so the second reading's `generation` never equals the
 * first's, no comparison ever matches, and every re-read appends a second
 * reading beside the one it was meant to replace. The user asked to read the
 * book again and got two banks, one of them stale, forever.
 *
 * So the comparison is over what was ASKED, and the generation is what came
 * back. The distinction is worth having a name for because it will come up
 * again: any params field a job STAMPS on its own answer belongs here.
 *
 * ── And `pages` is the field that proved it was a table ─────────────────────
 *
 * A page count is COUNTED OFF THE BANK AFTER THE RUN — `recordReading` counts the
 * lines in the file the engine wrote — so it is an answer in exactly the way a
 * generation is, and it sat in the question's pile for one release because it
 * ALMOST WORKS THERE. Two readings of one book usually produce the same count, so
 * a re-read usually matched the step it was meant to replace, and the count acted
 * as a proxy for "the same page range". The cases where the proxy fails are the
 * expensive ones and they fail silently:
 *
 *   A RE-READ WITH DIFFERENT `--skip-pages` produced a different count and so
 *   BRANCHED — leaving two `read` steps both naming the single
 *   `readings/<key>.jsonl` the engine writes, the older of them describing a bank
 *   that has since been archived out from under it. Two steps, one payload, and a
 *   row that renders somebody else's reading.
 *
 *   A RUN RESUMED after dying at page 200 landed with a bigger count and branched
 *   the same way — for a run that added pages to the very bank the first step
 *   names, which is the one case where "the same reading" is not even arguable.
 *
 * The fix is not to move `pages` on its own. It is to RECORD WHAT WAS ASKED FOR:
 * `ReadRequest` carries the page skips and the language and nothing else the user
 * chose, so those are what a reading is identified by, and the count went here
 * where it always belonged. A re-read of the same request replaces; a re-read
 * asking for a different page range is a different question and branches, which
 * is the rule stated rather than approximated.
 */
const MINTED_BY_THE_RUN: Readonly<Record<StepAction, readonly (keyof LedgerParams)[]>> = {
  import: [],
  read: ['generation', 'pages', 'completedAt'],
  curate: [],
  translate: [],
};

// ─────────────────────────────────────────────────────────────────────────────
// Making one
// ─────────────────────────────────────────────────────────────────────────────

/** A project with no history recorded yet. */
export function emptyLedger(): ProjectLedger {
  return { steps: [] };
}

/**
 * The origin — the import, and the only step whose parent is null.
 *
 * It is not produced by a queue job and never was: importing is a file copy, and
 * the thing it retains is the untouched original, which is irreplaceable for the
 * one reason nothing else in a project is — some of these are scans of documents
 * that exist nowhere else, and nobody but the user knows where the file came
 * from.
 *
 * THE ID IS AN ARGUMENT rather than minted here. This module has no clock and no
 * randomness on purpose (see the header), and a uuid is both. Main mints it.
 */
export function originStep(
  id: string,
  payload: string,
  createdAt: number,
  label = 'Imported',
): LedgerStep {
  return { id, parent: null, action: 'import', payload, retention: RETENTION_OF.import, createdAt, label };
}

/**
 * What a step is CALLED, in the app's voice — never a filename.
 *
 * The count is in the label rather than beside it because the row is one line
 * and "Read" alone is a row that does not say whether it read the book or four
 * pages of it. A step whose count nobody recorded says the plain word, which is
 * the honest answer and the one a migrated project gets.
 */
export function labelFor(action: StepAction, params?: LedgerParams): string {
  switch (action) {
    case 'import':
      return 'Imported';
    case 'read':
      return params?.pages === undefined || params.pages <= 0 ? 'Read' : `Read (${params.pages} pages)`;
    case 'curate':
      return params?.amendments === undefined || params.amendments <= 0
        ? 'Saved corrections'
        : `Saved corrections (${params.amendments})`;
    default:
      return params?.language === undefined || params.language.length === 0
        ? 'Translated'
        : `Translated (${params.language})`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading one off disk
// ─────────────────────────────────────────────────────────────────────────────

const LEDGER_FIELDS = ['position', 'steps'] as const;
const STEP_FIELDS = ['id', 'parent', 'action', 'payload', 'params', 'retention', 'createdAt', 'label', 'stale'] as const;
const RETENTIONS = ['irreplaceable', 'expensive', 'regenerable'] as const;

/**
 * A stored value → a ledger, or a refusal that names the row and the field.
 *
 * ONE BAD ROW TAKES THE WHOLE FILE DOWN, exactly as one bad amendment takes an
 * overlay down. Skipping a row that will not parse is the failure mode worth
 * avoiding above all others here: a step quietly dropped is a payload nothing in
 * the app knows about any more, sitting in the project folder, invisible to the
 * sweep and to the delete confirm and to the user — hours of GPU that the app has
 * forgotten it owns. A refused ledger is recoverable; the caller says so, names
 * the file, and the project opens on its per-type rows.
 *
 * `unknown` rather than text: reading the file, and whatever has to be done about
 * byte-order marks or a torn write, is the caller's job.
 */
export function parseLedger(raw: unknown): ProjectLedger {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new StepLedgerError(`The step ledger is ${JSON.stringify(raw)}, which is not a ledger object`);
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(LEDGER_FIELDS as readonly string[]).includes(key)) {
      throw new StepLedgerError(
        `The step ledger carries a field called "${key}", and a ledger is `
        + `${LEDGER_FIELDS.join(' and ')} and nothing else`,
      );
    }
  }
  if (!Array.isArray(record['steps'])) {
    throw new StepLedgerError(
      `The step ledger's "steps" is ${JSON.stringify(record['steps'])}, and the steps are the whole of a ledger`,
    );
  }

  const steps = record['steps'].map((entry, index) => readStep(entry, index));

  // ── the id is what everything else in the file points at ──────────────────
  const byId = new Map<string, LedgerStep>();
  for (const step of steps) {
    if (byId.has(step.id)) {
      throw new StepLedgerError(
        `Two steps in this ledger are both called "${step.id}". An id is what a parent points at and `
        + 'what the pointer names, so two of them means neither can be resolved',
      );
    }
    byId.set(step.id, step);
  }

  // ── the parent chain: it exists, there is one root, and nothing loops ─────
  const roots: LedgerStep[] = [];
  for (const step of steps) {
    if (step.parent === null) {
      roots.push(step);
      continue;
    }
    if (!byId.has(step.parent)) {
      throw new StepLedgerError(
        `Step "${step.id}" (${step.label}) says it was made from "${step.parent}", and there is no such `
        + 'step in this ledger. What a step was made from is not something to guess at',
      );
    }
  }
  if (steps.length > 0 && roots.length === 0) {
    throw new StepLedgerError(
      'No step in this ledger is the origin — every one of them claims to have been made from another. '
      + 'A project begins with the file that was imported',
    );
  }
  if (roots.length > 1) {
    throw new StepLedgerError(
      `This ledger has ${roots.length} steps with no parent (${roots.map((step) => `"${step.id}"`).join(', ')}), `
      + 'and a project has one origin: the document it was made from. Everything else was made from something',
    );
  }
  for (const step of steps) {
    const seen = new Set<string>([step.id]);
    let walker = step.parent;
    while (walker !== null) {
      if (seen.has(walker)) {
        throw new StepLedgerError(
          `Step "${step.id}" (${step.label}) was made from itself, by way of "${walker}". A step's `
          + 'ancestry has to end at the import, and this one goes in a circle',
        );
      }
      seen.add(walker);
      walker = byId.get(walker)!.parent;
    }
  }

  // ── the array's order IS the chronology, so it has to hold ────────────────
  //
  // Non-DECREASING rather than strictly ascending, and the difference is a real
  // case rather than leniency: a migration stamps several rows from one recorded
  // time, and two jobs can land in one millisecond. What is refused is a row
  // claiming to have happened BEFORE the row above it, because `chronological`
  // draws this array in order and "the row immediately above" is what decides
  // whether a row needs its "from …" annotation.
  for (let at = 1; at < steps.length; at += 1) {
    const step = steps[at]!;
    const before = steps[at - 1]!;
    if (step.createdAt < before.createdAt) {
      throw new StepLedgerError(
        `Step "${step.id}" (${step.label}) is listed after "${before.id}" and claims to have happened `
        + 'before it. The steps are stored in the order they happened, and that order is the list a person reads',
      );
    }
  }

  const ledger: ProjectLedger = { steps };
  if ('position' in record && record['position'] !== undefined) {
    const position = record['position'];
    if (typeof position !== 'string') {
      throw new StepLedgerError(
        `This ledger's "position" is ${JSON.stringify(position)}, and the pointer names a step by its id. `
        + 'Leave it out entirely to stand on the newest step',
      );
    }
    if (!byId.has(position)) {
      throw new StepLedgerError(
        `This ledger's pointer stands on "${position}", and there is no such step in it. The pointer decides `
        + 'what the viewers show and what the next action is made from, so it is not something to guess at',
      );
    }
    ledger.position = position;
  }
  return ledger;
}

function readStep(entry: unknown, index: number): LedgerStep {
  const where = `Step ${index} of this ledger`;
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new StepLedgerError(`${where} is ${JSON.stringify(entry)}, not a step`);
  }
  const record = entry as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(STEP_FIELDS as readonly string[]).includes(key)) {
      throw new StepLedgerError(
        `${where} carries a field called "${key}", and a step has ${STEP_FIELDS.join(', ')} and nothing else`,
      );
    }
  }

  const id = record['id'];
  if (typeof id !== 'string' || id.length === 0) {
    throw new StepLedgerError(`${where} says "id": ${JSON.stringify(id)}, and a step is named by a string`);
  }
  const parent = record['parent'];
  if (parent !== null && typeof parent !== 'string') {
    throw new StepLedgerError(
      `Step "${id}" says "parent": ${JSON.stringify(parent)}. It names the step this one was made from, `
      + 'or null for the import — and null has to be written out, because a missing parent and a parentless '
      + 'step are different claims',
    );
  }
  const action = record['action'];
  if (typeof action !== 'string' || !(STEP_ACTIONS as readonly string[]).includes(action)) {
    throw new StepLedgerError(
      `Step "${id}" says "action": ${JSON.stringify(action)}, which is not something this app does. `
      + `The actions are: ${STEP_ACTIONS.join(', ')}`,
    );
  }
  const payload = record['payload'];
  if (typeof payload !== 'string' || payload.length === 0) {
    throw new StepLedgerError(
      `Step "${id}" says "payload": ${JSON.stringify(payload)}. Every step is the retained payload of one `
      + 'action, and a step naming no file is a step with nothing behind it',
    );
  }
  const retention = record['retention'];
  if (typeof retention !== 'string' || !(RETENTIONS as readonly string[]).includes(retention)) {
    throw new StepLedgerError(
      `Step "${id}" says "retention": ${JSON.stringify(retention)}. It says what it would cost to get this `
      + `payload back, and the answers are: ${RETENTIONS.join(', ')}`,
    );
  }
  const expected = RETENTION_OF[action as StepAction];
  if (retention !== expected) {
    // REFUSED RATHER THAN CORRECTED, because the sweep reads this field without
    // knowing what an action is. A file calling a reading `regenerable` is a file
    // giving something permission to delete hours of GPU on the grounds that it
    // is cheap to make again, and quietly rewriting it would hide whichever
    // program wrote it that way.
    throw new StepLedgerError(
      `Step "${id}" is a ${action} and calls itself "${retention}". A ${action} is "${expected}" — `
      + 'what it costs to get a payload back is settled by what made it, and a step that disagrees would '
      + 'send a sweep after something it must not touch',
    );
  }
  const createdAt = record['createdAt'];
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || !Number.isInteger(createdAt) || createdAt < 0) {
    throw new StepLedgerError(
      `Step "${id}" says "createdAt": ${JSON.stringify(createdAt)}, and it is a whole number of milliseconds `
      + 'since the epoch',
    );
  }
  const label = record['label'];
  if (typeof label !== 'string' || label.length === 0) {
    throw new StepLedgerError(
      `Step "${id}" says "label": ${JSON.stringify(label)}. The label is the only part of this bookkeeping a `
      + 'person is meant to read, and a row with nothing on it is a row nobody can click on purpose',
    );
  }

  const step: LedgerStep = {
    id,
    parent: parent as string | null,
    action: action as StepAction,
    payload,
    retention: retention as LedgerStep['retention'],
    createdAt,
    label,
  };
  if ('params' in record && record['params'] !== undefined) {
    step.params = readParams(record['params'], id, action as StepAction);
  }
  if ('stale' in record && record['stale'] !== undefined) {
    if (typeof record['stale'] !== 'boolean') {
      throw new StepLedgerError(
        `Step "${id}" says "stale": ${JSON.stringify(record['stale'])}, and it is true or false`,
      );
    }
    if (record['stale']) step.stale = true;
  }
  return step;
}

/**
 * The params that are WORDS rather than counts, so a stored one can be checked.
 *
 * A LIST RATHER THAN AN `if` OF LITERALS, which it used to be: with two string
 * fields the condition read fine, and the third one — `skipPages`, "3,17,19-24" —
 * would have been a fourth clause somebody could forget while adding a field, and
 * a forgotten clause here means a page range checked as if it were a page count
 * and refused for being a string. Everything not in here is a whole number.
 */
const WORDS = ['generation', 'language', 'skipPages'] as const;

function isWord(key: keyof LedgerParams): key is typeof WORDS[number] {
  return (WORDS as readonly string[]).includes(key);
}

/** `a`, `a and b`, `a, b and c` — this app writes sentences, not comma runs. */
function spokenList(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function readParams(value: unknown, id: string, action: StepAction): LedgerParams {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new StepLedgerError(`Step "${id}" says "params": ${JSON.stringify(value)}, which is not a params object`);
  }
  const record = value as Record<string, unknown>;
  const allowed = PARAMS_OF[action];
  const params: LedgerParams = {};
  for (const named of Object.keys(record)) {
    if (!(allowed as readonly string[]).includes(named)) {
      throw new StepLedgerError(
        `Step "${id}" is a ${action} and carries a param called "${named}". A ${action} is described by `
        + `${allowed.length === 0 ? 'nothing at all' : spokenList(allowed)}`,
      );
    }
    // Narrowed only after the membership check above, which is what earns the
    // cast: every key that reaches here is one this action declares.
    const key = named as keyof LedgerParams;
    const said = record[key];
    if (said === undefined) continue;
    if (isWord(key)) {
      if (typeof said !== 'string') {
        throw new StepLedgerError(`Step "${id}" says "${key}": ${JSON.stringify(said)}, and it is a string`);
      }
      params[key] = said;
    } else {
      if (typeof said !== 'number' || !Number.isInteger(said) || said < 0) {
        throw new StepLedgerError(
          `Step "${id}" says "${key}": ${JSON.stringify(said)}, and it is a whole number of 0 or more`,
        );
      }
      params[key] = said;
    }
  }
  return params;
}

// ─────────────────────────────────────────────────────────────────────────────
// Standing somewhere, and looking around
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The step the pointer stands on, or null for a project with no history yet.
 *
 * ABSENT MEANS THE NEWEST, which is where a project spends nearly all of its
 * life. Writing the pointer on every append would rewrite the manifest to record
 * a fact the array already implies, in a folder people sync.
 *
 * A pointer naming a step that is not here falls back to the newest rather than
 * throwing. `parseLedger` refuses that file outright, so this can only be reached
 * by a ledger built in memory — and the honest answer for a pointer that has come
 * loose is the place a project with no pointer stands.
 */
export function positionOf(ledger: ProjectLedger): LedgerStep | null {
  if (ledger.position !== undefined) {
    const standing = ledger.steps.find((step) => step.id === ledger.position);
    if (standing !== undefined) return standing;
  }
  let newest: LedgerStep | null = null;
  for (const step of ledger.steps) {
    if (newest === null || step.createdAt >= newest.createdAt) newest = step;
  }
  return newest;
}

/**
 * The import — the one step with no parent — or null for a ledger with none.
 *
 * ── Which actions are made from the position, and which from the document ───
 *
 * The position is the parent of whatever the user does next, and that is right
 * for every action whose INPUT is a step's payload: a translation reads a book
 * that was cast from a bank, a save freezes a curation of a reading. A READING IS
 * NOT ONE OF THOSE. It reads the pixels, which live in `archive/` and are the
 * project's origin — `planReading` resolves the source itself for exactly this
 * reason, because the document the user is looking at may be a real-text reprint
 * with no photograph in it at all.
 *
 * So a reading's parent is this, wherever the pointer happens to be, and getting
 * that wrong is expensive in the way this whole model exists to prevent. Standing
 * on the reading and pressing OCR again is the ordinary way somebody re-reads a
 * book; parented at the position it would append a reading MADE FROM a reading,
 * which is not a thing, and `reRunTarget` would never match it — so the project
 * would collect a chain of read steps, every one of them naming the single bank
 * file the engine writes, all but the newest describing a bank that has been
 * archived out from under it. Parented here, the second read replaces the first
 * and stales the saves and translations that were about the old blocks, which is
 * what actually happened.
 *
 * It is also what `migrateLedger` already does, and a reconstruction and a
 * recording that disagreed about the shape of one project's history would be two
 * accounts of one book.
 */
export function originOf(ledger: ProjectLedger): LedgerStep | null {
  return ledger.steps.find((step) => step.parent === null) ?? null;
}

/** The step of that id, or a refusal naming it. */
export function stepOf(ledger: ProjectLedger, id: string): LedgerStep {
  const step = ledger.steps.find((candidate) => candidate.id === id);
  if (step === undefined) {
    throw new StepLedgerError(`This ledger has no step called "${id}"`);
  }
  return step;
}

/**
 * The chain that produced a step: the origin first, the step itself last.
 *
 * WALKED BY PARENT POINTER AND NOT BY ARRAY POSITION, because the array is in
 * creation order and creation order is not the chain. The whole point of this
 * design is that the step made most recently may have been made from something
 * six rows up.
 */
export function ancestry(ledger: ProjectLedger, id: string): LedgerStep[] {
  const chain: LedgerStep[] = [];
  const seen = new Set<string>();
  let walker: string | null = id;
  while (walker !== null) {
    if (seen.has(walker)) {
      throw new StepLedgerError(`Step "${id}" has an ancestry that goes in a circle, by way of "${walker}"`);
    }
    seen.add(walker);
    const step = stepOf(ledger, walker);
    chain.unshift(step);
    walker = step.parent;
  }
  return chain;
}

/** The steps made directly from this one, in creation order. */
export function childrenOf(ledger: ProjectLedger, id: string): LedgerStep[] {
  return ledger.steps.filter((step) => step.parent === id);
}

/**
 * A step and everything made from it, in creation order.
 *
 * WHAT A DELETE ACTUALLY COSTS. Deleting a step takes its descendants with it —
 * a reading's translations were made from that reading and have nowhere to hang
 * — and the confirm names every one of them before the user agrees. Creation
 * order because that is the order the confirm lists them in and the order the
 * user saw them appear.
 */
export function subtree(ledger: ProjectLedger, id: string): LedgerStep[] {
  // WALKED DOWNWARD RATHER THAN SCANNED ONCE, and the difference is a real
  // correctness hole rather than a style. A single forward pass over the array
  // only works if every parent is listed before its child, and that is an
  // invariant `appendStep` happens to produce but the file format does not
  // promise: rows stamped in one millisecond are allowed in any order, so a
  // grandchild listed above its parent would be missed — and a delete that
  // missed a descendant would leave a step pointing at a parent it had just
  // destroyed, which is a ledger that refuses to load.
  const children = new Map<string, LedgerStep[]>();
  for (const step of ledger.steps) {
    if (step.parent === null) continue;
    children.set(step.parent, [...(children.get(step.parent) ?? []), step]);
  }
  const taken = new Set<string>();
  const pending = [stepOf(ledger, id)];
  while (pending.length > 0) {
    const step = pending.pop()!;
    if (taken.has(step.id)) continue;
    taken.add(step.id);
    pending.push(...(children.get(step.id) ?? []));
  }
  return ledger.steps.filter((step) => taken.has(step.id));
}

// ─────────────────────────────────────────────────────────────────────────────
// Acting: append, or replace
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A step, added — and the pointer moved onto it, unless the step is one that is
 * retained beside you.
 *
 * IMMUTABLE, returning a new ledger, because the caller is `withManifest` in the
 * main process and a half-applied mutation on a throw is a manifest that
 * disagrees with the disk. Nothing here edits what it was given.
 *
 * THE POINTER FOLLOWS FOR EVERY ACTION BUT ONE. A person who stepped back to the
 * reading and translated is now standing on the translation — that is what they
 * just made, and it is what the viewers should be showing. Leaving the pointer
 * where it was would mean the act of translating produced nothing visible. A
 * curation save is the exception and `RETAINED_BESIDE_YOU` is where that is said
 * once, in general, rather than as a special case at the one call site that
 * happens to make one today.
 */
export function appendStep(ledger: ProjectLedger, step: LedgerStep): ProjectLedger {
  if (ledger.steps.some((existing) => existing.id === step.id)) {
    throw new StepLedgerError(`This ledger already has a step called "${step.id}"`);
  }
  if (step.parent === null) {
    if (ledger.steps.length > 0) {
      throw new StepLedgerError(
        `Step "${step.id}" (${step.label}) has no parent, and this project already has an origin. `
        + 'Every step after the import was made from something',
      );
    }
  } else if (!ledger.steps.some((existing) => existing.id === step.parent)) {
    throw new StepLedgerError(
      `Step "${step.id}" (${step.label}) says it was made from "${step.parent}", and there is no such step `
      + 'in this ledger',
    );
  }

  // CLAMPED RATHER THAN REFUSED, and this is the one place the two directions
  // differ. `parseLedger` refuses a file whose rows run backwards, because a
  // stored file like that was written by something other than this function. But
  // a clock that steps backwards between two appends is ordinary — an NTP
  // correction, a laptop waking up — and refusing to record a run that has
  // already finished would throw away the payload it produced to protect the
  // order of a list. The list wins; the payload is what matters.
  const last = ledger.steps[ledger.steps.length - 1];
  const createdAt = last === undefined ? step.createdAt : Math.max(step.createdAt, last.createdAt);

  return {
    ...ledger,
    position: pointerAfter(ledger, step),
    steps: [...ledger.steps, createdAt === step.createdAt ? step : { ...step, createdAt }],
  };
}

/**
 * Where the pointer stands once this step exists — the table, applied.
 *
 * IT IS WRITTEN OUT EVEN WHEN IT DOES NOT MOVE, and that is the whole subtlety of
 * a retained step. An absent pointer does not mean "no pointer": it means THE
 * NEWEST STEP (`positionOf`), and appending is exactly the operation that makes
 * this step the newest. So a project with no pointer that froze a save would have
 * had the pointer follow the save anyway, silently, through the very field that
 * exists to spare the manifest a line — the bug this whole rule is about,
 * arriving by the back door. Recording the position the user is actually standing
 * on is what makes "it did not move" true rather than merely intended.
 *
 * The fallback is the new step itself, for a ledger that had nothing in it to
 * stand on. No action that is retained beside you can be the first step in a
 * project — a save is made FROM a reading — so this is the honest answer to a
 * question that cannot be asked rather than a case being handled.
 */
function pointerAfter(ledger: ProjectLedger, step: LedgerStep): string {
  if (!RETAINED_BESIDE_YOU[step.action]) return step.id;
  return positionOf(ledger)?.id ?? step.id;
}

/**
 * The two fields the OCR dialog lets somebody fill in, exactly as they typed them.
 *
 * It is a named shape rather than an inline object because THREE places now hold
 * one: the dialog that asks, the plan that decides where the bank goes, and the
 * landing that records what was asked. All three have to mean the same thing by
 * it, and a shape spelled three times is a shape that grows a field in two of
 * them.
 */
export interface ReadAsk {
  /** `--skip-pages`, verbatim: "3,17,19-24". */
  skipPages?: string;
  /** `--language`: the BCP-47 tag, declared and never detected. */
  language?: string;
}

/**
 * What a reading ASKED, as params — trimmed, and dropped when there is nothing
 * left.
 *
 * ── Why this is a function and not two spreads at each call site ────────────
 *
 * A blank `--skip-pages` box and an absent field are the same statement, and two
 * spellings of it are two questions as far as `reRunTarget` is concerned: the
 * same book read twice would branch because one run recorded the empty string
 * somebody's cursor left behind. That rule used to live inline in `recordReading`
 * and nowhere else, which was fine while the landing was the only thing that
 * asked the question.
 *
 * IT IS NOT ANY MORE, and the drift would be expensive in a new way. The bank's
 * PATH is now decided before the job is enqueued, by asking `reRunTarget` the
 * same question the landing will ask hours later — so a plan that trimmed
 * differently from the landing would mint a branch path for a run the landing
 * then files as a replace, and the step and the file it names would disagree
 * about which bank belongs to which reading. One normalisation, asked twice.
 */
export function askedOf(asked: ReadAsk): LedgerParams {
  const params: LedgerParams = {};
  const skipPages = asked.skipPages?.trim() ?? '';
  if (skipPages.length > 0) params.skipPages = skipPages;
  const language = asked.language?.trim() ?? '';
  if (language.length > 0) params.language = language;
  return params;
}

/** What the user is about to do, before it has an id or a payload. */
export interface StepRequest {
  action: StepAction;
  /** The position at the moment they pressed the button. Null only for the import. */
  parent: string | null;
  params?: LedgerParams;
}

/**
 * The step this action would REPLACE, or null when it would branch.
 *
 * ── The one decision the whole model turns on ───────────────────────────────
 *
 * Same action, same parameters, same parent is a RE-RUN, and a re-run replaces:
 * the new payload swaps in when the run completes and the old one is destroyed,
 * with no timestamped hoards left behind. Anything else — another language,
 * another page range, the same action from a different step — is a BRANCH, which
 * appends and is always safe. Getting this backwards in either direction is
 * expensive in a different way: a false replace destroys a payload somebody
 * wanted, and a false branch leaves the project holding two banks where the user
 * asked for one.
 *
 * ── Why irreplaceable steps are never a target ──────────────────────────────
 *
 * Replacing means destroying, and the retention rule says user labour is never
 * destroyed by a re-run — it goes stale, visibly, and stays clickable. So an
 * irreplaceable step cannot be replaced by construction rather than by a list of
 * exceptions: the origin is never re-run (a project has one import), and two
 * curation saves from one parent are two saves, which is exactly what the spec
 * says they are. That falls out of the retention rule instead of restating it.
 *
 * ── And why a stale step IS a target ────────────────────────────────────────
 *
 * Deliberately. A translation that went stale because its reading was replaced
 * is the exact thing a user re-runs, and re-running it from the same step with
 * the same language is them saying "make this one current again". Refusing would
 * leave them with no way to refresh a branch except to delete it.
 */
export function reRunTarget(ledger: ProjectLedger, request: StepRequest): LedgerStep | null {
  const asked = identityOf(request.action, request.params);
  return ledger.steps.find((step) => (
    step.action === request.action
    && step.parent === request.parent
    && step.retention !== 'irreplaceable'
    && identityOf(step.action, step.params) === asked
  )) ?? null;
}

/**
 * The QUESTION a step asked, as one string — the thing two runs are compared by.
 *
 * ORDER-INDEPENDENT because it walks the action's own field list rather than the
 * object's keys: `{pages: 17, generation: 'a'}` and `{generation: 'a', pages: 17}`
 * are the same question however JSON happened to spell them, and an equality
 * built on key order would call them different runs.
 *
 * UNDEFINED IS ABSENT. A params bag written `{language: undefined}` and one
 * written `{}` are the same statement — a field somebody explicitly set to
 * nothing said nothing — and treating them as different would make a re-run
 * depend on how the calling dialog happened to build its object.
 */
function identityOf(action: StepAction, params?: LedgerParams): string {
  const minted = MINTED_BY_THE_RUN[action];
  const said: string[] = [action];
  for (const key of PARAMS_OF[action]) {
    if ((minted as readonly string[]).includes(key)) continue;
    const value = params?.[key];
    if (value === undefined) continue;
    said.push(`${key}=${JSON.stringify(value)}`);
  }
  return said.join('\u0000');
}

/**
 * Everything made from a replaced step, marked stale — and the step itself
 * marked fresh.
 *
 * TRANSITIVELY, because staleness is inherited the same way the payload was. A
 * curation snapshot made against a reading names blocks by `(page, order)`, and
 * those numbers mean different blocks after the pages are read again; a
 * translation of that curation was a translation of blocks that have moved. Both
 * are stale, and so is anything made from either.
 *
 * NOT THE STEP ITSELF, and it is un-stalled if it was: its payload has just been
 * swapped for a fresh one, which is what "re-run" means. A re-read of a bank that
 * had itself gone stale is exactly how a branch gets brought back to current, and
 * leaving the mark on would tell the user their new reading was old.
 *
 * STALE IS A DISPLAY STATE, NOT A DELETION. Nothing here removes a step or names
 * a file. The stale rows stay in the list, dimmed, clickable and renderable —
 * a translation made from a replaced reading still has its own bank, and that
 * bank is still a true record of what was translated.
 */
export function markStale(ledger: ProjectLedger, id: string): ProjectLedger {
  const marked = new Set(subtree(ledger, id).map((step) => step.id));
  marked.delete(id);
  return {
    ...ledger,
    steps: ledger.steps.map((step) => {
      if (marked.has(step.id)) return step.stale === true ? step : { ...step, stale: true };
      if (step.id !== id || step.stale !== true) return step;
      const { stale: _fresh, ...rest } = step;
      return rest;
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// A run that finished: append or replace, decided once
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the main process is holding when a job comes home successfully.
 *
 * THE ID IS SUPPLIED AND IS ONLY USED IF THIS APPENDS, which is the one shape
 * this module can offer for the uuid problem. A landing may turn out to be a
 * re-run, in which case there is no new step and no new id — but the caller
 * cannot know that before asking, and this module has no randomness to mint one
 * with after asking (see the header). So the caller mints one speculatively and
 * this says whether it was used.
 */
export interface LandedRun {
  action: StepAction;
  /**
   * The step this was made FROM — the position CAPTURED WHEN THE JOB WAS
   * ENQUEUED, and not the position now. A person who queued a translation from
   * the reading, then clicked back to look at something else while it ran, asked
   * for a translation of the reading; retargeting it at whatever row they happen
   * to be standing on three hours later would file the run against a parent
   * nobody chose.
   */
  parent: string;
  /** Project-relative, forward slashes. See `LedgerStep.payload`. */
  payload: string;
  params?: LedgerParams;
  createdAt: number;
  /** Minted by the caller, spent only on an append. */
  id: string;
  /** Overrides `labelFor`, for the rare step whose name the catalogue already wrote. */
  label?: string;
}

/** What a landing did — everything main needs to finish the job on disk. */
export interface Landing {
  ledger: ProjectLedger;
  /** The step as it now stands: the one appended, or the one swapped into. */
  step: LedgerStep;
  /** True when an existing step's payload was replaced rather than a new one added. */
  replaced: boolean;
  /**
   * The file the replace displaced, and which nothing in the ledger names any
   * more — or null, which is the ORDINARY answer and not an edge case.
   *
   * A re-read writes `readings/<key>.jsonl`, which is exactly where the previous
   * reading was; a re-translation writes `generated/<book> (en).epub`, which is
   * exactly where the previous translation was. The engine has already dealt with
   * what was there (the bank is archived, the origin is rotated aside), so the
   * step's payload PATH is unchanged and there is nothing left for main to unlink.
   * This is set only when a re-run genuinely moved a payload to a new path, and
   * then only when no surviving step still names the old one — a delete or a
   * destruction that took a file another row points at would leave that row
   * describing nothing.
   */
  displaced: string | null;
  /** Everything this landing marked stale, in creation order, so main can say so. */
  stale: LedgerStep[];
}

/**
 * A finished run, put where it belongs: appended, or swapped into the step it
 * re-ran.
 *
 * ── Why this is one function rather than three lines at each call site ──────
 *
 * Three places record a landing — a reading, a translation, a curation commit —
 * and every one of them owes the same four decisions: is this a re-run
 * (`reRunTarget`), what is it called (`labelFor`), what goes stale (`markStale`),
 * and what file is now nobody's. A rule re-derived at three call sites is a rule
 * that drifts, and the two ways it drifts are both expensive: a call site that
 * forgot `markStale` leaves a translation of a bank that no longer exists looking
 * current, and one that decided "replace" for itself could destroy a payload the
 * user still wanted.
 *
 * ── The replaced step KEEPS ITS PLACE AND ITS DATE ──────────────────────────
 *
 * A re-run swaps a payload; it does not move a row. Stamping the new time on it
 * would put a row claiming to have happened today above rows that happened
 * yesterday, which is precisely the file `parseLedger` refuses to load — the
 * array's order IS the chronology, and re-sorting to fix it would shuffle the
 * list under somebody who is looking at it. What changed is the payload, the
 * params the run recorded, and the label those params compose; where the step
 * sits in the story of this book did not change, because it is the same step.
 *
 * ── And nothing here touches a disk ─────────────────────────────────────────
 *
 * This is only ever called on a run that SUCCEEDED, which is what makes the
 * swap-on-success rule true by construction rather than by remembering it: a
 * failed run never reaches this function, so the old payload is still on disk and
 * still the one the ledger names. `displaced` is the caller's instruction to
 * destroy something, issued after the replacement exists and never before.
 */
export function recordLanding(ledger: ProjectLedger, run: LandedRun): Landing {
  const label = run.label ?? labelFor(run.action, run.params);
  const params = run.params !== undefined && Object.keys(run.params).length > 0
    ? run.params
    : undefined;
  const target = reRunTarget(ledger, { action: run.action, parent: run.parent, params: run.params });

  if (target === null) {
    const step: LedgerStep = {
      id: run.id,
      parent: run.parent,
      action: run.action,
      payload: run.payload,
      retention: RETENTION_OF[run.action],
      createdAt: run.createdAt,
      label,
    };
    if (params !== undefined) step.params = params;
    const next = appendStep(ledger, step);
    // Read back out of the new ledger rather than handed on: `appendStep` clamps
    // a createdAt that ran backwards, and the caller should be told what was
    // actually recorded rather than what was offered.
    return { ledger: next, step: stepOf(next, step.id), replaced: false, displaced: null, stale: [] };
  }

  const swapped: LedgerStep = { ...target, payload: run.payload, label };
  if (params === undefined) delete swapped.params;
  else swapped.params = params;
  const replaced: ProjectLedger = {
    ...ledger,
    // The same rule the append obeys, asked the same way. A re-run of an action
    // that is retained beside you cannot happen — `reRunTarget` never returns an
    // irreplaceable step, which is every action in that table — so this changes
    // nothing today and is written this way so that the two places the pointer is
    // decided cannot come to disagree about what an action does to it.
    position: pointerAfter(ledger, swapped),
    steps: ledger.steps.map((step) => (step.id === target.id ? swapped : step)),
  };
  const marked = markStale(replaced, target.id);
  const stale = subtree(marked, target.id).filter((step) => step.id !== target.id);
  return {
    ledger: marked,
    step: stepOf(marked, target.id),
    replaced: true,
    displaced: target.payload === run.payload || namesPayload(marked, target.payload)
      ? null
      : target.payload,
    stale,
  };
}

/**
 * Does any step still name this file?
 *
 * BY THE WHOLE PROJECT-RELATIVE PATH, never by its last segment. A project holds
 * `archive/Book.pdf`, `generated/Book.pdf` and `working/Book.pdf` at once, and a
 * comparison that had thrown away the layer would report the archived original as
 * still-in-use because a reprint of it happens to share a name — or, in the
 * direction that actually destroys something, would let a delete take one of them
 * believing it had checked.
 */
function namesPayload(ledger: ProjectLedger, payload: string): boolean {
  return ledger.steps.some((step) => step.payload === payload);
}

// ─────────────────────────────────────────────────────────────────────────────
// Deleting
// ─────────────────────────────────────────────────────────────────────────────

/** A delete, decided but not yet done: the ledger after, and what to destroy. */
export interface SubtreeDeletion {
  ledger: ProjectLedger;
  /**
   * Every step whose payload must be destroyed, in creation order.
   *
   * THE CALLER DOES THE FILE WORK. This module does not know a project
   * directory from a hole in the ground, and the same list is what the confirm
   * names to the user before any of it happens.
   */
  removed: LedgerStep[];
}

/**
 * A step and everything made from it, taken out of the ledger.
 *
 * CASCADES RATHER THAN REFUSING, which was the ruling and had a rejected
 * alternative: refuse until the children are deleted one at a time. That is
 * busywork — somebody deleting a branch means the branch — and making them do it
 * leaf-first teaches them nothing they did not already know. What makes the
 * cascade safe is that every casualty is named in the confirm before they agree,
 * which is what `removed` is for.
 *
 * THE ORIGIN IS REFUSED BY NAME. Deleting the import is deleting the project:
 * everything else in the folder was made from it, so there is nothing left to be
 * a project without it. The project ✕ already does that, with its own ceremony
 * and its own accounting of what it costs — and this delete quietly becoming
 * that one is precisely the confusion the ✕'s ceremony exists to prevent.
 */
export function deleteSubtree(ledger: ProjectLedger, id: string): SubtreeDeletion {
  const step = stepOf(ledger, id);
  if (step.parent === null) {
    throw new StepLedgerError(
      `"${step.label}" is the document this project was made from, and it cannot be deleted as a step: `
      + 'everything else here was made from it, so taking it is deleting the project. The ✕ on the project '
      + 'itself does that, and says what it costs first',
    );
  }

  const removed = subtree(ledger, id);
  const gone = new Set(removed.map((casualty) => casualty.id));
  const steps = ledger.steps.filter((candidate) => !gone.has(candidate.id));

  // THE POINTER MOVES TO THE PARENT when it was standing inside what went. It is
  // resolved through `positionOf` rather than read off the field, because an
  // absent pointer is not "no pointer" — it means the newest step, and the newest
  // step is the one most likely to have just been deleted. Left alone, an absent
  // pointer would silently land on whatever is newest among the survivors, which
  // is some unrelated branch rather than the place the deleted work came from.
  const standing = positionOf(ledger);
  const next: ProjectLedger = { steps };
  if (standing !== null && gone.has(standing.id)) next.position = step.parent;
  else if (ledger.position !== undefined) next.position = ledger.position;
  return { ledger: next, removed };
}

/**
 * The files a delete may actually destroy, in creation order, without repeats.
 *
 * ── Why "the removed steps' payloads" is the wrong answer ───────────────────
 *
 * Two steps are allowed to name one file, and in this app they routinely do. A
 * re-read that branched rather than replaced — a different `--skip-pages`, so a
 * different question — leaves two `read` steps, and the readings bank has ONE
 * path: the engine archives the previous one aside and writes the same
 * `readings/<key>.jsonl` again. Delete the older of those two and a naive unlink
 * would destroy the bank the newer one is made of, which is hours of GPU thrown
 * away by a delete aimed at something else entirely.
 *
 * THAT BRANCH IS NOW DELIBERATE RATHER THAN ACCIDENTAL, which is worth writing
 * down because it is what settles whether this function is still needed. It used
 * to happen when a re-read came back with a different page COUNT, which was a
 * proxy nobody chose (see `MINTED_BY_THE_RUN`); it now happens exactly when
 * somebody asks a different question of the same book. The state this defends is
 * therefore more reachable than before, not less — and a translation is the same
 * story in another folder: two `translate` steps into one language from two
 * different parents both name `generated/<book> (en).epub`, because the output
 * path is composed from the stem and the tag and knows nothing about the ledger.
 *
 * So the question is not "what did this subtree name" but "what is left naming
 * it", asked of the ledger AFTER the surgery — and asked by whole project-
 * relative path, for `namesPayload`'s reason.
 *
 * Deduplicated because the caller unlinks what this returns and a path listed
 * twice is a second unlink of something that is already gone, reported as a
 * failure by every filesystem that bothers to answer.
 */
export function orphanedPayloads(deletion: SubtreeDeletion): string[] {
  const orphaned: string[] = [];
  for (const casualty of deletion.removed) {
    if (orphaned.includes(casualty.payload)) continue;
    if (namesPayload(deletion.ledger, casualty.payload)) continue;
    orphaned.push(casualty.payload);
  }
  return orphaned;
}

/**
 * The engine's in-flight debris beside a bank, by name — the pending replacement
 * and the sidecar that says what it was asked.
 *
 * ── Why a delete has to know about files no step names ──────────────────────
 *
 * A re-read writes its answers into `<bank>.pending` and swaps that over the real
 * bank only when the run completes, so a failed one leaves the old bank untouched
 * and the pending file sitting there as resumable debris — which is the entire
 * point of it (docs/BANK-LIFECYCLE.md §2). A PENDING BANK IS INVISIBLE TO THE
 * LEDGER: steps are minted on success, and success is the moment the pending file
 * stops existing, so no step ever names one and `orphanedPayloads` cannot be the
 * thing that finds it.
 *
 * That leaves exactly one rule for the sweep to learn: when a delete destroys a
 * read step's bank, the half-finished replacement OF that bank goes with it.
 * Debris whose bank is gone is debris about nothing — a resume nothing would ever
 * ask for, keyed to a question no row in the project still asks.
 *
 * ONE FUNCTION FOR BOTH NAMES, and that is the whole reason it is a function
 * rather than two suffixes at the call site: the sidecar's name is the pending
 * file's name plus a suffix, so a call site spelling them separately is a call
 * site where the two can come to disagree about what a pending file is called.
 * The names are the engine's (src/vlm/readings.ts); this is the app reading them.
 */
export function pendingBeside(bank: string): string[] {
  const pending = `${bank}.pending`;
  return [pending, `${pending}.request`];
}

/**
 * The per-type chains with every row naming a destroyed file struck out.
 *
 * ── The ghost row this exists to prevent ────────────────────────────────────
 *
 * A delete used to do half the surgery. It took the steps off the ledger and
 * destroyed their payloads, and left `manifest.documents` — the per-type chains
 * Home's rows are drawn from — still naming the files it had just unlinked. So
 * deleting a translation gave the user a document row for an EPUB that no longer
 * existed, drawn by `summarise` as `missing`, which is the app's way of saying
 * "something went wrong with a file you still have" about a file they had just
 * told it to destroy. They asked for a clean absence and got a broken row.
 *
 * ── Which direction the truth runs ──────────────────────────────────────────
 *
 * THE LEDGER IS THE TRUTH AND THE PER-TYPE ROWS ARE A VIEW OF IT (see
 * `ProjectManifest.ledger` and `currentStandard`), so this takes its instruction
 * from the ledger's answer and never the other way round. It is handed
 * `orphanedPayloads` — the files that are ACTUALLY being destroyed — rather than
 * every removed step's payload, because a file some surviving step still names
 * survives on disk, and a chain row for a file that is still there is a row that
 * is still true.
 *
 * A CHAIN LEFT WITH NO STEPS IS DROPPED ENTIRELY, and that is what `summarise`
 * already means by it: the loop that draws the rows takes the LATEST step of each
 * record and skips a record that has none, so an empty chain is a document the
 * app will never draw again. `ProjectTypeRecord.steps` says the same thing in the
 * type — "never empty; a type with no origin is not a type this project has" — so
 * keeping the husk would leave the catalogue asserting the project has an EPUB
 * with nothing behind it, and `recordStep` rebuilds the record from nothing the
 * moment another file of that type lands.
 *
 * BY THE WHOLE PROJECT-RELATIVE PATH, `namesPayload`'s rule, and it matters more
 * here than anywhere: `archive/Book.pdf`, `working/Book.pdf` and
 * `generated/Book.pdf` are three documents in one project, and a comparison that
 * had thrown away the layer would strike the scan's row for a delete aimed at a
 * reprint.
 */
export function chainsWithout(
  documents: readonly ProjectTypeRecord[],
  destroyed: readonly string[],
): ProjectTypeRecord[] {
  const gone = new Set(destroyed);
  const kept: ProjectTypeRecord[] = [];
  for (const record of documents) {
    const steps = record.steps.filter((step) => !gone.has(step.file));
    if (steps.length === 0) continue;
    // Rebuilt only where something changed, so a project whose delete touched
    // one type hands back the very same objects for every other one.
    kept.push(steps.length === record.steps.length ? record : { ...record, steps });
  }
  return kept;
}

/**
 * The sentence the confirm says, in the retention rule's own terms.
 *
 * NOT "ARE YOU SURE?". The three retentions are three genuinely different
 * losses, and a confirm that did not say which one this is trains people to
 * click through it — which is how somebody loses a curation while dismissing
 * what they assumed was the dialog about a rendering.
 *
 * The reasons are quoted from `WHY_IMPORTED`, `WHY_HANDMADE` and
 * `WHY_MODEL_PASS` rather than written again here, because those constants exist
 * so that every warning in this app says the same words about the same loss.
 */
export function deleteCost(step: LedgerStep): string {
  switch (step.retention) {
    case 'irreplaceable':
      return step.action === 'import'
        ? `Discarding “${step.label}” destroys ${WHY_IMPORTED}. There is nowhere to fetch it back from.`
        : `Discarding “${step.label}” destroys ${WHY_HANDMADE}. No run remakes it, at any price.`;
    case 'expensive':
      return `Discarding “${step.label}” costs a paid run to undo: ${WHY_MODEL_PASS}.`;
    default:
      return `Discarding “${step.label}” costs nothing — it is made again from what is still here, for free.`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The two views the app draws
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The newest non-stale step of each action along the position's ancestry.
 *
 * ── The most delicate thing in this file ────────────────────────────────────
 *
 * The per-type document rows — "the PDF", "the EPUB" — and the ledger must not
 * be two sources of truth. THE LEDGER IS THE TRUTH, and the rows are derived
 * from this. That means this function decides which reading is "the" reading and
 * which translation is "the" translation for everything downstream: what a
 * Generate renders, what the shelf shows, what a new job takes as input.
 *
 * ALONG THE ANCESTRY, and not across the whole ledger, which is the part that is
 * easy to get wrong and cheap to describe: standing on the Hungarian translation,
 * "the translation" is the Hungarian one — the English one is a sibling, made
 * from the same reading, and it is not on the path from the import to where the
 * user is standing. A scan of the whole list would pick whichever happened to be
 * newest and would repaint somebody's screen with a language they had stepped
 * away from.
 *
 * NON-STALE ONLY, because a stale step is a payload whose ancestor has been
 * replaced under it. It is still renderable and still listed — that was the
 * ruling — but it is not the current standard of anything, and derived rows that
 * pointed at it would be showing a reading of a bank that no longer exists.
 *
 * The ancestry runs origin-first, so the LAST match is the newest by
 * construction; no comparator, and no dependence on the array's own order.
 */
export function currentStandard(ledger: ProjectLedger): Partial<Record<StepAction, LedgerStep>> {
  const standing = positionOf(ledger);
  if (standing === null) return {};
  const standard: Partial<Record<StepAction, LedgerStep>> = {};
  for (const step of ancestry(ledger, standing.id)) {
    if (step.stale === true) continue;
    standard[step.action] = step;
  }
  return standard;
}

/**
 * WHERE A WALK UP FROM THE POSITION STOPS — the edge of one bank's story.
 *
 * ── The rule both views were spelling separately ────────────────────────────
 *
 * Two questions are answered by walking the position's ancestry upward and taking
 * the first thing found: WHICH CURATION is in effect, and WHICH BANK the row is
 * about. They walk the same chain and they stop in the same places, and the
 * places are a `read` and the `import` — because a reading is where a bank's
 * story BEGINS. Anything above a read belongs to a different pass over the pages:
 * a snapshot from up there names blocks by `(page, order)` numbers that mean
 * different blocks on this side of it (see `ProjectReading`), and a bank from up
 * there is somebody else's reading of the same book.
 *
 * A TABLE, and the same shape as `RETENTION_OF` for the same reason. The two
 * views used to state the stopping rule as a literal `if` apiece, and a third
 * would arrive the day another action is added — at which point one of them
 * learns the new boundary and the other does not, and the two disagree about
 * where one reading's story ends while both look correct.
 */
const BOUNDS_THE_WALK: Readonly<Record<StepAction, boolean>> = {
  import: true,
  read: true,
  curate: false,
  translate: false,
};

/**
 * The nearest step of this action on the position's ancestry, or null.
 *
 * The walk is upward from where the user is standing, so a step of the wanted
 * action is answered even when it IS the boundary — that is how a `read` finds
 * itself — and the boundary otherwise ends the search rather than letting it
 * continue into a pass this row is not about. A sibling is correctly never found:
 * a curate step hanging off the reading is not on the path from the import to a
 * position standing on the reading itself.
 */
function nearestUpward(ledger: ProjectLedger, wanted: StepAction): LedgerStep | null {
  const standing = positionOf(ledger);
  if (standing === null) return null;
  const chain = ancestry(ledger, standing.id);
  for (let at = chain.length - 1; at >= 0; at -= 1) {
    const step = chain[at]!;
    if (step.action === wanted) return step;
    if (BOUNDS_THE_WALK[step.action]) return null;
  }
  return null;
}

/**
 * The reading a rendering AT THE POSITION is made from — the step that owns the
 * bank — or null for a project with no reading on the path.
 *
 * ── The lie this exists to end ──────────────────────────────────────────────
 *
 * A read step's `payload` has always been the authority on where its bank lives,
 * and everything else COMPOSED that path from the project key instead of asking
 * the step: `readings/<key>.jsonl`, one per project, forever. That was true while
 * there was only ever one bank, and a re-read with different `--skip-pages`
 * branches by design (`MINTED_BY_THE_RUN`) — so a project could hold two `read`
 * steps and one file, the older of them describing a bank that had been written
 * over from under it. Standing on the older row and pressing Generate rendered
 * the newer reading, silently, with nothing on screen admitting the swap.
 *
 * So the plan asks the row. A branch mints its own bank path and the step records
 * it; every project that existed before this keeps `readings/<key>.jsonl`, which
 * is exactly what its one read step already says, so nothing on any disk moves.
 *
 * NULL FALLS BACK TO THE COMPOSED PATH, and the caller is where that happens
 * rather than here, because composing it needs the project key and this module
 * knows nothing about projects. It is the honest answer for two states: a project
 * with no reading at all, and a position standing on the import — the revert row,
 * which is about the untouched original rather than about any bank.
 */
export function readingInEffect(ledger: ProjectLedger): LedgerStep | null {
  return nearestUpward(ledger, 'read');
}

/**
 * The curation snapshot a rendering AT THE POSITION is made with, or null when
 * the answer is the live overlay.
 *
 * ── This is what makes the pointer worth moving ─────────────────────────────
 *
 * Every rendering in this app is `render(bank + overlay)`. Which overlay was
 * never a question before, because there was one: `overlays/<key>.json`, the
 * mutable working state of the block editor. A curation step freezes a copy of
 * that file, and the whole point of freezing one is to be able to stand on it and
 * get the book as it was — so the pointer has to decide which of them a Generate
 * reads, or the frozen snapshots are files nobody can ever see the effect of.
 *
 * THE ANSWER IS FOUND BY WALKING UP FROM THE POSITION, and the walk stops at a
 * reading. Standing on a save gives that save; standing on the reading gives the
 * live overlay, because the reading step is where live editing happens (a curate
 * step made from that reading is a SIBLING of wherever the user is standing, not
 * an ancestor, so it is correctly not found). A chain of saves gives the newest
 * one on the path, which is the one being stood on.
 *
 * A TRANSLATE STEP FALLS THROUGH TO ITS NEAREST ANCESTOR THAT HAS ONE, and that
 * is a deliberate limit of this pass rather than the final answer. A translation
 * has a payload of its own — a bank of translated blocks — and rendering FROM one
 * means rendering that bank rather than the scan's, which is a second rendering
 * path this app does not have yet. Until it does, standing on a translation and
 * pressing Generate renders the book it was translated from, with the curation
 * that translation was made under, which is the honest approximation: it is the
 * state the translation was taken of.
 *
 * NULL IS THE ORDINARY ANSWER. A project nobody has committed a curation in has
 * no `curate` step anywhere, so every position resolves to the live overlay and
 * nothing about this app's behaviour changes.
 */
export function curationInEffect(ledger: ProjectLedger): LedgerStep | null {
  // The walk and its stopping places are `nearestUpward`'s, shared with
  // `readingInEffect` rather than spelled twice: both questions are "the nearest
  // one of these on the way up", and both stop at the reading whose blocks the
  // answer would be about. See `BOUNDS_THE_WALK`.
  return nearestUpward(ledger, 'curate');
}

// ─────────────────────────────────────────────────────────────────────────────
// Which pass over the pages an overlay is about
//
// The generation is the id a curation carries and the app compares before it
// draws one over a book. It is a uuid, and this module has no randomness (see
// the header), so every function here is handed one and says whether it was
// spent — the same shape `LandedRun.id` already uses for a step id.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The generation a viewer at the position compares against, and what has to be
 * written down for that answer to still be true tomorrow.
 *
 * ── What replaced the folder count ──────────────────────────────────────────
 *
 * This used to be answered by counting `readings/archived-<stamp>/` folders: the
 * engine archived a completed bank before reading the pages again, so a count
 * that had moved meant a re-read and an unchanged one meant a re-render, which
 * is exactly the distinction an overlay cares about. Two changes landed together
 * and took both of its legs. A re-read now writes a PENDING bank and swaps it in
 * on success (docs/BANK-LIFECYCLE.md §2) — nothing archives, so the count never
 * moves and a fresh reading would silently inherit the old generation. And a
 * re-read asking for a different page range BRANCHES into a bank of its own,
 * which never archived anything either, so both branches would answer with the
 * first reading's id and the app would compare an overlay against a pass it was
 * not made from.
 *
 * The step model already holds the truth. A read step's `params.generation` is
 * what that pass over the pages was called, and the one a viewer wants is the
 * POSITION'S — `readingInEffect`, the same walk `readingBank` uses to find the
 * bank, so the id and the file it is about are answered from one row.
 *
 * ── The four answers, in the order they are asked ───────────────────────────
 *
 * THE STEP'S OWN ID, when the position stands under a reading that recorded one.
 * This is every project that has read a book since the ledger existed.
 *
 * RE-MINTED, when the completion marker on disk is not the one this step landed
 * with. That is a bank read again by something that is not this app — `foundry
 * vlm-read` from a terminal swaps a new bank into the same path — and it is the
 * honest successor to "the folder count moved": the blocks were renumbered, so
 * the id has to move or the archive-the-pair machinery never fires.
 *
 * THE PROJECT'S RECORD, for a project whose ledger holds no read step at all: a
 * bank filled from a terminal, one adopted out of the old flat workspace, or a
 * position standing on the import — the revert row, which is about the untouched
 * original and not about any bank.
 *
 * MINTED FRESH, for a project that has no record anywhere. Backfilling is safe
 * exactly as it always was: a project with nothing written here has no overlay
 * bound to a generation, because nothing was writing one.
 *
 * ── And what it will NOT do ─────────────────────────────────────────────────
 *
 * A MARKER NOBODY RECORDED IS ADOPTED, NEVER RE-MINTED. An absent stamp means
 * the generation was minted before there was a marker to record — somebody
 * opened the block editor while the first OCR was still running — and the run
 * that finishes appends to the very bank they were looking at. Re-minting there
 * would archive an overlay aside for a run that renumbered nothing, which is the
 * one case the folder count got right and the one this must not lose.
 *
 * A MISSING MARKER IS NOT EVIDENCE EITHER. There is a window inside the swap
 * where the old marker is gone and the new one is not written yet (§2), and a
 * bank can outlive its marker for reasons nobody chose. "I cannot see one" is
 * never allowed to mean "the bank was replaced".
 */
export interface GenerationRuling {
  /** The id the overlay and its undo ledger are bound to at this position. */
  generation: string;
  /** The ledger to write, or null when no step's record changed. */
  ledger: ProjectLedger | null;
  /** The reading record to write, or null when it did not change. */
  reading: ProjectReading | null;
}

export function generationInEffect(
  ledger: ProjectLedger,
  reading: ProjectReading | null,
  /** The position's bank's completion marker, epoch ms, or null for no marker. */
  markerAt: number | null,
  /** Spent only when this mints. See `LandedRun.id` for the same arrangement. */
  minted: string,
): GenerationRuling {
  const settled = (generation: string): GenerationRuling => (
    { generation, ledger: null, reading: null }
  );

  const step = readingInEffect(ledger);
  const recorded = step?.params?.generation;
  if (step !== null && recorded !== undefined && recorded.length > 0) {
    const stamped = step.params?.completedAt;
    if (markerAt === null) return settled(recorded);
    // The backfill: a step landed before markers were recorded, or one whose
    // generation was minted mid-read. Take the marker as this step's own without
    // moving the id — see "adopted, never re-minted" above.
    if (stamped === undefined) {
      return { generation: recorded, ledger: stamping(ledger, step.id, recorded, markerAt), reading: null };
    }
    if (stamped === markerAt) return settled(recorded);
    return { generation: minted, ledger: stamping(ledger, step.id, minted, markerAt), reading: null };
  }

  if (reading === null) {
    return {
      generation: minted,
      ledger: null,
      reading: {
        generation: minted,
        readAt: 0,
        pages: 0,
        ...(markerAt !== null ? { completedAt: markerAt } : {}),
      },
    };
  }
  /*
   * THE MARKER IS ONLY ASKED WHERE THE PROJECT HAS NO READ STEP AT ALL, and the
   * guard is the whole safety of this arm.
   *
   * `manifest.reading` is one record per project. The bank being looked at is the
   * POSITION'S, and a project with steps can have several — so standing on the
   * import, or on an older branch, would compare one branch's marker against a
   * stamp the newest landing wrote about a different file, disagree every time,
   * and re-mint a generation on every repaint. That would archive somebody's
   * curation aside for no event at all.
   *
   * With no read step anywhere there is exactly one bank this record can be
   * about, and the comparison is the same one the steps make.
   */
  if (ledger.steps.some((other) => other.action === 'read')) return settled(reading.generation);
  if (markerAt === null) return settled(reading.generation);
  if (reading.completedAt === undefined) {
    return { generation: reading.generation, ledger: null, reading: { ...reading, completedAt: markerAt } };
  }
  if (reading.completedAt === markerAt) return settled(reading.generation);
  /*
   * `readAt` AND `pages` ARE LEFT EXACTLY AS THEY ARE, which is not laziness.
   * They are this app's record of ITS OWN landings — `readAt > 0` is what the
   * library row means by "read", and zeroing it would re-arm the adoption rule
   * below and let the next landing in this app inherit an id minted against
   * somebody else's bank. What moved is which pass the pages came from, and that
   * is the only thing rewritten here. The next landing counts the pages again.
   */
  return { generation: minted, ledger: null, reading: { ...reading, generation: minted, completedAt: markerAt } };
}

/** One step's generation and marker stamp, written into a copy of the ledger. */
function stamping(
  ledger: ProjectLedger,
  id: string,
  generation: string,
  completedAt: number,
): ProjectLedger {
  return {
    ...ledger,
    steps: ledger.steps.map((step) => (
      step.id === id ? { ...step, params: { ...step.params, generation, completedAt } } : step
    )),
  };
}

/**
 * The generation a READING THAT HAS JUST FINISHED lands with.
 *
 * ── Every landing mints, with one exception, and the exception is the point ──
 *
 * A reading that lands is a bank that is now on disk and was not before: a first
 * read, a re-read swapped in over the old one, or a branch beside it. In all
 * three the blocks are the model's answers from THIS pass and the `(page, order)`
 * numbers an older overlay carries mean different blocks, so the id moves and the
 * archive-the-pair machinery hands that overlay off. Minting is the rule.
 *
 * THE EXCEPTION IS A FIRST READ THAT SOMEBODY WATCHED. Open the block editor
 * while the first OCR is running and the app mints a first-touch generation
 * against the pages read so far, and a person can start correcting them; the run
 * then finishes by appending the remaining pages to the SAME bank. Nothing those
 * corrections name has moved. Minting there would archive their work aside as the
 * reward for having started early, for a run that renumbered nothing.
 *
 * So a landing adopts when all of this holds: this is the project's first read
 * step (there is no other for the id to be wrong about), the record was made by a
 * first touch and never by a landing (`readAt === 0`), and the marker it was
 * minted against is either absent — nothing had completed, so the run in progress
 * is the one that made those pages — or is the very marker this landing sees,
 * meaning the bank finished before and has not been read since.
 *
 * A RECORD WITH A DIFFERENT MARKER IS THE CASE THIS RULE EXISTS TO REFUSE. A bank
 * read from a terminal, corrected in the app, then read again from the OCR dialog
 * lands as this project's first read step with `readAt === 0` — every condition
 * of the old rule met — and the bank underneath it is a completely new pass. The
 * stamp is what tells those two apart.
 */
export function generationForLanding(
  ledger: ProjectLedger,
  reading: ProjectReading | null,
  /** The marker this run wrote for its own bank, epoch ms, or null for none. */
  markerAt: number | null,
  minted: string,
): string {
  if (ledger.steps.some((step) => step.action === 'read')) return minted;
  if (reading === null || reading.readAt !== 0) return minted;
  if (reading.completedAt === undefined || reading.completedAt === markerAt) return reading.generation;
  return minted;
}

/**
 * The list, in creation order, with the one annotation that admits to the tree.
 *
 * `from` is set only when a row's parent is NOT the row immediately above it.
 * That is the entire concession: no rails, no indentation, no graph. A project
 * worked straight through draws as a plain list of what happened, and the one
 * book where somebody stepped back and branched shows a quiet "from Read" on the
 * row where it happened — which is the only row where the flat list would
 * otherwise be misleading about what was made from what.
 *
 * THE ARRAY'S ORDER IS TAKEN AS THE CHRONOLOGY rather than re-sorted by
 * `createdAt`, and that is deliberate. `parseLedger` refuses a file whose rows
 * run backwards and `appendStep` cannot produce one, so the order is an
 * invariant — and re-sorting here would mean two rows stamped in the same
 * millisecond could swap places between one repaint and the next, moving a
 * "from …" annotation onto a different row for no reason a person could see.
 */
export function chronological(ledger: ProjectLedger): StepRow[] {
  return ledger.steps.map((step, index) => {
    const above = index === 0 ? null : ledger.steps[index - 1]!;
    if (step.parent === null) return { step, from: null };
    if (above !== null && above.id === step.parent) return { step, from: null };
    const parent = ledger.steps.find((candidate) => candidate.id === step.parent);
    return { step, from: parent?.label ?? null };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Building one for a project that predates all of this
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A ledger for a manifest that has none, out of what the old catalogue recorded.
 *
 * ── What can honestly be reconstructed, and what cannot ─────────────────────
 *
 * Modelled on `migrateToSteps` in shared/steps.ts, including its rule: a
 * migration says what the catalogue said and never invents what it did not. The
 * old catalogue recorded an import, the fact and size of a completed reading, and
 * a chain of files per type. It did not record which reading a translation was
 * made from, or what language it was into — that survives only inside a filename,
 * and reading a fact out of a filename is the basename matching this codebase
 * has already paid for twice.
 *
 * So three things come out, and nothing else:
 *
 *   THE ORIGIN, from `archive`, or from the first chain's origin for a project
 *   adopted out of the old flat workspace, which has outputs and no import.
 *
 *   THE READING, when there is evidence of one. `manifest.reading` is the direct
 *   evidence; a v1 catalogue predates that field entirely, and its evidence is
 *   that the engine MADE something — every `expensive` step in a chain was cast,
 *   reprinted, written out or translated from a bank, and none of those can
 *   exist without one. A project imported and never converted gets no reading
 *   step, and neither does one started from an EPUB, which has no pages to read.
 *
 *   THE TRANSLATIONS, one per `translate` step in the chains, oldest first,
 *   parented to the reading where there is one. Their payload is the EPUB that
 *   was retained, because that IS what was retained — the per-block translation
 *   bank is a later invention and no old project has one.
 *
 * Renderings do NOT become steps, which is the substantive judgement here rather
 * than a detail of shape. A cast EPUB, a reprinted PDF and a text file are three
 * renderings of one bank, free to make again; minting a step for each would put
 * three filenames where one action belongs and would offer the user a delete
 * button for something that costs nothing.
 *
 * ── Determinism, and why it is a requirement rather than a nicety ───────────
 *
 * READING A MANIFEST TWICE MUST PRODUCE THE SAME LEDGER, byte for byte. This
 * runs on every read of an un-migrated project — `readManifest` migrates in
 * memory and writes back only when something else edits the file — so a ledger
 * built from a uuid generator or from `Date.now()` would give a project a
 * different history on every open, and the ids in it are what the pointer, the
 * parent chain and the queue's captured parent all point at. A pointer written
 * on Tuesday would name a step that no longer exists on Wednesday.
 *
 * So the ids are ordinal — `m0`, `m1`, … in the order the steps are built — and
 * derived from nothing but the manifest's own contents and order. A hash of the
 * payload path was the obvious alternative and is worse: two chain rows are
 * allowed to name one file, and two steps with one id is a ledger that refuses
 * itself. The `m` says out loud that these were reconstructed rather than
 * recorded.
 *
 * The times come from the catalogue too — `createdAt` for the import, `readAt`
 * for the reading, `appliedAt` for a translation — clamped so the list never
 * runs backwards, because a v1 catalogue's `madeAt` values were written by
 * whatever the clock said at the time and one of them being earlier than the
 * import is a thing that happens.
 */
export function migrateLedger(manifest: ProjectManifest): ProjectLedger {
  const chains = manifest.documents ?? [];
  const origin = originPayload(manifest);
  if (origin === null) return emptyLedger();

  const steps: LedgerStep[] = [];
  let at = 0;
  let clock = Math.max(0, Math.trunc(manifest.createdAt));
  const mint = (
    parent: string | null,
    action: StepAction,
    payload: string,
    createdAt: number,
    label: string,
    params?: LedgerParams,
  ): LedgerStep => {
    clock = Math.max(clock, Math.max(0, Math.trunc(createdAt)));
    const step: LedgerStep = {
      id: `m${at}`,
      parent,
      action,
      payload,
      retention: RETENTION_OF[action],
      createdAt: clock,
      label,
    };
    // An empty bag is not written. A migrated reading that recorded neither a
    // generation nor a page count says nothing about itself, and `"params": {}`
    // in every one of those manifests is a field that looks like a record of
    // something. Absent and empty mean the same to every reader of a step.
    if (params !== undefined && Object.keys(params).length > 0) step.params = params;
    at += 1;
    steps.push(step);
    return step;
  };

  const imported = mint(null, 'import', origin.payload, manifest.createdAt, origin.label);

  let readFrom = imported;
  const reading = readingParams(manifest, chains);
  if (reading !== null) {
    readFrom = mint(
      imported.id,
      'read',
      `readings/${manifest.key}.jsonl`,
      manifest.reading?.readAt ?? manifest.createdAt,
      labelFor('read', reading),
      reading,
    );
  }

  // Oldest first, so the list reads in the order it happened. A v1 catalogue's
  // order was insertion order, which a rotation could disturb — the same reason
  // `migrateToSteps` sorts rather than trusting it.
  const translations = chains
    .flatMap((record) => record.steps)
    .filter((step) => step.kind === 'translate')
    .sort((a, b) => a.appliedAt - b.appliedAt);
  for (const translation of translations) {
    // NO `language` PARAM. It is legible only in the filename — `… (en).epub` —
    // and deriving a fact about a book from the characters in its name is what
    // this codebase's oldest house rule exists to forbid. The label the old
    // catalogue wrote is already in the app's voice, so it is kept as it stands.
    mint(readFrom.id, 'translate', translation.file, translation.appliedAt, translation.label);
  }

  // NO POINTER, which means the newest step. That is where somebody opening a
  // migrated project should land: at the last thing that happened to their book.
  return { steps };
}

/** The import a ledger hangs off, and what the old catalogue called it. */
function originPayload(manifest: ProjectManifest): { payload: string; label: string } | null {
  const chains = manifest.documents ?? [];
  const firstOf = (kind: ProjectStep['kind']): ProjectStep | undefined => chains
    .flatMap((record) => record.steps)
    .find((step) => step.kind === kind);

  // `!= null` for `readingParams`'s reason, two functions down: a manifest
  // assembled by hand rather than by `readManifest` can leave a field off
  // entirely, and a test written against `null` walks into the property access it
  // was meant to guard.
  if (manifest.archive != null) {
    const named = firstOf('origin');
    return {
      payload: `archive/${manifest.archive.file}`,
      // The old catalogue's own words where it recorded them — "The scan you
      // imported", "The book you imported" — because they are already in the
      // app's voice and already tell a scan from a book.
      label: named?.label ?? labelFor('import'),
    };
  }
  // A project adopted from the flat workspace: outputs and no import. Its first
  // origin step is the closest thing it has to one, which is exactly the call
  // `migrateToSteps` makes for the same projects.
  const adopted = firstOf('origin');
  return adopted === undefined ? null : { payload: adopted.file, label: adopted.label };
}

/**
 * What is known about this project's reading, or null when nothing says there was
 * one.
 *
 * The generation and the page count are both allowed to be missing, and a v1
 * project's are. Writing `generation: ''` rather than omitting it would be this
 * app claiming to know which pass the bank came from, which is the one claim the
 * generation exists to make honestly — and `overlayFate` already prints an empty
 * generation as "unrecorded", so the state is one this app has met before.
 *
 * NO `skipPages` AND NO `language`, ever, and their absence is what makes a
 * migrated project's identity deterministic rather than merely unknown. Nothing
 * in an old catalogue recorded which pages a reading was told to leave out; the
 * only place that question survives is the shape of the bank itself, and
 * inferring "3,17,19-24" from gaps in a file is exactly the sort of reconstruction
 * this migration refuses to do. So a migrated reading asks the plain question —
 * the whole book, no language declared — which means a re-read that also asks the
 * plain question REPLACES it, and one that skips pages branches beside it. That is
 * the right answer in both directions and it is the same answer on every read of
 * the file.
 *
 * `!= null` RATHER THAN `!== null`: this took a manifest whose `reading` was
 * undefined — a shape the type does not admit and `readManifest` never produces,
 * because it always writes the field — and walked straight into reading
 * `.generation` off it. Unreachable today is not a reason to be wrong; the next
 * caller assembling a manifest by hand is the one who would find out.
 */
function readingParams(
  manifest: ProjectManifest,
  chains: readonly { steps: ProjectStep[] }[],
): LedgerParams | null {
  if (manifest.reading != null) {
    const params: LedgerParams = {};
    if (manifest.reading.generation.length > 0) params.generation = manifest.reading.generation;
    if (manifest.reading.pages > 0) params.pages = manifest.reading.pages;
    return params;
  }
  const madeByTheEngine = chains
    .flatMap((record) => record.steps)
    .some((step) => step.retention === 'expensive');
  return madeByTheEngine ? {} : null;
}
