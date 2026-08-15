# Next work — a skeleton to flesh out

Draft, 2026-08-15. Assumes the step ledger as built (`docs/STEP-LEDGER.md`,
commits `e7cba53`, `f46e06d`, `e53435c`, `444a941`).

**§1, §2, §4 and §5 are superseded** — designed to build depth, open questions
resolved, in `docs/BANK-LIFECYCLE.md` (banks swap on success, the queue names
the cost, one bank path per step) and `docs/TRANSLATION-STEPS.md` (the
translation bank is question-keyed, so curation stays on the reading and a
translate-descended Generate is a two-stage replay). The sections are kept
below as the record of what the questions were; the answers live there.

---

## 1. Bank replace-on-success

**The rule, already settled:** a re-run replaces a step's payload, and *the old
payload is destroyed only after the new run succeeds*. No `archived-<stamp>/`
hoards accumulating in a project folder.

**Today:** a fresh read archives the old bank up front, so a run that dies at
page 9 of 17 has already moved the good bank aside. The overlay-archiving
machinery leans on that current behaviour, which is why this needs care rather
than a quick swap.

**Shape:** the engine writes into a pending bank beside the real one and renames
it into place only when the run completes — all pages landed, completion marker
written. A dead run leaves the old bank untouched and the pending file as
resumable debris. The engine owns it, so the CLI is safe too, not just the app.

**The asymmetry to preserve:** banks swap-and-destroy (machine output you chose
to replace); overlays and curations are archived forever (labour, and future
fine-tune labels). The retention rule already draws this line.

**Open:**
- What happens to a *resumed* run's pending bank if the parameters changed
  between attempts?
- Does the pending bank participate in `orphanedPayloads` reasoning?

---

## 2. Queue confirm on re-run

The other half of the same feature: the confirm names the cost **before** the
job is enqueued.

Now that the ledger exists it can name real things: "this replaces the 17-page
reading, and marks stale your 2 saves and the English translation" — by name,
from `markStale`'s own answer, not a count invented in the dialog. No reading
yet → no confirm. And because the swap is on-success, the confirm is honest:
nothing is lost if the re-run fails.

**Open:**
- Does a re-run that will *branch* rather than replace (different skip-pages,
  per the identity rule) get a confirm at all? It costs GPU but destroys
  nothing. Probably a quieter one, or none.

---

## 3. Step compare, side by side

Pick a step, open its rendering in the second pane beside the current one —
original beside translation being the case the user described.

**Leaning:** compare is a *view*, not a position move. The comparison pane is
read-only and does not disturb where the user is standing, because moving the
pointer is what decides Generate and what the editor edits.

**Open:**
- Is it invoked from the step row, or from the pane?
- Does closing the comparison restore anything, or is it just a pane close?
- Block-level alignment between two renderings is a much larger feature —
  explicitly out of scope unless the user asks.

---

## 4. Translation as a generatable step — and the question it opens

**The user's model, in their words:** a translation is stored as a ledger entry
the user can generate from whenever they like, so ten translations means ten
steps and ten EPUBs on demand. Their walkthrough: translate → click the
translation step → Generate produces the translation; then strike some blocks
and commit → click *that* entry → Generate re-renders with the stricken items
removed.

**Also settled: no step picker on Generate.** Generate always renders the step
currently selected — the ledger row *is* the picker. Revert is clicking step 0
and generating. This is already how the built code behaves; the picker I had
proposed is cancelled. (The dialog still *naming* which step it is about to
render is worth keeping — a statement of fact, not a choice.)

**What is actually missing:** rendering *from a translate step* was explicitly
scoped out of the phase-2 wiring. Standing on a translate step today falls back
to its nearest ancestor with a curation. So the work is: the translation's bank
becomes a real render source, and Generate reads it when that is where the user
stands.

**THE OPEN QUESTION, and it is the important one.** The user's scenario puts a
**curation on top of a translation**. That needs an overlay bound to the
*translation's* bank — but overlays today are keyed to the **reading**'s
generation. Options, unexplored:

- Overlays become per-bank rather than per-reading, with a translate step's bank
  carrying its own generation. Cleanest conceptually; touches the generation
  binding, the archiving-on-mismatch machinery, and `curationInEffect`'s
  stop-at-a-reading walk.
- Or curation stays reading-only and strikes always apply upstream of
  translation — which contradicts the user's walkthrough, so probably not.

