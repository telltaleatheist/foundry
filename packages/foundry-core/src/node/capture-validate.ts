/**
 * capture-validate — a recipe read from disk, checked field by field.
 */
import type { CaptureGutter, CaptureLines, CapturePage, CapturePhoto, CapturePrepared, CaptureRecipe, CaptureSplit, CaptureStanding, CaptureTimeSource } from '../shared/types';
import { cutOf, joinedQuad, splitFromFraction } from '../shared/capture';
import { fail, handsRead, validPoint, validQuad } from './capture-hands';

/**
 * Hand the event loop back, so the window stays alive between photographs.
 *
 * ── THE FREEZE THIS EXISTS FOR ──────────────────────────────────────────────
 *
 * Decoding a HEIC is wasm running IN THIS PROCESS and it does not yield. Owen
 * dropped 27 photographs and could not move the window for the better part of a
 * minute: every IPC reply, every paint, every drag of the title bar was behind
 * work that never let go. `setImmediate` between files is not a fix for that —
 * it is the difference between one unbroken minute and twenty-seven two-second
 * pauses with a progress line moving in between.
 *
 * THE REAL ANSWER IS A UTILITY PROCESS and it is deferred out loud in
 * docs/CAPTURE.md rather than built at midnight while somebody is mid-run.
 */
export const breathe = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

