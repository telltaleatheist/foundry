/**
 * capture-paths — where a capture project keeps its photographs, derived images and recipe, and its refusals.
 */
import * as path from 'node:path';

export const CAPTURE = 'capture';

export const ORIGINALS = 'originals';

export const DERIVED = 'derived';

export const RECIPE = 'recipe.json';

// Staging for a mint in progress. NOT served: the door reaches `derived/`
// and nothing else, and a half-finished book is nobody's business but
// this module's.
export const MINTS = 'mints';

/** Refusals from this module, named so a caller can tell them from an fs error. */
export class CaptureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaptureError';
  }
}

export function captureDir(projectDir: string): string {
  return path.join(projectDir, CAPTURE);
}

export function originalsDir(projectDir: string): string {
  return path.join(captureDir(projectDir), ORIGINALS);
}

export function derivedDir(projectDir: string): string {
  return path.join(captureDir(projectDir), DERIVED);
}

export function recipeFile(projectDir: string): string {
  return path.join(captureDir(projectDir), RECIPE);
}
