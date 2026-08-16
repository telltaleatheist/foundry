# The renderer's visual language — the proof sheet on the bench

Companion to RENDERER.md. **This file is law for the renderer's appearance**:
an implementing agent copies these tokens and specs verbatim and invents
nothing visual. Where a case is not covered, the rule is: chrome lives in the
gutters and backgrounds, never in the text column; and nothing moves the text.

## 0. The concept

Foundry's user is not reading a book, they are working on one. So the surface
is not a reader and not a form — it is a **proof sheet on a dark workbench**:
a warm paper column floating on the app's dark chrome, with the instrument
markings (rails, chips, flags, rules) living in the paper's own gutters. At
rest the page is quiet and beautiful — a book. The closer your pointer gets,
the more instrument it becomes. Every mark uses the vocabulary of print
correction: inks, rules, cancel marks, marginal flags — never web-app borders
around paragraphs. The current outlines ("sloppy and ugly" — user) die with
the iframe.

Two registers, one toggle:

- **Workbench** — the working view. Paper + gutters + chrome.
- **Edition** — the export preview. The same replay with ALL chrome removed
  and the export stylesheet applied: struck blocks absent (a struck note's
  number cut from the prose with it — the number belongs to the note, §0
  ruling 9), live refs demoted to plain superscripts,
  measured typography. It should feel like the finished book because it is
  exactly the finished book.

## 1. Tokens

Declared once on the book surface's host (`.bench`); everything below uses
them. The app shell keeps its existing dark variables; these are the paper's.

```css
/* the bench (inherits the app's dark canvas behind it) */
--bench:        var(--bg-base, #191817);

/* the paper */
--paper:        #f6f1e7;   /* warm ivory — archival, not white */
--paper-high:   #fbf8f1;   /* hover tint base, chips */
--ink:          #211d16;   /* warm near-black, body text */
--ink-muted:    #6f6659;   /* secondary: page ghosts, hints */
--ink-faint:    #a99f8f;   /* hairlines, resting gutter marks */

/* instrument inks */
--ink-select:   #3b6ea5;   /* archival blue — selection, marquee */
--ink-strike:   #a23b2a;   /* iron red — the cancel mark */
--ink-chapter:  #2f7d4f;   /* spruce — structure: chapter rules and chips */
--ink-note:     #8a5a2b;   /* sienna — footnote markers and ordinals */
--ink-flag:     #b98a1c;   /* amber — something needs a decision */
--ink-edit:     #2f7d4f;   /* editing shares spruce: growth, not warning */

/* geometry */
--gutter:       3.25rem;   /* interior gutters where ALL chrome lives */
--rail-w:       3px;
--radius:       3px;
--shadow-paper: 0 1px 2px rgb(0 0 0 / .4), 0 12px 48px rgb(0 0 0 / .28);

/* motion */
--ease:         cubic-bezier(.2, .7, .3, 1);
--t-fast:       120ms;
--t-med:        180ms;
```

Category inks come from the ONE existing table (`shared/categories.ts`
colours) — never a second palette. They are used only as rails/tints/chips,
always at the alphas below, so the page never turns into confetti.

## 2. The paper

- Column: `width: min(46rem, 92%)`, centered on the bench, `padding: 4.5rem
  var(--gutter) 6rem`, `border-radius: 2px`, `background: var(--paper)`,
  `box-shadow: var(--shadow-paper)`. One continuous sheet — the book flows;
  chapters are rules on the sheet, not separate cards.
- Body type: the book speaks serif, the app speaks sans. Stack:
  `'Iowan Old Style', 'Palatino Linotype', 'Book Antiqua', Georgia, serif;`
  `font-size: 1.05rem; line-height: 1.62; color: var(--ink);` text rendering
  `optimizeLegibility`. Headings/captions/quotes/footnotes take the measured
  em ratios from the book's stylesheet rules (typography.ts) — the renderer
  states sizes per category exactly as the cast did: one size per category,
  nothing per block.
- Paragraphs: `text-indent: 1.4em`, no vertical margins between body blocks
  (print convention); first paragraph after a heading unindented.
- The bench shows above and below the sheet (`padding-block: 3rem`) so the
  paper reads as an object, not a fill.
- Scrollbar: thin (8px), thumb `#3a3733`, on the bench not the paper.

## 3. Block chrome (the heart — get this exact)

The text column NEVER reflows from chrome. Rails and chips sit in the gutters
(absolute, `left: calc(var(--gutter) * -1 + 0.9rem)`-style positioning inside
a relatively-positioned block host); tints are backgrounds that bleed slightly
past the text into the gutters (`margin-inline: -0.9rem; padding-inline:
0.9rem`) with `border-radius: var(--radius)`.

- **Rest:** nothing. Plain beautiful text.
- **Hover:** background `color-mix(in srgb, <category-ink> 5%, transparent)`
  and a left rail `var(--rail-w)` wide, `<category-ink>` at 60%, rounded,
  inset in the gutter. Transition `background var(--t-fast) var(--ease),
  opacity var(--t-fast)`. No cursor change (default), no outline anywhere.
