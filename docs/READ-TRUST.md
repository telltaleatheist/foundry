# What the reader believes, and when it refuses

Opened 2026-08-20, from a defect Owen found in live use. This file is the
plan of record for ONE question: **when is the model's answer about a page
not the page?** The read itself is designed elsewhere; this is about the
answers that come back wrong in a way no character-error measurement sees,
because the model was not reading — it was writing.

The rule this file exists under is Owen's, said in the same breath as the
report and treated as absolute:

> "its doing a fine job with everything else so i dont want to cripple its
> other work"

So every instrument here is judged first on **what it costs a healthy
page**, and an instrument whose cost to a good page is not provably zero
does not land.

---

## 1. The report (Owen, live, 2026-08-20)

> "dots runs away when a page is a bad scan with bleed through from the
> other side of the page. like if michelle remembers' blank page was
> photographed, but there was writing on the other side, it tries to
> decipher it but just throws out nonsense and goes on for 25,000
> characters. any way we can cap that / build in a hallucination
> protection for blank pages?"

A page with almost nothing on it is the lowest-signal input the reader
ever meets, and a model given nothing to transcribe will transcribe
something. The failure is not that it read the bleed-through badly. It is
that having started, it did not stop.

---

## 2. What was already there, read from the source before anybody designed

- `models.ts`, `dots-ocr`: **`maxTokens: 8192`**, and its docblock says why
  it is high — a dense index page ran past 4096 and came back truncated.
  *"The cap is not a budget, it is a stop for a model that has started
  repeating itself, so it is set where a real page cannot reach it."* The
  same note records the measured band: **no page of any book read that day
  went past 1,700 tokens.**
- `read.ts`: `finishReason === 'length'` → **refuse** (recorded unreadable,
  with a reason, not landed in the book). Empty text → **refuse**.
  Anything else → the text is **accepted as the page**.

**So there is a stop, and there is a gap.** Roughly 1,700 tokens of real
page against an 8,192-token cap, and everything in between is currently
believed. 25,000 characters is about 6–8k tokens: inside the gap, near the
cap. Which side of the cap it landed on decides which defect this is, and
that is a measurement, not a design (§5).

**THE CAP IS NOT THE LEVER.** Lowering it to catch this is the one fix
Owen's constraint forbids: it is high on purpose, and it would trade a real
dense index page for a fake blank one. Nothing below proposes touching it.

---

## 3. The blank-page pre-filter is CLOSED (ruled 2026-08-20, from P2's scoping)

Owen asked for blank-page protection by name. It is the wrong instrument,
and the reason is structural rather than a matter of tuning.

**BLEED-THROUGH AND A FAINT REAL PAGE ARE THE SAME PIXELS.** They differ by
MIRRORING and POSITION, not by INTENSITY — and a darkness threshold can
only see intensity. So any line drawn low enough to put bleed-through below
it also puts below it: a chapter opener carrying three words, a plate
caption, a colophon, a dedication, a part title, and every page of any scan
exposed lighter than the book the threshold was calibrated on. The band
between "faint enough to be bleed-through" and "faint enough to be a real
sparse page" is not a constant of the world; it is a constant of one
scanner on one day.

And the asymmetry that settles it:

| | must be right about | fails by | testable against |
|---|---|---|---|
| **blank pre-filter** | every healthy page, in every book, forever | **DELETING a page** | nothing — there is no bank of pages that *should* have been skipped |
| **degeneration post-filter** | text that has already been generated | keeping a bad page | the bank Owen already has |

A pre-filter is a promise about all future scans made from one book's
exposure. A post-filter only has to be right about words already on the
page, and a healthy page never repeats itself two hundred times, so its
cost to a good page is **zero by construction** rather than by calibration.

**What would actually separate them, recorded so it is not re-proposed as
cheap:** asking whether the ink is MIRRORED — correlating the page against
a horizontally flipped facing page. That is a real image operation, it
needs the neighbour, and it is far more than this defect earns. Deferred
out loud, not dismissed: if bleed-through ever becomes a population rather
than a page, this is its instrument.

### 3a. The ink facility is dead, and this is not its resurrection

Scoped by P2 and worth writing down because the dots notes still advertise
it: **the ink test was removed at `f192c50`** (2026-08-15). What remains is
the two ends with nothing between them —

