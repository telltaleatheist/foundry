/**
 * job-queue — the conversions, owned by MAIN.
 *
 * It lives here and not in the renderer for the same reason BookForge's stages
 * do: an ng-serve reload, or a user navigating to Settings, must not be able to
 * kill ninety minutes of GPU. The renderer holds a MIRROR, pushed on every
 * change; it never holds the truth.
 *
 * A BOARD OF SLOTS, AND IT WAS ONE SLOT UNTIL WAVE 35. The engine loads a
 * document vision model and holds a GPU for the length of a book; two of THOSE
 * on one machine is two runs that each take twice as long, or an out-of-memory
 * failure at page 200. That is a fact about the CARD, and for a year it was
 * enforced by there being exactly one slot in this file — which also meant a
 * thirty-second EPUB compile sat behind a three-hour reading for no reason at
 * all, because the compile wants a disk and never goes near the model.
 *
 * So the invariant is stated as what it always was: ONE GPU, because the card
 * is one, and TWO CPU RUNS, because Owen said two and because two engine
 * processes writing two different books contend for nothing this app has not
 * already serialised (docs/QUEUE-BOARD.md §2). Which lane a job waits in is a
 * fact about its KIND, declared once in shared/queue-board.ts and read by the
 * scheduler here and by the shelf that draws the board. `pump()` starts the
 * next queued job whose lane has a free slot; nothing preempts, nothing
 * reorders, and a lane that is full is a lane whose rows wait exactly as the
 * whole queue used to.
 *
 * ONE GPU PER MACHINE, AND THERE CAN BE MORE THAN ONE MACHINE (Wave 61,
 * Package G). "One card, one owner" was written when this app knew of one card;
 * a registered Crucible is a second, and Owen ruled what follows from that
 * (docs/SLOTS.md §1): *"if there are more than one servers connected, there will
 * be more than one GPU slot listed in the queue that can be filled… an emergent
 * property of having multiple servers configured is the distributed load."* So
 * the GPU side of the board is one lane PER COMPUTE SLOT, derived from the slot
 * list in the one place both programs read it from (`computeLanes`,
 * shared/queue-board.ts). The card's rule is unchanged and is simply said once
 * per card: a translation on the Mac and a cleanup on this desk are two runs on
 * two machines, and nothing about them was ever a reason to make the second wait
 * three hours for the first. The CPU lane is untouched — a compile is this
 * machine's disk however many rooms away the models are.
 *
 * A job that reads through the LOCAL page reader waits for that server first
 * (electron/page-reader.ts). The wait is part of the job, not a thing that
 * happens beside it: the shelf says "Starting the reading server…", and a
 * server that will not start fails THAT job with the server's own log tail.
 *
 * ── Nothing EXPENSIVE starts until the user says so ──────────────────────────
 *
 * A READING is enqueued HELD. It sits in the list, in order, visible, and does
 * nothing until `start()` releases it. `pump()` only ever claims a `queued` job,
 * so the gate is the state itself rather than a flag anything has to remember to
 * check.
 *
 * THE POINT IS THE BATCH. Enqueueing used to pump immediately, which made the
 * moment of configuring the moment of commitment: the first conversion was
 * already reading pages before the second book could be chosen, so "queue these
 * four and let them run overnight" was not a thing this app could do. `start()`
 * releases everything held AT THAT MOMENT and nothing else — a job added after
 * the press is held again, because Start means "run what is here" and a button
 * that silently also armed the future would make the next enqueue a surprise.
 *
 * A RENDERING IS NOT HELD, and the exception is the rule stated properly. The
 * hold exists so that hours of GPU are never spent by the act of configuring
 * them. A `vlm-convert --reuse-readings` over a finished bank spends no GPU at
 * all: it is arithmetic over answers already on the disk, it is offline, it
 * takes seconds, and it can be asked for again as often as somebody likes. There
 * is nothing to commit to, so there is nothing for Start to mean — and a person
 * who pressed Generate and then had to find this shelf and press another button
 * would be confirming a decision they had already made. It is still QUEUED
 * rather than run beside whatever is going: the number of engines this machine
 * runs at once is a fact about the machine, and it holds however cheap the job
 * is. What CHANGED in Wave 35 is only the number — a cheap rendering waits for a
 * CPU slot rather than for the card, so it no longer sits behind a reading it
 * has nothing in common with.
 *
 * ── NO JOB IN HERE STARTS ANOTHER ONE ────────────────────────────────────────
 *
 * Every row in this queue arrives from a person pressing something. A reading
 * that lands makes ONE document nobody asked for — its book file — and even that
 * is not a job: `vlm-book` is arithmetic over a bank already on the disk, no
 * model, no GPU, no server, so `landReadProducts` spawns it and awaits it inside
 * the settle, which is the same posture `loadBook` (electron/book.ts) takes when
 * a pane opens a book nothing has reflowed. The user: "from that bank, we
 * create an html page of the document - a proto epub. that's the step that appears
 * automatically the moment i OCR something."
 *
 * THE FACSIMILE USED TO ARRIVE HERE TOO, enqueued by the read arm the instant a
 * bank was marked complete, and it was there as insurance rather than as a
 * convenience. It dates from before the bank was kept unconditionally: a
 * page-for-page reprint already on the disk was the one record of a reading that
 * nothing downstream could invalidate. The bank is now kept whatever happens, so
 * the thing that reprint was standing in for is the thing that survives, and
 * making the reprint again is seconds of offline arithmetic over answers that are
 * still there. That turns it into a document somebody ASKS for — Export →
 * Facsimile PDF, or any other door onto `planRendering` — rather than one a
 * landing leaves in a folder, and it leaves this queue with nothing in it that
 * starts a job of its own.
 *
 * ── A HOST MAY OWN THE SCHEDULING, AND THIS FILE SPLITS IN TWO FOR IT ────────
 *
 * Owen ruled it (docs/PLAN.md, Wave 16): *"we need to centralize the queue in
 * bookforge."* One machine's GPU needs one owner, and hosted there are two
 * schedulers — this one and the host's, which knows nothing about it.
 *
 * So the file has always been two things in one body: a SCHEDULER that decides
 * which row goes next, and an EXECUTOR that turns a row into an engine run and a
 * landing. They are two functions now. `pump()` is the scheduler and is
 * unchanged in what it does; `executeJob()` is everything that used to happen
 * after the row was chosen, and `runJob()` is the second door onto it — execute
 * THIS, now, because somebody else did the deciding.
 *
 * THE DIVISION IS: THEY DECIDE WHEN, WE STILL DO THE WORK. A host's queue never
 * reimplements the ledger writes, the bank, the rotations or the export landings,
 * because two copies of that bookkeeping is how two apps start disagreeing about
 * what a book is. A job ordered by the host is minted as a row here, runs through
 * the same `executeJob`, lands the same products and publishes the same
 * announcements. What disappears in hosted mode is the WAITING — the row is born
 * `running`, because the waiting already happened in somebody else's list.
 *
 * ROUTED VERSUS INTERNAL IS A DOOR, NOT A FLAG. Every exported gesture in this
 * file is either a door a PERSON reached through the window (`enqueue`,
 * `enqueueTextPass`, `cancel`, `remove`, `start`, `clearFinished` — these route
 * when a host queue is registered) or a door FOUNDRY ITSELF reached for
 * (`enqueueHere`, `cancelHere`, `runJob`, `runNow` — these
 * never route). Nothing below the doors consults anything: `pump`, `executeJob`
 * and every landing are the same code in both worlds, so there is no flag for a
 * function to forget.
 *
 * ── AND ONE KIND OF JOB NEVER WAITS AT ALL ───────────────────────────────────
 *
 * An EXPORT ordered from the Export dialog runs the moment it is asked for and
 * reports back to the dialog that asked (`runNow`). The queue is for work that
 * costs something — hours of GPU, a model held for a book — and an export is
 * seconds of offline arithmetic a person is actively waiting on; parking it in
 * a list beside the readings made the list the place you went to learn whether
 * a button worked. The row still exists for the length of the run (the guards
 * and the landings are built on rows), and it leaves the list the moment it
 * settles, because a shelf of finished exports is a history nobody asked for.
 */
export { onQueueChanged, onExportLanded, onJobSettled, listJobs, engineSentence } from './job-queue-state';
export { shelfJobs, shelfJobsFor, setHostQueueRows, seedHostQueueRows, venueRulesChanged, hostQueueDrained } from './job-queue-shelf';
export { enqueue, enqueueHere, producing, enqueueTextPass, triageRequestFor, enqueueTriagedCleanup, enqueueAnalysis } from './job-queue-enqueue';
export { start, release, QueueRoutingRefusal, setWaitFor, rowsWaitingFor, remove, cancel, beginMint, noteMintPage, mintCancelled, settleMint, cancelHere, clearFinished, shutdown, drained } from './job-queue-gestures';
export { argsFor } from './job-queue-args';
export { runJob, printedFormsForRun, printedFormsAt, runNow } from './job-queue-run';
