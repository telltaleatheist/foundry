/**
 * job-queue-shelf — what the shelf draws: our rows beside a host's, and which rows never routed.
 */
import { projectDirOf } from './projects';
import { fold } from '../shared/original';
import type { FoundryJobRow, Job, JobKind } from '../shared/types';
import { pump } from './job-queue-board';
import { changed, copyOf, forgetPark, hostQueue, hostRowsByProject, hostScheduled, jobs, listJobs } from './job-queue-state';

/**
 * WHAT A WINDOW DRAWS — the host's rows where there is a host queue, ours where
 * there is not.
 *
 * ── Never a merge, and that is the point ────────────────────────────────────
 *
 * Hosted, a job a person pressed for is filed in the host's list and comes back
 * to us only when the host decides to run it — at which moment `runJob` mints a
 * row of our own for it, because the landings, the settle and the export
 * announcement are all things a ROW carries. Publishing both lists would put the
 * host's row for that work beside ours, and the two would disagree the instant
 * one of them moved: two cards for one book, one of them stale. So there is one
 * answer to "what is in the queue" and it is the answer belonging to whoever is
 * doing the scheduling.
 *
 * OUR ROWS ARE STILL THERE AND STILL TRUE — `listJobs` is what `foundryBusy`
 * (electron/mount.ts) and the delete guards read, and they must go on counting a
 * host-ordered run that is writing into a folder somebody is about to erase.
 * This is about what is DRAWN, not about what is known.
 *
 * ── THE EXCEPTION, AND IT IS AN EXCEPTION THAT CANNOT DISAGREE ─────────────
 *
 * Our own LIVE rows are appended — the env install BookForge asked for after
 * seeing one vanish from the shelf mid-download (*"an install is real work with
 * real progress and the shelf is the window's answer to what is this machine
 * doing"*), the mint, and the export a host ordered through `exportEpubFromStep`
 * that waits behind its parent. What makes that safe is structural rather than
 * careful: NONE OF THEM HAS A ROW IN THE HOST'S LIST. An install never routes
 * (16e), a mint never routes, and an export the host ordered through the mount
 * seam was never filed in the host's queue at all — so each exists in exactly
 * one of the two lists and no row can be drawn twice.
 *
 * THE ROWS THAT CAN BE IN BOTH LISTS ARE THE TWINS `runJob` MINTS, and they are
 * filtered out by name (`hostScheduled`, where the argument and the night it was
 * drawn twice both live). So the rule above is unchanged for everything it was
 * written about: every row that CAN be in both lists is drawn from the host's
 * alone. What is added is only work the host's list has never heard of.
 */
export function shelfJobs(): Job[] {
  if (hostQueue() === null) return listJobs();
  const rows: Job[] = [];
  for (const held of hostRowsByProject.values()) rows.push(...held.map(copyOf));
  /*
   * AND EVERY ROW OF OURS THAT IS STILL ALIVE — not just the never-routed kinds.
   *
   * A mint is minutes long and drawing nothing for it while hosted would leave a
   * person watching an app that looks idle while it works; that was the original
   * reason and it is unchanged. What it missed is the door the HOST orders work
   * through: `exportEpubFromStep` enqueues here rather than routing (mount.ts's
   * header says why), and while that only ever meant "an export that runs at
   * once" the row was gone before anybody could have looked for it. A deferred
   * one waits — Owen's narrate on a running cleanup orders an EPUB that sits
   * behind it for as long as the cleanup takes — and until this line it sat
   * there invisible in both windows and reachable by no gesture at all: six of
   * them were queued on the Mac before anyone could see one (2026-09-08).
   *
   * ALIVE ONLY, which keeps `runNow`'s rule intact: a settled row leaves this
   * app's list at the settle and does not accumulate in anybody's shelf. What is
   * drawn is work this app is doing or is about to, which is exactly what a
   * queue is for.
   *
   * AND NEVER A TWIN. The rows `runJob` mints for work the HOST scheduled are
   * the host's rows seen from the inside — the host is publishing its half
   * through `setHostQueueRows` and this would publish ours beside it, which is
   * one job drawn twice and is how one Clean text became two identical grayed
   * cards (`hostScheduled`, 2026-09-11). They stay in `jobs`, where every reader
   * that counts real work goes on counting them: `listJobs`, `foundryBusy` and
   * the delete guards, `clearFinished`, the chain verdicts. This is about what is
   * DRAWN. A gesture cannot land on an undrawn row, and the host's own row keeps
   * the ✕ that reaches the host.
   */
  const alive = jobs.filter(
    (job) => !hostScheduled.has(job)
      && (NEVER_ROUTED[job.kind]
        || job.state === 'held' || job.state === 'queued' || job.state === 'running'),
  );
  return [...rows, ...alive.map(copyOf)];
}

