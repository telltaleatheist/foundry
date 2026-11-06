/**
 * crucible-coordinate-state — each server's coordination state, and who is told when it changes.
 */
import type { CrucibleCoordinationMap, CrucibleCoordinationState } from '../shared/coordinate-wire';

// ─────────────────────────────────────────────────────────────────────────────
// The session's memory: one state per server, one run at a time, one refusal
// ─────────────────────────────────────────────────────────────────────────────

export const states = new Map<string, CrucibleCoordinationState>();

export const inFlight = new Map<string, Promise<CrucibleCoordinationState>>();

/** Servers whose module was refused about the REQUEST. Never posted again. */
export const requestRefusals = new Map<string, { code: string; message: string }>();

export type Listener = (state: CrucibleCoordinationState) => void;

export const listeners = new Set<Listener>();

/** Every state coordination currently holds. A server absent from it is idle. */
export function coordinationStates(): CrucibleCoordinationMap {
  return Object.fromEntries(states);
}

/**
 * Watch every state change, for the main process that forwards them to windows.
 *
 * THE LISTENER IS IPC'S, NOT THIS MODULE'S. `electron/ipc.ts` is where the push
 * is made and where `afterRegistryChanged()` is called when a preparation
 * lands, because both of those are facts about the APP — which windows exist,
 * what a finished install does to the tiles — and this module's whole subject is
 * one conversation with one server. A `broadcast` from in here would make this
 * file the second owner of both.
 */
export function onCoordination(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function publish(state: CrucibleCoordinationState): void {
  states.set(state.server, state);
  for (const listener of listeners) {
    try {
      listener(state);
    } catch (err) {
      /*
       * A LISTENER THAT THROWS MUST NOT UNWIND THE RUN. This publish happens
       * between a post and the stream that follows it; a throw from a dead
       * window's push would abandon a task that is already running on somebody
       * else's machine. `window.ts`'s `broadcast` makes the same argument from
       * the other side.
       */
      console.error(
        '[crucible] a coordination listener threw and the run carried on: '
        + `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

export function report(state: CrucibleCoordinationState): CrucibleCoordinationState {
  publish(state);
  return state;
}