export function validRecipe(value: unknown, file: string): CaptureRecipe {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(file, 'it is not an object');
  const row = value as Record<string, unknown>;
  if (row['version'] !== 1) fail(file, `it is version ${String(row['version'])} and this app reads version 1`);
  const photos = row['photos'];
  const order = row['order'];
  if (!Array.isArray(photos)) fail(file, 'it names no photographs');
  if (!Array.isArray(order) || order.some((id) => typeof id !== 'string')) fail(file, 'its order is not a list of ids');

  const seen = new Set<string>();
  const checked: CapturePhoto[] = photos.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) fail(file, `photograph ${index} is not an object`);
    const photo = entry as Record<string, unknown>;
    const text = (key: string): string => {
      const held = photo[key];
      if (typeof held !== 'string' || held.length === 0) fail(file, `photograph ${index} names no ${key}`);
      return held;
    };
    const count = (key: string): number => {
      const held = photo[key];
      if (typeof held !== 'number' || !Number.isFinite(held) || held <= 0) {
        fail(file, `photograph ${index} has no positive ${key}`);
      }
      return held;
    };
    const id = text('id');
    if (seen.has(id)) fail(file, `two photographs share the id ${id}`);
    seen.add(id);
    const source = photo['takenAtSource'];
    if (source !== 'exif-offset' && source !== 'exif-local' && source !== 'mtime') {
      fail(file, `photograph ${index} says its time came from ${String(source)}`);
    }
    const pages = photo['pages'];
    if (!Array.isArray(pages)) fail(file, `photograph ${index} names no pages`);
    const checkedPages: CapturePage[] = pages.map((page, pageIndex) => {
      if (typeof page !== 'object' || page === null) fail(file, `page ${pageIndex} of photograph ${index} is not an object`);
      const held = page as Record<string, unknown>;
      const pageId = held['id'];
      if (typeof pageId !== 'string' || pageId.length === 0) fail(file, `page ${pageIndex} of photograph ${index} has no id`);
      if (typeof held['struck'] !== 'boolean') fail(file, `page ${pageId} does not say whether it is struck`);
      /*
       * CARRIED, NEVER CONSULTED — and carrying is the whole job.
       *
       * Nothing in main reads `byHand`: not the mint, not a rule in this file.
       * But this function REBUILDS every page field by field, so a field it
       * did not name would be dropped here — and since `writeRecipe` validates
       * on the way out too, the mark would not survive one save. The thing it
       * exists to protect is an evening of per-page crops, so it is written
       * down here rather than assumed to flow through.
       *
       * Absent is legal and means false (every recipe before Wave 21). Present
       * and not a boolean is a writer that thinks it marked a page and did
       * not, which is worth refusing for the same reason an empty name is.
       */
      const byHand = held['byHand'];
      if (byHand !== undefined && typeof byHand !== 'boolean') {
        fail(file, `page ${pageId} says it was set by hand in something that is not a yes or a no`);
      }
      return {
        id: pageId,
        quad: validQuad(held['quad'], file, `page ${pageId}`),
        struck: held['struck'] as boolean,
        ...(typeof byHand === 'boolean' ? { byHand } : {}),
      };
    });
    /*
     * A PHOTOGRAPH IS ONE PAGE OR TWO, and a split means two.
     *
     * The split line is the gesture that DERIVES the second quad, so a recipe
     * claiming a split over one page has lost one of them somewhere between the
     * editor and here — and the mint would print a spread as a single page
     * without ever noticing the other was gone. The converse is deliberately
     * NOT checked: two quads and no split line is a person who cropped both
     * halves by hand, which is allowed.
     */
    if (checkedPages.length < 1 || checkedPages.length > 2) {
      fail(file, `photograph ${index} has ${checkedPages.length} pages, and a photograph is one page or two`);
    }

    /*
     * ── THE SPLIT IS READ AGAINST THE PAGES, WHICH IS WHY IT IS READ HERE ───
     *
     * It was parsed before them for as long as it was one number. A segment
     * is two points ON THE EDGES OF THE PAGE IT CUTS, so it cannot be checked
     * — or migrated — without the sheet those pages make.
     *
     * MIGRATION HAPPENS ON EVERY READ, not in a pass somebody remembers to
     * run. A recipe holding `{ x }` is the normal case on this machine right
     * now, and a one-shot migration is a migration that can be missed: read
     * it as the vertical segment it always meant, and the next save writes
     * the segment. The fraction was measured ALONG THE QUAD, so it is turned
     * into points against the sheet rather than against the photograph.
     */
    const held = photo['split'];
    let split: CaptureSplit | null = null;
    if (held !== null && held !== undefined) {
      if (typeof held !== 'object' || Array.isArray(held)) fail(file, `photograph ${index} has a split that is not a line`);
      const asked = held as Record<string, unknown>;
      const sheet = joinedQuad(checkedPages.map((page) => page.quad), null);
      if (asked['a'] === undefined && asked['b'] === undefined) {
        const x = asked['x'];
        if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 1) {
          fail(file, `photograph ${index} has a split at ${String(x)}, which is not a fraction of its width`);
        }
        split = splitFromFraction(sheet, x);
      } else {
        split = {
          a: validPoint(asked['a'], file, `photograph ${index}'s split starts where it`),
          b: validPoint(asked['b'], file, `photograph ${index}'s split ends where it`),
        };
      }
      /*
       * OPPOSITE EDGES OR NOTHING. A segment between neighbouring edges takes
       * a corner off — a triangle and a pentagon — and the mint prints four
       * corners or nothing at all. No drag can produce it (`seatSplit` builds
       * every dragged segment opposite by construction), so reaching this
       * means a hand-edited file, which is exactly what the refusal says.
       */
      if (cutOf(sheet, split) === null) {
        fail(file, `photograph ${index} has a split running between neighbouring edges, which cuts a corner off the page rather than cutting it in two`);
      }
    }
    if (split !== null && checkedPages.length !== 2) {
      fail(file, `photograph ${index} is split but holds ${checkedPages.length} page(s)`);
    }
    /*
     * ABSENT IS LEGAL, EMPTY IS NOT. A recipe from before the field existed has
     * no name and cannot be given one (see `CapturePhoto.name`); a recipe that
     * carries the key with nothing in it is a writer that thinks it set a name
     * and did not, and that is worth refusing rather than rendering as a blank.
     */
    const dropped = photo['name'];
    if (dropped !== undefined && (typeof dropped !== 'string' || dropped.length === 0)) {
      fail(file, `photograph ${index} has a name that is not a name`);
    }

    /*
     * THE BOOK STOPS MOVING THIS ONE — carried, never consulted, and carrying
     * is again the whole job.
     *
     * `byHand`'s contract for the fourth time, and it earns the fourth telling
     * because the two fields fail differently. A dropped `byHand` loses a mark
     * that could be re-derived from the quads (`handsRead`, above). A dropped
     * `complete` loses an answer NOTHING can re-derive: the say-so is a person
     * speaking about a page they decided not to move, so it leaves no trace in
     * the geometry, and a release leaves a page whose lines still look
     * hand-placed. Both would silently revert to the derive on the next save.
     *
     * ABSENT IS LEGAL AND IS NOT A FALSE. It means "ask the pages" — see
     * `CapturePhoto.complete`. Present and not a boolean is a writer that
     * thinks it recorded a decision and did not.
     */
    const said = photo['complete'];
    if (said !== undefined && typeof said !== 'boolean') {
      fail(file, `photograph ${index} says it is complete in something that is not a yes or a no`);
    }

    /*
     * WHERE THE FOLD LOOKED TO BE -- carried, checked, and read by nothing in
     * main except the backfill that writes it.
     *
     * `byHand`'s contract for the fifth time, and the fifth telling earns
     * itself on the THIRD state. A dropped `gutter` would not merely lose a
     * measurement: absent means NEVER MEASURED (see `CapturePhoto.gutter`), so
     * dropping it on every save would send `openCapture`'s backfill back to
     * work on the next open, decoding every thumbnail in the book, forever,
     * to write a field the save would drop again. An optional field main
     * "ignores" is not free here; it is a loop.
     *
     * NULL IS LEGAL AND IS NOT ABSENT. It is the honest answer for a page with
     * no visible fold, and the whole reason `gutterOf` is allowed to return
     * one rather than guessing the middle.
     *
     * THE AXIS IS A CLOSED SET AND `at` IS A FRACTION, on the same argument
     * `validPoint` makes: the unit is a share of the working copy, and outside
     * [0,1] is off the photograph. An axis this side accepted and did not
     * understand would be compared against a split's direction and silently
     * never match, which is a feature that quietly does nothing.
     */
    const noticed = photo['gutter'];
    let gutter: CaptureGutter | null | undefined;
    if (noticed === null) gutter = null;
    else if (noticed !== undefined) {
      if (typeof noticed !== 'object' || Array.isArray(noticed)) {
        fail(file, `photograph ${index} has a gutter that is not a measurement`);
      }
      const measured = noticed as Record<string, unknown>;
      const axis = measured['axis'];
      if (axis !== 'x' && axis !== 'y') {
        fail(file, `photograph ${index} says its gutter runs along ${String(axis)}, and a gutter runs along x or y`);
      }
      const at = measured['at'];
      if (typeof at !== 'number' || !Number.isFinite(at) || at < 0 || at > 1) {
        fail(file, `photograph ${index} has its gutter at ${String(at)}, which is not a fraction of the frame`);
      }
      const rule = measured['rule'];
      if (rule !== undefined && (typeof rule !== 'number' || !Number.isInteger(rule) || rule < 1)) {
        fail(file, `photograph ${index} says its gutter was measured under rule ${String(rule)}`);
      }
      const ends = measured['ends'];
      const fraction = (value: unknown): value is number =>
        typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
      if (ends !== undefined && (!Array.isArray(ends) || ends.length !== 2 || !ends.every(fraction))) {
        fail(file, `photograph ${index} has gutter ends that are not two fractions of the frame`);
      }
      gutter = {
        axis,
        at,
        ...(ends === undefined ? {} : { ends: [ends[0], ends[1]] as [number, number] }),
        ...(rule === undefined ? {} : { rule }),
      };
    }

    return {
      id,
      file: text('file'),
      ...(typeof dropped === 'string' ? { name: dropped } : {}),
      workingCopy: text('workingCopy'),
      thumb: text('thumb'),
      width: count('width'),
      height: count('height'),
      takenAt: text('takenAt'),
      takenAtSource: source as CaptureTimeSource,
      split,
      ...(gutter === undefined ? {} : { gutter }),
      pages: checkedPages,
      ...(typeof said === 'boolean' ? { complete: said } : {}),
    };
  });

  /*
   * ── THE ORDER AND THE PAGES MUST BE THE SAME SET ──────────────────────────
   *
   * `order` is the only stored truth about arrangement, and the mint walks IT
   * rather than the photographs. So a page id missing from it is a leaf that is
   * never printed and never drawn — invisible on the grid, so nobody can even
   * see that it is gone — and a repeated id mints the same page twice.
   *
   * FOUND ON P2’S READ-BACK, and not hypothetically: their reverse() dropped an
   * id it could not resolve instead of preserving it, so an inconsistent recipe
   * accepted here would have had a page silently deleted by the next press of a
   * button. Each half of that was nearly unreachable alone. Together they were a
   * path, which is what most real losses are made of.
   */
  const pageIds = checked.flatMap((photo) => photo.pages.map((page) => page.id));
  const listed = new Set(order as string[]);
  if (listed.size !== order.length) fail(file, 'its order lists the same page twice');
  if (listed.size !== pageIds.length || pageIds.some((id) => !listed.has(id))) {
    const missing = pageIds.filter((id) => !listed.has(id));
    const unknown = (order as string[]).filter((id) => !pageIds.includes(id));
    fail(file, 'its order does not list every page exactly once'
      + (missing.length > 0 ? ` (missing ${missing.length})` : '')
      + (unknown.length > 0 ? ` (naming ${unknown.length} that do not exist)` : ''));
  }

  /*
   * ── THE TICKS: CARRIED, REFUSED IF WRONGLY TYPED, CONSULTED BY NOTHING ────
   *
   * `byHand`'s contract one level up, and for `byHand`'s exact reason: this
   * function rebuilds the recipe field by field and `writeRecipe` validates on
   * the way out too, so a field main "ignores" is erased on the next save and
   * would not survive one round trip. Nothing in main reads these — not the
   * mint, which is deliberate: the gate belongs to the rail, and a person who
   * mints from the keyboard has not lied to anybody.
   *
   * ABSENT IS LEGAL AT BOTH LEVELS. No `prepared` at all is every recipe ever
   * written; a `prepared` naming one verb is somebody who has ticked one box,
   * which is the ordinary state for most of the time this field exists. Present
   * and not a boolean is a writer that thinks it recorded an answer and did not,
   * and that is worth refusing rather than reading as a no.
   *
   * THE UNTICKED VERBS ARE DROPPED RATHER THAN WRITTEN FALSE, so the file says
   * what somebody answered and stays silent about what they have not been asked.
   */
  const prepared = row['prepared'];
  let ticks: CapturePrepared | undefined;
  if (prepared !== undefined && prepared !== null) {
    if (typeof prepared !== 'object' || Array.isArray(prepared)) {
      fail(file, 'it records what has been prepared in something that is not a set of answers');
    }
    const answers = prepared as Record<string, unknown>;
    const verbs = ['turned', 'cropped', 'split'] as const;
    for (const verb of verbs) {
      const answer = answers[verb];
      if (answer !== undefined && typeof answer !== 'boolean') {
        fail(file, `it says the pages were ${verb} in something that is not a yes or a no`);
      }
    }
    const kept = verbs.filter((verb) => answers[verb] === true);
    if (kept.length > 0) {
      ticks = Object.fromEntries(kept.map((verb) => [verb, true])) as CapturePrepared;
    }
  }

  const standing = validStanding(row['book'], file);

  /*
   * WHICH PASS THE PROJECT IS IN — carried for the reason everything optional
   * here is carried, and refused for a reason of its own.
   *
   * `'split'` OR ABSENT, AND NOTHING ELSE. Absent is the crop pass and is every
   * recipe ever written; there is deliberately no `'crop'` to write, so a file
   * saying one is a file written against a model this app does not have. A pass
   * this side accepted and did not understand would be read as "not the split
   * pass" and would silently reopen somebody's crops.
   */
  const pass = row['pass'];
  if (pass !== undefined && pass !== 'split') {
    fail(file, `it says the project is in the ${String(pass)} pass, and a project is in the split pass or in neither`);
  }

  return {
    version: 1,
    photos: handsRead(checked),
    order: order as string[],
    ...(ticks === undefined ? {} : { prepared: ticks }),
    ...(standing === undefined ? {} : { book: standing }),
    ...(pass === 'split' ? { pass } : {}),
  };
}

