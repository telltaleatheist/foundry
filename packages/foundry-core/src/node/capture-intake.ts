/**
 * capture-intake — photographs coming into a capture, and taken out of it.
 */
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import type { CaptureIntakeProgress, CaptureOpened, CaptureRecipe } from '../shared/types';
import { PHOTOGRAPH_TYPES, recipeBytes } from '../shared/capture';
import { currentArrangement } from './projects';
import { writeAtomically } from './atomic';
/*
 * THE TEMP DIR AND THE IMAGE CODEC COME THROUGH THE PLATFORM PORT (2026-11-04).
 * They were `app.getPath('temp')` and `nativeImage`, the only two reasons capture.ts
 * imported Electron; `mountFoundry` hands over Electron's own `nativeImage`,
 * so every decode, resize and encode below runs exactly the code it ran before.
 */
import { images } from './platform';
import { pagesFor, readExifTimes, takenAtFrom } from './capture-exif';
import { THUMB_EDGE, decodeHeic, decoderModule, encodePng, gutterFromImage, thumbnailOf } from './capture-images';
import type { DecodedImage } from './capture-images';
import { mints } from './capture-mint';
import { CAPTURE, CaptureError, ORIGINALS, derivedDir, originalsDir, recipeFile } from './capture-paths';
import { readRecipe, withRecipe } from './capture-recipe';
import { tokenForServing } from './capture-serve';
import { breathe } from './capture-validate';

/*
 * ── HOW AN INTAKE SAYS WHERE IT HAS GOT TO ──────────────────────────────────
 *
 * One listener, replaced rather than appended, exactly as `onEnvInstallProgress`
 * does it: this module's business is photographs on disk, not who is hosting
 * the app, and the one place that knows whether anybody is listening
 * (electron/ipc.ts) wires it to a broadcast.
 */
export let intakeProgress: (progress: CaptureIntakeProgress) => void = () => { /* set by ipc */ };

export function onIntakeProgress(listener: (progress: CaptureIntakeProgress) => void): void {
  intakeProgress = listener;
}

/** What intake did, beyond the recipe it hands back. */
export interface IntakeReport extends CaptureOpened {
  added: number;
  /** Files already in this project, by sha — dropped twice, copied once. */
  duplicates: string[];
  /** Files this stage will not read, and the reason, in words. */
  refused: { file: string; why: string }[];
}

/*
 * `READABLE` STOOD HERE AND IS NOW `PHOTOGRAPH_TYPES` IN shared/capture.ts,
 * with the whole of its argument — the HEIC/PNG/JPEG measurement, and the EXIF
 * double-rotation fear this stage answers by rotating NOTHING — moved intact
 * beside the definition rather than left behind as a summary.
 *
 * It moved because Wave 38 gave the RENDERER an opinion about what a photograph
 * is: Home's drop zone sorts a dropped file into the document door or into the
 * intake workspace before any of it crosses the bridge, and a second list of
 * five extensions over there would be two answers to the one question this
 * stage exists to answer. The refusal written below is now a refusal of exactly
 * the files the other side declined to keep.
 */

/** Which of the readable kinds goes through libheif rather than Electron. */
export const HEIC_LIKE = new Set(['.heic', '.heif']);

/**
 * Copy photographs into the project, decode them once, and add them to the
 * recipe.
 *
 * ── ONE PHOTOGRAPH AT A TIME, ON PURPOSE ────────────────────────────────────
 *
 * A decoded 12-megapixel frame is 48 MiB of RGBA and its PNG is another 12; the
 * acceptance shoot is 27 of them. Held together that is a gigabyte and a half of
 * live heap in the main process for no reason at all, since nothing here needs
 * two photographs at once. Sequential also means an intake that fails halfway
 * leaves every photograph before the failure fully written and catalogued.
 */
