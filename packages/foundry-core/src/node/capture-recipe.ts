/**
 * capture-recipe — reading and writing a capture's recipe, one edit at a time, filling in its gutters, and opening a capture.
 */
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { CaptureOpened, CapturePhoto, CaptureRecipe } from '../shared/types';
import { emptyRecipe, recipeBytes } from '../shared/capture';
import { GUTTER_RULE } from '../shared/gutter';
import { currentArrangement } from './projects';
import { writeAtomically } from './atomic';
/*
 * THE TEMP DIR AND THE IMAGE CODEC COME THROUGH THE PLATFORM PORT (2026-11-04).
 * They were `app.getPath('temp')` and `nativeImage`, the only two reasons capture.ts
 * imported Electron; `mountFoundry` hands over Electron's own `nativeImage`,
 * so every decode, resize and encode below runs exactly the code it ran before.
 */
import { images } from './platform';
import { gutterFromImage } from './capture-images';
import { CaptureError, derivedDir, originalsDir, recipeFile } from './capture-paths';
import { tokenForServing } from './capture-serve';
import { breathe, validRecipe } from './capture-validate';

// ─────────────────────────────────────────────────────────────────────────────
// The recipe, on disk
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One recipe write at a time, per project.
 *
 * `recipe.json` is rewritten WHOLE (it is kilobytes even for hundreds of
 * photographs), so a save that crossed an intake would drop whichever landed
 * first. A promise chain per directory is the smallest thing that makes that
 * impossible — the same answer `withManifest` gives for the catalogue, for the
 * same reason, and it is a separate chain because a recipe edit must not queue
 * behind an unrelated manifest write.
 */
export const recipeEdits = new Map<string, Promise<unknown>>();

export function withRecipe<T>(projectDir: string, work: () => Promise<T>): Promise<T> {
  const key = path.resolve(projectDir).toLowerCase();
  const previous = recipeEdits.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => { /* a failed edit must not poison the ones queued behind it */ })
    .then(work);
  recipeEdits.set(key, next);
  return next;
}

/**
 * The recipe this project holds.
 *
 * A MISSING FILE IS A REFUSAL AND NOT AN EMPTY RECIPE. `capture:create` writes
 * `recipe.json` before it returns, so a capture project without one is damaged
 * rather than new — and answering "no photographs" for a project whose
 * `originals/` is full of them would invite the surface to save that answer back
 * over the file, which is how one missing read becomes a real loss.
 */
