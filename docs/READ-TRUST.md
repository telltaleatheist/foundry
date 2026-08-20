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

## 4. The instrument is a post-filter — which one waits on one fact

The runaway is a **degeneration loop**: a model that has started repeating
itself. Detecting the signature is model-agnostic, costs a healthy page
nothing, and — unlike a lower cap — never trades a good page for a bad one.
It can also stop the generation early, so the minutes are not spent either.

**But which post-filter exists depends on a measurement not yet in:**

- if the 25,000 characters are an **n-gram cycling**, repetition detection
  is the instrument and it is nearly free;
- if they are **varied invention**, repetition detection catches nothing,
  and the instrument has to be length-in-context — a page whose answer is
  wildly out of band for *its own book* (self-calibrating against the run's
  own pages, never an absolute number, because an absolute number is the
  cap again in a smaller coat).

Nothing is designed past that fact. P1 is taking it (§5).

---

## 5. The first question is a measurement, and the bank already holds it

Every read is banked with `text`, `tokens`, `finishReason` and `seconds`,
so the runaway is on disk and needs no re-run. Read-only against Owen's
real library, which is never written to.

1. **`finishReason` on that page.** `length` → it hit the cap and **was
   refused**: the book is clean and the cost was wasted minutes. `stop` →
   25,000 characters of nonsense were **accepted and are in his book**.
   Different defects, different fixes.
2. Its tokens and chars against the **band of healthy pages in that same
   book** — is the 1,700-token ceiling true here?
3. **What the nonsense looks like** — cycling, or varied invention. This
   decides §4.
4. How many pages in the library have ever hit either refusal — one page,
   or a population.

---

## 6. Open, and Owen's to rule

**What should a caught page BECOME?** A blank page in the book (silent,
because a blank verso really is blank), or a refusal he is told about (so
he can look at it himself)? The existing refusal path already records a
page as unreadable *with its reason*, so the machinery for the second
exists and the first is the choice to say less. Different feel in a
300-page book; his call, not a guess.