/**
 * EVERY ROW ABOUT ONE BOOK, from whichever list is scheduling — the shelf's answer,
 * narrowed to a project.
 *
 * ── Why it is here and not spelled at each caller ──────────────────────────
 *
 * Two places in main derive the promised chain: the IPC doors, which resolve what a
 * plan is aimed at and what a host act is downstream of, and the mount seam, which
 * exports from a step that may not have landed. Both need the same list and both
 * would compose it the same wrong way if left to themselves — `listJobs()`, which
 * hosted holds only the rows Foundry ordered for itself and would answer empty for
 * every chain a person actually made.
 *
 * FOLDED, WHOLE PATH AGAINST WHOLE PATH, through `projectDirOf`. The shelf is one
 * global list across every book on the machine, and this codebase's oldest house
 * rule forbids matching a project by a path's last segment.
 */
export function shelfJobsFor(projectDir: string): Job[] {
  const key = fold(projectDir);
  return shelfJobs().filter((job) => {
    const dir = projectDirOf(job.outputPath);
    return dir !== null && fold(dir) === key;
  });
}

/**
 * THE ONE ID IN A HOSTED SHELF THAT DID NOT COME FROM THE HOST — and the reason
 * drawing a row is never only about drawing it.
 *
 * ── What making a row visible costs ─────────────────────────────────────────
 *
 * `cancel` and `remove` route hosted, unconditionally, because until now every id
 * a hosted shelf could hand back came off a row the HOST had pushed — that
 * premise is written into `remove`'s own docblock. `shelfJobs` appending the env
 * installs makes it false: the shelf draws an install, the shelf's ✕ is bound to
 * that row (`queue.remove` while it is queued, `queue.cancel` once it is
 * running), and a press would forward one of OUR ids into a list that has never
 * heard of it. The download would go on downloading and the button would look
 * broken, which is a worse defect than the invisible row 17c set out to fix.
 *
 * ── Why the test is the KIND and not "is it in our list" ────────────────────
 *
 * Because our list also holds the rows `runJob` mints for work the HOST
 * scheduled, and a cancel of one of those belongs to the host: it chose when that
 * job ran and its own list is what the shelf is drawing. The thing that makes an
 * install different is not where its row is kept, it is that IT NEVER ROUTED —
 * 16e, an install is a precondition of the engine running rather than GPU work.
 * A gesture must go back through the same door the work went out of, and for an
 * install that door was always the internal one. This was `cancelEnvInstalls`'
 * rule (it always refused to send an install's id to the host; installs retired
 * 2026-11-04) reaching
 * the two gestures a person can now actually press.
 *
 * An id belonging to no row of ours answers false and routes, which is the
 * ordinary case and the whole of the host's queue.
 */
/**
 * Which kinds of row NEVER went out through the host, and are therefore ours
 * to draw and ours to stop.
 *
 * ── A TABLE, BECAUSE THE LAST SPELLING OF THIS WAS A LITERAL AND IT AGED ────
 *
 * This test used to be `kind === 'env-install'`, written when an install was
 * the only work this process did on its own. A MINT is the second: it is
 * rasterized by the renderer under somebody’s hands, it never routes, and the
 * host has never heard of its id. Three sites asked the old question and all
 * three were wrong for a mint — two would have forwarded our id into a list
 * that does not contain it (the work carries on, the button looks broken), and
 * `shelfJobs` would have drawn no row at all for a minutes-long operation while
 * hosted, leaving no progress and nothing to press.
 *
 * As a `Record<JobKind, …>` the compiler names every kind the day one is added,
 * which is the same reason the ledger’s per-action tables are tables. A literal
 * could not, and did not.
 *
 * THE QUESTION IS "DID IT ROUTE", NOT "IS IT IN OUR LIST" — the distinction the
 * old docblock drew and it still holds: our list also holds rows `runJob` mints
 * for work the HOST scheduled, and a gesture on one of those belongs to the
 * host. A gesture must go back through the same door the work went out of.
 */
