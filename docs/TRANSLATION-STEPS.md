# Translation as a generatable step

Build-ready, 2026-08-15. Supersedes §4 of `NEXT-WORK.md`. Assumes the step
ledger as built (`docs/STEP-LEDGER.md`) and shares the `id8` path convention
with `docs/BANK-LIFECYCLE.md`.

**The contract, in the user's words:** a translation is stored as a ledger
entry the user can generate from whenever they like — ten translations means
ten steps and ten EPUBs on demand. Translate → click the translation step →
Generate produces the translation; strike some blocks and commit → click
*that* entry → Generate re-renders with the stricken items removed. No step
picker on Generate: the row is the picker. Strikes made before a translation
are baked into it, because translating from a curation takes the curated
rendering as input.

---

## 1. The discovery that decides the architecture

NEXT-WORK §4 posed "overlays become per-bank rather than per-reading" as the
leading option, with a blast radius through the generation binding, the
archive-on-mismatch machinery and `curationInEffect`. **That option is dead,
and for a happy reason.**

The translation bank (`src/translate/bank.ts`) is not a positional bank. It is
keyed by `sha256(model, to, from, instructions, masked-source-text)`
(`bankKey`, `bank.ts:147-157`) — no page, no order, no generation, no run id.
A record answers the question *"what is this exact text, in this language?"*
and answers it for any run that ever asks. Two consequences:

1. **Nothing can render *from* a translation bank** — its records carry no
   position, so it can never be what `--overlay` amendments apply to. An
   overlay "bound to the translation's bank" is not a thing that can exist.
2. **Re-translating an already-translated book is nearly free.** Every block
   whose masked source is unchanged is a cache hit (`run.ts`, `fromBank`).
   Strike ten blocks and translate again: the ten are simply never asked, and
   the rest come out of the bank without touching the model.

So curation stays keyed to the reading — where the blocks actually live — and
"curation on top of a translation" needs no new overlay machinery at all. What
the user's walkthrough needs is a **pipeline**: render the curated book from
the readings bank (free — `--reuse-readings`), then translate that rendering
through the translation bank (cache hits — ~free). The position's ancestry
*is* the pipeline description. The whole per-bank blast radius evaporates.

Order-independence falls out too: a block stricken before translation was
never translated; a block stricken after translation is translated in the bank
and simply not asked for. Either way the output is *the translation of the
book minus its strikes* — which is why "baked in" and "applied on top" are the
same artefact, and only the ledger's story about the order differs.

---

## 2. What a translate step is, precisely

Already true (`recordGenerated`, `app/electron/projects.ts:2027-2041`): a
translation lands a ledger step — the only Generate-family product that does —
with `action: 'translate'`, `parent` captured at enqueue, `payload:
generated/<file>`, `params: {language}`.

Extended by this design:

- **`params` gains `bank`** — the project-relative path of the translation
  bank the run wrote, recorded by the landing. It goes in `PARAMS_OF.translate`
  *and* `MINTED_BY_THE_RUN.translate` (`app/shared/ledger.ts:131,224`): a
  recorded fact about the answer, never part of the question — exactly the
  split `generation` and `pages` already obey for reads. A step without it
  (every existing translate step) falls back to the legacy composed path
  `readings/<key>.<tag>.bank.jsonl`.
- **Identity stays `language`, parent-scoped.** `reRunTarget` compares
  `step.parent === request.parent` before params (`ledger.ts:827`), so a
  translation of the pre-strikes curation and one of the post-strikes curation
  are different steps by construction — the branch the user's own example
  requires. Re-translate the same language from the same parent and it
  **replaces**, including a re-translate with different `instructions` or a
  different model: those are the user refining *this* translation, not asking
  a new question. (If that ruling ever chafes, the fix is one line in
  `PARAMS_OF` — the table exists so the rule has one home.)

### Output paths — the §4 collision

`translationFileFor` (`projects.ts:789`) composes `<stem> (<tag>).epub` from
stem and language alone, so the before-strikes and after-strikes translations
in the user's example would collide. Same fix, same convention as bank paths
(`BANK-LIFECYCLE.md` §4.1):

