# Bank lifecycle — replace on success, confirm before expense, one path per step

Build-ready, 2026-08-15. Supersedes §1, §2 and §5 of `NEXT-WORK.md`, which said
these three were one feature; this document is that feature designed. Assumes
the step ledger as built (`docs/STEP-LEDGER.md`).

The one-sentence version: **a bank is replaced by renaming a finished pending
bank over it, never by archiving the good one before the gamble; the queue
names that cost before the job exists; and a step names its own bank so no row
ever renders somebody else's reading.**

---

## 1. What is wrong today, stated as three facts

1. **A fresh read archives the good bank up front.** `openReadingsBank`
   (`src/vlm/readings.ts`) sees a completion marker plus a re-read order and
   calls `archiveReadingsBank` *before a single page is read*. A run that dies
   at page 9 of 17 has already moved the finished bank into
   `archived-<stamp>/` — the project is left worse off for having tried.
   The overlay archive-the-pair machinery (`app/electron/overlays.ts`) then
   fires on the generation mismatch a successful re-read mints, so today a
   *failed* re-read at least leaves overlays alone only because no new
   generation was recorded — by luck of ordering, not by design.

2. **The cost of a re-read is never named.** The OCR dialog enqueues; nothing
   tells the user that the 17-page reading, their 2 saves and the English
   translation all go stale. The ledger can name every one of those
   (`markStale`, `app/shared/ledger.ts:878`) — the dialog just never asks it.

3. **One bank path per project key is a lie in the ledger.** A re-read with
   different `--skip-pages` *branches* by design (`MINTED_BY_THE_RUN`,
   `ledger.ts:224`), but `planConversion` composes the bank path from the
   project key alone (`workspace.ts:196`: `readings/<key>.jsonl`), so the older
   read step names a bank that was archived out from under it, and clicking
   that row renders the newer reading. `orphanedPayloads` keeps a delete from
   destroying it; nothing keeps the row honest.

`recordLanding`'s header already states the contract this document makes true
on disk: *"This is only ever called on a run that SUCCEEDED, which is what
makes the swap-on-success rule true by construction"* (`ledger.ts:978-984`).
The ledger half of the rule was built; this is the disk half.

---

## 2. The pending bank — engine-owned, so the CLI is safe too

### 2.1 The shape

A run that would today archive-then-read instead writes its answers into a
**pending bank beside the real one**:

```
readings/<key>.jsonl                  the bank every step still names
readings/<key>.jsonl.pending          the gamble in progress
readings/<key>.jsonl.pending.request  what the gamble was asked (see 2.3)
readings/<key>.completed.json         the marker, unchanged
```

On completion — all pages landed, the moment `writeCompletionMarker` fires
today — the engine swaps:

1. delete the old completion marker,
2. `fs.renameSync(pending, real)` — the old bank is destroyed by the rename,
3. write the fresh marker.

That ordering is chosen for what a crash between any two steps leaves behind,
and every gap is self-healing:

| died after | on disk | next run sees |
|---|---|---|
| step 1 | old bank, no marker, complete pending | pending matches the request → resumed, found complete, swap retried |
| step 2 | new bank, no marker | an "interrupted" run with no pages missing → completes instantly, writes the marker |

The one sequence that is *not* safe is marker-last-but-bank-first without
deleting the old marker: a new bank under an old marker replays the wrong
completion. Hence step 1 is first, and it is not optional.

**A dead run leaves the old bank untouched and the pending file as resumable
debris.** That is the entire point. The failure mode in fact 1 becomes: nothing
happened, and page 9's answer is waiting in the pending file for the retry.

### 2.2 When the pending path is used, and when it is not

The pending file exists to protect a **finished** bank from an unfinished
replacement. Where there is nothing to protect, the current behaviour is
already right and does not change:

