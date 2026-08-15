# The derived book — one truth, every output a projection

DRAFT for review, 2026-08-15. Not build-ready: the decisions marked ⚖ are the
user's to confirm. Grounded in a full trace of the assembler, the EPUB editors,
`history.ts`, `epub-final` and the translate engine; file:line citations are in
the scout notes this distils. Builds on `docs/STEP-LEDGER.md`,
`docs/BANK-LIFECYCLE.md`, `docs/TRANSLATION-STEPS.md` as landed.

**The proposition, in one paragraph.** The readings bank is the only truth a
book has. Everything else — the curated book, the translation, the simplified
edition, the EPUB, the txt, the facsimile PDF — is a projection computed from
it by deterministic passes plus recorded human decisions. Decisions are
recorded against SOURCE BLOCK ADDRESSES, so a decision made anywhere applies
everywhere; per-page truth is never destroyed, so the facsimile is never lost;
and "advanced operations" (translate, simplify) are per-block text records
keyed to the same addresses, which is what makes ten translations ten cheap
projections instead of ten forked books.

---

## 1. What the trace established (facts, not design)

1. **The overlay already applies before everything.** Strikes, recategorisations
   and text overrides land on parse-time blocks `(page, order, part)` one line
   after parsing, before any merge, reflow or emission. Every output format is
   downstream of the curated block list. This is the foundation and it is
   already right.

2. **A cross-page paragraph is NOT one block.** The halves keep separate
   `(page, order)` identities to the end; the join happens as string surgery on
   the emitted `<p>` inside chapter-body building. `part` is the markdown
   sub-split index, not a cross-page part. Consequences: each half is
   separately strikeable (striking one drops half a paragraph), and the merged
   paragraph's emitted element carries only the FIRST half's stamp.

3. **The join is deterministic given bank + PDF, not bank alone.** The textual
   test (`continuesTextually`) is bank-pure; the fallback (`carriesOver`)
   samples the page raster's ink extent at the pinned DPI. Same bank + same
   PDF → same joins. No model, no randomness.

4. **Two identity spaces exist and do not line up.** `(page, order, part)`
   addresses a parse-time block (the overlay's space). `data-bf-id = p<page>-<n>`
   addresses an emitted ELEMENT — a per-page counter that shifts whenever a
   strike, a recategorisation or a merge changes what is emitted before it.
   The one place both are in hand at once is the emitter's `stamp()`.

5. **EPUB edits are already operations — in the wrong address space.** The
   in-place block editor records `{member, target, field, before, after}` rows
   (fields: cut, category, html, note-cut, nav-label, page-heading) into
   `history/<tree>.json`, generation-bound, replayable. `target` is the
   emitted-element id, so the rows die with the working tree. The raw textarea
   editor is the one write that can be anything at all, and is deliberately
   outside the ledger.

6. **Save never applies cuts.** The app's Save repacks the working tree
   verbatim — `data-bf-cut` marks included. `epub-final`, the engine command
   that removes cut elements and tidies orphaned notes/nav, is never spawned by
   the app. `recordFinal` records `manifest.final` only; no ledger step. The
   step kind `'edit'` exists in the type and is constructed nowhere.

7. **The translation unit today is an XHTML byte range.** `findBlocks` keys on
   `data-bf-cat` in an emitted chapter; masking protects inline apparatus
   (noterefs, `<sup>`, pagebreak spans, formatting tags). The per-block text
   *before* emission (`DotsBlock.text`) is plain text with markdown and
   superscript digits — no markers exist yet at that stage. The translation
   bank keys on the MASKED text hash.

---

## 2. The design

### 2.1 Join groups — the assembled block becomes a first-class unit

A new deterministic pass, hoisted from the emitter, runs after overlay
application and produces the book's **join groups**: each group a list of
parts `[(page, order, part), …]`, almost always length 1, length ≥2 exactly
where today's emitter would have joined paragraphs. The emitter then consumes
groups instead of re-deriving joins, so the grouping and the rendering cannot
disagree.

- The group is the unit the UI strikes, the unit translation translates, and
  the unit a text override overrides. Striking a group strikes all its parts
  (the overlay stays part-addressed on disk — no format change — the UI just
  stops offering half a paragraph as a target).
- The grouping is pinned by tests as part of the contract: same bank + same
  PDF + same overlay → same groups. A version that changes the join rule
  changes groups DETECTABLY (records carry their parts; a record whose parts
  no longer describe a group is stale, never misapplied).
- ⚖ **Decision**: the block editor's display should show a spanned group as
  one selectable thing across the page boundary. (Recommended; the alternative
  — keep half-paragraph striking — preserves today's behaviour but makes the
  "strike it everywhere" promise subtly false at page turns.)

### 2.2 Transforms — translation (and simplify, and whatever is next) as records

A transform run consumes join groups and produces **records**:

```
{ parts: [(page, order, part), …],   ← which source blocks this is about
  generation,                        ← dies with a re-read, like every decision
  key,                               ← hash of (transform, params, source text)
  text }                             ← the transformed text, model-dialect
```

- Source text for the model is the group's merged, dehyphenated, reflowed
  plain text — complete thoughts, no OCR artifacts — with a TEXT-LEVEL mask
  for what must survive verbatim (superscript note digits, markdown emphasis;
  the design successor of `maskBlock`, one level earlier).
- The existing question-keyed bank remains the cost layer: same text, same
  params → cache hit, across branches and re-reads alike.
- Records per language/transform live beside the reading
  (`readings/<key>.<tag>.records.jsonl` — exact naming at build time), owned
  by their step, swept with it, seeded by copy exactly as translation banks
  are today.
- **Strikes are never in the records.** Strike a group — from the source view
  or while reading any translation — and the strike lands in the overlay at
  the parts; every projection drops the group on next render. This is the
  "one strike applies to all translations" property, and it holds because
  nothing downstream stores its own copy of the decision.
- ⚖ **Decision**: translated-text OVERRIDES (fixing an awkward sentence in
  the Hungarian) are per-record, stored with that language's records; source
  text overrides invalidate the record (text changed → key changed → re-ask).
  Deletes/restores/categories are always source-level.
- Rendering a transform = the same emitter, fed the records' text instead of
  the groups' text, through the same inline pass (notes, pagebreaks, ids) —
  which is what retires the EPUB round-trip: `translate` stops parsing
  emitted books and starts answering for groups. Reflow outputs only (epub,
  txt); the facsimile belongs to the source language, permanently.

### 2.3 The id bridge — EPUB edits move into the source address space

The emitter's `stamp()` — the one place both identities exist — additionally
writes a **manifest of `data-bf-id → parts`** beside the rendering. Then:

- The in-place editor's ops (cut, category, html, note-cut) are recorded
  against PARTS via the bridge, into the overlay/decision system, instead of
  against emitted ids into `history/<tree>.json`. A cut in the book view IS a
  strike; a recategorisation in the book view IS the overlay's category; an
  html edit becomes the group's text override (word-level validation already
  exists and comes along).