- the **first** translation to a tag keeps `generated/<stem> (<tag>).epub` —
  no migration, every existing project is already in the scheme;
- a **branch** mints `generated/<stem> (<tag>).<id8>.epub` from the
  speculatively-minted step id (`LandedRun.id`), decided at `planTranslation`
  time by asking `reRunTarget`: replace → the target step's existing payload
  path; branch → mint. Filenames are out of the UI; the row's label
  (`labelFor`) is what a person reads, and ten translations are ten rows.

Translation banks branch identically: `readings/<key>.<tag>.<id8>.bank.jsonl`.
A branched translation deliberately does **not** share the first one's bank —
sharing would be harmless for hits but would let `deleteStep`'s sweep destroy
a bank two steps name, and `orphanedPayloads` should not need to learn about
params-recorded banks (it reasons over payloads; the sweep gains one rule:
a translate step's recorded `bank` is destroyed with it, guarded by the same
whole-path `namesPayload` check against other steps' recorded banks).

---

## 3. Generate, standing anywhere — the render pipeline

The rule today: the position affects a Generate **only** through
`overlayPath` (`planConversion` → `overlayForPosition`,
`workspace.ts:221`); the bank is composed from the key and the source is the
archived scan. Standing on a translate step falls back to the nearest
curated ancestor — `ledger.ts:1293-1301` calls it "the honest approximation".
This section replaces the approximation.

`planConversion` walks the position's ancestry (same walk as
`curationInEffect`, which already stops at `read`/`import`) and derives:

| standing on | pipeline |
|---|---|
| `import` | vlm-convert, no overlay (step 0 = the book as read, uncurated) — unchanged |
| `read` | vlm-convert + live overlay — unchanged |
| `curate` (no translate above it) | vlm-convert + that snapshot — unchanged |
| `translate` | vlm-convert (ancestor curation in effect) → **translate stage** |
| `curate` parented under a `translate` | vlm-convert (*this* snapshot) → **translate stage** |

The translate stage: the nearest `translate` step on the ancestry supplies
`--to` (`params.language`) and `--bank` (`params.bank`, legacy fallback).
vlm-convert writes an intermediate EPUB in the OS temp dir (never
`generated/` — debris does not go where products live); `translate` reads it
and writes the real `outputPath`; the intermediate is deleted on settle,
success or not.

Mechanics: `GenerateRequest` gains an optional `thenTranslate?: {to, bank,
model, ollama, instructions?}` block, composed at plan time like everything
else about a Generate. `pump()` (`app/electron/job-queue.ts`) runs the two
spawns serially under one job — one queue row, one progress bar, one settle;
the rotation-and-restore brackets the pair. The vlm stage needs no backend
(`replaysCompletedBank` is true by construction — the plan refuses if the
ancestral read has no completion marker); the translate stage needs the
Ollama endpoint exactly as a translate job does today, and a bank-covered
replay makes it fast rather than free — the honest price of a text edit made
since the translation is that block's re-ask.

**Bounds, stated rather than discovered:**

- **EPUB only.** Standing on a translate-descended position, the Generate
  dialog offers the EPUB card and disables pdf/txt with a sentence — a
  translation is an EPUB transform, and reprinting the scan's pages in
  Hungarian is not a thing `vlm-convert --format pdf` can do. (`generate-
  dialog.component.ts` reads the position from the ledger mirror it already
  paints.)
- **One hop.** A translate step whose ancestry holds another translate step
  is refused at plan time with a sentence. The model permits chains; the
  pipeline v1 does not pretend to. Deferred, named here.
- Generate on a translate position always runs the pipeline (rotating the
  previous output via `rotateGenerated`, as any Generate does) — it does not
  short-circuit to the payload already on disk, because the payload was made
  from the ledger-as-it-stood and the pipeline is made from the
  ledger-as-it-stands, and the bank makes the difference in cost a rounding
  error.

---

## 4. The editor, standing under a translation