| bank state | request | behaviour |
|---|---|---|
| none | read | write the real bank directly (unchanged) |
| incomplete, no marker | read | **resume into the real bank** (unchanged — the partial bank IS the debt, there is no good copy at risk) |
| completed | read again (no `--reuse`) | **pending mode** — swap on success |
| completed | `--fresh-readings` | **pending mode** — same path; `--fresh` stops meaning "archive", it means "do not resume the pending, start it over" |
| completed | `--reuse-readings` | replay (unchanged) |
| pending exists | read, same request | resume **into the pending** |
| pending exists | read, different request | discard the pending, start a new one (see 2.3) |

`archiveReadingsBank` loses both engine callers and is deleted. The file
header's "the bank is NEVER DELETED" paragraph (`readings.ts:29-32`) is
rewritten: the rule the user actually set is *the bank is never destroyed
until its replacement exists* — swap-and-destroy for machine output, archives
forever only for labour (`RETENTION_OF`, `ledger.ts:110`). `archived-<stamp>/`
directories stop accumulating under `readings/`.

The same amendment applies to the translation bank: `archiveTranslationBank`
(`src/translate/bank.ts:271`) is `--fresh-bank`'s archive-up-front and gets
the same pending treatment. It is a smaller change there because the
translation bank has no completion marker by design (`bank.ts:66-86`) — the
pending file is used only under `--fresh-bank`, and the swap happens when the
run writes its EPUB.

### 2.3 The request sidecar — how a resume knows it is one

`<bank>.jsonl.pending.request` is a small JSON file written when the pending
bank is opened, recording **what was asked**: `skipPages`, `language`, the
model id, and the foundry version. A later run finding a pending bank compares
its own request:

- **Same ask → resume the pending.** The debt is paid off, never re-paid —
  the same sentence the real-bank resume has always printed.
- **Different ask → the pending is discarded** (deleted, not archived). It is
  *incomplete machine output whose completion nobody wants any more* — the
  user changed the question, which is them saying the half-answer to the old
  question is not worth finishing. Regenerable, per the retention rule, and
  regenerating it is exactly what the new run is about to not do (different
  pages). This is the answer to NEXT-WORK §1's first open question.

The identity fields compared are the same two the ledger compares
(`PARAMS_OF.read` minus `MINTED_BY_THE_RUN.read` = `skipPages`, `language`) —
one rule, stated in `ledger.ts`, obeyed by the engine through the sidecar.
The model id is in the sidecar as a *recorded fact*, not an identity field,
for the same reason `pages` is minted: nobody chose it per-run in the app.

### 2.4 `orphanedPayloads`, and the sweep

**A pending bank is invisible to the ledger.** No step names it — steps are
minted on success, and success is when the pending stops existing. So
`orphanedPayloads` (`ledger.ts:1142`) does not change, and `deleteStep`'s
sweep (`app/electron/projects.ts`) must simply learn one rule: when it
destroys a read step's bank, it also removes `<bank>.jsonl.pending` and the
sidecar beside it. Debris whose bank is gone is debris about nothing.

A queued job about to resume a pending bank cannot lose it to a sweep,
because `refuseBusyStepDelete` already refuses to delete a step a
pending-or-running job targets — the same busy-check, no new mechanism. This
answers NEXT-WORK §1's second open question.

### 2.5 What changes where (engine)

- `src/vlm/readings.ts` — `openReadingsBank` grows the pending arm of the
  table in 2.2; `archiveReadingsBank` deleted; new `pendingPath()`,
  `readPendingRequest()`, `swapPendingIntoPlace()`. `ReadingsBankOutcome`
  gains `pendingPath: string | null` so the run knows which file to append to,
  and every `sentence` keeps stating the decision.
- `src/commands.ts` — `runVlmRead` / `runVlmConvert` pass the ask
  (`skipPages`, `language`, model) into `openReadingsBank` for the sidecar,
  and call the swap where they call `writeCompletionMarker` today.
