# blocks encoder — replay verification

`src/blocks/encoder.ts` is a MOVE of BookForgeApp
`src/app/features/pdf-picker/services/rubric-encoder.ts` (MIGRATION §1). Symbols
were renamed rubric→blocks; nothing about what the module emits or accepts was
allowed to change. This file is the record that it did not.

## The harness

    node tools/replay-blocks.mjs

Both encoders are compiled by the same transpiler, in the same mode, into a temp
directory, and then driven over the same inputs — so a difference cannot be an
artefact of how one side was built. Requires `typescript` to be resolvable
(`npm i --no-save typescript`, or run under bun).

Input is the real labelled corpus at `/Volumes/Callisto/training/rubric/`, not a
fixture: each book's `labels.json` (the labelling session, already in `TextBlock`
shape). A book without one is read from `blocks.json` and converted exactly as
BookForgeApp `tools/rubric-detect-corpus.js` `sessionFromBlocks()` converts it.

Compared per book × per prompt version, all exact:

| What | Why it is in the diff |
|---|---|
| encoded page count + page numbers | a page silently dropped is a page never labelled |
| `blockIds`, in order | the answer is keyed by 1-based prompt position |
| `system` turn | the class list is interpolated into it; order is part of the string |
| `user` turn | every block line — geometry, ratios, the clipped text |
| `toRawPrompt()` | the actual bytes that go to `/completion`, think block included |
| `parseAnswer()` | driven by the book's own gold labels, so the per-version legal-class set is exercised |
| `RUBRIC_STOP` vs `BLOCKS_STOP` | same string value |
| `rubricCategories(v)` vs `blocksCategories(v)` | v0..v7, including the out-of-range ends |
| `rubricVersionFor()` vs `blocksVersionFor()` | 12 ids, including `foundry-blocks-v1-4b` and an id with no version |

## Result — 2026-08-01

Command: `node tools/replay-blocks.mjs` (defaults: 5 books, versions 1,2,3,4,5,6)

| Book | Source | Blocks | Encoded pages | PDF pages |
|---|---|---|---|---|
| michelle-remembers | labels.json | 3,091 | 326 | 360 |
| rise-and-fall | labels.json | 9,381 | 1,040 | 1,040 |
| himmler-a-life | labels.json | 17,198 | 1,052 | 1,052 |
| siege-of-budapest | labels.json | 6,013 | 501 | 522 |
| deathstalker-rebellion | labels.json | 4,745 | 513 | 516 |

Totals across the 6 prompt versions:

    20,592 page encodings
    20,592 raw prompts
   242,568 block lines
    20,592 parsed answers

    IDENTICAL — zero differences

(Encoded pages < PDF pages where a page carries no blocks: `encodeBook()` skips
those, in both implementations, identically.)

## The harness was checked against a known-bad encoder

A verification that never fails is not a verification. One space was added to
the v2/v3+ block line (`q<conf> ` → `q<conf>  `) in `src/blocks/encoder.ts` and
the harness was re-run over one book at one version:

    [replay] FAILED — 652 page differences, 0 export differences

652 = 326 pages × 2 (the `user` turn and `toRawPrompt`). The mutation was
reverted and the full run above was repeated from the reverted file.