export async function intakePhotos(projectDir: string, paths: readonly string[]): Promise<IntakeReport> {
  /*
   * ASKED FOR ONCE, BEFORE ANY DIRECTORY IS MADE OR ANY FILE IS COPIED. If the
   * decoder is missing this throws HERE — one loud failure about the app —
   * rather than inside the loop, where it would become one refusal per
   * photograph about the photographs. Failing before the first `mkdir` also
   * means an intake that cannot possibly work leaves nothing behind.
   */
  decoderModule();
  const originals = originalsDir(projectDir);
  const derived = derivedDir(projectDir);
  await fsp.mkdir(originals, { recursive: true });
  await fsp.mkdir(derived, { recursive: true });

  return withRecipe(projectDir, async () => {
    const recipe = await readRecipe(projectDir);
    const photos = [...recipe.photos];
    const order = [...recipe.order];
    const duplicates: string[] = [];
    /*
     * GUARDED, because a listener is somebody else’s code running inside our
     * loop: a throw from a window that closed mid-intake must not abandon a
     * photograph half-copied. The same argument `importLanded` makes at its own
     * settle, for the same reason.
     */
    const report = (progress: CaptureIntakeProgress): void => {
      try {
        intakeProgress(progress);
      } catch (err) {
        console.error(
          '[capture] the intake-progress listener threw: '
          + `${err instanceof Error ? err.message : String(err)}. The intake continues.`,
        );
      }
    };
    const refused: { file: string; why: string }[] = [];
    let added = 0;

    for (const each of paths) {
      const resolved = path.resolve(each);
      const name = path.basename(resolved);
      /*
       * SAID BEFORE THE WORK, NOT AFTER IT. A progress line that appears once a
       * photograph is finished names the one the person has already waited for;
       * this names the one they are waiting ON.
       *
       * And it is emitted for EVERY path, including those about to be refused or
       * recognised as duplicates: a total counting only successes would make the
       * count jump backwards the moment somebody drops a stray file in with the
       * photographs.
       */
      report({
        projectDir,
        done: added + duplicates.length + refused.length,
        total: paths.length,
        file: name,
      });
      // Between photographs, never inside one: the decode cannot be interrupted,
      // so this is the only place the window gets a chance to breathe.
      await breathe();
      const extension = path.extname(resolved).toLowerCase();
      if (!PHOTOGRAPH_TYPES.has(extension)) {
        refused.push({
          file: name,
          why: `${extension || 'a file with no extension'} is not a photograph this stage reads — HEIC, PNG or JPEG`,
        });
        continue;
      }

      let bytes: Buffer;
      try {
        bytes = await fsp.readFile(resolved);
      } catch (err) {
        refused.push({ file: name, why: `it could not be read: ${(err as Error).message}` });
        continue;
      }

      /*
       * CONTENT-ADDRESSED, so dropping the same folder twice copies nothing and
       * adds nothing. The id IS the hash, so a second copy could not be given an
       * id of its own without breaking the one rule the page ids rest on.
       */
      const id = createHash('sha256').update(bytes).digest('hex');
      if (photos.some((photo) => photo.id === id)) {
        duplicates.push(name);
        continue;
      }

      /*
       * TWO DECODERS, ONE INVARIANT: whatever comes out is the working grid,
       * with no rotation of this intake's own (`PHOTOGRAPH_TYPES`' docblock carries
       * the whole argument). HEIC goes through libheif exactly as before. PNG
       * and JPEG go through Electron's imaging — and a PNG's working copy is
       * THE BYTES THEMSELVES, byte for byte: it is already the lossless format
       * the working copy exists to be, and a decode-reencode of a lossless
       * file buys a chance to be wrong about channel order and nothing else.
       * A JPEG is transcoded once to PNG by the same imaging that decoded it,
       * so no hand-written encoder ever touches a channel order Electron chose.
       */
      let frame: { width: number; height: number };
      let png: Buffer;
      if (HEIC_LIKE.has(extension)) {
        let decoded: DecodedImage;
        try {
          decoded = await decodeHeic(bytes, name);
        } catch (err) {
          refused.push({ file: name, why: (err as Error).message });
          continue;
        }
        frame = { width: decoded.width, height: decoded.height };
        png = await encodePng(decoded);
      } else {
        const image = images().createFromBuffer(bytes);
        if (image.isEmpty()) {
          refused.push({ file: name, why: 'it could not be decoded as an image — the file may be damaged' });
          continue;
        }
        frame = image.getSize();
        png = extension === '.png' ? bytes : image.toPNG();
      }

      const original = `${id}${extension}`;
      const workingCopy = `${id}.png`;
      const thumb = `${id}.${THUMB_EDGE}.jpg`;
      await writeAtomically(path.join(originals, original), bytes);
      await writeAtomically(path.join(derived, workingCopy), png);
      // ONE RESIZE, TWO READINGS -- the JPEG the grid draws and the gutter read
      // off the same pixels. See `thumbnailOf`.
      const thumbnail = thumbnailOf(png, frame);
      await writeAtomically(path.join(derived, thumb), thumbnail.toJPEG(85));

      const stat = await fsp.stat(resolved);
      const { pages, split } = pagesFor(id, photos[photos.length - 1] ?? null);
      photos.push({
        id,
        file: `${ORIGINALS}/${original}`,
        // The name the person dragged in, kept because nothing else here
        // remembers it: the copy is named by hash and the source path is not
        // recorded. It is the only word a sentence about this photograph can use.
        name,
        workingCopy,
        thumb,
        // THE DECODER'S DIMENSIONS. EXIF's are about the other grid, and storing
        // them here would make the aspect rule above answer about a photograph
        // nobody is looking at.
        width: frame.width,
        height: frame.height,
        ...takenAtFrom(readExifTimes(bytes), stat.mtime),
        split,
        /*
         * MEASURED AT INTAKE, ONCE, AND WRITTEN EVEN WHEN IT IS NULL.
         *
         * The bitmap is in hand here and will never be this cheap again: the
         * alternative is `openCapture`'s backfill re-decoding a JPEG off disk
         * for a photograph that has just been resampled in memory. Null is
         * written rather than omitted for the same reason -- absent means
         * NEVER MEASURED, and a page with no visible fold has been measured.
         */
        gutter: gutterFromImage(thumbnail),
        pages,
      });
      order.push(...pages.map((page) => page.id));
      added += 1;
    }

    // The last word: everything asked for is accounted for. Without it a modal
    // driven by this sits at 26 of 27 while the recipe is written.
    report({ projectDir, done: paths.length, total: paths.length, file: '' });

    /*
     * SPREAD, NOT REBUILT — and it was rebuilt until Wave 24, which quietly cost
     * something every time.
     *
     * This wrote `{ version: 1, photos, order }`, so an intake DELETED every
     * field it did not name: the prepare rail's ticks, and now the book's
     * standing crop. Dragging four more photographs into a project was enough to
     * un-answer three questions somebody had already answered, and nothing on
     * the surface said so — the rail simply had its boxes cleared.
     *
     * The two locals are the only things an intake changes. Everything else
     * about the recipe belongs to the person, and the way to keep it is to carry
     * the recipe rather than to remember each field.
     */
    const next: CaptureRecipe = { ...recipe, photos, order };
    await writeAtomically(recipeFile(projectDir), Buffer.from(recipeBytes(next)));
    return {
      recipe: next,
      token: tokenForServing(derived),
      // An intake answers with an opening, so it answers the same question an
      // opening does. Null on a project that has never minted, which is every
      // project an intake is normally run on -- and NOT undefined, which is a
      // field the surface would have to know to treat as silence.
      mintedFrom: await currentArrangement(projectDir),
      added,
      duplicates,
      refused,
    };
  });
}

