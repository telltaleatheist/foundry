# Wave 35 — the queue as a slot board. The contract, before the code.

Opened 2026-08-22, from Owen's ruling, verbatim: *"the queue shelf should
probably look a bit more like the bookforge queue, where it has two cpu
slots and one gpu slot, and i can see details about the step thats taking
place."* PLAN.md indexes this file; the build lands against it, and a
builder who finds it contradicting the code edits THIS FILE FIRST and
says so.

## 0. What this is not

- **Not hosted.** Hosted, there is no shelf at all (Wave 26) and BookForge
  owns the machine's queue (Wave 16: *"one machine's GPU needs one
  owner"*). Everything below is STANDALONE ONLY, and nothing here may
  touch the routed path, `runJob`, the mount seam, or the drain contract
  the host relies on (`hostQueueDrained`).
- **Not persistence.** Wave 16's deferred item — the queue survives no
  restart — stays deferred, and the lanes must not make it worse: a held
  job is still lost on restart, and that stays SAID (this file is where
  it is said) until its own wave.

## 0b. Corrected 2026-08-23 — an export from the Export dialog never enters the board

Owen's ruling: *"only things that take a long time or use lots of
resources go to the queue. epubs can be processed right there on the
spot, in the modal that spawned the job."* So the CPU lane's rows below
are what they always were for work that arrives through `enqueue` — but
the Export dialog no longer arrives through `enqueue` at all. It calls
`queue:run` → `runNow` → `runJob`: the job runs DETACHED the moment it is
pressed (an export is seconds of offline arithmetic somebody is watching
a spinner for), the dialog reports the settled outcome, and the row
leaves the list at the settle so the shelf never holds it as history. The
row exists for the length of the run — guards, ✕, drain hold, landings
all unchanged — and readings, translations and host-ordered exports keep
the board exactly as written below.

## 1. The resource is a fact about the job's kind

One table, in `shared/`, read by the scheduler and by the shelf so the
lane a row draws in and the slot it waits for cannot disagree:

| kind | resource | why |
| --- | --- | --- |
| `read` | `gpu` | the VLM holds the card for hours |
| `translate` | `gpu` | Ollama holds the card (`keep_alive: 0` on exit, Wave 4c) |
| `epub` / `txt` / `pdf` | `cpu` | engine compile/facsimile — disk and CPU |
| `mint` | `unscheduled` | **corrected in the build** — see below |
| `env-install` | `exclusive` | **corrected in the build** — see below |

**TWO ROWS WERE WRONG AND THE BUILD CORRECTED THEM HERE FIRST**, as this
file asks.

- `env-install` was written as **neither**, *"outside the slots exactly as
  Wave 16e ruled"*. 16e ruled that an install never ROUTES to a host
  queue; it says nothing about slots, and in this app's own queue an
  install has always taken the pump's one serial slot deliberately —
  job-queue.ts's header: *"a conversion that needs the environment must
  wait BEHIND it. One serial queue gives that ordering for free, where a
  downloader running alongside would let a run start against the Python it
  is halfway through replacing."* Outside the slots on a two-lane board is
  exactly that race. So an install is **exclusive**: it starts only when
  every slot is free, nothing starts beside it, and — the second half,
  which one serial queue also gave for free — **nothing queued behind it
  starts before it does**. A queued install is a barrier in the walk, or a
  stream of cheap CPU rows would step over it forever, each one running
  against the environment it is waiting to replace.
- `mint` was written as `cpu`, and a mint is never scheduled at all: it is
  born `running` (`beginMint`), the rasterising happens in the renderer
  under somebody's hands, and the pump only ever claims a `queued` row.
  Filing it in the CPU lane would have made the shelf report a slot as
  held that the scheduler had never given out. It is `unscheduled`: no
  slot, no drain hold, drawn beside the board.

Simplify **never appears as its own kind** — the Simplify dialog calls
`enqueueTranslate` and the row it makes is `kind: 'translate'` wearing a
title of its own, so it inherits `gpu` through that, which is right for
the lane's own reason. (The original wording, *"is `gpu` wherever it
appears as its own kind"*, described a kind that does not exist.)

