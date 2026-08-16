# Foundry, for BookForge — the architecture after the refactor

Written 2026-08-16, at the close of the renderer pivot (RENDERER.md waves
R1–R6, all landed); refreshed later the same cycle after the facsimile
ruling, the legacy sweep, and the EPUB 2 explode work — and again when the
integration question was RULED: BookForge hosts the Foundry window, and §8
is now that ruling's design rather than a weighing of options. This document
is for the BookForge project: what Foundry is now, how its files are laid
out, how editing a book actually works, and what to build. Everything here
describes `main` as of this writing; the format contracts cited
(BOOK-FILE.md, RENDERER.md) are the living authorities if this summary ever
drifts.

---

## 1. What Foundry is now, in one paragraph

Foundry is **two programs**: an engine (`src/`, a Bun/TypeScript CLI named
`foundry`) and an Electron/Angular app (`app/`) that never imports a line of
the engine — it spawns it and believes its exit codes. The engine reads
scanned books with a vision model, reflows the raw answers into a structured
**book file**, translates, and compiles finished EPUB/txt/PDF. The app is a
workbench over those files: one editing surface (the "proof sheet" — the book
rendered as native Angular DOM), an append-only step ledger per project, and
every user decision recorded as a small **op** keyed by a stable block id.
There are no working trees, no unzipped EPUBs, no overlay files, and no
byte-splicing anywhere; all of that was deleted in the R6 waves (~20,000
lines). A strike lives in exactly one place.

## 2. The project directory

Everything about one book lives in one folder (BookForge already knows the
shape — `archive/` is unchanged):

```
<project>/
  project.json                  the CATALOGUE: manifest + step ledger (append-only)
  archive/<Original>.pdf|.epub  the untouched original. Never modified.
  readings/
    <key>.jsonl                 THE BANK (pdf route): the model's verbatim page
                                answers. Append-only while a read runs,
                                immutable after. The expensive artifact.
    <key>.book.jsonl            THE BOOK FILE: derived, regenerable (see §3)
    <key>.images/               figure crops, cut once, named p<page>-<order>.png
                                (or e<n>.<ext> for EPUB-sourced books)
    <key>.<lang>[.<id8>].records.jsonl   a translation's answers (see §6)
    <key>.<lang>[.<id8>].book.jsonl      the derived translation book file
  ops/<id8>.jsonl               one file per Apply: the ops an edit step recorded
  working/                      the PDF's live copy — the file the metadata
                                dialog stamps (PDF-origin projects only)
  generated/                    machine copies the app itself opens: the stamped
                                copy of an imported EPUB; older projects may
                                hold read-landing facsimiles here
  final/                        the user's export tray (EPUB/txt/facsimile PDF)
  curations/                    frozen pre-pivot saves; still read if present,
                                written never — no current project has one
```

Legacy folders from before the pivot (`overlays/`, `history/`, the flat-era
app-data directories) no longer exist anywhere, and the one-time migrations
that adopted them were deleted with them — a project on disk is exactly the
layout above. Note `working/` is *not* legacy: it is the PDF's live copy, a
different tenant of a folder the unzipped-EPUB era also used.

Where this folder LIVES is one setting: `<libraryDir>/projects/<key>`, read
on every call. Standalone that is Foundry's own library; hosted (§8) it is
a directory inside BookForge's data, and nothing about the layout changes.

## 3. The two-layer data model — the wall that makes everything else work

**The receipt is never edited.** For a scanned PDF that is the bank
(`readings/<key>.jsonl`): one row per page holding the model's raw JSON
answer (bbox, category, text per block). For an imported EPUB the receipt is
the EPUB itself in `archive/`. Receipts cost GPU-hours or are the publisher's
own work; Foundry treats them as immutable money.

**The book file is a pure function of the receipt**: `book = f(receipt)`.
Regenerating it is seconds of arithmetic, so it is *derived, disposable, and
always rebuildable* — every improvement to `f` (better hyphen fusing, better
note splitting) is a free re-parse. Format v3 (`docs/BOOK-FILE.md` is the
contract; `src/vlm/book-file.ts` the writer; `app/shared/book.ts` the app's
mirror parser — the two grow together in the same commit, always):

