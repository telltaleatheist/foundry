/**
 * THE SEAM — the one interface every install surface in Foundry is built on.
 *
 * crucible `docs/PHASE19-AUTOMATIC-WSL.md` §2.6 gives the orchestrator a door
 * that can be WATCHED and not only driven: `GET /install` answers the outcome
 * and whether a move is running, `GET /install/events` attaches to the running
 * stream, and `@crucible/bootstrap` grows `installStatus()` and
 * `watchInstall()` over them. Foundry's renderer must not know which of those
 * it is talking to, so it talks to neither: it talks to the three verbs below,
 * across the preload, and main decides what is behind them.
 *
 * ── WHY AN INTERFACE AND NOT A FUNCTION ────────────────────────────────────
 *
 * The SDK that carries §2.6 is not vendored here yet — it is cut with the
 * Crucible release that lands PHASE19 §1, and this app pins the SDK as an
 * immutable tarball (`app/package.json`'s `_crucibleClientNote`). Building the
 * screens against a package that does not exist would mean building them
 * twice. Building them against this interface means the swap is ONE file:
 * {@link preSdkInstallDoor} is replaced by an `sdkInstallDoor()` whose
 * `status` is `installStatus()` and whose `watch` is `watchInstall()`, and
 * nothing in `src/` is touched.
 *
 * ── THE PRE-SDK SEAM, LABELLED AS ONE ──────────────────────────────────────
 *
 * This is a STOPGAP and it is named as one, per the house rule that a stopgap
 * is labelled rather than disguised. What it can honestly report is only what
 * this app itself does: Foundry runs Crucible's own installer and then starts
 * and registers the engine, so it emits the `install` and `windows-engine`
 * rows and a terminal `done` carrying the backend that answered.
 *
 * WHAT IT CANNOT REPORT, AND DOES NOT PRETEND TO:
 *
 *   - **The outcome is null.** §2.2's `wsl-outcome.json` is written by the
 *     TRAY, and the tray that writes it ships with the Crucible release this
 *     app is not yet pinned to. Reading a file that no version of Crucible
 *     writes and calling the absence `done` would be a fallback inventing the
 *     one fact this phase exists to own. Null means "nothing has said", the
 *     screens draw no terminal control on it, and part 2 makes it real.
 *   - **The Linux engine, job types and model rows never start.** Nothing in
 *     Foundry runs the move; the tray does, from §2.3. Those rows end
 *     `skipped` and are not drawn (shared/crucible-install-wire.ts).
 *
 * Nothing here parses the installer's prose for a step name. The sequence in
 * crucible-install.ts KNOWS which step it is on and says so; deriving that
 * back out of a line of English would be a guess about our own code.
 */
import { driveCrucibleInstall } from './crucible-install';
import type { CrucibleInstallEvent, CrucibleInstallStatus } from '../shared/crucible-install-wire';

/**
 * THE DOOR, as Foundry uses it. Three verbs and no fourth.
 *
 * `watch` answers the unsubscribe, synchronously, so a window that closes
 * mid-install detaches without waiting on a promise that may be a stream.
 */
export interface CrucibleInstallDoor {
  /** §2.6's `GET /install`: is a move running, and what did the last one do? */
  status(): Promise<CrucibleInstallStatus>;
  /** Attach to the run in flight, or to the next one. Answers the detach. */
  watch(onEvent: (event: CrucibleInstallEvent) => void): () => void;
  /**
   * §2.5's **Try again** — `POST /install`. Drawn only on a `cannot` or a
   * `failed`, because a machine that is done has nothing to try and a machine
   * mid-move is already trying.
   */
  retry(): Promise<void>;
}

/** Everyone attached right now. A set, so a double-detach is not a hole. */
const watchers = new Set<(event: CrucibleInstallEvent) => void>();

/** One run at a time, and the flag main's install handler reads back out. */
let running = false;

/** Tell every attached window. A throwing listener never stops the others. */
function emit(event: CrucibleInstallEvent): void {
  for (const watcher of [...watchers]) watcher(event);
}

/**
 * RUN THE SEQUENCE AND NARRATE IT — the pre-SDK seam's whole body.
 *
 * Exported rather than private because main's `crucible:install` door and this
 * door's {@link CrucibleInstallDoor.retry} are the SAME run: §2.5 is explicit
 * that Try again is `POST /install`, which is the install, and two entry
 * points that walked different sequences would be two owners of it.
 */
export async function runInstallNarrated(): Promise<void> {
  running = true;
  try {
    await driveCrucibleInstall(emit);
  } catch (error) {
    emit({
      event: 'failed',
      code: 'install_failed',
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    running = false;
  }
}

/**
 * The stopgap implementation. Swapped whole in PHASE19 part 2.
 */
export function preSdkInstallDoor(): CrucibleInstallDoor {
  return {
    status: async () => ({ running, outcome: null }),
    watch: (onEvent) => {
      watchers.add(onEvent);
      return () => { watchers.delete(onEvent); };
    },
    retry: () => runInstallNarrated(),
  };
}
