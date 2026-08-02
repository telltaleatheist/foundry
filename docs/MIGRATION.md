# Migration — what moves from BookForgeApp

**Status: NOTHING HAS MOVED. This repository is a scaffold and contains no
migrated code.** Every row below is a plan, not a record.

Source repo: `/Volumes/Callisto/Projects/BookForgeApp`
(`github.com/telltaleatheist/bookforge`). Paths below are relative to its root.
Destination paths are relative to this repo.

The rename map, applied everywhere as things move:

| BookForge name | Foundry name |
|---|---|
| rubric | **blocks** |
| galley / proof | **ocr** |
| dagger | **footnotes** |
| `rubric-v5-4b` etc. | `foundry-blocks-v1-4b` etc. |

---

## Move rules

1. **Move, do not copy.** Once a file lands here, BookForge deletes its copy and
   calls the `foundry` binary instead. A file that exists in both repos is a bug
   with a fuse on it (see ARCHITECTURE §2).
2. **The encoder moves byte-exact.** The prompt is a trained-against artifact.
   Rename the symbols, change nothing about what it emits. If a refactor is
   wanted, do it *after* a replay test proves the moved encoder produces
   identical prompts for the existing corpus.
3. **Everything Electron comes out.** `import { app } from 'electron'` for a
   data directory, `ipcMain` handlers, the component/download UI machinery —
   none of it exists here. Data dirs resolve from the platform, or from
   `--models-dir`.
4. **Angular comes out too.** `rubric-encoder.ts` is a plain module living under
   an Angular feature folder; it should carry no framework imports across.
5. **Each move lands with its verification.** A port with no fixture check is
   not done — see the replay/fixture column.

---

## 1. Prompt encoder — blocks (was rubric)

| | |
|---|---|
| **From** | `src/app/features/pdf-picker/services/rubric-encoder.ts` |
| **To** | `src/blocks/encoder.ts` |
| **Status** | NOT YET MOVED |

The single implementation of the blocks prompt format. Exports to carry over:
`RubricVersion`, the `RUBRIC_CATEGORIES*` class lists (v1/v3/v5/v6),
`rubricCategories()`, `rubricVersionFor()`, `encodeBook()`, `EncodedPage`,
`EncodeOptions`, `toRawPrompt()`, `RUBRIC_STOP`, `parseAnswer()`.

- `rubricVersionFor()` is the load-bearing id parser (ARCHITECTURE §3). It moves
  intact, including its version→class-list table; foundry ids must parse under
  it or it must be extended deliberately, not loosened.
- `toRawPrompt()` is what makes the `/completion` rule enforceable — the whole
  point is that the encoder produces the final string. Keep the seam.
- `parseAnswer()` moves with it. Main never parses answers; the stage that owns
  the format owns the parsing.

**Verify:** replay the existing labelled corpus through the moved encoder and
diff the produced prompt strings against the BookForge implementation. Byte
identity, not "looks right". `tools/rubric-replay.js` is the existing harness to
adapt.

---

## 2. Edit contract + applier — ocr (was galley)

| | |
|---|---|
| **From** | `tools/galley/edits.mjs` |
| **To** | `src/ocr/edits.ts` |
| **Status** | NOT YET MOVED |

The edit contract itself: `ARROW`, `LIMITS`, `diffOpcodes()`, `deriveEdits()`,
`applyEdits()`, `formatEdits()`, `parseEdits()`.

- `.mjs` → `.ts`: add types, change nothing about the matching or the limits.
- `applyEdits()` carries the rejection rule (a `before` not found verbatim is
  dropped). That rule is the safety property — it does not get "improved" during
  the port.
- Hyphenation is JOIN, never completion. Preserve.

**Verify:** the existing eval set through both implementations, comparing
applied output and rejection counts exactly.

Related, moving alongside:

| From | To | Note |
|---|---|---|
| `tools/galley/contract-crosscheck.mjs` | `test/ocr/contract-crosscheck.test.ts` | contract invariants as tests |
| `tools/galley-score.js` | `tools/score-ocr.ts` | eval harness |
| `tools/galley/eval-line.py` | *stays in BookForgeApp* | training-side line eval |
| `docs/GALLEY_INTEGRATION.md` | fold into `docs/ARCHITECTURE.md` §7 | already partly folded |

The rest of `tools/galley/` (`build-corpus.mjs`, `build-dataset.py`,
`degrade*.{py,mjs}`, `mine-*.mjs`, `align-pairs.py`, `truth-gate.py`,
`train-line.sh`, the training profiles) is **corpus and training tooling and
stays in BookForgeApp.** Foundry is inference and packaging.

---

## 3. Applier + prompt — footnotes (was dagger)

