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

## 1. The resource is a fact about the job's kind

One table, in `shared/`, read by the scheduler and by the shelf so the
lane a row draws in and the slot it waits for cannot disagree:

| kind | resource | why |
| --- | --- | --- |
| `read` | `gpu` | the VLM holds the card for hours |
| `translate` | `gpu` | Ollama holds the card (`keep_alive: 0` on exit, Wave 4c) |
| `epub` / `txt` / `pdf` | `cpu` | engine compile/facsimile — disk and CPU |
| `mint` | `cpu` | rectify + PDF assembly |
| `env-install` | **neither** | it is a precondition, not work; it keeps its own path outside the slots exactly as Wave 16e ruled |

Simplify rides the translate machinery and is `gpu` wherever it appears
as its own kind. A NEW kind added without a row here must fail the
typecheck (spell the table as `Record<..., Resource>` over the union, not
a lookup with a default — a default resource is a fallback, and fallbacks
are bugs).

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

- The serial slot becomes a small ledger of running jobs per resource.
  A queued job starts when its resource has a free slot; `held` rows
  still wait for Start; order within a resource stays FIFO by queue
  position — no priorities, nothing preempts.
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

## 4. The shelf draws the board

- Rows grouped by lane: a GPU section and a CPU section, each headed by
  its slot count and what is running in it; held/queued rows sit under
  the lane they will run in (the shared table again — one question).
- **The step detail Owen asked to see**: the running row grows the
  progress sentence the pushes already carry (`page N of M`, the export's
  stage line) instead of burying it in the aggregate bar. The aggregate
  bar stays on the head for the glanceable case.
- The head/chrome rules from Wave 26 stand (head on top, its ✕ semantics
  unchanged); standalone-only, exactly as the whole shelf is.

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