/**
 * Take photographs out of the project — the recipe, the pixels and the bank.
 *
 * ── REMOVAL IS NOT A STRIKE, AND THE DIFFERENCE IS THE WHOLE FEATURE ────────
 *
 * A strike keeps the photograph and leaves it out of the mint: it is a decision
 * about the BOOK, and it is reversible by looking at the grid and changing your
 * mind. This is a decision about the PROJECT — Owen dragged in the wrong files
 * and wants them gone. So everything goes together: the recipe entry, its pages
 * out of `order`, the derived working copy and thumbnail, AND the original in
 * the bank. Leaving any of those behind would orphan it: a file no recipe names,
 * that nothing will ever delete, in a directory whose whole promise is that
 * everything in it is accounted for.
 *
 * ── DELETING THE BANK IS SAFE TO SAY OUT LOUD, WHICH IS WHY WE SAY IT ───────
 *
 * Everywhere else in this stage the bank is sacred — it is the irreplaceable
 * half, and the door cannot even address it. It is deletable HERE and only here
 * because it holds COPIES: the files the person dragged in still exist wherever
 * they dragged them from. The confirm dialog says exactly that, with the count,
 * before any of this runs. This function does not ask; the surface has already
 * asked, and a door that re-asked would be a second opinion about a decision
 * somebody already made.
 *
 * ── REFUSED MID-MINT ───────────────────────────────────────────────────────
 *
 * A mint holds a list of working copies it is part way through rasterizing. A
 * photograph vanishing under it would be a book quietly short a leaf, or a read
 * of a file that is no longer there — the first is invisible and the second is a
 * crash. Neither is worth allowing so that somebody can tidy up eight seconds
 * earlier.
 *
 * ── AN ID THAT NAMES NOTHING IS NOT AN ERROR ───────────────────────────────
 *
 * The surface sends ids off the grid it drew; by the time they arrive one may
 * already be gone (two windows, a repeated Delete). Deleting something already
 * deleted is SUCCESS — the world is in the state that was asked for. Refusing
 * the whole batch for one stale id would strand the other twenty-six.
 */
