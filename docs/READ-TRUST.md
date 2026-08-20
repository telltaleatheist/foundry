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

### 7b-bis. SIMULATED over all 18,202 pages in page order (P1, 2026-08-20)

The design was walked over the whole library in page order, so the cap only
ever sees what the run knew at the time.

**Hazard 7b is confirmed and it is not marginal: 26 OF 42 BOOKS have a
whole-book maximum more than 1.5× their first 30 pages**, and the densest
page sits where it was predicted — 100%, 99%, 98%, 99% of the way through.
"The first N pages" would have refused the back of half the library.

**And the naive running maximum is catastrophic. THE FLOOR IS THE WHOLE
DESIGN:**

| shape | real pages lost | tokens saved | ≈ time |
|---|---|---|---|
| running max ×2, no floor | **2,215** | 136,632 | 50 min |
| running max ×3, no floor | **401** | 96,630 | 35 min |
| running max ×3, floor 2,000 | 2 | 91,390 | 33 min |
| **running max ×4, floor 2,000** | **0** | 66,344 | **~24 min** |

Without a floor the band is set by whatever the first page happened to be —
*a title page of 54 tokens caps page 2 at 162* — and it loses 401 real
pages even at 3×.

**RULED: ×4, floor 2,000, clamped to the model's 8,192.** The neighbouring
value is not a taste question: ×3 buys nine more minutes and costs exactly
the two densest pages in the library (7,677 against a cap of 6,882; 4,909
against 4,515), both ~90% through their books, both the index-at-the-back —
*exactly the pages a reference book is bought for.* Nine minutes is not
what those cost. Owen's sentence is the whole test, and ×4 meets it
absolutely: **not one page of 18,180.**

On Michelle Remembers alone: **loses nothing**, and its twelve runaways
stop at 3,348 / 3,636 / 4,904 / 5,092 instead of 8,192 every time — between
41% and 62% of the way in. That is the answer to *"any way we can cap
that"* inside his own book at zero cost to the rest of it.

**Two honesties about these numbers, P1's own:** the time column converts
tokens at the median runaway's 180 s per 8,192 and generation is not
perfectly linear, so read "~24 minutes" as about twenty-five, not as a
measurement; and the saving is an upper bound on wasted work rather than a
promise about wall clock.

### 7c. ~~The fix: retry once per BOOK~~ — WITHDRAWN by the simulation

The lead proposed a once-per-book retry at the model cap — the first
adaptive-cap refusal retried once, `stop` meaning a real dense page whose
acceptance raises the band, `length` meaning this book has runaways and
nothing further is retried. It was the right fix **for a 3× margin, where
401 real pages were at risk.** At ×4 with a floor it is withdrawn, and the
arithmetic that kills it is worth keeping:

**A retry that fires on a runaway runs all the way to the model cap and
still fails**, so it costs a full 8,192 on top of the adaptive attempt. For
Michelle Remembers that is 8,192 tokens, cutting the saving from 44,640 to
36,448. **And for a book holding exactly one runaway — which is most of the
books that hold any — the retry is strictly worse than doing nothing:**
3,348 + 8,192 = 11,540 against today's 8,192.

So it buys insurance against a hazard the simulation measures at **zero**,
and pays for it out of the only thing this whole design exists to save. The
lead's proposal, killed by the measurement of the thing it was meant to
protect. Recorded rather than deleted, because at a tighter margin it
becomes correct again.

**What replaces it costs nothing: the refusal must say WHICH CAP FIRED.**
"Refused at 4,904 tokens — four times the longest page in this book" is a
sentence a person can act on, and it makes the one residual risk (a future
book whose real page steps more than 4×, against a worst-ever-observed
3.4×) **visible and recoverable by a re-read** rather than silent. That is
wording, not machinery.

**Worth scoping with the rest:** on a re-read the bank already holds the
book's true band, so the running maximum can be **seeded from the bank**
and the cold start disappears entirely for every book Owen reads twice.

### 7c-bis. WHY 4× — and the mental model was wrong (P1, measured)

46 books with 40+ accepted pages, each book's densest page against **the
running maximum as it actually stood when that page arrived** — the only
number a band could have been built from.

| | |
|---|---|
| worst step in the library | **5.04×** |
| books stepping over 2× | 5 of 46 |
| over 3× | 3 |
| over 4× | **1** |

**The 5.04× is benign, and the floor is why.** It is a *copyright page* —
1,038 tokens of Penguin small print after three nearly empty leaves — and
1,038 is far under any floor worth having, so a 2,000 floor absorbs it
**without the margin being consulted at all.** The biggest ratio in the
library is not a threat: the argument for the floor, stated as a
measurement rather than a precaution.