/**
 * THE BOOK'S STANDING CROP AND CUT — carried, refused if malformed, read by
 * nothing in main.
 *
 * `byHand`'s contract for the third time and for the third time it is not
 * politeness: `validRecipe` rebuilds the recipe field by field and `writeRecipe`
 * validates on the way out too, so a field main "ignores" is DELETED on the next
 * save. The thing this one protects is the answer to "what do the rest of the
 * pages look like", which a person set once and expects to still be there next
 * week.
 *
 * ── Absent at every level, and each absence means something different ──────
 *
 * No `book` at all is every recipe written before Wave 24 and every project
 * before its first *Crop all*. A `book` with no `crop` is a book whose pages are
 * uncropped and cut anyway — a shoot of spreads photographed edge to edge, which
 * is a real thing somebody can do. A `crop` with no `cut` is the ordinary book
 * of single pages. So none of the three is required and none of them implies
 * another.
 *
 * ── AND THE TWO SIDES OF THE BOOK, SINCE WAVE 51b ─────────────────────────
 *
 * `odd` and `even` are the same pair of lines again, for the photographs on one
 * side of a recto/verso shoot (`CaptureStanding`). They are carried through the
 * same body as the book's own, which is the whole reason the body was split out:
 * three standings validated by three transcriptions of one rule is the drift
 * shape this feature has paid for by name. Absent is "that side never asked",
 * which is every recipe written before this wave — so there is nothing to
 * migrate and nothing to guess.
 *
 * ── WHAT IT REFUSES, AND THE ONE THING IT DOES NOT CHECK ───────────────────
 *
 * A quad that is not four points, a frame with no positive size, a cut that is
 * not two points: all refused, because each is a writer that believes it
 * recorded a standing and did not. What is NOT checked is whether the cut lands
 * on opposite edges of the crop — the per-photograph split is checked for that
 * (a corner cut off is a shape the mint cannot print), but the standing is never
 * printed. It is re-seated by `halvesOf` against whatever sheet it is applied
 * to, and a standing that resolves to nothing simply offers no cut. Refusing to
 * OPEN a project over a line that only ever proposes would be the validator
 * spending a person's whole recipe on a suggestion.
 */