The user's walkthrough strikes blocks *after* translating. Today that can be
read-only: `curationLock` asks `curationInEffect`, and a translate step made
from a save resolves to that save — frozen. The lock's own reason
(display/edit drift — editing a live overlay while a frozen snapshot is
displayed) is real, so the fix is a display ruling, not a lock exception:

**Snapshots display themselves and lock; every other row displays the live
overlay and edits.** Standing on a `curate` row shows that snapshot,
read-only — unchanged. Standing on a `translate` row shows the **live
overlay**, editable — changed. The WHY: a translate row is a state of the
*text*, not a snapshot of *corrections*; the corrections pane there shows
your working corrections, which is what striking-then-committing needs. The
lock and the display keep asking one function (`curationInEffect` grows a
`forDisplay` distinction or a sibling; lock derives from display, so they
cannot drift — the same coupling `curation-lock.ts` was built on).

What Generate renders is unchanged by this: Generate uses the committed
snapshot in effect (`renderingOverlay`), and the Generate dialog already
names that (*"with your block corrections applied"*). The one place display
and Generate now differ — standing on a translate with uncommitted strikes,
the pane shows them, Generate-of-the-translation does not — is resolved the
way the whole app resolves it: commit, and the commit is a row.

The commit path needs nothing new: `recordCuration` passes `parent: null`
and `landStep` parents at the standing position (`projects.ts:1120-1133`), so
a save made standing on a translate step is already a `curate` under it. The
tables already carry the row: `RETENTION_OF.curate = 'irreplaceable'`,
`RETAINED_BESIDE_YOU.curate = true` — a save under a translation leaves you
standing on the translation, holding it, exactly like a save under a reading.

The close dialog also needs nothing: `liveRoot`
(`app/shared/uncommitted.ts:125`) walks to the nearest `read`/`import`, and a
save under a translate step still has the read on its ancestry, so
`restorePointOf` finds it — corrections measure against the newest save under
the *reading*, which is the newest snapshot of the one live overlay there is.

---

## 5. Blast radius, checked

Every place that binds to a generation, verified against this design:

| site | verdict |
|---|---|
| `overlays.ts` archive-the-pair on mismatch | untouched — overlays still name the reading's generation, which still only changes on a successful re-read |
| `curationInEffect` stop-at-a-reading walk | untouched for its callers; grows the display/lock distinction of §4 |
| `curation-lock.ts` | re-derived from the display rule, same coupling |
| `uncommitted.ts` `liveRoot`/`restorePointOf` | untouched, verified in §4 |
| `FrozenCuration` unassignability | untouched |
| `recordGenerated` translation landing | extended: records `params.bank`, asks `reRunTarget` for the output path |
| `markStale` transitivity | already right: reading replaced → translation stale → its curations stale |
| `deleteStep` sweep | one rule: destroy a translate step's recorded bank, `namesPayload`-guarded |

---

## 6. Build plan

Ordered; each phase green through all five gates before the next.

**Phase 1 — ledger tables + paths** (`app/shared/ledger.ts`,
`projects.ts::translationFileFor` callers, `workspace.ts::planTranslation`;
tests in `test/app/`): `params.bank` in `PARAMS_OF`/`MINTED_BY_THE_RUN`,
branch-vs-replace path minting for outputs and banks, sweep rule. Pure +
main-process, no UI.

**Phase 2 — the pipeline** (`app/shared/types.ts::GenerateRequest`,
`workspace.ts::planConversion` ancestry walk, `job-queue.ts::pump` two-spawn
job, `argsFor`): Generate from translate-descended positions works end to
end. Depends on phase 1 for `params.bank`.

**Phase 3 — display/lock ruling + dialog bounds**
(`curationInEffect` sibling, `curation-lock.ts`, pdf-view display source,
`generate-dialog.component.ts` EPUB-only bound): the walkthrough's
strike-after-translate becomes possible in the editor. Independent of
phase 2; needs phase 1's nothing — can run parallel to phase 2 **but touches
the renderer**, so it runs as its own agent on its own files.

**Phase 4 — hand-test walkthrough** (the user's own script): translate →
click row → Generate; strike → commit → click new row → Generate; compare
the two EPUBs. Not automatable; named so it is not skipped.