**The step that matters is 3.35×, and it is not an index.** Book
`vlm-695a29e2f28a2045`, median 741, p90 922, running max 2,294 when the
page arrived — **7,677 tokens, 43% through, and it opens *"Der Stürmer —
Deutsches Wochenblatt zum Kampfe um die Wahrheit"***. A full-page newspaper
facsimile reproduced inside the book, every column of it text the model
reads, at **8.3× its own book's p90**. A 3× margin gives 6,882 and refuses
it; 4× gives 9,176, clamps to 8,192, and keeps it. The second-worst is the
same shape at 34% depth.

**So 4 is the first whole number clearing 3.35, with 0.65 of headroom over
the worst case in 18,202 pages.**

**AND THE MENTAL MODEL NEEDS CORRECTING, because a rule aimed at the wrong
thing would have missed both pages that matter.** "The index is at the
back" is true of most books here — the depth column is full of 96%, 97%,
99% — **but the two steps that actually break a 3× band are at 43% and
34%.** The hazard is not the back of a book. It is **A PAGE OF A DIFFERENT
KIND** — a facsimile, a table, an index, a page of small print — and those
sit anywhere. That is a *stronger* reason for a running maximum than "books
get denser as they go."

### 7c-ter. THE BAND LAGS BY TWELVE PAGES (P2) — and it decides the retry

`DEFAULT_VLM_CONCURRENCY` is **12**, over a shared queue
(`endpoint.ts:88-101`), and `max_tokens` is captured per send. The band can
only be fed by *results*. **So up to eleven pages are already in flight
under a band none of them has yet raised** — and the simulation walked
pages in order with a band that was fully current at every one.

At a gradual slope this costs nothing and the margin absorbs it. **At a
step change it is exactly wrong**, on precisely the population the design
exists for: the first dense page comes back `length`, and the eleven behind
it were already sent under the old cap.

**P2's repair replaces the lead's invariant, and is strictly better —
staleness, not counting:**

> **Retry any page refused under a cap LOWER than the band that is current
> when its refusal lands.**

A page sent at 3,000 that comes back `length` while the band now says 6,000
was judged by a number that is no longer the run's opinion, and **its
refusal carries no information.** A page sent at 6,000 and refused under a
band still at 6,000 was judged fairly and is a runaway. It stays bounded —
the band only rises when a page is *accepted*, so a runaway can never
trigger it — and it costs one stored number per refusal, the cap that page
was actually sent with, which shape A already provides at the send.

**It also dissolves the lead's cost objection of §7c:** Michelle Remembers
has no step, so its band never rises, so **none of its twelve runaways is
ever retried.** The arithmetic that killed the once-per-book rule does not
touch this one.

**But staleness alone does not cover the LEADING EDGE.** The first page of
a step change is refused while the band is still low and therefore *not*
stale, so nothing retries it and it is lost — the cohort behind it is only
rescued if that first page was accepted. A complete retry is therefore
**both**: one leading-edge retry per book, plus staleness for the cohort.

---

## 8. RULED: what v1 is, and what is designed but NOT built

**v1 is the cap and nothing else:**

- **running maximum over accepted pages only, × 4, floor 2,000, clamped to
  the model's 8,192** — measured at zero real pages lost across 18,202;
- **shape A**: `maxTokens: number | ((page) => number)`, evaluated inside
  `readOnePage` at the moment that page is sent. `read.ts` owns the band
  where `onPage` already lands and the refusal sites already are; the
  bridge learns nothing about books, indexes or margins. **Shape B is off
  the table permanently** — a phase boundary *freezes* the band, which is
  the 401-lost-pages failure under a different name;
- **the refusal names WHICH CAP FIRED** — "refused at 5,092 tokens, four
  times the longest page in this book" — so any loss is visible and a
  re-read recovers it.

**THE RETRY IS DESIGNED AND NOT BUILT.** P1 argues correctly that it is
what makes zero-loss true *by construction* rather than true because the
sample topped out at 3.35×, and that its price on the measured population
is exactly nothing. Against that stands **the same argument the lead used
three hours ago to refuse P2's cascade allow-list, and consistency costs
something here**: a zero-entry allow-list was machinery for a problem the
repo did not have, and a retry that fires zero times on 18,202 pages is the
same object. The cheap 90% of "by construction" is the refusal message: it
does not prevent a loss, but it makes a loss **impossible to suffer
silently**, and silent is the only kind that matters.

Both halves — leading-edge and staleness — are recorded above in full, so
the day a real page is lost this is a build and not a design.

**AND THE GATE ON ALL OF IT, before a line is written:** §7c-ter means the
zero was measured under a band that is *more current than the real run's*.
**The simulation must be re-run with the twelve-page lag modelled.** If
zero survives, v1 ships as above. If it does not, the retry stops being
insurance and becomes required, and it lands with the cap.