- **Selected:** rail at 100%, tint at 9%, plus a **margin chip**: category
  name in 10px/600 small-caps tracking `.06em`, category ink on
  `--paper-high`, 1px hairline border in the ink at 35%, radius 999px,
  sitting in the LEFT gutter aligned to the block's first line. Multi-select
  shows one chip per block; the marquee is `--ink-select` at 12% fill,
  1px solid at 55%.
- **Struck:** the proofreader's cancel. `opacity: .45; text-decoration:
  line-through; text-decoration-color: color-mix(in srgb, var(--ink-strike)
  55%, transparent);` plus the X — two thin diagonals drawn as background
  linear-gradients in `--ink-strike` at 50%, `mix-blend-mode: multiply` so
  the mark sits ON the paper like ink. On strike, the X fades/scales in over
  `var(--t-med)`; on restore it lifts. The mark shows ALWAYS — struck is a
  state of the document, not of a mode (landed rule).
- **Editing:** caret in the block, rail and tint in `--ink-edit` (spruce),
  tint 7%. No boxes, no visible textarea — the block itself is the editor.
- **Focus-visible (keyboard):** 2px `--ink-select` outline, offset 2px — the
  one permitted outline, for accessibility, keyboard-only.

## 4. Structure marks

- **Chapter rule:** a full-column rule where a chapter starts — `border-top:
  2px dashed color-mix(in srgb, var(--ink-chapter) 65%, transparent)` with
  `2rem` of air above and `1.25rem` below — carrying a **chapter chip** on the
  rule at the left gutter: spruce ink, `--paper-high` ground, hairline spruce
  border, the chapter title in 11px/600. Dragging a rule lifts it
  (`--shadow-paper` reduced, cursor grabbing) and candidate seams between
  blocks glow as 2px spruce lines at 35%; drop animates the rule into place
  over `var(--t-med)`. Double-click the chip to rename in place.
- **Page ghosts:** in the RIGHT gutter, at each block where a new source page
  begins: `≈ 14` — 10px, `--ink-muted` at 65%, italic. The ≈ is the design:
  pages are estimates and the type says so. Hovering a ghost hairlines the
  blocks it spans (`--ink-faint` rail) — the one place page provenance is
  visible, and it is deliberately a whisper.
- **Seams (unjoined page turns):** between the two blocks, centered, a
  ghost control: `··· join ···` in 10px small-caps `--ink-muted`, hairline
  rules either side, `opacity: 0` until either neighbour is hovered, then
  `.85`. Click = the join op: the blocks slide together over `var(--t-med)`
  and the seam evaporates. This is the fix for the "4 page turns left as two
  paragraphs" report — the report becomes a control.
- **Note markers:** a reference number renders as a real element: sienna,
  raised, `padding: 0 .18em`, radius `.45em`, hairline sienna underline on
  hover. Hover a marker → its note gains the hover tint; hover a note → its
  marker(s) do. Click either → smooth-scroll to the other with a 600ms tint
  pulse. **Unlinked** marker or note: `--ink-flag` dotted underline + an
  amber dot flag in the right gutter that expands on hover to a pill naming
  the problem ("no note carries this number"). Deleting a note strikes its
  markers with it — derived, animated together.
- **Footnote rows:** set at the measured footnote ratio, separated from the
  body by a short hairline rule (`4rem` wide, `--ink-faint`) above the first
  note of a page-group, sienna ordinal in the gutter.

## 5. Panels and overlays

Panels (Notes, Furniture, Chapters) live in the app shell and keep its dark
style — the paper vocabulary stays on the paper. Additions:

- Counts as quiet badges (existing `.count` style). Flag counts in
  `--ink-flag` when nonzero.
- **Furniture review:** each dropped running head as a row — slate glyph,
  the text, page ghost — with "restore" on hover. Restoring animates the
  block back into the flow.
- The **Edition toggle**: a two-segment control in the book toolbar,
  `Workbench | Edition`, styled like the app's existing acts. Switching
  crossfades the sheet over `var(--t-med)`: chrome and gutters fade, struck
  blocks collapse (height animates to 0), demoted refs re-render. Edition is
  read-only; any edit gesture flips back to Workbench with the block focused.
- Loading: the empty sheet with `Opening the book…` centered in
  `--ink-muted`; no spinners on paper. Errors render as main's own sentence
  on the sheet, never a toast.

## 6. Motion rules

- Durations: `--t-fast` for hover/tint, `--t-med` for anything structural
  (strike, join, drag-drop, edition crossfade). Easing always `--ease`.
- Movement is meaningful only: things that BECOME one thing slide together;
  things that leave the document collapse; nothing bounces, nothing floats.
- `prefers-reduced-motion: reduce` → all transitions `0ms`, no slides — the
  states must read perfectly as stills.

## 7. What is forbidden

- Outlines or borders around text blocks in any resting or hover state.
- Layout shift from chrome, ever. Chrome is gutters + backgrounds.
- A second category palette, a second serif stack, ad-hoc hexes. Tokens only.
- Spinners, toasts, badges-with-numbers-in-red — this is an instrument,
  not a dashboard.
- Filenames or paths anywhere on the paper (house rule).