export function validStanding(value: unknown, file: string): CaptureStanding | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    fail(file, 'it records the book\'s crop in something that is not a crop and a cut');
  }
  const row = value as Record<string, unknown>;
  const book = validLines(row, file, 'the book\'s');
  const odd = validSide(row['odd'], file, 'the book\'s odd-page');
  const even = validSide(row['even'], file, 'the book\'s even-page');

  // A standing holding nothing at any level is a standing that says nothing, and
  // writing the empty object back would be a key that means "somebody pressed
  // the button and nothing came of it". Silence says that better.
  if (book === undefined && odd === undefined && even === undefined) return undefined;
  return {
    ...(book ?? {}),
    ...(odd === undefined ? {} : { odd }),
    ...(even === undefined ? {} : { even }),
  };
}

/**
 * ONE SIDE OF THE BOOK'S OWN LINES, or nothing.
 *
 * Separate from `validLines` below only to name the container: `odd` has to BE
 * an object before its crop can be looked for, and the sentence a person reads
 * should say which side of the book their file is wrong about.
 */
export function validSide(value: unknown, file: string, whose: string): CaptureLines | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    fail(file, `${whose} lines are recorded in something that is not a crop and a cut`);
  }
  return validLines(value as Record<string, unknown>, file, whose);
}