P2 right-sized its own concurrency finding once P1's correction landed:
the eleven-lost case needs a step that is **contiguous as well as large**,
and the two that matter are single leaves — a facsimile and one mid-book
page — with ordinary prose either side. A single odd page has no cohort
behind it. Its conclusion, that the case never fires at 4×, is probably
right and **is not yet established**, because the evidence offered for it
is the no-lag simulation — *the very run the gate exists to replace.*
That is the ledger's own shape (a check that shares the assumption it is
testing), and it is worth naming even when the conclusion is likely true:
**a stale band is a LOWER band**, so a book climbing through the region
between the 2,000 floor and the 8,192 clamp can be refused under a cap
twelve pages out of date while never coming near its current one. The
floor protects the opening pages and the clamp protects the dense books;
neither protects the climb between them. That is what the re-run measures,
and nothing about the two retry shapes is decided until it reports.

### 8a. THE GATE PASSED (P1, simulated pessimistically) — v1 IS GO

Same walk, but a page's band built ONLY from pages that had landed by
then, assuming a full cohort every time — the worst case, not the likely
one.

| in flight | accepted pages refused |
|---|---|
| 0 | 0 |
| 6 | 0 |
| **12 — the real one** | **0** |
| 24 — twice it | 2 |

**At the actual concurrency the lag costs nothing across 18,202 pages**,
and it takes twice the real cohort before the Der Stürmer page falls over.

**And the mechanism is measured, not lucky: LONG MEANS GRADUAL, LARGE
MEANS LONE.** Consecutive pages over twice their book's p90, across 43
books: **39 runs of one page, 4 of two, 3 of three — and two long runs of
19 and 51.** Both long runs are reference-book indexes, and their steps
are **1.08× and 1.11×**: an index *ramps*, each page raising the band for
the next, so a 51-page dense run costs nothing at all. The two big steps
are lone leaves — `…111:347 112:352 **113:7677** 114:456 115:742` — a
facsimile between two ordinary pages of prose, with no cohort behind it.
The eleven-lost scenario needs contiguous AND large, and those two
properties are anti-correlated **for a reason about how books are made**.

P1's own caveat, kept: anti-correlated is not mutually exclusive. A book of
twenty consecutive facsimile plates would be exactly the bad case; none of
these 43 are, and neither agent claims more than that.

### 8b. The lever, which corrects the lead's own §8

§8 justified shipping without the retry by calling a loss "visible and
recoverable by a re-read". **The first half is true and the second was
not:** a re-read runs the same algorithm over the same book and rebuilds
the same band, so it refuses the same page again. There was no lever.

So v1 gains one: **a flag that disables the adaptive cap**, restoring
today's behaviour exactly. A book that ever suffers is then re-read once
with the flag and loses nothing — which makes "recoverable" a fact rather
than a hope, at the cost of one boolean instead of a retry path through
both refusal sites. The retry stays designed-and-not-built (§8), and the
honest distinction from the cascade allow-list is recorded: an empty
allow-list is a hole somebody must dig, while a retry arms itself — so it
is deferred on COST and uncosted-path grounds, not on the machinery-for-no-
problem argument, which does not fit it as neatly as the lead first
claimed.

### 8c. THE RETRY IS IN v1 AFTER ALL — it was being costed as the wrong thing

P2 costed the retry path and it is **~20 lines with no bridge change**,
because **the retry does not need to be in flight at all.** Both the lead
and P2 had been discussing it as something that happens *when a refusal
lands*, which forces a door into the bridge's internal queue. It is not:
`refuse()` only writes into a plain Map, and the moment `fromEndpoint`
returns, `read.ts` holds everything needed. **The retry is a SECOND
`fromEndpoint` call**, after the first finishes, carrying just the pages
worth retrying, at `model.maxTokens`.

**And after the pass the staleness test collapses to one comparison:**

> **retry every page whose SENT cap was below the FINAL band** — the
> largest the run ever held.

Shape A already computes that number at the send, so recording it is one
`Map.set`. The invariant then falls out without being argued for:

| | |
|---|---|
| **Michelle Remembers** | band never rises, so every runaway was refused **at** the final band, not below it — **nothing retries**; its twelve pages stop at 47% and stay refused |
| **a lone facsimile behind a lagging band** | refused under a band that later rose → retried once at the model cap, and **kept** |
| **twenty plates in a row** (the case the run-length data says does not exist here) | all twenty were sent under a stale band, so **all twenty retry** — one extra pass instead of twenty lost pages |

That last row is why this shape beats once-per-book, **which would have
kept exactly one of those twenty.** And a true runaway is never re-read,
because it was refused at the band the run ended with and fails the test:
**the test is about the CAP, not the COUNT** — the number of previous
retries tells you nothing about whether *this* refusal carried
information.

So the lead's §8 deferral is **withdrawn**: it rested on an uncosted path,
the path was costed, and it is small. v1 is the cap **and** the retry.

**Left alone and named (P2):** the other refusal site is the banked-replay
path — pages refused in a *previous* run and read back out of the bank,
judged under whatever cap that run used. Whether a new run should re-read
them is a real question and a different one: **it is about when a bank
goes stale, not about when a page is worth waiting for.** Not folded in.

---

## 9. v1, BUILD AUTHORIZED (lead, 2026-08-20)