| | |
|---|---|
| **From** | `electron/dagger-footnotes.ts` |
| **To** | `src/footnotes/applier.ts` (+ `src/footnotes/prompt.ts`) |
| **Status** | NOT YET MOVED |

Exports: `DAGGER_SYSTEM_PROMPT`, `DaggerDeletion`, `DaggerChapterPlan`,
`parseDaggerAnswer()`, `isDeletionOnly()`, `applyDaggerDeletions()`,
`DaggerApplyResult`, `splitForDagger()`, `DaggerPlanOptions`,
`planChapterFootnotes()`.

- **`isDeletionOnly()` is the subsequence guard** and the single most important
  function in this file. `after` must be reachable from `before` by deleting
  characters only. Move it with its comment block intact.
- `planChapterFootnotes()` is EPUB-chapter-shaped in BookForge. Here the unit is
  a **block** from the blocks JSON, so this one needs reshaping rather than a
  straight move — split the model-driving loop from the chapter-walking.
- `DAGGER_SYSTEM_PROMPT` is a trained-against string: move verbatim, rename the
  constant only.

| From | To | Note |
|---|---|---|
| `tools/dagger-score.js` | `tools/score-footnotes.ts` | keeps the false-fire / applier-reject metrics; see its header comment, it explains the shortcut risk |

---

## 4. llama-server: binary resolution + lifecycle

| | |
|---|---|
| **From** | `electron/llama-bridge.ts` — `resolveBinary`, exported as `resolveLlamaServerBinary` (~line 164) |
| **To** | `src/serve/llama-binary.ts` |
| **Status** | NOT YET MOVED |

Only the resolution function moves; `llama-bridge.ts` is 33 KB of AI-cleanup
code that stays. Here it gains `--llama-server <path>` as the highest-priority
source, then the vendored binary. **No PATH fallback.**

| | |
|---|---|
| **From** | `electron/llama-model-server.ts` |
| **To** | `src/serve/llama-server.ts` |
| **Status** | NOT YET MOVED |

The lifecycle: spawn on first use, private loopback port, idle shutdown,
`/completion` only. Its header comment is the canonical statement of the
verbatim-prompt rule — carry it over.

Changes on the way in:
- Drop the GPU **arbiter** integration (that sequences against BookForge's TTS
  engines; Foundry is one process and has no other tenants).
- Drop `import { app } from 'electron'`.
- **Invert the "separate instances" decision.** BookForge runs one server per
  fine-tune because they are different full models. Foundry has *one base with
  three adapters*, so it is one server with per-request adapter selection
  (ARCHITECTURE §3). This is the one place where the source design deliberately
  does not carry over.

| From | To | Note |
|---|---|---|
| `electron/rubric-server.ts` | folded into `src/serve/llama-server.ts` | thin wrapper; its per-model params become blocks' entry in the adapter table |
| `electron/dagger-server.ts` | folded into `src/serve/llama-server.ts` | same |
| `electron/rubric-bridge.ts` | `src/blocks/run.ts` | request shaping for blocks |

---

## 5. Model catalog + download

| | |
|---|---|
| **From** | `electron/rubric-models.ts` (`RubricModelDef`: id, name, filename, url, sha256, bytes, rank) |
| **From** | `electron/dagger-models.ts` |
| **To** | `src/models/catalog.ts` |
| **Status** | NOT YET MOVED |

One catalog, entries for the base model and the three adapters. Keep the shape —
`url` + `sha256` + `bytes` + `rank`, old entries never deleted, `rank` picks the
default (ARCHITECTURE §6).

| | |
|---|---|
| **From** | `electron/components/downloader.ts` (`downloadFile`) |
| **To** | `src/models/download.ts` |
| **Status** | NOT YET MOVED |

Plain HTTP + sha256, no Python, no `huggingface_hub`. Strip the component-system
progress/UI plumbing down to a progress callback.

| | |
|---|---|
| **From** | `electron/shared-paths.ts` (OwenMorgan shared dir), `migrateLegacyDir` |
| **To** | `src/models/paths.ts` |
| **Status** | NOT YET MOVED |

Resolve a platform data dir; `--models-dir` overrides. Drop `migrateLegacyDir` —
Foundry has no legacy layout to migrate from, and importing one on day one would
be inventing debt.

**Not moving:** `electron/components/rubric-model-components.ts`,
`dagger-model-components.ts`, `component-catalog.ts`, `component-manager.ts`.
That is BookForge's Settings/Add-ons UI. Foundry's equivalent is
`foundry models pull|list`.

---

## 6. Tesseract: the pin, and the band merger

| | |
|---|---|
| **From** | `electron/ocr-service.ts` — Tesseract invocation, `OCR_DPI` (200), block extraction |
| **To** | `src/scan/tesseract.ts` |
| **Status** | NOT YET MOVED |