- `bridge.ts`: the `grayscale` flag still WRITES a PGM beside each PNG, and
  its own docblock says *"IT HAS NO READER LEFT… nothing on this side opens
  one of these files"*.
- `src/scan/pgm.ts`: alive, ~90 lines, **zero callers** — named only in
  three docblocks. `bridge.ts` already records that whoever removes the
  flag should remove the module in the same breath.

It was also a **BOX test, not a page test**: it measured ink inside
dots.ocr's own geometry, so it ran *after* the read by construction. Asking
before the read is a different measurement that merely shares the raster.
(Its threshold was already the 128 midpoint, so it was closer to
contrast-aware than feared — which is exactly why the threshold was never
the obstacle. §3 is.)

**The seam, if pixels are ever wanted before a read:** the endpoint path
renders the whole book first (`read.ts`, `renderOnly`) and hands pages over
as `{ number, imagePath }`, so every PNG is on disk before one page is
sent. The hook is free. The raster is not: either the `grayscale` flag
(reaching across the Python seam, changing what a run leaves under
`--renders`) or a PNG decoder — a dependency this codebase has refused
twice on the record, the same refusal that made the capture mint
hand-write its own PNG encoder.

**Deferred out loud, separately:** the dead `pgm.ts` and the reader-less
`grayscale` flag are cleanup this defect did not create and does not need.
They should go together, in their own commit, when somebody is in that file
for a reason of their own.

---

## 4. MEASURED (P1, 2026-08-20) — the library, read-only: 55 banks, 18,202 pages