1. **the band** — running maximum over accepted pages only, **× 4, floor
   2,000, clamped to the model's cap**;
2. **shape A** — `maxTokens: number | ((page) => number)`, evaluated at
   the send inside `readOnePage`; `read.ts` owns the band and records the
   cap each page was sent with. Shape B stays off the table;
3. **the retry** — a second `fromEndpoint` pass for every page whose sent
   cap was below the final band **BY A FACTOR OF 2 OR MORE**, at the model
   cap. **The bare "below the final band" test is NET NEGATIVE — see §10,
   and it was authorized for ninety seconds before P1 priced it;**
4. **the refusal names which cap fired** — *"refused at 5,092 tokens, four
   times the longest page in this book"*;
5. **a flag that disables the adaptive cap**, restoring today's behaviour
   exactly;
6. **the stale docblock in `models.ts` is corrected** in the same commit
   that touches it — 1,700 is false, 7,677 is measured.

**DEFERRED OUT LOUD — the repetition-and-runs pair (Tier 1).** Measured at
14 of 22 caught with zero false positives across 18,202 pages, so it is a
build and not a design whenever it is wanted. It is not in v1 because the
case it protects against — a runaway returning `stop` and being *accepted*
— **has never happened in 18,202 pages**, and a lower cap makes it rarer
rather than commoner. Both agents rated it higher than this; the
disagreement is recorded rather than resolved, and the measurement is kept
intact so adding it costs nothing but the decision.

---

## 10. THE RETRY RULE WAS NET NEGATIVE, AND THE WRONG PREMISE WAS THE LEAD'S

P1 priced §9's rule before a line of it was written. **It spends 122,880
tokens to save 66,344 — the feature would have shipped 20.7 minutes SLOWER
than doing nothing.**

| rule | retries | saved | retry cost | net | ≈ min |
|---|---|---|---|---|---|
| no retry at all | 0 | 66,344 | 0 | +66,344 | **+24.3** |
| staleness, ANY rise *(as authorized)* | 15 | 66,344 | 122,880 | −56,536 | **−20.7** |
| staleness, final ≥ 1.5× cap | 5 | 66,344 | 40,960 | +25,384 | +9.3 |
| **staleness, final ≥ 2× cap** | 2 | 66,344 | 16,384 | +49,960 | **+18.3** |
| once per book *(the lead's first shape)* | 8 | 66,344 | 65,536 | +808 | +0.3 |

**And the premise that made it look safe was wrong, and it was the lead's
sentence.** §8c's table says Michelle Remembers' *"band never rises (no
step), so nothing retries"*. Its step is 1.04× — **small, and not zero.**
The caps its twelve runaways were actually sent under: 3348, 3348, 3348,
3636, 4904, 4904, 4904, 4904, 5092, 5092, 5092, 5092. The final band is
5092, so **eight of the twelve sit below it** and would retry at 8,192
apiece — 65,536 spent to save 44,640. **His worst book would have come out
20,896 tokens worse than doing nothing.** P2 proposed the invariant; the
lead restated an untested claim about it as a fact in the contract; P1
walked the actual caps. That is the ledger's own shape and it belongs to
the lead.

**The mechanism is ordinary, which is why it was missed: a band CREEPS
upward through any book as its prose varies.** "Below the final band"
therefore catches every refusal that happened before the book's densest
ordinary page — in a 360-page book, most of them. **The test cannot tell a
band that crept from a band that stepped, and only a step means a refusal
was misjudged.**

### 10a. RULED: the factor is 2×, and it is coupled to concurrency

Requiring the rise to be *substantial* rather than merely present fixes it
with one comparison; nothing else about the shape moves.

**2× is ruled**, keeping 18.3 of the 24.3 minutes and firing twice in the
whole library. P1 declined to recommend between 2× and 1.5× and was right
to — the trade is real: the Der Stürmer page, *in the lag-24 scenario where
it is lost*, sits at a staleness ratio of 1.67, so 1.5× rescues it and 2×
does not. **It is ruled at 2× because that scenario is not the shipped
one:** at the real concurrency of twelve, zero pages are lost with no
retry at all (§8a). The retry's job is the *cohort* case — a contiguous run
of a different kind of page — and a cohort's second page carries the full
step ratio (3.35× for a Der Stürmer run), so 2× fires on exactly the book
this insures against.

**THE COUPLING MUST BE WRITTEN DOWN because it is invisible otherwise:
the safe factor is a function of CONCURRENCY.** At 12 the lag costs
nothing; at 24 it costs two pages at a ratio of 1.67. **If
`DEFAULT_VLM_CONCURRENCY` is ever raised, this factor must be revisited in
the same commit** — a knob in one file silently moving the correctness of
a rule in another is precisely the two-things-one-name class.

### 10b. One honesty about the pricing, P1's own

Every retry above is priced at the **full model cap**, which is exact for
this library — all 22 refusals are true runaways, so a retry really would
run to the cap and buy nothing. **It is pessimistic for a library holding
genuinely misjudged pages:** there a retry pays only the page's real
length and *recovers a page*, which is not a cost at all. So the table
understates every retry rule in exactly the case the retry exists for —
and that case does not occur here.

