/**
 * fs-replace — put a finished file in place of another, waiting out a holder.
 *
 * Every product this engine writes is written beside its target and renamed over
 * it, so an interrupted run leaves the old file or the new one, never neither.
 * On Windows that rename is refused (EPERM/EBUSY/EACCES) while ANY other process
 * has either file open, and on the library's share that is routine, not rare.
 *
 * MEASURED, 2026-10-10: 300 replaces of a 278 KB file on `\\TITAN\iO` (the NAS
 * the library lives on), 100 ms apart, in a folder nothing else knew of — 18
 * refused at least once, every one free again within 70–115 ms. The same loop on
 * the local disk: 0 of 300. So about one replace in seventeen on the share meets
 * a holder for a tenth of a second, and a run that writes its product once, at
 * the end, with a bare `renameSync` dies one time in seventeen after all its work
 * (BookForge's pronunciation guide did, on Pursuit of Power, the same day).
 *
 * That is weather: retried on a budget (about seven seconds, BookForge's
 * `fs-retry` SHORT schedule, sixty times the measured hold), and a holder that
 * outlives it is a real lock, thrown to the caller with the platform's own error.
 * DELETE-THEN-RENAME IS NEVER THE FALLBACK — it opens the window where there is
 * no file at all.
 */
import * as fs from 'node:fs';

/** ~7 s in all. The measured hold is ~0.1 s. */
const WAITS_MS = [100, 200, 400, 800, 1200, 1800, 2500];

function held(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
}

/** A synchronous wait, for the synchronous writers (the event loop is held for the wait, a tenth of a second as measured). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** `fs.renameSync(from, to)`, retried while another process holds either file. */
export function replaceFileSync(from: string, to: string): void {
  retrySync(fs.renameSync, from, to);
}

/** The retry itself, over a given rename (the test hands it one that refuses). */
export function retrySync(rename: (from: string, to: string) => void, from: string, to: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rename(from, to);
      return;
    } catch (err) {
      const wait = WAITS_MS[attempt];
      if (!held(err) || wait === undefined) throw err;
      sleepSync(wait);
    }
  }
}

/** `fs.promises.rename(from, to)`, retried the same way. */
export function replaceFile(from: string, to: string): Promise<void> {
  return retryAsync(fs.promises.rename, from, to);
}

/** The async retry, over a given rename. */
export async function retryAsync(
  rename: (from: string, to: string) => Promise<void>, from: string, to: string,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const wait = WAITS_MS[attempt];
      if (!held(err) || wait === undefined) throw err;
      await new Promise((wake) => { setTimeout(wake, wait); });
    }
  }
}