The book is **not in the Foundry library at all** — it was read through
BookForge (`foundry-runs/vlm-8c9d7d96132f43e8`, page 1 *"MICHELLE
REMEMBERS by Michelle Smith and…"*), 360 pages, **12 refused**. That is
3.3% of the book and **more than half of every runaway Owen owns**.

### 4a. HIS BOOKS ARE CLEAN. This is a COST defect, not a correctness one

**All 22 runaways in the library are `finishReason: length`** — every one
hit the cap and was refused, at both call sites (`read.ts` refuses in the
banked-replay path and again in the live path before the text can become an
answer). Nothing has ever been accepted as truth. The second defect of §5.1
**does not exist in this library.**

So what a runaway costs is time:

| | |
|---|---|
| 22 refused pages | **3,848 s — 64 minutes of GPU** |
| median refused page | 180.0 s |
| median accepted page | 21.7 s |
| a runaway costs | **8.3× a real page, and buys nothing** |

### 4b. The 1,700-token band is OBSOLETE, and that kills the cap option outright

`models.ts` still claims no page went past 1,700 tokens. **Measured today,
accepted healthy pages reach 7,677 tokens (11,691 chars) — 93.7% of the
8,192 cap**, then 5,615 / 5,069 / 5,047 / 4,909 / 4,783. There is almost no
headroom left, so a lowered global cap trades a real dense page for a fake
one. The measurement kills that option on fact rather than on taste. *(The
stale docblock is itself a defect — the ledger's own class — and is fixed
with the measured numbers.)*

**But inside one book the band is tight.** Michelle Remembers' healthy
pages top out at **1,273 tokens** against runaways at 8,192: a **6.4× gap
within a single book**. A per-book threshold separates it perfectly; a
global one cannot. That asymmetry is the whole design.

### 4c. THREE SPECIES, and the leaning was WRONG

A 12-word window, most frequent occurrence over number of windows:

| species | count | repetition | shape |
|---|---|---|---|
| **phrase cycling** | 9 of 22 | 10.8% – 99.7% | locks onto a sentence, repeats to the cap |
| **whitespace-free stream** | 3 of 22 | scores 0.00% | single runs of 12,233 / 12,239 / **508,930** characters with no space — a word-window measure cannot see these at all |
| **varied invention** | 8 of 22 | 1.58% – 6.22% | 27,000–39,000 characters of *different* nonsense, never looping |

**All eight varied-invention pages are Michelle Remembers.** Its runaways
score 1.58, 1.62, 2.10, 2.12, 2.70, 3.43, 3.55, 4.32% — indistinguishable
from prose by repetition, because the model is not repeating. It is
inventing, at length, without looping.

**So the lead's leaning (§ earlier, degeneration detection) WOULD NOT CATCH
THE BOOK THAT PROMPTED THE REQUEST.** Recorded plainly rather than quietly
revised: it is a real instrument for the other fourteen and the wrong one
for Michelle Remembers.

### 4d. What a signature pair does buy, tested against all 18,202 pages

| | |
|---|---|
| a **6,000-character floor** | leaves 18,122 of 18,202 pages untouched — the ordinary page is never examined |
| worst-repeating *accepted* long page | 0.26% against a 5% threshold — a **20× margin** |
| longest whitespace-free run in an accepted long page | **148 characters** |

**The pair catches 14 of 22 with ZERO false positives across the whole
library.** Safe by measurement, and two-thirds of the job.

---

## 5. The reframe: no post-generation check buys the thing worth buying

P1's own conclusion, and it is right: **the cap already protects the book,
so the only thing left to buy is the 160 wasted seconds — and no check that
runs after generation can buy it, because by then the time is spent.**
Every instrument discussed before this measurement, the lead's included,
was a post-generation test of a defect that is no longer about the text.

So the signal must be read **while the model writes**. Michelle Remembers
makes it concrete: 1,273 tokens is its real ceiling, so a page still
writing at three or four thousand is already lost, with 160 of its 180
seconds still in front of it.

### 5a. Two tiers, and they do NOT have the same evidentiary standing

This is the part that must not be blurred, because §3's standard —
zero-cost *by construction*, not by calibration — applies to one tier and
not the other.

- **TIER 1 — the signature pair, incremental (repetition, whitespace-free
  run).** Zero false positives measured across 18,202 pages, with 20× and
  ~80× margins. A healthy page never repeats itself two hundred times and
  never writes 12,000 characters without a space, so the cost to a good
  page is zero by construction. Catches 14 of 22. **Safe to build on the
  measurement alone.**
- **TIER 2 — the per-book band.** The *only* instrument that reaches
  Michelle Remembers' species, and it is calibration, not construction: it
  says "this page is wildly out of band for its own book", which is a
  judgement a real page could in principle fail. It therefore needs an
  explicit acceptance from Owen, and a failure mode that is **visible**
  (refused-early must say so in different words from refused-at-the-cap)
  and **recoverable** (a re-read must be able to overrule it).

---

## 6. Open, and Owen's to rule

**6a. What should a caught page BECOME?** A blank page in the book (silent,
because a blank verso really is blank), or a refusal he is told about (so
he can look at it himself)? The existing refusal path already records a
page as unreadable *with its reason*, so the machinery for the second
exists and the first is the choice to say less. **This now has teeth: 12
pages of one 360-page book are currently refusals**, and if they are blank
versos then twelve notices are twelve pieces of furniture in a book that
should simply have twelve blank pages.

**6b. Tier 2's risk, which is his to accept or refuse.** Tier 1 costs him
nothing and needs no permission. Tier 2 buys the book that prompted all of
this, at the price of a rule that *could* refuse a genuinely enormous page
early. Visible and recoverable, but not free — and he is the one who said
nothing may cripple the work that is going well. **§7c reduces this price
to one extra partial read per book; whether that is cheap enough is still
his sentence to say.**

---

## 7. The instrument already exists and is set in the wrong place (P2, 2026-08-20)

**`max_tokens` is already a per-request field.** `endpoint.ts` sends
`opts.maxTokens` on every call; `read.ts` fills it from `model.maxTokens`,
a constant off a table that cannot know anything about the book in front of
it. Nothing has to be invented to stop a runaway earlier.

**THE CAP IS NOT A PROPERTY OF THE MODEL. IT IS A PROPERTY OF THE RUN.**
1,273 tokens is the real ceiling inside Michelle Remembers; 7,677 is the
ceiling across the library; one global number cannot be right about both.
This promotes §4's "length in context" from fallback to instrument, because
it is the only one of the four that buys the thing actually being lost.

**It cannot corrupt a book, and that is a stronger safety property than any
filter has.** A tighter cap changes only *when* a refusal happens, never
whether text is accepted: both refusal sites key on `finishReason: length`,
and a page cut at 3,800 refuses exactly as a page cut at 8,192 does. A
filter decides what is true; this only decides when to stop waiting.

### 7a. The shape: a running maximum over ACCEPTED pages only

Never "the first N pages" — **a band calibrated on the front of a book is
calibrated on its sparsest pages.** Half-title, title, copyright,
dedication, contents; and then the densest page in the book is the index,
at the back.

So: a running maximum that **rises and never falls**, fed by **accepted
pages only**, with the cap derived as that maximum × a margin and **clamped
to the model's own**. Two properties fall out of it:

- **a runaway can never inflate the band meant to catch it** — it is
  refused, so it never enters the maximum;
- **the densest books are untouched BY CONSTRUCTION** — 7,677 × 3 = 23,031,
  which clamps to 8,192, so nothing changes for them at all. That is §3's
  standard met rather than approximated.

On the measured numbers, Michelle Remembers' 1,273 at a 3× margin gives
3,819: each runaway stops at **47% of where it stops today**.

### 7b. THE HOLE, which the running maximum does not close

A running maximum handles a book that gets denser *gradually*. **An index
is a step change at the back of a book**, and Foundry's own docblock
records exactly that case as a real event:

> *"A dense index page — two columns of surnames and page numbers, no
> prose — ran past 4096 and came back truncated… no page of any book read
> today went past 1,700 tokens."*

A **real** page past 4,096 in a library whose ordinary ceiling was 1,700 —
**more than 2.4×, and truncated, so its true length is unknown and
larger.** A 3× margin on a running maximum would refuse that page. The very
observation that justified raising the cap to 8,192 is the observation that
breaks a 3× band, and it would break it at the back of the book, after
hundreds of pages of quiet prose have set the maximum low.

### 7c. The fix: retry once per BOOK, never once per page

P2 rejected a retry-at-the-full-cap, correctly, **for the per-page shape**:
a true runaway would then cost its adaptive cap *plus* 8,192, which is
worse than today. Retrying **once per book** is a different object:

- the **first** page in a book to hit the adaptive cap is retried once at
  the model's cap;
- comes back `stop` → it was a **real dense page**. Accept it; the running
  maximum rises to cover it, and no further retry is ever needed, because
  the band now clears that whole population (the index);
- comes back `length` → **this book has runaways.** Refuse it, and retry
  nothing further in this book.

**Page-loss cost becomes zero by construction**, at a bounded one-time
price of a single extra partial read per book. For Michelle Remembers: one
page pays double, eleven pay 47%. For a reference book with a dense index:
one extra partial read, and the index is never lost.

**And this is why Tier 1 is kept rather than treated as redundant.** The
retry's one hole is a runaway that comes back `stop` under the model cap —
which would be accepted, and would raise the band. That has never been
observed (all 22 are `length`), and it is *precisely* the case the
repetition-and-runs pair catches. The two instruments answer two questions:
**the adaptive cap buys back TIME, the pair protects the BOOK** — and it
matters more once the cap that made the second case impossible is the thing
being lowered.

### 7d. The real engineering cost, and the measurement that sets the margin

**`fromEndpoint` takes ONE `maxTokens` for the whole batch.** `read.ts`
hands it every wanted page at once with a single number and `onPage` fires
as each lands, so a cap that moves *during* a run is not a one-value
change. Either a per-page `maxTokens` on the pages array (smaller, but it
moves the bridge's contract) or a phased call — calibrate, then read (no
contract change, two round trips, and a decision about how many pages phase
one reads). **Not yet costed; that is the next scope.**

**The margin is not a taste question and must not be picked by feel.** The
number that sets it is the *within-book step ratio* — for each book, its
densest accepted page against the rest of its own distribution. If any book
in the library shows a 4× step, then 3× is unsafe and the measurement says
so. That is answerable from the bank Owen already has.

### 7e. Owed regardless of which design lands

`models.ts`'s docblock still carries **1,700 tokens** as a live
justification and it is now false (7,677, measured). A stale measurement
presented as a live reason is a class this feature already has a ledger
entry for. Corrected in whatever commit next touches that file.

---

## 6. Open, and Owen's to rule

**What should a caught page BECOME?** A blank page in the book (silent,
because a blank verso really is blank), or a refusal he is told about (so
he can look at it himself)? The existing refusal path already records a
page as unreadable *with its reason*, so the machinery for the second
exists and the first is the choice to say less. Different feel in a
300-page book; his call, not a guess.
