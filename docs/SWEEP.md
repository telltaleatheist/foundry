# The Sweep — a census of a pattern, verdicted, landed as pending edits

Wave 45. Ruled by Owen on 2026-08-22, from the design canvas "The Sweep"
(directions A and B were drawn; **A — the census modal — was chosen**:
*"ya, lets do the census modal"*). His ask, verbatim:

> "give me the ability to detect things in parentheses, light them up, and
> strike them selectively. maybe line them up in a list and i scroll through
> and click what i want to keep or delete from the blocks. theres a lot of
> (see sandoval p. 170), etc. stuck in this one book. and there was a case
> where footnotes were read as: '>3<...' for some reason. maybe i should be
> able to regex search for something, have it listed in the list, and
> selectively delete/keep them as well. maybe this happens in a modal, and
> when i hover, it shows me surrounding context. i can strike all and then
> selectively unstrike or i can keep them all unstruck but select what goes."

Two workflows, one mechanism: a pattern finds spans, every span wears a
verdict, one act lands the verdicts. The sweep is **a faster hand, not a
second editor** — every landing it makes is a landing the double-click
editor or the Delete key could have made by hand, through the same doors.

---

## §1 What it rides — nothing new below the modal

- **A span cut inside a block is a `text` op** — the block's current source
  string with the chosen spans sewn out (`TextOp`, `app/shared/ops.ts`).
  No new op verb: a first-class "cut this range" op was considered and cut
  on the canvas — `text` already says it, replays it, and every downstream
  consumer survives it unchanged. Two spellings of one edit is the house's
  oldest defect.
- **A match that empties its block is a `strike`** — the block stays in the
  document, cancelled, restorable. Never an empty `text`.
- **Staging goes through the stack's public door**: `BookStack.push(ops)`
  (`app/src/app/core/book-stacks.service.ts`), reached via
  `bookStackFor(tabId)`. One variadic push carries the whole sweep, exactly
  as `strikeSimilar` pushes its N strikes. The pending sidecar
  (`ops/pending.jsonl`), the tray's waiting count, Apply, Discard, and the
  Discard/Apply guard card all see the sweep's ops as what they are:
  ordinary pending edits. None of them changes.
- **Opening the sweep needs no unapplied guard.** The guard protects acts
  that consume the ledger or move the position — acts that would run
  against a book missing its pending ops. The sweep only stages MORE
  pending ops onto the same viewer at the same position. No
  `clearedHere` call, no confirm.

## §2 The rulings

*(Read with §6 — the build corrected four details, each argued in the
code where it lives.)*

1. **A sweep is a pattern over the book's current text.** The match source
   is `view().rows` — the replayed rows with the recorded chain AND the
   pending stack already in them, on whichever pass the workbench stands.
   Rows already struck are shown ghosted in the census, take no verdict,
   and count for nothing. Matching is per block; a parenthetical the OCR
   split across two blocks is a seam problem, not a sweep problem, and the
   sweep does not pretend otherwise.
