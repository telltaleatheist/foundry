/**
 * capture — photographs become a project the rest of this app can read.
 *
 * A capture project arrives as pictures of a bound volume rather than as a file
 * (docs/CAPTURE.md). This module owns everything that happens to those pictures
 * BEFORE a PDF exists: copying them in, hashing them, decoding them once, and
 * keeping the recipe of splits and quads that says how they become pages. The
 * mint that turns the recipe into a PDF is the other half and lands later; from
 * the minted PDF onward nothing in this app knows this stage happened.
 *
 * ── THE LAYOUT, AND WHICH HALF OF IT HAS A DOOR ──────────────────────────────
 *
 *   capture/originals/<sha>.<ext>    the bank. Never written, NEVER SERVED
 *   capture/derived/<sha>.png        the upright working copy
 *   capture/derived/<sha>.640.jpg    the thumbnail the grid draws
 *   capture/recipe.json              the splits, quads, strikes and order
 *
 * ONE SERVED DIRECTORY, FLAT NAMES. The renderer reaches pixels only through
 * `foundry-file://capture/<token>/<name>`, whose token maps to `derived/` and
 * whose name must be a plain basename — the same allow-list shape as the book
 * host next door (`bookFigureFile`, electron/book.ts), kept character for
 * character rather than replaced with a cleverer path check that has to stay
 * right forever.
 *
 * The consequence is the reason the layout is this one: NO STRING A RENDERER CAN
 * COMPOSE REACHES THE ORIGINALS. The irreplaceable half of this stage — often
 * the only copy of an afternoon in an archive that does not lend its books — is
 * not merely un-served, it is unaddressable through the scheme. A second host
 * segment, or a token that reached `capture/` itself, would have left the bank
 * one accepted path component away from being readable, guarded by a check
 * instead of by arithmetic.
 *
 * `derived/` and not `working/`, which was the first proposal: `working/` is
 * already a project directory (`WORKING`, electron/projects.ts) holding the live
 * PDF, and one word may not mean two things one folder apart. The name is also
 * true of the contents — everything in it is reconstructible from the originals
 * plus the recipe, which is this stage's first truth, and it makes the deletion
 * rule readable without a comment.
 *
 * ── UPRIGHT IS THE DECODER'S DEFAULT, AND APPLYING ORIENTATION IS A BUG ──────
 *
 * libheif applies the container's `irot` while decoding, so the buffer comes
 * back already upright and this module writes it out unchanged. Applying EXIF
 * Orientation on top would be a DOUBLE ROTATION: measured on the acceptance
 * shoot, it would have turned 26 of 27 photographs 90° wrong — uniformly enough
 * to look deliberate rather than broken. The dependency is pinned to an exact
 * `libheif-js@1.19.8` for that reason: this is decoder behaviour, not format
 * truth, and a caret would let a routine install change it without a person
 * deciding to.
 *
 * DIMENSIONS COME FROM THE DECODER, NEVER FROM EXIF. EXIF says 4032x3024 for a
 * file the decoder hands back as 3024x4032; both are correct about different
 * grids. The recipe, the editor and the mint all live on the DECODED grid, and
 * there is no orientation field anywhere to disagree with it.
 */
import { CAPTURE_RECIPE_PAYLOAD, emptyRecipe } from '../shared/capture';

export { CaptureError, captureDir } from './capture-paths';
export { captureServedFile } from './capture-serve';
export { readRecipe, writeRecipe, openCapture, ensureCapture } from './capture-recipe';
export { onIntakeProgress, intakePhotos, removePhotos } from './capture-intake';
export type { IntakeReport } from './capture-intake';
export { mintBegin, mintPage, mintCommit, mintAbort } from './capture-mint';
export { pdfStageBegin, pdfStagePage, pdfStageRelease } from './capture-pdf-stage';

// Re-exported so a caller that already imports this module does not need to
// know the constant lives one directory over.
export { CAPTURE_RECIPE_PAYLOAD };

// `emptyRecipe` and `recipeBytes` come from shared/ — see the argument there.
export { emptyRecipe };