export async function removePhotos(
  projectDir: string,
  photoIds: readonly string[],
): Promise<CaptureRecipe> {
  const resolved = path.resolve(projectDir).toLowerCase();
  for (const session of mints.values()) {
    if (path.resolve(session.projectDir).toLowerCase() === resolved) {
      throw new CaptureError(
        'This project is being minted right now. Wait for it to finish, or stop it, before '
        + 'removing photographs — a mint that lost a page half way through would print a book '
        + 'with a leaf missing.',
      );
    }
  }

  return withRecipe(projectDir, async () => {
    const recipe = await readRecipe(projectDir);
    const going = new Set(photoIds);
    const doomed = recipe.photos.filter((photo) => going.has(photo.id));
    if (doomed.length === 0) return recipe;

    const orphanedPages = new Set(doomed.flatMap((photo) => photo.pages.map((page) => page.id)));
    // Spread for intake's reason: a removal decides which photographs are in
    // the project and nothing else, so the ticks and the book's standing crop
    // travel through it untouched rather than being dropped by omission.
    const next: CaptureRecipe = {
      ...recipe,
      photos: recipe.photos.filter((photo) => !going.has(photo.id)),
      order: recipe.order.filter((id) => !orphanedPages.has(id)),
    };

    /*
     * THE RECIPE FIRST, THEN THE FILES. If this crashes between the two, what is
     * left is a project whose recipe is correct and whose `derived/` holds a few
     * files nobody names — wasted disk, and everything on screen is still true.
     * The other order would leave the recipe naming pictures that no longer
     * exist, which is a grid of broken images and a mint that throws.
     */
    await writeAtomically(recipeFile(projectDir), Buffer.from(recipeBytes(next)));

    const derived = derivedDir(projectDir);
    const originals = originalsDir(projectDir);
    for (const photo of doomed) {
      // `force` on every one: a file already gone is the outcome we wanted, and
      // one missing thumbnail must not strand the twenty-six deletions after it.
      await fsp.rm(path.join(derived, photo.workingCopy), { force: true });
      await fsp.rm(path.join(derived, photo.thumb), { force: true });
      await fsp.rm(path.join(projectDir, CAPTURE, ...photo.file.split('/')), { force: true });
    }
    return next;
  });
}