export async function readRecipe(projectDir: string): Promise<CaptureRecipe> {
  const file = recipeFile(projectDir);
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (err) {
    throw new CaptureError(
      `${file} could not be read, so this project's photographs have no recipe: `
      + `${(err as Error).message}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new CaptureError(`${file} is not JSON (${(err as Error).message}).`);
  }
  return validRecipe(parsed, file);
}

/**
 * Write the recipe, whole, or refuse it.
 *
 * VALIDATED ON THE WAY IN even though the renderer composed it, because "the
 * renderer would not send that" is a claim about code that does not exist yet.
 * A recipe that reaches disk malformed is not a bug that throws — it is a
 * project that will not open tomorrow, and its photographs are the one thing
 * here nobody can remake.
 */
export async function writeRecipe(projectDir: string, recipe: CaptureRecipe): Promise<void> {
  const checked = validRecipe(recipe, recipeFile(projectDir));
  await withRecipe(projectDir, async () => {
    await writeAtomically(recipeFile(projectDir), Buffer.from(recipeBytes(checked)));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Opening — the recipe plus the token that makes its pictures loadable
// ─────────────────────────────────────────────────────────────────────────────

/**
 * EVERY PHOTOGRAPH'S GUTTER MEASURED ONCE, for a project intaken before there
 * was such a thing — and the recipe written back so it is measured once only.
 *
 * ── Why a backfill at all, and why it is not a migration ──────────────────
 *
 * The fragebogen scan is 272 photographs already on this machine, and it is the
 * book the feature was asked for. Its recipe has no gutters and cannot get them
 * from anything stored: the measurement needs the pixels. Re-intaking is not an
 * answer — it would re-copy 272 originals to arrive at the same recipe with one
 * field added — so the gutters are read off the thumbnails that are already in
 * `derived/`, which is exactly the picture intake would have measured.
 *
 * It is not `handsRead`'s kind of migration, which re-derives a mark from
 * geometry on EVERY read and writes nothing. This reads files, so it writes
 * what it found: absent means NEVER MEASURED (see `CapturePhoto.gutter`), so a
 * backfill that did not persist would decode the whole book on every open,
 * forever, for a number it already had.
 *
 * ── AND IT IS TOLERANT ALL THE WAY THROUGH, WHICH IS THE POINT ────────────
 *
 * A gutter is a convenience. A project that will not open is the loss this
 * whole module is written around, so nothing here is allowed to be the reason
 * one does not: a thumbnail that is missing or will not decode leaves the field
 * ABSENT (not null — nothing was measured), the photograph opens as it always
 * did, and the next open tries again. A write that fails is swallowed for the
 * same reason, because the recipe in hand is already correct and the only cost
 * of not persisting it is measuring again next time.
 *
 * It breathes between photographs, on `intakePhotos`' argument: a decode cannot
 * be interrupted, and 272 of them in one tick is a window that does not paint
 * while a project opens.
 */
export async function gutteredRecipe(projectDir: string, recipe: CaptureRecipe): Promise<CaptureRecipe> {
  /*
   * UNMEASURED, OR MEASURED UNDER AN OLDER RULE. A found gutter carries the
   * rule it was read by, and a rule that changes the answer for the same
   * pixels (rule 2: held off the type) has to reach books read under the
   * last one, or the fix lands only on books nobody has opened yet. A null --
   * looked, and no shadow found -- carries no rule, because the dip test the
   * null comes from has not changed; bump `DIP_FLOOR` and this must re-read
   * the nulls too.
   */
  const stale = (photo: CapturePhoto): boolean => photo.gutter === undefined
    || (photo.gutter !== null && (photo.gutter.rule ?? 1) !== GUTTER_RULE);
  if (!recipe.photos.some(stale)) return recipe;
  const derived = derivedDir(projectDir);
  let measured = 0;
  const photos: CapturePhoto[] = [];
  for (const photo of recipe.photos) {
    if (!stale(photo)) {
      photos.push(photo);
      continue;
    }
    await breathe();
    // `createFromPath` answers an empty image for a file it cannot read as well
    // as for one that is not there, and both mean the same thing here: leave
    // the field absent and let a later open have another go.
    const image = images().createFromPath(path.join(derived, photo.thumb));
    if (image.isEmpty()) {
      photos.push(photo);
      continue;
    }
    measured += 1;
    photos.push({ ...photo, gutter: gutterFromImage(image) });
  }
  if (measured === 0) return recipe;
  const next: CaptureRecipe = { ...recipe, photos };
  try {
    await writeRecipe(projectDir, next);
  } catch {
    /* The recipe in hand is right; persisting it is an optimisation. */
  }
  return next;
}

/**
 * Everything the light table needs to draw itself, in one round trip.
 *
 * The token is minted HERE rather than by a door of its own because the two
 * arrive together every time: a recipe whose pictures cannot be addressed is a
 * grid of broken images, and a token for a recipe nobody has read has nothing to
 * point at.
 *
 * IT MEASURES THE GUTTERS OF A BOOK THAT HAS NONE, on the way past. See
 * `gutteredRecipe`, which is where that costs an open its one-off decode.
 */
export async function openCapture(projectDir: string): Promise<CaptureOpened> {
  const dir = derivedDir(projectDir);
  await fsp.mkdir(dir, { recursive: true });
  return {
    recipe: await gutteredRecipe(projectDir, await readRecipe(projectDir)),
    token: tokenForServing(dir),
    // Resolved in projects.ts against the catalogue's chain, so this and the
    // step list's `current` marker are one answer to one question.
    mintedFrom: await currentArrangement(projectDir),
  };
}

/*
 * ── GRAVESTONE: `loadMintedPages` AND `SERVED_PAGE_TYPES` (Wave 41) ────────
 *
 * A door stood here that listed a mint's page images in reading order and minted
 * a token to serve them, because the mint wrote pictures and no container and
 * the minted row had to open SOMETHING. Owen ended the class at the source:
 * *"maybe we should mint a pdf from the pages after theyre fully arranged and
 * complete… the pdf is just the images on each page"*, and *"the system isnt
 * trying to sift through images, it's using the original pdf just like it
 * normally would"*.
 *
 * So the minted row opens a PDF through the ordinary document path, pdf.js draws
 * it, and there is nothing left for this to answer. The IPC door
 * (`capture:pages-load`), its preload arm, its `FoundryApi` member, the
 * `CaptureMintedPages` payload and `app-pages-view` retired with it.
 */


/**
 * The same thing, for a project that does not have a recipe yet.
 *
 * SEPARATE FROM `openCapture` BECAUSE THE REFUSAL IS THE POINT OF THAT ONE. A
 * missing `recipe.json` means damage everywhere except here, at the single
 * moment a capture project is created and there is genuinely nothing to read
 * yet. Folding the two would make every later load answer "no photographs" for
 * a project whose `originals/` is full of them, and invite the surface to save
 * that answer back over the file.
 */
export async function ensureCapture(projectDir: string): Promise<CaptureOpened> {
  await fsp.mkdir(originalsDir(projectDir), { recursive: true });
  await fsp.mkdir(derivedDir(projectDir), { recursive: true });
  const file = recipeFile(projectDir);
  try {
    await fsp.access(file);
  } catch {
    await writeAtomically(file, Buffer.from(recipeBytes(emptyRecipe())));
  }
  return openCapture(projectDir);
}