export const NEVER_ROUTED: Readonly<Record<JobKind, boolean>> = {
  // Engine work. It routes: the host chose when it ran.
  epub: false,
  txt: false,
  pdf: false,
  read: false,
  translate: false,
  // The other two text passes, on translate's clause: engine work on the GPU lane,
  // ordered by a person, filed by whoever is scheduling. A cleanup in particular
  // is only ever ordered in a hosted window, so its rows are the host's by
  // construction as well as by this table.
  simplify: false,
  clean: false,
  // Engine work on the GPU lane, ordered by a person. It routes for translate's
  // reason: the host chose when it ran.
  analysis: false,
  // The cleanup's triage, on the cleanup's own clause: ordered in a hosted window
  // with its cleanup behind it, and filed by whoever is scheduling the pair.
  'clean-triage': false,
  // The analysis's ranking, on the analysis's clause — which today means it is
  // never ordered hosted at all (`enqueueAnalysis`).
  'analysis-rank': false,
  // Renderer-driven and interactive. It never entered the host’s queue and
  // never took the serial slot, so nothing over there can stop it or draw it.
  mint: true,
};

/**
 * Is this id one of OUR rows — one that never routed?
 *
 * An id belonging to no row of ours answers false and routes, which is the
 * ordinary case and the whole of the host’s queue.
 */
/**
 * IS THIS ROW OURS — the test the two gestures route on, and it is the row's
 * OWNERSHIP rather than its kind.
 *
 * It was `NEVER_ROUTED[job.kind]`, which answered for the mint and the install
 * and nothing else, because nothing else of ours was ever drawn hosted. Now the
 * shelf draws every live row of ours (`shelfJobs`), and a ✕ on one of those has
 * to reach the row it is drawn on: forwarding it to the host would hand a host
 * queue an id from a list it has never seen, which is a button that does
 * nothing. Ours are `randomUUID`s and a host's are its own step ids, so the
 * lists cannot collide; being IN this list is the whole of the question.
 */
export function ourRow(id: string): boolean {
  return jobs.some((job) => job.id === id);
}

/**
 * THE PUSH DOOR: these are the host's rows for this project, as of now.
 *
 * `setHostNodes`'s mechanics deliberately — the whole set every time, no diffs,
 * nothing validated on this side — for that door's reasons: a diff protocol
 * between two processes goes wrong silently and stays wrong, and a queue is a
 * handful of rows.
 *
 * THE EMPTY LIST IS AGREED AND IS SENT EXACTLY ONCE, on the falling edge: a
 * project that loses its last row. Without it a global mirror could never learn
 * that a project it was told about has gone quiet, because every other push is
 * about a project that still has something in it.
 *
 * NOTHING IS VALIDATED. A row naming a file in no project of ours, a state this
 * app would never write, a row for a book the window has never opened: all drawn
 * as given. Foundry cannot know what the host's queue holds, and a correction
 * here would be this app overruling the only side that does.
 */
export function setHostQueueRows(projectDir: string, rows: readonly FoundryJobRow[]): void {
  hostRowsByProject.set(fold(projectDir), rows.map(copyOf));
  changed();
  /*
   * ── AND THE PUSH IS NEWS, WHICH MEANS IT IS A REASON TO LOOK ───────────────
   *
   * `changed()` NOTIFIES; it does not schedule. So a row of ours waiting on one
   * of the host's — which is every deferred export ordered from a promised step
   * — sat in `queued` after its parent went `done`, because the only thing that
   * had happened was a push, and nothing in this module wakes on one. It would
   * start on the next unrelated thing that pumped: a press in the window, or one
   * of our own jobs settling. For somebody who pressed Narrate and walked away
   * that is never, and Owen watched an EPUB that takes seconds sit for two
   * minutes and stopped it (2026-09-08).
   *
   * A HOST'S PUSH IS THE ONE ANNOUNCEMENT THAT A DEPENDENCY MAY HAVE SETTLED, so
   * it is exactly the moment to reconsider. `pump` re-runs `reconcileChains`
   * first, which is what re-reads `chainVerdict` against the rows that just
   * arrived — and that is also what frees a row whose parent has finished AND
   * been cleared away, and cancels one whose parent is never coming.
   *
   * ONLY WHEN WE ARE HOLDING SOMETHING, because a push arrives for every progress
   * tick of every row the host owns, and `reconcileChains` reads a manifest per
   * waiting row it cannot decide from memory. With nothing of ours queued there
   * is nothing for a pass to start or to cancel, so the guard costs one array
   * scan and saves a disk read on news that cannot concern us.
   */
  if (jobs.some((job) => job.state === 'queued')) void pump();
}