/**
 * A CROP AND A CUT, wherever they are written — the book's own, or one side's.
 *
 * The ONE body for all three, because "what a standing looks like" must not have
 * three transcriptions free to drift the day a fourth caller exists. `whose`
 * only decides the words in the refusal, so the file's complaint names the thing
 * that is wrong rather than a field name three levels up.
 *
 * Undefined for a block holding neither, which is what lets the caller drop it
 * rather than write a key meaning nothing.
 */
export function validLines(
  row: Record<string, unknown>,
  file: string,
  whose: string,
): CaptureLines | undefined {
  let crop: CaptureLines['crop'];
  const held = row['crop'];
  if (held !== undefined && held !== null) {
    if (typeof held !== 'object' || Array.isArray(held)) fail(file, `${whose} crop is not a crop`);
    const asked = held as Record<string, unknown>;
    const side = (key: string): number => {
      const measure = asked[key];
      if (typeof measure !== 'number' || !Number.isFinite(measure) || measure <= 0) {
        fail(file, `${whose} crop was drawn for a frame with no ${key}`);
      }
      return measure;
    };
    crop = {
      quad: validQuad(asked['quad'], file, `${whose} crop`),
      width: side('width'),
      height: side('height'),
    };
  }

  let cut: CaptureSplit | undefined;
  const line = row['cut'];
  if (line !== undefined && line !== null) {
    if (typeof line !== 'object' || Array.isArray(line)) fail(file, `${whose} cut is not a line`);
    const ends = line as Record<string, unknown>;
    cut = {
      a: validPoint(ends['a'], file, `${whose} cut starts where it`),
      b: validPoint(ends['b'], file, `${whose} cut ends where it`),
    };
  }

  if (crop === undefined && cut === undefined) return undefined;
  return { ...(crop === undefined ? {} : { crop }), ...(cut === undefined ? {} : { cut }) };
}