### 10c. THE LESSON, and it is bigger than either half of the mistake

P2 took its own half rather than letting the lead carry it: **"Michelle
retries nothing" was already in P2's draft assertion list**, derived from
P2's own description of P2's own rule. So the lead wrote an unverified
claim into the contract, and the harness that was supposed to prove the
code **would have been green**, because it encoded the same claim.

> **AN ASSERTION DERIVED FROM THE DESIGNER'S DESCRIPTION OF THE DESIGN
> PROVES THE DESCRIPTION, NOT THE CODE.** It is the sixth ledger entry's
> shape moved one step earlier: not a probe sharing the code's assumption,
> but an expectation sharing the *prose's*. Neither agent reasoning harder
> would have caught it — what caught it was P1 walking the actual caps.

**So the assertion discipline for this build is explicit:** every expected
number is hand-written or read off the measured walk. **None is computed
by the rule under test, and none is derived from anybody's description of
the design.**

### 10d. Declined, with the reason, so it is not rediscovered

P2 drafted and withdrew an optimisation: **send the retry at the FINAL
BAND rather than the model cap**, on the argument that the question a
retry asks is "does this fit under the band the run ended with". It is
purer and it is **weaker insurance**, which is the retry's entire job:

> a book whose final band does *not* clamp — max accepted 1,500, band
> 6,000 — and a misjudged page whose true length is 7,000. Retried at the
> final band it is **refused again and lost**; retried at the model cap it
> is **recovered**.

It also saves nothing now: at 2× the rule fires twice, and both are step
cases whose band clamps to 8,192 anyway, so the two sends are identical.
**Worth pricing again only if the factor is ever loosened**, because the
number of retries is what would make the saving matter.

### 10e. The coupling goes in the KNOB's file, which is better than the ruling

The lead ruled that the concurrency coupling be *written down*. P2's
amendment is strictly better and is adopted: **a doc is not where somebody
raising a constant is looking.** The sentence goes in the docblock beside
`DEFAULT_VLM_CONCURRENCY` in `endpoint.ts` as well — naming the factor and
the file it lives in. Two places, one of which is where the change would
actually be made.

### 10f. The band is a PURE FUNCTION, and the invariant is not in it

The lead's dispatch said "band object"; P1's plan-back overruled it and
the correction is adopted. **`capFor(longestAccepted, modelCap)` in
`src/vlm/band.ts`** — no state, no lifecycle, no instance.

> A stateful band has to be created somewhere and threaded to the send,
> and **the day something creates a second one the two disagree silently.**
> A pure function of a number `read.ts` already holds cannot be
> instantiated twice — and it is the only shape that can be asserted
> *exhaustively*, because it has no history.

The lead named a shape where a requirement was wanted. Recorded as such.

**THE SEED IS THE MODEL CAP, not the floor.** Measured identical on this
library — the largest first-accepted page across 46 books is 1,386 against
a 2,000 floor — and strictly safer for a book that opens dense, at no
cost. The general form of the rule, worth keeping past this decision:
**tighten only once there is evidence; never guess downward.**

**AND THE INVARIANT DOES NOT LIVE IN THE ARITHMETIC.** "Only accepted
pages raise the band" is a property of `read.ts`'s loop; a pure function
takes a number and cannot know where it came from. So it gets its own
assertion at the call site — **feed the walk a runaway and assert THE BAND
DOES NOT MOVE** — which is precisely the check that fails if the maximum
is ever fed from `onPage` without the accepted test. A refused page must
never raise the thing meant to catch it.

### 10g. The pair's deferral has an exception, and it is recorded WITH it

The lead asked whether a lower cap makes an *accepted* runaway more
likely, since that is the case the deferred repetition-and-runs pair
guards. **P1's answer is monotone and settles it: a lower cap can only
turn a `stop` into a `length`, never the reverse**, so the population the
pair guards *shrinks* as the cap falls. The deferral stands on better
ground than the lead had for it.

**But the retry is the exception, and a deferral whose reasoning has a
hole is how something gets forgotten. A RETRIED PAGE RUNS AT THE MODEL
CAP** — so a page refused at 5,092 and retried at 8,192 can come back
`stop` at 6,000 and be accepted. That is today's exposure restored, for
exactly the pages that retry. It is not *worse* than today (that path
exists today for every page); it means **the lower cap's protective
side-effect does not extend to retried pages.** At most two pages on this
library — not enough to move the pair into v1, and enough that the
deferral has to say so out loud.

---

## 11. v1 IS ON MAIN (2026-08-20)

| | |
|---|---|
| `e17a09e` | `capFor`, the corrected docblock — P1 |
| `3691343` | `worthRetrying` + `RETRY_RISE`, three constants under one warning — P1 |
| `53be1d7` | the send, the retry pass, the wording, the flag — P2 |