- `src/translate/bank.ts` — `--fresh-bank` goes pending; swap at EPUB write
  (`src/translate/run.ts:1544`).
- `replaysCompletedBank` (`src/vlm/read.ts`) — unchanged; it reads the marker,
  and the marker's meaning is unchanged.

---

## 3. The queue confirm — the cost named before the job exists

### 3.1 Where it fires

In the renderer, in the OCR dialog, at the moment before `queue.enqueue` — the
renderer already holds the ledger mirror (`app/src/app/core/ledger.service.ts`)
and the decision functions are pure and shared, so **no IPC round-trip is
needed to name the cost**:

- `reRunTarget(ledger, {action: 'read', parent, params})` — is this a replace?
- If it is: `subtree(ledger, target.id)` minus the target — the casualties,
  by their own labels.

The parent for the question is the same one the landing will use: a reading is
parented at the origin, not the position (`recordReading`'s rule,
`job-queue.ts:762-772`).

### 3.2 What it says

Replace, with descendants:

> **Read this book again?**
> This replaces the 17-page reading. Your 2 saved corrections and the English
> translation were made from it and will be marked stale — kept, listed, and
> dimmed. Nothing is destroyed if the run fails: the current reading stays
> until the new one finishes.

Replace, no descendants: the same first and last sentences, nothing invented
in between. The last sentence is only honest **because §2 is built first** —
this dialog must not ship ahead of the pending bank.

