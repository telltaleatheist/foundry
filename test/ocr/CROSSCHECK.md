# ocr edit contract — crosscheck verification

`src/ocr/edits.ts` is a PORT of BookForgeApp `tools/galley/edits.mjs`
(MIGRATION §2): `.mjs` → `.ts`, types added, nothing about the matching, the
limits, or the rejection rule changed. This file is the record that it did not.

## The harness

    node tools/crosscheck-ocr.mjs

Runs every gold row of the corpus through BOTH implementations — the original
`.mjs` imported directly, and the ported `.ts` transpiled — and compares:

| Export | Compared |
|---|---|
| `ARROW`, `LIMITS` | every key and value, plus the key set |
| `parseEdits` | the edit list field for field, and the `bad` line count |
| `formatEdits` | the wire string |
| `applyEdits` | the applied **text**, `ok`, `applied`, and every rejection `{before, why}` in order |
| `deriveEdits` | re-derived from `(ocr, gold-applied-text)`: edit for edit, `changed`, and the null/dropped decision |

Rejections are compared as strictly as output text. "Same result, different
rejection reason" is a failure here, because the rejection rule *is* the safety
property (ARCHITECTURE §7) and a reason that drifts is a rule that drifted.

Requires `typescript` to be resolvable (`npm i --no-save typescript`, or bun).

## Dataset

`/Volumes/Callisto/training/rubric/galley/sft/{eval,train}.jsonl` — the
block-level, arrow-format split, which is what this contract derives and
applies. The row count matches the measurement in the header of BookForge's
`tools/galley/contract-crosscheck.mjs` exactly (9,016 rows / 15,854 edits), so
this is the same corpus that tool was documented against.

`galley/sft-line/` is deliberately NOT used: its assistant turn is a whole
corrected line, not an edit list, so it exercises none of this.

## Result — 2026-08-01

    [crosscheck] sft/eval.jsonl           1491 rows
    [crosscheck] sft/train.jsonl          7525 rows

    [crosscheck] rows 9016  identity 4508  with-edits 4508
    [crosscheck] gold edits 15854  unparseable gold lines 0
    [crosscheck] applier accepted every edit on 9016/9016 rows, 0 rejections total
    [crosscheck] re-derivation: 15854 edits over 9016 rows, 0 pairs the contract refuses

    [crosscheck] IDENTICAL — zero differences

That is 9,016 `parseEdits` + 9,016 `formatEdits` + 9,016 `applyEdits` (text,
`ok`, `applied`, rejection list) + 9,016 `deriveEdits` comparisons, over 15,854
gold edits, with zero differences.

## The harness was checked against a known-bad port

`LIMITS.MERGE_GAP` was changed from 6 to 5 in `src/ocr/edits.ts` and the
crosscheck re-run over the eval split alone:

    DIFF LIMITS.MERGE_GAP: 6 vs 5
    [crosscheck] FAILED — 81 row differences, 1 constant differences

The first reported row shows the ported derivation splitting
`l’ your.own exeellent-r → l your own excellent r` into two narrower edits — a
change invisible in the applied text and fatal to the trained-against format.
The mutation was reverted and the full run above was repeated from the reverted
file.

## Tests

    bun test test/ocr        # or: node --test, after transpiling

| File | What it holds |
|---|---|
| `edits.test.ts` | the self-test from the bottom of `edits.mjs`: 11 derive→format→parse→apply round trips, 10 adversarial applier cases that assert the text survives, 2 derivation refusals, and the hyphen-JOIN invariant |
| `contract-crosscheck.test.ts` | the contract invariants from `tools/galley/contract-crosscheck.mjs` over a committed 120-row gold fixture |
| `fixtures/gold-rows.jsonl` | 120 real gold rows (60 identity, 60 with edits), sampled at a fixed stride from `galley/sft/eval.jsonl` |

32 tests, all passing.

### What was NOT ported, and why

BookForge's `contract-crosscheck.mjs` also runs the gold edits through
`electron/ai-cleanup-prepass.ts` `applyEditList` — a *different* contract with
nine semantic guards, a MULTI path, a fuzzy ladder and word-boundary
lookarounds — and found it landed only 18.6% of gold edits, because 72.5% of
gold anchors sit mid-word. That applier is BookForge's AI-cleanup path and is
not moving to Foundry, so there is nothing here to run it against.

What survives is the half that is about the contract itself: anchors present
verbatim, anchors unique, zero applier rejections on gold, wire-format round
trip — plus the mid-word measurement that explained the 18.6%, kept as a test so
that anyone who ever adds a word-boundary guard to *this* applier sees it go red
on the spot rather than losing recall silently.

### Hyphenation

There is no hyphen logic in `edits.ts`, and that is the point: a JOIN happens in
the corpus builder, on text that exists, and completion — asking the model to
finish a word whose other half is on the next line — is generation. The
`hyphen wrap kept` round trip and the `a line-wrapped hyphen is never completed`
test hold that line: derivation refuses to produce an anchor spanning the wrap,
and an invented `inter- → international` is rejected by the applier because the
anchor does not occur.