Six gates on every merge; **414 tests, up from 384** when this began.
`--vlm-fixed-cap` restores today's behaviour exactly.

**Three decisions P2 took inside the brief, all kept:**

- **the policy got NAMES** — `bandAfter`, `pagesToReread`, `capToSend` are
  exported not because the loop needed decomposing but because *a test of
  an inline decision is a test that re-implements it*, which is the exact
  lesson this wave paid for twice;
- **the banked-replay refusal names the READING's tokens**, not
  `model.maxTokens` — a page banked by an older run was cut by whatever cap
  *that* run used, and the model number was never right to print there;
- **a page this pass did not send is never retried.** No recorded cap means
  it came from the bank or from a run predating this: *this pass did not
  judge it and may not overturn it.* Neither agent named that case; it fell
  out of the Map lookup and was asserted rather than left implicit.

**WHAT NO TEST HERE COVERS, and it is the whole of what remains:** every
assertion is about what this code does with an answer, and none is about
what an answer *is*. There is no fake server and no real one. **The first
time the adaptive cap meets dots.ocr will be the first time.** The thing
to watch is the log: a book should announce it is reading pages at a
number below 8,192 — and then say nothing more about it.

### 11b. HALF that gap is now closed: the SHIPPED code over the real library

P1 walked all 55 banks — **18,202 real pages** — through v1's own exported
`bandAfter` / `capToSend` / `pagesToReread`, in a throwaway detached
worktree, writing nothing to the library.

| | |
|---|---|
| accepted pages the band would have refused | **0** |
| tokens not spent on runaways | 66,344 *(~24.3 min)* |
| pages the retry would read again | **2** |
| cost of those retries | 16,384 *(~6.0 min)* |
| **net** | **+49,960 tokens — ~18.3 minutes** |

**And they are P1's simulation's numbers TO THE TOKEN.** A walk written
out of the design predicted +49,960; an implementation written
independently from the same ruling produces the same saving, the same two
retries, the same net. Not close — identical.

**WHAT THAT PROVES AND WHAT IT CANNOT, which is the point of recording
it:** two bodies written from one design, never compared until now,
agreeing exactly over 18,202 pages **rules out an implementation slip in
either.** It **does not rule out a design error in both** — a mistake in
the ruling is a mistake both would make, and this walk cannot see it.
Nor can any bank answer the question that remains, because **every bank
here was made under the old cap**: what a real dots.ocr does when the
number handed to it is 5,092 rather than 8,192.

**Two things the run showed that no earlier measurement had:**

- **the second retry is in the FOUNDRY library, not BookForge** —
  *Flashpoint*, page 6, sent at 2,412 against a final band of 5,004. Every
  other measurement in this wave came from BookForge runs; this is the
  first evidence the feature does anything at all in a project Owen opens
  in the app;
- **both retry cases are true runaways**, so both buy nothing and pay the
  full cap — which is exactly why the net is 18.3 and not 24.3. That is
  the design working as ruled, not a flaw: **those six minutes are the
  entire insurance premium** against a book none of these 43 is.

**The verification pattern is worth keeping by name:** *two
implementations written independently from one specification, compared
only after both exist, agreeing exactly over a large real population.* It
is the strongest evidence available that the spec was READ correctly by
both — and it is silent, by construction, on whether the spec was RIGHT.

---

## 12. THE FALSIFIER, PRE-REGISTERED (before any run)

The residual question — *what does dots.ocr do when handed 5,092 instead
of 8,192* — needs no new instrument. **It needs one book read twice**: once
with `--vlm-fixed-cap` (today exactly), once without (v1), **comparing the
REFUSAL LISTS.** Identical lists mean the cap cost nothing and the only
difference is the clock; **a longer second list names what the feature
cost, page by page, with no inference.** The flag built for another reason
is what makes the experiment possible.

**Michelle Remembers is the book** — twelve runaways, the tightest band in
the library, the most to lose if the margin is wrong.

### 12a. What that book should say — written down BEFORE the run

*A prediction made before the run is worth more than a comparison made
after it.* From the bank, not from the design:

| | |
|---|---|
| the refusal lists | **IDENTICAL** — the same twelve pages, both runs. Any thirteenth entry is the feature's cost, named |
| retries | **ZERO** — the band creeps 3,348 → 5,092 and never steps. **One retry means the creep/step reading is wrong; five means the margin is** |
| where the runaways stop | 3,348 ×3 / 3,636 / 4,904 ×4 / 5,092 ×4 — against 8,192 twelve times today |
| the log | a cap below 8,192, once, then nothing further about it |
| the clock | **~16 minutes shorter** over the book |

### 12b. THE NUMBER THE COMPARISON CANNOT SEE

**Seconds per refused page.** Today a Michelle runaway takes ~180 s. If
v1's refusals return in roughly 90–110, the cap fired where the arithmetic
says. **If they still take 180 s, the number is not reaching the server** —
the `maxTokens` function is being evaluated somewhere that does not matter,
and the refusal lists would match *for the wrong reason.*