Related, and settled enough to state: **strikes made before a translation are
baked into it**, because translating while standing on a curation takes the
curated rendering as input. That is already the position model working
correctly, and it is worth confirming with the user that it is what they expect.

**Also needs solving:** two renderings from different steps must not share an
output path. A translation's file is composed from stem + language tag and
knows nothing about the ledger, so two translations into one language from
different parents collide — which is exactly the before-strikes / after-strikes
pair in the user's own example.

---

## 5. Carried over: one bank path per project

Flagged during the ledger build, unresolved, and it belongs with §1 because both
are about where a payload lives.

A re-read with different skip-pages now *branches* by design — but there is one
bank path per project key, so the older read step names a bank that was archived
out from under it, and clicking that row renders the newer reading.
`orphanedPayloads` defends the worst consequence (a delete will not destroy a
bank a surviving step still needs), but the row still lies.

The real fix is distinct payload paths per step. That is an on-disk layout
change, so it wants a decision rather than an improvisation — and it is the same
shape as the translation-collision problem in §4.

---

## 6. The undo stack stops persisting — commits are the durable history

**The user's proposal (2026-08-15), and it is right:** the undo/redo stack goes
back to being in-memory and starts fresh on every document open. Committing to
the ledger is how a state becomes durable.

**Why it is right, stated plainly:** two mechanisms for "go back" is one too
many, and they conflict at exactly one place — moving between steps. A persisted
undo row names an element and a field and replays a setter; replayed against a
different step's state it is nonsense. Making the stack session-scoped removes
the conflict by construction rather than by defending against it.

**What is NOT lost, and this is the part that makes the trade cheap:** the live
overlay still persists. Close the app mid-edit and every correction is still
there on reopen — what ends is the ability to *step backwards through them one
at a time*, replaced by stepping back to a commit. Fine-grained undo within a
session, coarse-grained restore points across sessions.

**What it deletes:** `overlays/<key>.ledger.json` and its read/write path, the
archive-the-pair logic, ledger serialisation in `app/shared/overlay.ts`, and the
generation-mismatch handling for the ledger specifically. The fine-tune plan is
untouched — the labels live in the overlay, never in the undo stack.

**Refinement worth taking:** "fresh on every document open" should also mean
fresh when the underlying overlay identity changes — a re-read mints a new
generation and archives the overlay, and a stack that outlived it describes a
thing that is gone. But it does **not** need to reset on every position move:
standing on a frozen save is read-only (`curation-lock.ts`), so the live overlay
cannot change while the user is away from it. Peeking at an old save and coming
back can keep the undo history, safely, by construction.

**The caution — `history.ts` is a different animal.** There are two persisted
histories, not one:

- `overlays/<key>.ledger.json` — PDF block curation. Commits exist here, so the
  proposal lands cleanly.
- `history/<working tree name>.json` — the EPUB text editor, which the user
  **explicitly asked for** ("open a project, edit a file, have Foundry die
  randomly, and still be able to press Ctrl+Z"). EPUB text edits have **no
  commit or step equivalent yet**, so dropping persistence there is a pure loss
  with nothing to replace it.

So this change applies where commits exist. `history.ts` keeps persisting until
EPUB edits become steps of their own — which is a real gap in the step model
worth naming separately: editing a book's HTML is user labour, therefore
irreplaceable, therefore ought to be a retained step.

**Settled (user, 2026-08-15): closing with uncommitted corrections asks.** Not a
passive dot — a dot teaches you after the loss. It routes through the close
question that already exists (`api.confirmClose`) rather than stacking a second
dialog, and it offers to commit and then close, because "cancel, hunt for Save,
close again" is the app making the user do its job. No auto-commit: that would
spam the ledger with rows nobody chose.

**The sentence must not lie.** "Unsaved changes will be lost" is false here —
the live overlay persists and every correction is still there on reopening. What
is at stake is the ability to come back to *this* point: a restore point never
made. Being built now, ahead of the undo change, because it is correct either
way and it is what makes that change safe.

---

## Suggested order

§1 and §2 together (one feature, two ends), since they release the
`readings.ts` open/archive lifecycle that has been on hold. §5 folded in, since
it is the same question about payload paths. Then §4, which is the biggest and
has a live design question in it. §3 last — it is the least entangled and the
most self-contained.