/**
 * THE FIRST PAINT, asked when a window draws a book.
 *
 * `hostNodesFor`'s reason exactly: every push after this one arrives on its own,
 * and a window that opened after the host's last push would otherwise be drawing
 * a queue it was never told about. Asked of the host, stored through the same
 * door the pushes use, so there is one place a row can come from.
 *
 * A HOST THAT OFFERS NO `rows` IS NOT AN ERROR and is not a fallback: it has said
 * its queue is push-only, and the window will draw its work as soon as something
 * moves. A THROW is caught, because this rides on an unrelated question the tree
 * asks (`host-ops:nodes`) and a host's mistake here must not break the tree.
 */
export function seedHostQueueRows(projectDir: string): void {
  const host = hostQueue();
  if (host?.rows === undefined) return;
  try {
    setHostQueueRows(projectDir, host.rows(projectDir));
  } catch (err) {
    console.error(
      `[queue] the host could not say what it holds for ${projectDir}: `
      + `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * THE HOST'S QUEUE HAS DRAINED OF FOUNDRY WORK — the drain signal, when the
 * deciding is not ours.
 *
 * ── Why this has to exist rather than be derived ────────────────────────────
 *
 * The page reader's lifetime hangs off queue drain (`noteQueueIdle`,
 * electron/page-reader.ts) and `keepServerWarmMinutes` DEFAULTS TO 0
 * (electron/app-settings.ts), which is not a short timer — it is an immediate
 * `stopPageReader`. Under a host queue this app's own list is empty between
 * every pair of the host's rows, because the rows live in the host's list until
 * the moment each one runs. Deriving drain from our list would therefore tear
 * the server down after every job and a batch of N readings would pay N model
 * loads, which is three gigabytes loaded N times to read one shelf of books.
 *
 * SO THE HOST SAYS IT, AFTER ITS OWN PUMP HAS CHOSEN — it is the only side that
 * knows whether anything is still coming. BUSY STAYS OURS, because every job
 * start already says so from inside `executeJob`, through `runJob` as much as
 * through `pump`, and a busy signal always beats a pending idle timer.
 */
/**
 * THE RULES ABOUT WHERE WORK MAY GO HAVE CHANGED — the live queue's dial moved.
 *
 * ── Why every park is forgotten and not just one ──────────────────────────
 *
 * `setWaitFor` forgets ONE row's park, because one row was re-pointed. The dial
 * is the other control (`GPU_DIAL_ANY`, shared/slots.ts) and it applies to the
 * whole board: turning it from "3090 Ti" to Any can free every row that was
 * parked for disagreeing with it, and turning it TO a machine can park rows that
 * were about to run. So the backoff every parked row is sitting out is now a
 * timer counting down against a question that has changed, and making somebody
 * wait thirty seconds for a decision they made with a click is the app arguing
 * with the gesture — `setWaitFor`'s own reasoning, one control along.
 *
 * ── AND THE STALE SENTENCE GOES WITH IT ───────────────────────────────────
 *
 * A parked row wears the reason it was turned away ("the queue's GPU dial is set
 * to X"). Leaving that on a row after the dial moved would be the shelf
 * reporting a wait that has been resolved — the defect `setWaitFor` deletes
 * `job.message` to avoid. The next pass writes a true one, or starts the row.
 */
export function venueRulesChanged(): void {
  let woke = false;
  for (const job of jobs) {
    if (job.state !== 'queued') continue;
    forgetPark(job.id);
    if (job.message !== undefined) {
      delete job.message;
      woke = true;
    }
  }
  if (woke) changed();
  if (jobs.some((job) => job.state === 'queued')) void pump();
}

export function hostQueueDrained(): void {
  // AND IT IS NEWS TOO, on `setHostQueueRows`' reasoning and more sharply: the
  // host having nothing left means every parent a row of ours was waiting on has
  // either landed or gone, which is precisely the pair `reconcileChains` exists
  // to tell apart. Same guard, and drained is rare enough that it hardly matters.
  if (jobs.some((job) => job.state === 'queued')) void pump();
}
