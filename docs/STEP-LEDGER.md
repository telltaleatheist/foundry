# The Step Ledger

Design handoff, 2026-08-14. This is the spec for the step system's next form — a
Photoshop-style history with one deliberate difference: **acting from an earlier
step never destroys the steps after it.** Read this whole document before
touching code; the last section says where everything lives.

## Where this starts from (already settled, already built)

The settled model, verbatim: **the queue is where expense happens; a step is the
retained payload of one queue job; everything else is a rendering.** Manifest v2
(`app/shared/types.ts`, `app/shared/steps.ts`) already records steps with
`retention: 'irreplaceable' | 'expensive' | 'regenerable'` and a `why`. The
retention rule: imported files are irreplaceable (only copy in the world), model
passes are expensive, and **user edits are irreplaceable regardless of machine
cost** — a sweep may only ever discard `regenerable`.

Also already built and not to be disturbed:

- **The readings bank** (`readings/<key>.jsonl` + `<key>.completed.json`) is the
  OCR step's payload. **Generate** renders epub/txt/pdf from bank + overlay,
  offline by construction. Renderings are free and are **not steps**.
- **The curation overlay** (`overlays/<key>.json` + `.ledger.json`): strikes,
  reclassifications, text overrides, the definitive chapters list. The bank is
  never mutated; every rendering = render(bank + overlay). The overlay binds to
  a reading **generation** uuid (`ProjectManifest.reading.generation`); a re-read
  mints a new generation and the stale overlay+ledger pair is archived aside,
  never deleted (corrections double as fine-tune labels).
- **Bank replace-on-success** (may or may not be built by the time you read
  this): a re-read writes a pending bank and swaps it in only when the run
  completes; a failed run leaves the old bank untouched; no `archived-<stamp>/`
  bank hoards.

## The new model in one paragraph

Every project carries a **ledger of steps**. Each step is the retained payload
of one completed action: the import, a reading, a committed set of curation
edits, a translation. Steps form a **parent chain** — every step records which
step it was made *from* — but the UI shows them as one flat, chronological list,
like Photoshop's History panel. A **position pointer** marks where the user is
standing. Clicking any step moves the pointer there (free, instant — it's a
repaint). Acting while standing on an earlier step does **not** truncate the
list the way Photoshop does: it appends a new step whose parent is the step you
were standing on. Translate German→English, step back to the reading, translate
German→Hungarian: the ledger now shows *import → reading → English → Hungarian*,
Hungarian listed after English because it happened after, with its parent being
the reading. Nothing was lost.

So structurally it is a tree; experientially it is a ledger. Do not build a tree
UI. Build a list.

## Step types and their payloads

| Step | Payload | Retention | Produced by |
|---|---|---|---|
| **Origin** (import) | `archive/<file>` — the untouched original | irreplaceable | import (instant, no queue job) |
| **Reading** (OCR) | the readings bank | expensive | `vlm-read` queue job |
| **Curation commit** | a frozen snapshot of the overlay at commit time | irreplaceable (user labor) | the user pressing **Save** in the block editor — no queue job, no expense |
| **Translation** | the translation bank | expensive | translate queue job |

Renderings (epub/txt/pdf via Generate) are **not** steps. They are free,
reproducible from a step's payload at any time, and minting a step for one would
put a filename where an action belongs.

### Curation commits, precisely

The **live overlay** stays exactly what it is today: mutable working state with
its own undo ledger, edited continuously in the block editor. It is the
"unsaved edits" of this system. What is new: a **Save** action in the block
editor freezes the current overlay as a snapshot — a curation step. The live
overlay keeps going; the snapshot never changes again.

- Snapshot files: `curations/<uuid>.json` inside the project dir — same schema
  as the overlay file, plus the id/parent bookkeeping lives in the manifest, not
  the file.