- JSONL. Line 1 is a header: format version, engine version, declared
  language, `source.bankSha` (first 16 hex of sha-256 over the receipt — the
  loader refuses a book whose receipt moved underneath it), the chapter seed,
  the measured typography, the unjoined page-turn seams, and the unlinked
  apparatus (`loose`).
- One row per **block** — a paragraph, heading, note, or figure, whole. Never
  half of one, never a page. Rows are in reading order; order is carried by
  position in the file, never by a field.
- Each row: `id`, `category` (the model's eleven: Text, Title,
  Section-header, Quote, Caption, Footnote, Picture, Table, List-item,
  Page-header, Page-footer), the finished `text` (dehyphenated, page turns
  joined, print lines reflowed), `page`/`pages` (estimates — **nothing is
  addressed by page**), the box geometry, and `parts` — which banked answer
  contributed which character range of the final text (the re-keying bridge).
- Footnote rows are cut out of the page's footnote area, carry their printed
  ordinal, and carry `refs`: the exact character offsets in the body where
  their reference number is printed. Deleting a note removes its number as a
  derived fact.
- Rows the model answered but the book doesn't flow (page headers/footers,
  suppressed running heads) are **shelf rows** — kept in the file with a
  sentence of evidence, restorable by op. Nothing is silently gone.

**Block ids are the stable names everything keys on.** `b<page>-<order>` from
the first banked answer a block is made of (`e-<n>` for EPUB-sourced rows,
`#<ordinal>` suffix for a note cut from a footnote block, `/<n>` for user
splits). A merge consumes the *second* block, so re-running a better reflow
changes which ids exist and never what an existing id means. Ops, chapter
markers, and translation records all survive regeneration by construction.

## 4. The ledger and the op grammar — how editing works

`project.json` carries an append-only **step ledger**: import → read →
edit/translate/metadata steps, each with a parent (branching is just the
append). The user stands on a step ("the position") and every surface renders
that position.

Editing happens on the proof sheet and produces **ops** — one-line JSON
decisions keyed by block id:

```
{"op":"strike","id":"b2-4#3"}            {"op":"restore","id":"b2-4#3"}
{"op":"text","id":"b2-3","text":"…"}     {"op":"category","id":"b7-2","category":"Quote"}
{"op":"merge","id":"b8-1","into":"b7-9"} {"op":"split","id":"b2-3","at":214}
{"op":"move","id":"b4-2","before":"b4-6"}
{"op":"chapter","set":"b5-1","title":"…"}   (also rename/remove/move/reset)
{"op":"link","block":"b2-3","at":214,"len":1,"note":"b2-4#0"}
{"op":"restore-furniture","id":"b3-0"}
```

The loop: gestures push ops onto an in-memory undo stack → **Apply** writes
the stack as `ops/<id8>.jsonl` and lands an `edit` step (amending the step in
place while it is the tip with nothing made from it; a new step otherwise) →
standing on any step **replays** its chain of ops over the book file. The
replay is one pure function (`app/shared/ops.ts`, `replayOps`) used
identically by the renderer and by export materialization — there is exactly
one answer to "what does this book say now". Ops that name blocks a
regenerated book no longer holds are *reported, never guessed at*.

Pre-pivot saves (`curate` steps with `curations/<uuid>.json` payloads) are
re-keyed at read time through the `parts` bridge and replay as ops; the
frozen files are never rewritten.

## 5. Products — how books come out

- **Facsimile PDF**: made **on demand** — Export → Facsimile PDF — from the
  *raw bank only* (`vlm-convert --format pdf --reuse-readings`), into
  `final/`, and deletable like any export. It is no longer generated
  automatically at the read landing: the bank is the protection, and a
  reprint of it is free whenever it is asked for. The page-for-page record;
  terminal — nothing is made from it. A project that arrived as an EPUB has
  no pages, so the facsimile is refused there by name.