A NEW kind added without a row here must fail the typecheck: the table is
`Readonly<Record<JobKind, JobResource>>` in `app/shared/queue-board.ts`,
never a lookup with a default — a default resource is a fallback, and
fallbacks are bugs.

## 2. The slots

`gpu: 1, cpu: 2`. Constants in one place, beside the table. The GPU slot
is one because the card is one (Wave 16's whole argument); the CPU slots
are two because Owen said two, and because two engine processes compiling
two different books are disjoint by construction — every book file write
is already serialised per target path (`oneWriterOf`), and the
two-live-rows-one-output refusal (`enqueueHere`'s dedupe) stays exactly
where it is and keeps being the guard that matters.

## 3. The scheduler

`pump()` stays the ONE scheduler (Wave 16f's split survives: `pump`
decides, `executeJob` works). What changes inside it:

- The serial slot becomes a small ledger of running jobs per resource
  (`slots`, keyed by row id, each entry holding its resource and its
  cancel). A queued job starts when its resource has a free slot; `held`
  rows still wait for Start; order within a resource stays FIFO by queue
  position — no priorities, nothing preempts.
- **`starting` is deleted rather than generalised.** It was a boolean
  covering the gap between choosing a row and its child existing (the
  reading server's wait). A slot is now taken at the moment of CHOOSING,
  before any await, so that gap is closed by the occupancy every later
  pump reads anyway — one fact instead of two that had to agree.
- **A slot outlives its child, deliberately.** `release()` nulls the
  cancel when the last engine child exits; the slot itself is held
  through the landings and given up only when the whole run returns.
  That is what the single slot did (the pump did not look again until
  `executeJob` had returned), and it matters more with lanes: a lane
  freed at the child's exit would let the next row's rotation start while
  the previous row's landing was still moving files in the same folder.
- **Drain** means: no running job in ANY slot, no queued work, and no
  live detached run — the same three facts as today, counted across
  lanes. `noteQueueIdle`/`noteQueueBusy` semantics unchanged; the
  reading server's lifetime hangs off this and `keepServerWarmMinutes`
  defaults to 0 (Wave 16d), so an accidental early drain STOPS the
  server — treat any change to the drain condition as a correctness
  change, not tidying.
- **Cancellation and shutdown** stop every slot's child and every
  detached run — `shutdown` and `cancelHere` already look in two places;
  they learn to look across the slot ledger the same way.
- **`foundryBusy` and the delete guards** read `listJobs()` and keep
  working unchanged — a running row is a running row whichever lane runs
  it.

## 4. The chrome draws the board

> **Wave 43 re-housed this section's furniture and none of its rules.**
> Everything below was written about the queue SHELF — a pill docked in
> the bottom-right corner. The shelf is deleted (Owen, 2026-08-22:
> *"can you make the queue shelf a bar along the top right that i can
> click and look at, and put a button in it for 'more info' thatll take
> me to a queue page that looks like bookforge's queue page? this is
> just ui work mostly, not changing the way it works on an engine
> level."*). Read "the shelf" below as **the dropdown panel under the
> top-right chip**, which draws exactly what the shelf drew, off exactly
> the same table, by exactly these rules.
>
> The drawing rules now live in `app/src/app/core/queue-view.service.ts`
> — one description of the queue, read by BOTH surfaces, which is the
> arrangement BookForge already reached (its tray and its queue page
> read one service, after a period in which they *"spoke different
> dialects"*). The chip and panel are `components/queue-bar`; the page is
> `pages/queue`, on the `/queue` route, standalone-only by `canMatch`.
>
> **What the PAGE adds, and it is a reading of the same table:** the
> bench, one card per SLOT — GPU 1 of 1, CPU 1 of 2, CPU 2 of 2 — always
> all three, occupied or free. The scheduler does not say which slot a
> job landed in and the page does not pretend it does: a lane's running
> rows are dealt into that lane's slots in queue order, and the fact
> drawn is the one main really guarantees, that at most `SLOTS[lane]`
> run at once. Nothing in §1–§3 changed to allow it.

- Rows grouped by lane: a GPU section and a CPU section, each headed by
  its slot count and its occupancy (`1 of 1 running`, `2 slots free`);
  held/queued rows sit under the lane they will run in (the shared table
  again — one question). What is running in a lane names itself in the
  rows directly under the head, so the head carries the count rather than
  a second copy of the titles.
- **When the heads are drawn, as built.** While every row in the shelf
  wants the same resource, there are NO heads and the list is exactly the
  list it always was — that is the common case (a batch of readings, one
  export), and two headers of ceremony over one lonely job is worse than
  what it replaced. The moment the board holds work of two kinds, BOTH
  lanes draw, the empty one included with `1 slot free` under it: at that
  point "the card is free while these two compile" is precisely the fact
  a board exists to show. The two sections that are not lanes — the
  install that holds the whole machine, the mint that runs beside it —
  draw only when they have rows, because neither has an occupancy to
  report.
- **The step detail Owen asked to see**: the running row grows the
  progress sentence the pushes already carry (`page N of M`, the export's
  stage line) instead of burying it in the aggregate bar. The aggregate
  bar stays on the head for the glanceable case.
- The head/chrome rules from Wave 26 stand (head on top, its ✕ semantics
  unchanged); standalone-only, exactly as the whole shelf is.
- **Wave 43: standalone-only now covers THREE surfaces, not one.** The
  chip, the panel and the page are each gated, and the route refuses
  hosted with `canMatch` so it falls through to the workspace rather
  than failing a navigation. Owen's 2026-08-21 ruling — *"when im in
  bookforge, the shelf shouldnt appear at all"* — is a rule about
  Foundry drawing a queue at all, so a redesign that turned one surface
  into three had to gate all three or it would have quietly repealed
  it. The ✕'s two meanings are unchanged in both surfaces, and Start is
  still the one control that releases the WHOLE held batch: the page
  groups waiting rows by book but deliberately draws no per-book Start,
  because `queue.start()` has no such door and a button that started
  four other books would be a lie.

## 5. What the build must verify and report

- Two CPU jobs genuinely running while a GPU read runs (three children,
  one machine) — watched, not reasoned.
- A read landing while an export runs: the landing arms
  (`onExportLanded`, ledger writes) were written under a serial queue;
  the builder walks every landing arm for an assumption that nothing
  else is running (shared mutable state, `pump()` re-entry) and names
  what was found, found-nothing included.
- The env-install path untouched; the hosted path untouched
  (`hostQueue()` callers unchanged, byte for byte).
- Drain measured: queue two CPU jobs and one GPU job, watch
  `noteQueueIdle` fire once, at the end.

## 6. What the build measured (2026-08-22)

Measured against the REAL `job-queue.ts` and the REAL `queue-board.ts`
with every executor stubbed at the module boundary — a throwaway probe,
run and deleted (no test was added; house rule).

- **Three children on one machine.** Two renderings and a reading were
  live together (`live=3`); the GPU lane never exceeded 1 — the second
  reading started 1ms after the first ended — and the CPU lane never
  exceeded 2, with the third rendering starting 1ms after the first
  finished.
- **Drain fired ONCE**, at the end, with the board empty. Four landings
  happened before it and not one of them declared idle.
- **The install held the whole machine and was a barrier.** Queued while
  a reading ran, it stayed `queued` until the reading ended, then ran
  alone; a rendering queued AFTER it did not start until the install had
  finished, though a CPU slot was free the whole time.
- **A cancel picked the right child out of three**: cancelling the
  reading killed `vlm-read` and left both renderings running.
- **`shutdown` stopped every slot's child** — both renderings, in one
  call. (It declares drain once per slot it clears, which is new and
  harmless: the process is quitting and `noteQueueIdle` is idempotent.)
- **The landing arms were walked** for serial assumptions; findings are
  in the wave's report and in PLAN.md's Wave 35 row.