Take the invocation, the dpi constant and its comments (they document exactly
why 200 is not a setting — ARCHITECTURE §5), and the block/word-confidence
parsing. Leave behind the Electron project store, caching and progress events.
**Add** the version + tessdata hash check, which BookForge does not have because
it assumes an installed Tesseract; Foundry vendors it.

| | |
|---|---|
| **From** | `electron/headless-ocr.ts` | 
| **To** | reference for `src/scan/` CLI shape |
| **Status** | NOT YET MOVED |

The closest thing BookForge already has to a headless run — useful as the
starting shape for `foundry scan`.

| | |
|---|---|
| **From** | `tools/ocr-lab/bands.py` (Python) |
| **To** | `src/scan/bands.ts` |
| **Status** | NOT YET MOVED — **PORT TO TS WITH FIXTURE VERIFICATION** |

Projection-profile line segmentation: deskew, horizontal ink profile, one band
per line, boxes as `[x0,y0,x1,y1]` in **full-page** pixels (half-open, PIL crop
order), `deskewDeg` recorded per page and required by anything cropping the
render.

This is the "safe to port" code from ARCHITECTURE §1 — pure geometry over
numbers — and it is safe **only because it is verifiable**:

> **Port protocol.** Run `bands.py` and `bands.ts` over the same fixture
> renders and diff the emitted JSON box-for-box. The port is done when they
> agree on every page of the fixture set, and not before. Commit the fixtures
> and the diff harness with the port.

Preserve its no-fallback contract: a page that cannot be segmented raises, is
reported by page number, and makes the run exit nonzero.

| From | To | Note |
|---|---|---|
| `tools/ocr-lab/score.py`, `run-book.py`, `align-*.py`, `extract_reference.py` | *stay in BookForgeApp* | corpus/measurement rig |
| `electron/ocr-preprocess.py` | evaluate later | may be unnecessary once bands is in TS |

---

## 7. Run orchestration

| | |
|---|---|
| **From** | `electron/rubric-run.ts` (main-owned run lifecycle, resume, cancellation) |
| **To** | `src/pipeline/run.ts` |
| **Status** | NOT YET MOVED |

Much of this exists because a run had to survive an ng-serve reload and be owned
by the main process rather than the renderer. In a CLI the process *is* the run,
so what carries over is the **staging and resume** logic — a long convert should
be resumable — not the ownership machinery.

| From | To | Note |
|---|---|---|
| `electron/rubric-predictions.ts` | `src/blocks/predictions.ts` | prediction storage/shape |
| `electron/corpus-ocr-run.ts` | *stays* | corpus-building, BookForge-side |

---

## 8. Export (PDF → EPUB)

| | |
|---|---|
| **From** | the category-driven XHTML export path in `electron/pdf-analyzer.ts` / `epub-processor.ts` |
| **To** | `src/export/epub.ts` |
| **Status** | NOT YET MOVED — **scope not yet pinned down** |

The category→XHTML rules and the prosody paragraph rule (a paragraph ends where
the text ends, not where the page did). This is the least-surveyed item on the
list: the export logic in BookForge is entangled with its manifest/project
model, and the extraction boundary needs a read-through before it can be
tabled properly.

---

## 9. Docs to fold in

| From | Disposition |
|---|---|
| `docs/RUBRIC_TRAINING.md` | **stays in BookForgeApp** — training rig, corpus state, measurement discipline. Foundry does not train. |
| `docs/OCR_LAB.md` | stays; it is the authority on the band pipeline. Link from here. |
| `docs/GALLEY_INTEGRATION.md` | fold the contract half into `ARCHITECTURE.md` §7; leave the training half. |
| `tools/galley/README.md` (27 KB) | mine for the contract rationale; the rest is training. |

---

## Order of work

The dependency order, roughly:

1. **`models/`** — catalog, download, sha256, paths. Nothing runs without
   weights, and it is the least entangled code in the list.
2. **`serve/`** — binary resolution + llama-server lifecycle + adapter swap.
   Prove `/completion` round-trips verbatim before anything depends on it.
3. **`blocks/`** — encoder moves byte-exact, replay-verified. This is the one to
   get right; the other two adapters follow its pattern.
4. **`scan/`** — tesseract pin first, then the `bands.py` port with fixtures.
5. **`ocr/`** and **`footnotes/`** — appliers move with their eval harnesses.
6. **`export/`** — after the boundary is surveyed (§8).
7. **BookForge becomes a thin client** — delete its copies, spawn the binary.
   Not done until the copies are *deleted*, because two implementations is the
   failure this whole extraction exists to prevent.