- Rendering at a curation step = render(parent reading's bank + that snapshot).
- Rendering at a reading step = render(bank + **live overlay**) — the reading
  step is where live editing happens. Standing on a curation step shows the
  frozen state, read-only; to edit further, the user steps to the reading (live)
  or commits again from where they are (see "acting from a step" below).
- A curation step's parent may be a reading **or another curation step** —
  commit, keep editing, commit again: a chain of saves, each one restorable.
- Generation binding: a snapshot records the reading generation it was made
  under, same as the live overlay does today. The existing archive-on-mismatch
  machinery stays for the live overlay; committed snapshots are already
  retained, so they need no archiving — they just become stale (mark them, don't
  touch them) if their reading is replaced.

## The position pointer

One per project, stored in the manifest (`position: <step id>`; absent = the
newest step). It answers two questions:

1. **What do the viewers show?** The rendering of the position step. Moving the
   pointer repaints the open tabs of that project — no queue job, no file
   writes, no confirmation.
2. **What does a new action take as input?** The position step is the parent of
   whatever the user does next. Translate while standing on the reading → the
   translation's parent is the reading. Translate while standing on a curation
   commit → the translation is made from the *curated* rendering (strikes
   excluded, categories applied), which is almost always what the user means.

Generate always renders **the position step**. The Generate dialog names which
step it is rendering ("from your save of Aug 14" / "from the reading") so the
user is never surprised by which state their epub reflects.

## Acting from a step: append, replace, or refuse

- **Different action, or same action with different parameters** (another
  language, another curation save): **append** a new step, parent = position.
  This is the branching case and it is always safe.
- **Same action, same parameters, same parent** (re-read the same pages,
  re-translate to English again): this is a **re-run**, and re-run means
  **replace** — swap-on-success, exactly per the settled rule. The old payload
  is destroyed only after the new run completes; the queue confirm names what is
  replaced and what becomes stale downstream ("this replaces the 17-page reading
  and marks your 2 saves and the English translation stale"). No timestamped
  hoards. The one exception to destruction stays: overlay/curation content is
  user labor and is never destroyed by a re-run — it goes stale, visibly, and
  the stale steps remain clickable (they still render, against their recorded
  payload... see open question 3).

## Deleting steps

The user asked for this explicitly ("maybe they can delete steps? like the
english translate step?"). Rules:

- **Origin is never deletable.** Deleting the origin is deleting the project,
  and the project ✕ already does that with its own ceremony.
- **A leaf step** (nothing was made from it) deletes with a confirm that names
  the cost in the retention rule's own terms: an expensive payload says what it
  cost to make ("this discards the English translation — re-making it is a paid
  run"); an irreplaceable one says it is user labor ("this discards your save of
  Aug 14 — 23 corrections, unrecoverable").
- **A step with descendants** deletes its whole subtree, and the confirm lists
  every step in it by name before the user agrees. (Alternative considered:
  refuse until the children are deleted one by one. Rejected as busywork — but
  see open question 1; flip this if the user prefers refusal.)
- Deleting the step the pointer stands on moves the pointer to the deleted
  step's parent.
- Deletion is a real destruction of payload files plus manifest surgery, behind
  main-process IPC with the same describe/confirm split the document delete
  uses.

## Storage

Manifest v2 grows (this is a manifest **change**, so bump carefully — v1 and v2
must still read; write a migration from today's linear step rows):

```jsonc
"ledger": {
  "position": "s3",              // step id; absent = newest
  "steps": [
    { "id": "s0", "parent": null, "action": "import",
      "payload": "archive/Book.pdf",
      "retention": "irreplaceable", "createdAt": 0, "label": "Imported" },
    { "id": "s1", "parent": "s0", "action": "read",
      "payload": "readings/<key>.jsonl",
      "params": { "generation": "edbd…", "pages": 17 },
      "retention": "expensive", "createdAt": 0, "label": "Read (17 pages)" },
    { "id": "s2", "parent": "s1", "action": "curate",
      "payload": "curations/<uuid>.json",
      "params": { "generation": "edbd…", "amendments": 23 },
      "retention": "irreplaceable", "createdAt": 0, "label": "Saved corrections" },
    { "id": "s3", "parent": "s1", "action": "translate",
      "payload": "translations/<key>-en.jsonl",
      "params": { "language": "English" },
      "retention": "expensive", "createdAt": 0, "label": "Translated (English)" }
  ]
}
```

- `id` uuids, `parent` refs — validate on read: unknown parent = refuse the
  ledger by name, don't guess.
- `stale: true` gets stamped on a step whose parent's payload was replaced by a
  re-run (transitively). Stale is a display state, not a deletion.
- The existing per-type step rows (`manifest.documents[].steps`) and this ledger
  must not be two sources of truth. The ledger is the truth; derive the per-type
  "current standard" views from it (the newest non-stale step of each kind along
  the position's ancestry). Expect this to be the most delicate part of the
  build.

## UI

An accordion in the inspector — **"Steps"** — visible whenever a project
document is focused. Content:

- One row per step, chronological order (creation time, not tree order). Each
  row: the action label in the app's own voice ("Read (17 pages)", "Saved
  corrections (23)", "Translated (Hungarian)"), the date, and — only when the
  parent is not the previous row — a quiet "from *Read*" annotation. That
  annotation is the entire concession to the tree. No graph rails.
- The position row is visibly current. Clicking a row moves the pointer and
  repaints. Stale rows are dimmed with a reason on hover.
- Row ✕ deletes, with the confirm above. No ✕ on origin.
- Step 0 (origin) doubles as **revert**: standing on it shows the untouched
  original, and Generate from it exports the original file.

## Queue integration

- A queued job carries its parent step id, captured at enqueue (the position at
  the moment the user pressed the button — a pointer move while a job is held
  must not silently retarget it).
- On success the step is appended (or its payload swapped, for a re-run) and
  `projects:changed` announces it.
- The queue-confirm-on-re-run work already specified elsewhere applies
  unchanged; its "N corrections set aside" sentence becomes "N steps marked
  stale," naming them.

## Decided (were open questions; these are the rulings — build to them)

1. **Subtree deletion cascades**, with every casualty named in the confirm.
   Refuse-until-empty was rejected as busywork: somebody deleting a branch means
   the branch, and making them delete it leaf-first teaches nothing.
2. **Stale steps stay renderable**, dimmed, with the reason on hover. A
   translation made from a replaced reading still has its own bank, and that bank
   is still a true record of what was translated. Locking it would destroy access
   to something we deliberately kept.
3. **Keep both** the live overlay's archive-on-generation-mismatch and curation
   steps. They cover different people: one who saves has retained steps, one who
   never saves still deserves their labor kept. Revisit only if the archive
   folder proves to be pure noise in practice.
4. **A Generate gets no ledger presence.** Renderings are free and reproducible;
   a step for one would put a filename where an action belongs. If "what did I
   export and when" is ever wanted it is an export *log*, a separate thing —
   do not conflate them.

## Where things live

- `app/shared/types.ts` — manifest types, `ProjectStep`, retention. The ledger
  types go here; keep pure logic in `app/shared/` for bun-testability.
- `app/shared/steps.ts` — `STEP_LABELS`, `migrateToSteps` (the v1→v2
  migration; model the new migration on it).
- `app/electron/projects.ts` — manifest read/write (`readManifest`,
  `writeManifest`, `importDocument`, `recordReading`, `recordGenerated`),
  `summarise` (Home's listing), `inspectProject` (delete card). All ledger
  surgery happens here behind `withManifest`.
- `app/electron/overlays.ts` — overlay/ledger load-save-archive; curation
  snapshots belong beside it.
- `app/electron/job-queue.ts` — `argsFor`, enqueue, on-landed recording; parent
  step id threads through here.
- `app/src/app/components/inspector/` — the accordion host (Chapters and
  Category accordions already live here; match their idiom).
- `app/src/app/core/tabs.service.ts` — repaint-on-pointer-move goes through the
  same signal paths the overlay repaint uses.
- Engine (`src/`): no changes expected. Generate already takes `--overlay
  <path>`; rendering a curation step means passing the snapshot instead of the
  live overlay. Translation-from-a-step may need a `--overlay` on the translate
  path if it doesn't have one — check.

## House rules (non-negotiable)

Verify with all four gates every time: `bun test`, `bunx tsc --noEmit` (root),
`bunx tsc -p tsconfig.electron.json --noEmit` and `-p tsconfig.app.json` (from
`app/`), and `bunx ng build` (from `app/` — tsc misses template errors). Escape
backticks as \` in Angular template/style prose. Never `::ng-deep` for
createElement'd nodes. Never match files by basename across directories —
compare project-relative paths. Long WHY decision comments in the codebase's
own voice. Do not commit unless asked; the main session verifies and commits.
No filenames in UI labels — steps are named by action, in words.