2. **Two preset chips and a free field.** `( parentheses )` is
   `/\([^()]*\)/g` — innermost pairs only, the cost named in the modal's
   own copy if it ever bites. `[ brackets ]` is `/\[[^\[\]]*\]/g`. The free
   field takes the person's own pattern (`>\d+<` catches the misread
   footnote numbers), compiled global, with a case-sensitivity toggle.
   Exactly one pattern is active at a time; changing it re-scans and
   resets every verdict, because a verdict belongs to a match and the
   matches are new. A pattern that does not compile refuses in a sentence,
   in place, under the field — never a throw. A pattern that matches
   emptiness is refused the same way ("that pattern matches nothing at
   all — it would select the whole book"): zero-length matches are not
   walked past silently, they are named.
3. **The stance is the starting verdict, spelled as bulk verbs.** Every
   fresh scan starts with every match **cut** — Owen's first workflow
   (strike all, selectively unstrike) is the default posture. The footer
   carries `Keep all` and `Cut all`, which is the second workflow and the
   flip in one pair of buttons. Every row click after that flips one
   verdict.
4. **The preview never lies.** A row quotes its sentence with the span
   drawn in the proofreader's cancel when cut (the same red the workbench
   strikes with) and held in the amber flag when kept. Hovering a row
   shows the block's fuller text — as a floating glance beside the row,
   never by swapping it into the row, because a row that grows under the
   pointer moves the verdict a hand is travelling toward (user ruling,
   2026-08-24: *"lets make it so the keep/cut lines dont change sizes
   when i hover… the button keeps moving around"*). What the row shows
   cut is exactly what the landed op removes, seam and all.
5. **The seam is sewn, locally.** Removing a span must not leave the
   sentence bleeding: at each cut point, if whitespace stands on both
   sides, one survives; if whitespace stands to the left and a closing
   punctuation mark (`.` `,` `;` `:` `!` `?` `)`) opens the right, the
   whitespace goes; a block's leading/trailing whitespace after all cuts
   is trimmed. Mending is LOCAL to each seam — the sweep never reformats
   text it did not touch. Multiple chosen spans in one block are cut
   right-to-left and land as ONE `text` op.
6. **Landing is one gesture; undo follows the house rule.** The landing
   verb says its counts before it is pressed — `Cut 143` — and lands the
   whole sweep in one variadic `push`. Undo then takes it back **one op at
   a time**, exactly as it takes back `strikeSimilar`'s forty strikes —
   the stack's documented behaviour, kept deliberately: the modal itself
   is the retreat, because nothing lands until the verdicts have been
   seen, counted, and pressed. (The canvas's "one Undo takes all of it
   back" is AMENDED here, out loud, to match the stack the app has.)
7. **On a translated pass, the sweep does what the hand does.** A text
   edit on a translation is not an op — it is a per-language record
   correction (`correct()`, one in flight at a time; an op would mint two
   truths, `book-view.component.ts` ~4928). So: matches are scanned over
   the translated rows; span cuts land as SERIAL corrections with the
   modal showing progress ("Cutting… 40 of 58 blocks") and finishing or
   refusing per block by the correction door's own rules; whole-block
   strikes stay ops and ride the same push as on source. Corrections are
   not on the undo stack — they never were, by the editor's own rule —
   and the modal's landing copy on a translated pass says "corrected",
   not "waiting to be applied", for the spans, while the strikes wait
   like any pending op.
8. **A cut that crosses an inline marker inherits the hand's behaviour.**
   A `text` op replaces the source string, markers and all — exactly what
   a double-click edit does today. The sweep adds no special case.

## §3 The surfaces

- **The dialog** is idiom (a): a `SweepDialogComponent` mounted in the app
  shell under `@if (ui.sweepOpen())`, opened by `ui.openSweep()` through
  `only()` (one dialog at a time), scrim + card at z-index 1200, the
  confirm card keeping its 1300 so the guard can still draw over
  everything. It finds its book through the active document tab →
  `stacks.bookStackFor(tabId)`, and reads text only through
  `stack.view()`.
- **Anatomy, per the canvas:** a sweep bar (two preset chips, the pattern
  field, the live count) · the census list (each row: block id + ≈page,
  the quoted sentence with the span lit, a CUT/KEEP toggle) · a footer
  (counts in both inks, `Keep all` / `Cut all`, the landing verb naming
  its number). The list is the modal's scrolling body; no silent cap —
  every match is a row.
- **A row travels.** Clicking a row's block-id chip closes the sweep and
  `reveal`s the block on the paper — the peek card's own travel gesture,
  pulse and all. The verdicts survive in the modal's state only while it
  is open; the sweep is a sitting, not a document.
- **The tile** lives in the action grid's acts, hand-written in document
  order like its neighbours, disabled-and-visible when no open book pane
  answers (`canSweep()`: active document tab with a registered book
  stack). Working label: **Sweep** — title copy names what it does:
  "Find a pattern across the book — parentheses, brackets, or your own —
  and cut or keep each match." It does NOT navigate home first: the sweep
  is about the book that is open, not a global act.
- **After landing** (source pass): close, toast the fact in the tray's own
  language — "Cut 143 across 58 blocks — waiting with your other edits."
  The tray's Apply flow is untouched and is where the ops become the
  book.

## §4 Deferred out loud

- **Saved/recent patterns** — the field starts empty each sitting; a
  memory of patterns is its own small feature, wanted only if the same
  regex keeps being retyped.
- **Multi-pattern stacking** (parentheses AND brackets in one census) —
  one pattern at a time until a real book demands otherwise; run two
  sittings.
- **Batch undo** — if per-op undo of a large sweep ever actually bites,
  the fix is a gesture marker on the stack, designed then, not smuggled
  in now.
- **Cross-block matches** — refused by ruling 1; the seam gesture (join)
  is the door for that defect class.

## §5 Verification

The five gates, as every wave: `bun test` zero-fail, root `bunx tsc
--noEmit`, `tsconfig.electron.json`, `tsconfig.app.json`, `bunx ng build`
(500kB budget warning pre-existing), raw-control-byte scan. No new tests
unless an existing one is invalidated. The builder reports divergence
before landing, not after — §2.7 (the translated-pass correction loop) is
the one place a narrower landing may be argued for, and the argument comes
back to the lead before it is built narrower.

## §6 Corrected by the build (2026-08-22) — the contract as landed

The wave was built whole, §2.7 included. Four details of this contract
met the code and lost, each argued in a docblock where it is built:

1. **A shelved row is not swept** (refines §2.1). A shelved block is in
   `view().rows` and not in the flow: not on the paper, `reveal` cannot
   travel to it, no edition emits it. A census row for one would be a
   verdict about text nobody can see, landing an op nothing draws. The
   Furniture panel is that population's surface. (`scan`,
   `app/src/app/core/sweep.ts`.)
2. **The verdict inks are the shell's roles, not the paper's pigments**
   (refines §2.4). `--ink-strike`/`--ink-flag` are declared on the book
   viewer's own host, mixed for a cream sheet; the same hex on the
   chrome's charcoal is ~2:1 and unreadable. The card carries the ROLE
   across — `--sweep-cut: var(--error)`, `--sweep-keep: var(--warn)`.
3. **A view-only tab is refused at the tile and again in the card** (adds
   to §3). The viewer's `push` refuses an export view with a sentence —
   but by then the card would have closed and toasted the cuts, which is
   user copy lying. `canSweep()` and the dialog's own shut sentence both
   answer first.
4. **The seam keeps a newline over a space** (refines §2.5's "one
   survives"), because a line break inside a block is structure a person
   can see; and every mend is given a FLOOR — the end of the next span
   still waiting — so a left-reaching deletion can never shift the
   offsets of a cut not yet made. (`mend`/`cutSpans`,
   `app/src/app/core/sweep.ts`.)