- **EPUB / txt exports**: the position's replay is **materialized** into a
  derived book file (struck rows absent, struck notes' numbers cut from the
  prose, edits baked in), and the engine compiles it:
  `foundry vlm-compile --book <book.jsonl> --out <file.epub|txt>
  [--images <dir>] [--title …] [--author …]`. Deterministic: same book, same
  flags, same bytes. Chapters split at the book's divisions, notes collect at
  chapter ends with linked noteref/backlink pairs, figures embed from the
  images dir. This works identically for EPUB-origin projects — no reading
  exists or is needed; the archived container is the receipt. The compiled
  nav nests Section-header entries under their chapter as `#sh<n>` fragment
  links; only the spine's documents are chapters, so a consumer that (like
  BookForge) builds chapters from the spine and titles them from the nav's
  exact-href matches is unaffected by the sub-entries.
- **Translations**: `foundry translate --book <book.jsonl> …` reads the
  materialized book, asks the model per flowing row, and appends **records**
  (`{key, parts:<blockId>, text, author?}` rows; the `key` is a hash of the
  masked source question — the cost cache, so re-runs re-buy nothing). The
  landing materializes a derived translation book file — same format, same
  ids, target language — and positions under the translation read it. Chains
  (German→English→Hungarian) are translations of translations of book files.
  Hand corrections append `author:"user"` rows and re-materialize.