**A branch gets no confirm.** A re-read with different skip-pages destroys
nothing and stales nothing; it costs GPU, and the queue is where expense
happens — enqueueing it *is* the deliberate act (reads are `held` until the
shelf's Start, `job-queue.ts:190`, a second deliberate act). The OCR dialog
states the fact inline instead — one line, not a modal: *"This will be a
second reading beside the current one."* — because a person asking for
different pages may genuinely think they are replacing. This answers
NEXT-WORK §2's open question: a statement, not a question.

No reading yet → neither the confirm nor the line. Nothing to say.

### 3.3 The race, and why it is acceptable

The confirm names the cost as of the moment of asking; the ledger can change
while the job sits held behind another job. The *naming* is advisory — the
actual replace/branch decision is made at landing by `recordLanding` against
the ledger as it stands then, exactly as today. The window is small, the
worst case is a stale sentence, and the alternative — re-confirming at spawn
— is a dialog interrupting a person who already answered. Same rule as
`Job.parentStep`: captured at enqueue, deliberately.

---

## 4. One bank path per step

### 4.1 The scheme

**A read step's `payload` is already the authority on where its bank lives**
(`LedgerStep.payload`, project-relative). The lie is that everything else
*composes* the path from the key instead of asking the step. So:

- **The first read of a project keeps `readings/<key>.jsonl`.** No file moves,
  no migration touches disk — every existing project is already in the scheme.
- **A branch mints `readings/<key>.<id8>.jsonl`**, where `id8` is the first 8
  hex characters of the new step's uuid. Deterministic, collision-free, and
  never shown to a person — filenames are out of the UI; the row's name comes
  from `labelFor`. (An ordinal would read better in Explorer and would also be
  a second counter to keep consistent with the ledger; the uuid is already
  minted and already unique.)
- **A replace targets the step's existing payload path** via the pending swap
  of §2. Same step, same path, new contents — which is what `recordLanding`'s
  "the replaced step KEEPS ITS PLACE" already says about the row.
- Translation banks follow suit: `readings/<key>.<tag>.bank.jsonl` for the
  first, `readings/<key>.<tag>.<id8>.bank.jsonl` for a branch. (Translation
  *outputs* are `docs/TRANSLATION-STEPS.md` §4's problem; the two documents
  use the same `id8` convention.)

### 4.2 Who stops composing and starts asking

- `planConversion` (`app/electron/workspace.ts:196`) — `readingsPath` becomes
  *the payload of the nearest `read` step on the position's ancestry*
  (a small pure helper beside `curationInEffect` in `ledger.ts`, same walk,
  stops at the same places), falling back to the composed path only for a
  project with no read step. **This is the §5 fix**: standing on the older
  read renders the older bank, because the row names it and the plan asks
  the row.
- `planReading` — decides the target path before enqueue: `reRunTarget` says
  replace (→ the target step's payload) or branch (→ mint `<key>.<id8>` with
  the speculatively-minted step id, the same id `LandedRun.id` already
  carries). The id travels on the `ReadRequest` so the landing and the path
  agree about which step the bank belongs to.
- `recordReading` (`projects.ts`) — records the payload from where the engine
  actually wrote, as today; `Landing.displaced` (`ledger.ts:948`) now does
  real work: a replace whose old payload path differs (a branch re-run
  landing as replace after a delete, the one case paths can drift) destroys
  the unnamed file, and `namesPayload`'s whole-path rule already guards it.
- `overlaysDir` pairing, `locateOverlay`, `curationInEffect` — unchanged.
  Overlays are keyed to the *generation*, which is minted per run, not per
  path; nothing there reads a bank path.

### 4.3 What is deliberately not done

Per-step *directories* (`readings/<stepId>/…`) were considered and rejected:
they orphan the existing flat layout for no queryable gain, force a disk
migration on real projects (Kershaw, German Christian Faith Movement), and
the flat scheme's collision risk is zero because uuids mint the suffix.

---

## 5. Folded in: the translate rotation with no way back

Found while mapping the queue, and it belongs here because it is the same
promise: **nothing is destroyed by a run that has not succeeded.** A convert
rotates its previous output at spawn time inside `pump()` with
`restoreRotation` on failure and cancel (`job-queue.ts:684-702`); a translate
rotates at *plan* time inside `planTranslation` (`workspace.ts:283`) with no
restore path at all. A translate job removed while held, or failed, leaves
the previous edition stranded in `generated/archived-<stamp>/` with the chain
rewritten to point there — the exact failure `restoreRotation`'s header says
was fixed for conversions.

The fix: translate rotation moves to spawn time in `pump()`, joining the
convert branch's rotation-and-restore, with the one case that forced plan-time
rotation preserved — a translation whose input *is* its previous output
(`samePath(inputPath, outputPath)`, `workspace.ts:284-286`) reads the
moved-aside copy, so that source substitution moves to spawn time with it.

Generated outputs keep **archiving** rather than swapping, deliberately: a
generated EPUB can carry a working tree with a person's text edits
(`rotateGenerated` moves `working-<dir>` beside it), and labour is archived
forever. The no-hoards rule is about `readings/` — machine answers — only.

---

## 6. Build plan

Each phase lands green through all five gates (`bun test`; `bunx tsc
--noEmit` at root; from `app/`: both tsconfigs and `ng build`) and is
independently shippable.

**Phase 1 — engine: the pending bank** (`src/vlm/readings.ts`,
`src/commands.ts`, `src/translate/bank.ts`, `src/translate/run.ts`; tests in
`test/`). Pure engine change, CLI-observable, no app involvement. The matrix
in 2.2 is the test list; every crash gap in 2.1's table gets a test that
stages the debris and proves the healing.

**Phase 2 — app: per-step bank paths** (`app/shared/ledger.ts` helper +
`workspace.ts` + `projects.ts` + `job-queue.ts` request shape; tests in
`test/app/`). Depends on nothing in phase 1 (paths are orthogonal to the swap)
but lands second so a replace already swaps safely at the path it targets.

**Phase 3 — renderer: the confirm** (OCR dialog component +
`ledger.service.ts`; pure sentence-composition helper in `app/shared/` so the
wording is testable). Depends on phase 1 for its honesty and phase 2 for the
parent/params it compares.

**Phase 4 — the translate rotation move** (`job-queue.ts`,
`workspace.ts`). Independent of 1–3; smallest; can run in parallel with
phase 3.
