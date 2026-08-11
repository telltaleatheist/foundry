import type { FoundryApi } from '@shared/api';

declare global {
  interface Window {
    foundry?: FoundryApi;
  }
}

/**
 * The bridge, or nothing.
 *
 * Nothing happens when the renderer is opened in a plain browser (`ng serve`
 * without Electron): every service degrades to an empty list and a disabled
 * button rather than a white screen full of `undefined is not a function`.
 */
export const api: FoundryApi | null =
  typeof window !== 'undefined' && window.foundry ? window.foundry : null;

export const hasBridge = api !== null;