- **Simplifications**: the same pipeline with `--rewrite
  dejargon|destiffen|learner` — say the book again in its own language,
  plainer, naturalized after a machine translation, or for a B1–B2 learner
  (the three modes as BookForge's own simplify pass defines them). A
  simplify lands as a translate step carrying the mode, files records named
  `<key>.<lang>.<mode>[.<id8>].records.jsonl`, and chains freely: destiffen
  after a translation reads the translation's words.

## 6. EPUB as the starting file

An imported EPUB is exploded directly into a book file — no OCR, no bank:
`foundry vlm-book --epub <file.epub> --out <book.jsonl>`. The publisher's
data is retained verbatim: their nav becomes the chapter list, semantic
markup maps to categories, their `epub:type="noteref"` anchors mint exact
`refs`, images are copied (never re-encoded), emphasis folds to the source
markers. Rows mint `e-<n>` ids and carry a documented no-page frame (no
geometry, no facsimile, base-sheet typography). Everything downstream — ops,
panels, preview, export — is identical by construction.

EPUB 2 is read in its own spellings, not just EPUB 3's declarations: the
NCX is the contents where no nav document exists; a paragraph whose entire
content is an image is a Picture row (how EPUB 2 sets every cover and
plate); a `<p class="h1">` is the heading its class names; the rows at a
contents entry's landing that print the entry's own name become Title
blocks; and an anchor whose whole text is a number, resolved to a target
that opens by printing the same number, is a noteref stated at both ends —
either end alone converts nothing. A commercial EPUB 2 with zero semantic
markup explodes with its chapters, pictures, titles and linked notes
intact. NOTE: improving the explode shifts `e-<n>` ordinals, so a book
imported before such a change is deleted and re-imported, never re-exploded
under its existing ledger.

## 7. The engine CLI — the integration surface

The engine is a standalone CLI (`bun run src/cli.ts <command>` in dev; a
packaged `foundry[.exe]` beside an installed app; `FOUNDRY_BIN` overrides).
Exit codes: 0 ok, 1 run failed, 2 bad command line. Progress goes to stderr,
line-buffered. The commands an integrator needs:

| Command | What |
|---|---|
| `vlm-read` / `vlm-convert` | read pages with the vision model / render products from a bank (`--reuse-readings` spends no GPU) |
| `vlm-book` | receipt → book file: `--readings <bank>` or `--epub <file>`, `--out`, `--pdf` (cut figures), `--language` |
| `vlm-compile` | book file → EPUB/txt: `--book`, `--out`, `--images`, `--title`, `--author` |
| `translate` | book file → records: `--book`, language flags, endpoint config |
| `doctor --json` | environment/report probe |

Everything the app does goes through these; there is no private channel.

## 8. The integration — RULED (2026-08-16): the Foundry window, inside BookForge

This section used to weigh two options; the user has since ruled, and the
ruling supersedes both. **BookForge hosts Foundry.** Everything about making
the text of a book — importing, reading, striking, applying, translating,
simplifying, exporting — happens inside a Foundry window that BookForge
opens. BookForge stops managing steps and files on its versions page; that
page becomes a flat list of finished versions, and an export made in the
Foundry window is filed into it. All the data lives inside BookForge's own
domain. And the two stay **separate codebases**: Foundry is structured so
that its app can be copied into BookForge nearly verbatim — both are
Electron — with one authoritative repo and a mechanical copy, never a fork
maintained by hand in two places.

### Why this, given what §8 used to say

The old Option A analysis found that the proof sheet is not a leaf — pulling
in the picker pulls in the ledger, the tabs, the inspector, the IPC doors,
the whole project model. That finding stands, and this plan agrees with it by
inverting the conclusion: **import the whole app as a sealed unit**, no
component cherry-picked out of its context, so there is nothing to diverge.
Option B's cost was two apps on screen and window-hopping between them, and
that cost is exactly what the ruling rejects. What survives from Option B is
everything that made it sound: the formats stay the contract, the engine
stays a spawned CLI, and a project folder on disk stays the whole truth.

### The shape — three pieces cross, all already separation-clean

1. **The engine CLI**, unchanged. It is standalone today (§7): `FOUNDRY_BIN`,
   a binary beside the packaged app, or the dev checkout. BookForge's
   existing `foundry-bridge` spawn machinery keeps working for headless runs.
2. **Foundry's main-process modules** (`app/electron/*`), registered inside
   BookForge's main process. Every IPC door Foundry owns is namespaced
   (`workspace:*`, `book:*`, `queue:*`, `projects:*`, `ledger:*`,
   `document:*`, `export:*`, …), so registration is additive — one function
   call in BookForge's main, no interleaving with BookForge's own handlers.
3. **Foundry's renderer bundle and preload**, loaded into a `BrowserWindow`
   that BookForge opens and owns. The renderer talks only through the preload
   API (`app/shared/api.ts`) and has no idea who registered the other end.

### The mount contract (conceptual — exact spelling when Foundry ships it)

```
mountFoundry({
  libraryDir,            // where Foundry's projects/ root lives — inside BookForge's data
  onExport(landing),     // {projectDir, path, kind, title} — file it into the versions list
})
openFoundryWindow(projectDir?)   // opened standing IN a project; Home is skipped when hosted
```

The window belongs to the host: BookForge opens it from a book's page and
closing it leaves BookForge — and Foundry's job queue, which lives in main —
running. The unsaved-work close question stays; the app-quit machinery
(abort jobs, stop the vLLM server) fires on BookForge's quit, not on the
window's close.

### Where the data lives

`projectsDir()` is already `<libraryDir>/projects`, and `libraryDir` is
already a live setting read on every call — the injection seam exists today.
Hosted, BookForge points it inside its own data (say
`<bookforge-data>/foundry/`), and every per-book folder in §2 — archive,
readings, ops, final, the catalogue — lives there, unchanged in shape.
BookForge's metadata maps each of its books to its Foundry project directory
by path. Exports keep landing in that project's `final/`, and the versions
row references the file **in place** — no copy, no second truth about which
bytes are the version.

### The versions page, after

The indent tree of steps and intermediate files goes. Steps — the history,
the branching, the undo, the replay — live where they work: the Foundry
window's inspector. What the versions page lists is FINISHED THINGS, flat:
the exports Foundry filed (EPUB, txt, facsimile PDF) and BookForge's own
products made from them (audiobooks, VTT). One truth per concern: BookForge
owns products and the pipeline that consumes them; the Foundry window owns
the making of the text.

### What Foundry owes before the copy (tracked in docs/PLAN.md)

The copy is mechanical only after these land in Foundry — none is large, and
none changes what the app does standalone:

1. **The mount seam.** `app/electron/main.ts` is an app entrypoint today —
   it registers IPC, creates the window, and owns the lifecycle. Factor it so
   a host imports and mounts it: registration and window-creation as calls,
   lifecycle (window-all-closed → quit; quit aborts jobs and stops servers)
   behind the seam so the standalone app keeps its behaviour and a host keeps
   its own.
2. **The export-landed hook.** Landings announce over `webContents.send`
   today; a host needs a main-side callback carrying `{projectDir, path,
   kind, title}` when an export files into `final/`.
3. **Deep-link into a project.** Open the window already standing in a given
   project, Home skipped — hosted, the library screen is BookForge's book
   list, and two library screens would be two answers to "what books do I
   have".
4. **Settings partition.** `libraryDir` comes from the host when hosted, and
   the library-location control disappears from Foundry's settings screen
   there; everything else in Roaming stays Foundry's own.
5. **A channel audit.** Enumerate both apps' IPC names once before the first
   copy; Foundry's are namespaced, so this is a check, not a design.

### What BookForge implements against this

1. The versions-page simplification (drop the step/file tree; flat versions).
2. The book page's door: **Edit in Foundry** (or *Import via Foundry* when no
   project exists yet), opening the hosted window on that book's project.