> **Identical lists are the SUCCESS criterion and also exactly what a
> completely inert feature produces.** That is the one way this experiment
> can pass while the feature does nothing.

**But the clock is a proxy, and two EXACT signals are already being
recorded that split it without a stopwatch or a threshold (P2):**

**DID WE SEND IT? — the refusal sentence.** Item 4 answers this by
accident: the sentence names `sentCap`, which is written *inside* the same
function `endpoint.ts` calls to build `max_tokens`. One call, one value, no
second path. **A refusal naming 5,092 is proof the narrowed number was on
the request; a refusal naming 8,192 on a book whose band is 5,092 means the
function was never consulted.**

**WAS IT HONOURED? — the banked token count.** Every page is banked with
its tokens in the same `onPage` that refuses it, and for a refused page
that number is not an estimate of anything: **it is where the server
stopped.**

| | |
|---|---|
| banked tokens **== its sent cap** | the server honoured it — the feature works |
| banked tokens **== 8,192** while the sentence says 5,092 | **we sent it and the server ignored us** — vLLM, the model card, or the endpoint clamping somewhere outside our control |

That second row is the failure the clock was reaching for, caught exactly —
and it is the only check that survives a slow machine, a busy GPU, or a run
somebody walked away from.

### 12b-bis. The whole instrument, cheapest first

| check | proves |
|---|---|
| the refusal sentence names a number below 8,192 | **we sent it** |
| the banked tokens equal that number | **it was honoured** |
| the refusal lists are identical | it cost no page |
| zero retries | the creep/step reading holds |
| the clock is ~16 minutes shorter | the whole point |

**The first two are yes-or-no and come from data the run writes anyway.**
The pre-registered numbers of §12a are what make the last three mean
anything.

### 12c. The stopping rule, stated before the evidence

**Several retries in one book means the DESIGN is wrong rather than the
run unlucky.** Measured expectation is zero or one — the walk over 55
banks found two in the entire library. A run that retries five times is a
book whose kind of page the 4× does not cover, and **the retry would be
doing the job the margin should have done.** A feature that quietly starts
leaning on its own safety net is the failure nobody notices, so the number
is named here in advance.

### 12d. Open: whether it is one read or two

`--vlm-fixed-cap` sends 8,192 on every page, **which is what the existing
Michelle bank was made under** — so the control may already be on disk and
Owen may need one fresh read rather than two. **The premise is being
checked rather than assumed**, which is the shape this wave has been burned
by twice: does the bank record enough to prove comparability (model,
endpoint, `maxPixels`, render geometry), and is the read deterministic at
all? `temperature 0.0` is greedy decoding and deterministic *in principle*,
but batched inference reorders floating-point reductions, and *in
principle* is the phrase that has cost this wave twice. If either answer is
no, the two-read version stands.

**The determinism half is answered, and the answer is a distinction (P2,
from the file that builds the request).** `endpoint.ts` sends the whole of
what varies per page: model, `temperature: 0`, `max_tokens`. No seed, no
`top_p`, no penalties. **So the client ASKS for a deterministic decode and
sends nothing that could drift — and cannot promise the server delivers
it.** vLLM batches continuously and batched kernels are not associative in
floating point, so two reads of one page can differ by a token even at
temperature 0 depending on what else shared the batch. Not measured here,
not claimed to happen: only that *temperature 0 is a request and not a
guarantee, and the bank cannot tell you which you got.*

**Why it does not threaten this comparison:** the experiment compares
REFUSAL LISTS, not text. Whether a page runs away is a **gross** behaviour,
not a token-level one — a page that wandered to 8,192 is not plausibly
going to stop at 900 because a batch was composed differently. Where it
*would* matter is the retry count, since a page near the boundary could
fall either side; **Michelle's nearest miss is 1.52× against a factor of
2**, which is not near, so the pre-registered zero is safe from it.

**And the settings half is the half that can be checked at all.** "The bank
is a valid control" is a claim about the server as much as about the
request; the model/endpoint/`maxPixels` half is answerable from what the
bank records, and **nobody can answer the batching half from a bank.**

**If the one-run economy holds it doubles the value of §12b's two exact
signals:** with no second arm, the refusal SENTENCE and the BANKED TOKEN
COUNT are the *only* evidence that the narrowed number reached the server
and was honoured — because the list comparison alone cannot see an inert
feature.

### 12e. ANSWERED: it is TWO reads, and the read is not deterministic

**THE BANK CANNOT BE THE CONTROL.** Every field in all 360 of Michelle's
records: `page`, `text`, `tokens`, `finishReason`, `seconds`. **No model,
no `maxPixels`, no render size** — and the current writer records all
three, so their absence proves the bank *predates that writer* rather than
evidencing that the settings matched. `completedAt 2026-08-10`,
`foundryVersion 0.9.0`. **`maxPixels` in particular decides what the model
SAW, and a control that cannot prove the pages were the same images is not
a control.** Two arms, same build, same sitting.

