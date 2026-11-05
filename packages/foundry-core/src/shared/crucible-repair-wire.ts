/**
 * crucible-repair-wire — what a repair says, in the one shape both doors answer.
 *
 * Owen: *"a doctor that repairs broken environments by redownloading them if
 * they arent right."* A server on this machine is repaired through the
 * bootstrapper and a server on another through its own `repair` task, and both
 * end in the SDK's `RepairResult`, so one view draws either.
 *
 * The state crosses whole rather than as the server's frames. A hash of hundreds
 * of gigabytes outlives the Settings page that started it, and a page that comes
 * back has to be able to ask where the repair has got to rather than only having
 * been listening.
 */

export interface RepairSubjectView {
  kind: string;
  id: string;
}

/** The SDK's `RepairResult`, in this wire's own words so `shared/` imports no SDK. */
export interface RepairResultView {
  healthy: boolean;
  verifyOnly: boolean;
  checked: readonly RepairSubjectView[];
  broken: readonly { subject: RepairSubjectView; was: string }[];
  repaired: readonly { subject: RepairSubjectView; was: string }[];
  failed: readonly { subject: RepairSubjectView; code: string; message: string }[];
  unverified: readonly { subject: RepairSubjectView; why: string }[];
  notHashChecked: readonly { subject: RepairSubjectView; files: readonly string[]; why: string }[];
  bytesHashed: number;
  bytesSkippedVerified: number;
}

export type RepairOutcome =
  | {
    outcome: 'finished';
    result: RepairResultView;
    /** Only a repair of this machine reaches these; a task on a server cannot speak for its own runtime. */
    server: 'ok' | 'reinstalled' | null;
    service: 'running' | 'started' | null;
  }
  | {
    outcome: 'refused';
    code: string;
    message: string;
    /** The server predates the repair task. */
    needsUpdate: boolean;
    /** Nothing there names a release to put back, so the cure is installing again. */
    reinstall: boolean;
  };

export interface RepairState {
  /** The registered server's name, or null for the Crucible on this machine with no row yet. */
  server: string | null;
  verifyOnly: boolean;
  running: boolean;
  /** What it is doing now, in the server's or the bootstrapper's own words. */
  doing: string | null;
  /** Something is in use and the repair is waiting for it. Cleared when it moves on. */
  waitingFor: string | null;
  /** From the `plan` frame: how much this repair will read. */
  bytesToCheck: number | null;
  /** The last `progress` frame. It counts verify reads, and later a download. */
  bytesDone: number | null;
  bytesTotal: number | null;
  file: string | null;
  outcome: RepairOutcome | null;
}

/** The key a state is held under: the door takes a name or null, and a map cannot take null. */
export function repairKey(server: string | null): string {
  return server === null ? '' : `server:${server}`;
}