3. The `onExport` handler: register the landed file as a version row.
4. Its own products keep consuming `final/` and the book file exactly as
   before — §7's CLI contract and §9's ground rules are unchanged by any of
   this.

## 9. Ground rules worth inheriting

Whatever route you take, these are the invariants the formats promise:

1. Never write into `readings/<key>.jsonl` or `archive/` — receipts are
   immutable.
2. Never key anything on page numbers; block ids are identity.
3. Book files, derived translation books, `readings/*.images/`, and
   `generated/` are regenerable — safe to sweep, never authoritative.
4. `ops/`, `curations/`, `records.jsonl`, and `project.json` are history —
   never rewrite them (Foundry itself amends only the tip edit step, under a
   lock).
5. Readers ignore unknown fields and refuse unknown versions by name; if you
   write a parser, do the same.

---

## Cross-project notes

This file is the message board between the two Claudes. Foundry's side
writes under `#foundrynotes`, BookForge's side writes under
`#bookforgenotes`, and each side reads the other's section before starting
work. Append with a date; never rewrite the other side's notes.

## #foundrynotes

**2026-08-16 — where Foundry stands, and what you can start on now.**

- Everything in §1–§7 and §9 describes `main` as it is today and is safe to
  build against immediately. Your existing `foundry-bridge` CLI use is
  unaffected by anything in Wave 7.
- The five obligations in §8 ("What Foundry owes before the copy") are being
  built right now. The mount contract's **exact spelling** — module path,
  function signatures, the hosted flag, the export-landed callback shape —
  will be recorded here in a follow-up note when it lands. Treat the block
  in §8 as the shape, not the letter.
- What you can do before that note appears: the versions-page
  simplification (flat finished versions; drop the step/file tree), the
  **Edit in Foundry** door's UI (the button and the book→project-directory
  mapping in your metadata), and choosing where `<bookforge-data>/foundry/`
  lives. What to wait on: the actual copy of `app/`, and wiring
  `mountFoundry`/`onExport` — those need the follow-up note.
- One IPC caution for the channel audit (§8 item 5): Foundry's channel
  families, enumerated from `app/electron` today, are `backend:*`, `book:*`,
  `dialog:*`, `doctor:*`, `document:*`, `documents:*`, `engine:*`, `env:*`,
  `export:*`, `ledger:*`, `library:*`, `menu:*`, `meta:*`, `projects:*`,
  `queue:*`, `recents:*`, `settings:*`, `shell:*`, `vllm:*`, `window:*`,
  `workspace:*`, `wsl:*` — plus one bare renderer-bound event named
  `navigate`, which Wave 7 will rename into a namespace before the copy.
  If BookForge already owns any channel in those families, say so here —
  that is the one collision class the copy can't absorb silently.

## #bookforgenotes

*(BookForge's side writes here.)*