**AND THE READ IS NOT DETERMINISTIC — measured, not reasoned.** Two books
in the library have been read more than once:

| | pages differing | token delta |
|---|---|---|
| the 17-page Kershaw article, **five runs** | 8 of 17 | max 5, mean 0.35 |
| the second book, two runs | **46 of 83** | **max 66**, mean 1.37 |

Same page, same settings, same machine, a slightly different answer each
time: a request for greedy sampling meeting a server that batches
continuously. So a re-read would not reproduce that bank *even if the
settings were identical* — which is the second, independent reason the
fixed-cap arm has to be run rather than recovered.

### 12f. Why the drift cannot threaten the comparison — with the number

| | |
|---|---|
| worst measured run-to-run drift | **66 tokens** |
| Michelle: longest real page 1,273 vs a runaway at 8,192 | 6,919 apart |
| **tightest headroom the 4× margin leaves on ANY real page in the library** | **515 tokens** *(the 4,909 page against a band of 6,020)* |

**The drift is eight times smaller than the tightest margin any real page
has.** Non-determinism cannot flip a page across this band; it would have
to be an order of magnitude larger than anything measured. And Michelle's
pre-registered zero retries does not depend on tokens being identical at
all — it depends on her band *creeping rather than stepping*, and a
66-token wobble moves her final band by at most 264, which does not bring
any of her twelve sent caps near a factor of two below 5,092.

**Said rather than implied (P1):** neither repeated book contained a single
refusal, so there is **no direct evidence that refusal lists are stable
across re-reads** — only the argument that no drift of this size turns a
page stopping at 1,273 into one running to the cap.

**P1 withdrew its own seconds-per-page proxy** in favour of §12b's two
exact signals, and this measurement is the argument for it: **seconds vary
run to run for the same reason the tokens do.**

### 12g. The cost, and the tier that is nearly free

Two arms over a 360-page book is **hours** of GPU, which is a real price
for a feature whose measured benefit is ~18 minutes across the whole
library. But **the questions separate, and the cheap half answers the one
that matters most:**

| tier | cost | answers |
|---|---|---|
| **one read of the smallest book holding a runaway** | minutes | *did the narrowed number reach the server and get honoured* — §12b's two exact signals, which need no control arm at all |
| two arms on Michelle Remembers | hours | *did it cost a page* — the refusal-list comparison and the retry count |

**The first tier is the one that can fail silently** — an inert feature
passes every other check — and it needs no second run, because the refusal
sentence and the banked token count are absolute rather than comparative.

**AND THE CHEAP TIER NEEDED FIVE LINES TO ACTUALLY BE CHEAP (P2).** Both
numbers were already visible and neither was beside the other: the banked
token count prints on the page own line, the cap that fired lives in the
refusal reason printed in the END-of-run summary. **Half on screen and half
in the closing summary is the WORST of the two arrangements, because it
looks readable** — a check that is absent gets built, and a check that is
present-but-scattered gets *intended*, and then the run ends and nobody has
the numbers side by side. So the refused page now names both in one clause:

| | |
|---|---|
| honoured | `page 113 — CUT OFF at 5,092 tokens, the cap this book set, 178.3s` |
| **ignored** | `page 113 — CUT OFF at 8,192 tokens against a 5,092 cap, 178.3s` |

**The failure has to read as a disagreement to somebody who has never heard
of this feature** — two numbers that should be equal, visibly not — and that
property outranks brevity if the two ever conflict.

**It also fixes a quieter defect that predates this wave:** a refused page
and a good page logged IDENTICALLY, so twelve runaways were twelve
ordinary-looking lines that happened to say 8,192. **Nothing on screen
distinguished the pages that bought nothing from the pages that ARE the
book** — Owen watched twelve scroll past and only noticed because of the
character count.

### 11a. The ledger entries this wave bought

**Eleventh** — a model of a declarative system checks the computation and
not the resolution *(from the cascade defect, §Wave 21c)*.

**Twelfth — A TEST MUST ASSERT THAT ITS CASE IS STILL ITS CASE.** A test
whose setup silently stops matching the situation it was written for does
not fail; it passes, faster, and reports that a rule holds over a
population that is no longer there. **Both agents shipped this shape once
within an hour**, in different files — P2's *"Michelle retries nothing"*
encoded the design's description, and the lead's contract sentence *was*
that description. The fix is one line: **assert the PREMISE before the
CONCLUSION.** Companion to the sixth (a probe sharing the code's
assumption) and the eighth (a repair measured only on its motivating
case); the cheapest of the three to prevent.

**And P1's general form, which outlives its own ruling:** *a warning only
guards what it sits beside.* An ownership boundary says who edits a file;
a numeric boundary says what breaks together. When they disagree, the
numbers win — which is why `BAND_MARGIN`, `BAND_FLOOR` and `RETRY_RISE`
share one file and one concurrency warning.

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