- Ops recorded at source level survive re-renders, re-casts and format
  changes by construction — the whole reason `history.ts` needed generation
  archaeology disappears for them.
- `history/<tree>.json` then holds only what cannot map upstream: nav-label
  and page-heading edits (document-level facts of one rendering), and nothing
  else. ⚖ **Decision**: the raw textarea editor stays as the escape hatch —
  its writes are outside provenance, marked as such (the working tree becomes
  "derived + your hand edits"), OR it is retired. Recommended: keep it,
  labelled honestly; retiring it costs real capability.

### 2.4 Save applies the cuts — the `epub-final` gap closes

Independent of everything above and wanted regardless: the app's Save runs
`epub-final` over the working tree into the chosen destination (the engine
command exists, takes a directory, and is spawned like any other), so a saved
book no longer contains every block the user cut, merely marked. The repack-
verbatim path remains for "save the working copy as-is" if a second verb is
wanted (⚖ — recommended: one verb, cuts applied; the marks are an
implementation detail no reader should ever see).

### 2.5 What this retires, eventually

- `translate`'s EPUB parsing/masking/splicing (§2.2 renders records instead).
- `history.ts`'s html/cut/category rows and their generation archaeology
  (§2.3 moves them upstream); the file stays for nav/page-heading rows.
- The two-stage Generate pipeline's intermediate EPUB (the translate stage
  stops needing an EPUB input at all). The pipeline shipped and works; it is
  the bridge, not the destination.

---

## 3. Sequencing (proposal)

1. **Join groups** (engine): the pass, the contract tests, the emitter
   consuming groups. No behaviour change to any output.
2. **Group-aware striking** (app): the block editor treats a group as one
   target. Small, visible, independently shippable.
3. **Cuts-on-save** (app): the `epub-final` gap. Independent of everything.
4. **Records + text-level mask** (engine): translation as records; `translate`
   gains the bank→bank mode; the app's pipeline switches to it.
5. **The id bridge** (engine emitter + app): EPUB in-place ops land upstream.
6. **Simplify** (or the next transform): arrives nearly free as a second
   params set on §2.2's machinery — the proof the abstraction earned itself.

Each phase lands green through the five gates; 1 and 3 can start the moment
this draft is confirmed.

---

## 4. Open questions for review (the ⚖ list, gathered)

1. Spanned groups as one selectable unit in the block editor? (Recommended: yes.)
2. Translated-text overrides per-record, source overrides invalidate? (Recommended: yes.)
3. Raw textarea editor: keep as labelled escape hatch, or retire? (Recommended: keep.)
4. Save: one verb with cuts applied, or two verbs? (Recommended: one.)
