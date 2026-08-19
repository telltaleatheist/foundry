import { Injectable, computed, inject, signal } from '@angular/core';

import type {
  CaptureIntaken,
  CaptureIntakeProgress,
  CapturePhoto,
  CaptureQuad,
  CaptureRecipe,
} from '@shared/types';

import { halvesOf, joinedQuad, sameShape, splitFromFraction, WHOLE_FRAME } from '@shared/capture';

import { rotate } from '../components/capture-editor/geometry';
import type { CaptureCard } from '../components/capture-grid/capture-grid.component';
import { api } from './foundry';
import { NoticeService } from './notice.service';

/**
 * THE LIGHT TABLE'S STATE — the recipe, and every rule about changing it.
 *
 * ── Where the line falls between this and the components ────────────────────
 *
 * The grid owns an arrangement and the editor owns four corners; NEITHER owns
 * the recipe, and neither can reach IPC. Everything they emit arrives here as a
 * question about the whole project — which photographs are the same shape as
 * this one, which pages belong to which photo, what the order means once
 * somebody has dragged — because those are the questions a single card cannot
 * answer about itself.
 *
 * That is also what lets the two components be pointed at anything: the doc's
 * trap about reversing spreads rather than page cards (below) is a rule about
 * photos, and only this service holds photos.
 *
 * ── PICTURES REACH THE PAGE THROUGH THE DOOR, NEVER THROUGH IPC ─────────────
 *
 * `foundry-file://capture/<token>/<name>`, where the token comes back from
 * `create`, `intake` or `recipeLoad` and the names are `photo.thumb` and
 * `photo.workingCopy` — PLAIN BASENAMES out of `capture/derived/`, which is the
 * only directory the capture token reaches. Nothing here composes a path: the
 * names are written by intake and carried in the recipe, so the layout on disk
 * is main's business alone.
 *
 * THE BANK HAS NO DOOR. `capture/originals/` — the HEIC files that are somebody's
 * only copy of an afternoon in an archive — is not merely unserved but
 * UNADDRESSABLE through the scheme, because no string this service could compose
 * reaches out of `derived/`. That is a property of the flat-name rule rather than
 * a check anybody has to keep right (feature channel, seq 40).
 *
 * ── The recipe is saved WHOLE, and debounced ────────────────────────────────
 *
 * `capture:recipe-save` takes the entire document every time — it is kilobytes
 * for hundreds of photographs, and a patch protocol would be a second way to say
 * what the file already says. Dragging a corner emits on every pointermove, so
 * the writes are debounced here rather than in the editor: the editor should not
 * have to know that saving costs anything.
 */
@Injectable({ providedIn: 'root' })
export class CaptureService {
  private readonly notices = inject(NoticeService);

  private readonly directory = signal<string | null>(null);
  private readonly door = signal<string | null>(null);
  private readonly current = signal<CaptureRecipe | null>(null);

  /**
   * HOW FAR AN INTAKE HAS GOT, or null when none is running.
   *
   * A PUSH RATHER THAN THE INVOKE'S ANSWER, because the invoke cannot speak
   * until it is finished and it is not finished for the better part of a minute
   * (`capture:intake-progress`, main's side). The subscription is armed once
   * for the life of the service rather than per intake: an intake that started
   * before anybody subscribed would push into nothing, and there is no second
   * chance at a progress event.
   *
   * THE CARD LIVES FOR THE INVOKE, NOT FOR THE PUSHES: set before the call and
   * cleared in a finally, so its lifetime is exactly the work it describes.
   *
   * IT IS NOT COUPLED TO THE CHANNEL, and that is the whole reason. If a push
   * never arrives — main throws before the loop, the listener misses its
   * registration, the broadcast goes to a window that has been replaced — a card
   * that waited for one would wait forever, and the person is back to a frozen
   * window with nothing on it, which is the exact complaint it exists to answer.
   * Shown on the invoke it cannot fail to appear, whatever the other end does;
   * cleared in the finally it cannot outlive the work. The pushes only decorate
   * a card that was already going to be there.
   *
   * (An earlier version of this paragraph justified the same decision by saying
   * the first push does not arrive until a photograph is decoded, "over a second
   * on this shoot". P1 measured it at 110 ms — the emit is BEFORE the work, not
   * after it, which is the same decision that makes the payload name the
   * photograph in hand. A correct choice defended by a false claim is the shape
   * this project keeps refusing, so the claim is gone rather than softened.)
   */
  private readonly run = signal<CaptureIntakeProgress | null>(null);
  readonly intakeProgress = this.run.asReadonly();

  /** The recipe on screen, or null when no capture project is open. */
  readonly recipe = this.current.asReadonly();

  /**
   * The cards for the grid, in the recipe's own order.
   *
   * A page whose photo has gone — which nothing writes today, but a hand-edited
   * recipe could — is dropped rather than drawn as a hole, and the count on the
   * header is the number of cards actually drawn.
   */
  readonly cards = computed<readonly CaptureCard[]>(() => {
    const recipe = this.current();
    if (recipe === null) return [];
    const cards: CaptureCard[] = [];
    for (const id of recipe.order) {
      const found = this.pageIn(recipe, id);
      if (found === null) continue;
      cards.push({
        id,
        photoId: found.photo.id,
        thumb: this.url(found.photo.thumb),
        label: `Page ${cards.length + 1}`,
        struck: found.page.struck,
        // The card draws it, so a turn and a crop are visible on the table
        // rather than only inside the editor.
        quad: found.page.quad,
      });
    }
    return cards;
  });

  /**
   * WHETHER SOMEBODY HAS ARRANGED THESE PAGES BY HAND — derived, never stored.
   *
   * The doc rules that "once the user has dragged, the sort is history and their
   * order is the order", and the recipe has nowhere to record that it happened.
   * It does not need one: the order either still runs in capture-time sequence
   * or it does not, and that is a fact ABOUT the order, so reading it off the
   * order cannot get out of step with the order the way a flag could.
   * `descending` was such a flag and left the recipe for this reason (main
   * 9a5a24c, from this service's own argument).
   *
   * ── Read off the TIMES rather than the ids, because of ties ────────────────
   *
   * The obvious derivation — sort the ids and compare the two arrays — breaks on
   * equal capture times, and equal times are not exotic here. A burst is one; a
   * bulk copy that leaves every file with the same mtime is twenty-seven, and
   * `takenAtSource: 'mtime'` says that is exactly how some of these times were
   * got. Where times tie, the ascending and descending sorts produce THE SAME
   * array, so one press of the reverse button would leave an order matching
   * neither, and the toggle would disable itself permanently on a shoot whose
   * only fault was being copied in one go.
   *
   * So this asks the question that survives ties: does the sequence of times
   * ever move against itself? If it never does, in either direction, the sort
   * still applies and nobody has arranged anything.
   *
   * The one imprecision left is worth naming and is harmless: a drag that moves a
   * card WITHIN a run of equal times is not noticed, because nothing changed that
   * the sort has an opinion about.
   */
  readonly arranged = computed(() => {
    const times = this.orderedTimes();
    return !runsWith(times, 1) && !runsWith(times, -1);
  });

  /**
   * Which way the capture-time sort is running, for the reverse button's label.
   * All-equal times read as ascending, which is as true as anything can be.
   */
  readonly descending = computed(() => {
    const times = this.orderedTimes();
    return runsWith(times, -1) && !runsWith(times, 1);
  });

  constructor() {
    /*
     * ARMED FOR THE LIFE OF THE SERVICE, and never torn down: this is a root
     * singleton that lives as long as the window, so an unsubscribe would only
     * ever run at shutdown. Holding the returned function and never calling it
     * would be ceremony that reads like a leak somebody forgot to close.
     */
    api?.capture.onIntakeProgress((progress) => this.run.set(progress));
  }

  /** A door URL for a name intake wrote. Never a path this service composed. */
  url(name: string): string {
    const token = this.door();
    return token === null ? '' : `foundry-file://capture/${token}/${encodeURIComponent(name)}`;
  }

  /** The working copy of the photo a page belongs to, for the editor. */
  workingCopyUrl(pageId: string): string {
    const recipe = this.current();
    if (recipe === null) return '';
    return this.url(this.pageIn(recipe, pageId)?.photo.workingCopy ?? '');
  }

  /** Start a capture project and stand in it. */
  async create(title: string): Promise<string | null> {
    if (api === null) return null;
    try {
      const made = await api.capture.create(title);
      this.directory.set(made.projectDir);
      this.door.set(made.token);
      this.current.set(made.recipe);
      return made.projectDir;
    } catch (err) {
      this.complain(err);
      return null;
    }
  }

  /** Open the recipe of a capture project already on disk. */
  async open(projectDir: string): Promise<void> {
    if (api === null) return;
    try {
      const opened = await api.capture.recipeLoad(projectDir);
      this.directory.set(projectDir);
      this.door.set(opened.token);
      this.current.set(opened.recipe);
    } catch (err) {
      this.complain(err);
    }
  }

  /**
   * Files dropped on the strip.
   *
   * The renderer turns each `File` into a path with `pathForFile` and main does
   * everything else — copying, hashing, decoding, the capture time, the working
   * copy and the thumbnail. A file the browser gave us no path for is skipped
   * and said aloud rather than dropped silently: that happens for a drag out of
   * another application's virtual folder, and the person deserves to know their
   * photograph did not arrive.
   */
  async intake(projectDir: string, files: readonly File[]): Promise<void> {
    /*
     * THE CALLER NAMES THE PROJECT, and that is not ceremony.
     *
     * This used to read `this.directory()`, which is set only AFTER
     * `recipeLoad` resolves. Two things came of that. A drop that landed while
     * the recipe was still loading found it null and returned in SILENCE — the
     * photographs simply did not arrive and nothing said so. And the window
     * drop handler routes on the front TAB while this read the SERVICE, so the
     * two could name different projects and the photographs would land in the
     * wrong one.
     *
     * The tab knows which project it is. Taking it as an argument makes the two
     * one fact, and lets a drop work during the load rather than vanish into it.
     */
    if (api === null) return;
    const paths: string[] = [];
    for (const file of files) {
      const path = api.pathForFile(file);
      // COUNTED, NOT ANNOUNCED HERE. A per-file notice inside this loop
      // overwrites itself: drag in twenty photographs out of another
      // application's virtual folder and the bar shows the twentieth name and
      // nothing about the other nineteen. The one sentence at the end says how
      // many, beside everything else that happened.
      if (path !== '') paths.push(path);
    }
    const unreadable = files.length - paths.length;
    if (paths.length === 0) {
      this.notices.notice.set(
        unreadable === 1
          ? 'That file could not be read from where it was dragged from.'
          : `None of those ${unreadable} files could be read from where they were dragged from.`,
      );
      return;
    }
    // Shown from the moment the ask is made rather than from main's first
    // push, which does not arrive until a photograph is decoded.
    this.run.set({ projectDir, done: 0, total: paths.length, file: '' });
    try {
      const intaken = await api.capture.intake(projectDir, paths);
      this.directory.set(projectDir);
      this.door.set(intaken.token);
      this.current.set(intaken.recipe);
      this.notices.notice.set(reportOn(intaken, unreadable));
    } catch (err) {
      this.complain(err);
    } finally {
      // Cleared here and nowhere else: main's closing push says done === total,
      // but the recipe is not on screen until the invoke has answered, and a
      // card that vanished at the last push would uncover a grid that has not
      // caught up yet.
      this.run.set(null);
    }
  }

  /** The person dragged a card: their order is the order from here on. */
  reorder(order: readonly string[]): void {
    this.change((recipe) => ({ ...recipe, order: [...order] }));
  }

  /**
   * REVERSE, BY SPREAD AND NOT BY CARD — the doc's sharpest trap.
   *
   * "A book shot back-to-front reverses into reading order by spread; within
   * each split the left page still precedes the right. Reversing raw page cards
   * would silently swap every pair."
   *
   * So the photographs are reversed and each photograph's own pages are left
   * alone. Grouping is by first appearance rather than by the recipe's photo
   * list, because after a drag the order is the person's and the groups should
   * follow what is on screen.
   */
  reverse(): void {
    this.change((recipe) => {
      const groups = new Map<string, string[]>();
      for (const id of recipe.order) {
        /*
         * An id no photograph claims groups UNDER ITSELF rather than being
         * skipped. Skipping it dropped it from the order the reversal returned,
         * which is a page deleted from the book by a button that says
         * "Newest first" — and invisibly, because `cards` does not draw an
         * unresolvable id either. It cannot arise from anything this service
         * writes; it can arise from a hand-edited recipe, and electron's
         * validator does not cross-check `order` against the declared pages
         * (raised, channel seq 46). Preserving it costs one `?? id`.
         */
        const photoId = this.pageIn(recipe, id)?.photo.id ?? id;
        const group = groups.get(photoId);
        if (group === undefined) groups.set(photoId, [id]);
        else group.push(id);
      }
      return {
        ...recipe,
        order: [...groups.values()].reverse().flat(),
      };
    });
  }

  /**
   * Remove photographs from the project, bank and all.
   *
   * NOT A STRIKE, and the surface must never let the two be confused: a strike
   * leaves a photograph in the project and out of the book, and this deletes the
   * recipe entry, the working copy, the thumbnail AND the original together, so
   * nothing is left orphaned.
   *
   * ONE CALL FOR THE WHOLE HANDFUL. The person answered one question about nine
   * photographs; nine calls would be nine recipe writes, nine chances to fail
   * half way, and a project that lost four of them. Main writes once.
   *
   * The recipe comes back rather than being re-read, because removal changes
   * which pages exist and the grid must not draw a card for a photograph whose
   * thumbnail has just been deleted underneath it.
   */
  async remove(photoIds: readonly string[]): Promise<void> {
    const dir = this.directory();
    if (api === null || dir === null || photoIds.length === 0) return;
    try {
      const recipe = await api.capture.remove(dir, [...photoIds]);
      this.current.set(recipe);
      this.notices.notice.set(
        photoIds.length === 1
          ? 'One photograph was removed from this project.'
          : `${photoIds.length} photographs were removed from this project.`,
      );
    } catch (err) {
      this.complain(err);
    }
  }

  /** Strike a page, or put it back. Struck pages stay on the table. */
  toggleStrike(pageId: string): void {
    this.change((recipe) => ({
      ...recipe,
      photos: recipe.photos.map((photo) => ({
        ...photo,
        pages: photo.pages.map((page) =>
          page.id === pageId ? { ...page, struck: !page.struck } : page,
        ),
      })),
    }));
  }

  /** The editor moved corners on one photograph. */
  setQuads(photoId: string, quads: readonly CaptureQuad[]): void {
    this.change((recipe) => ({
      ...recipe,
      photos: recipe.photos.map((photo) =>
        photo.id !== photoId
          ? photo
          : {
              ...photo,
              pages: photo.pages.map((page, index) => ({
                ...page,
                quad: quads[index] ?? page.quad,
              })),
            },
      ),
    }));
  }

  /** The editor dragged the split handle. */
  setSplit(photoId: string, at: number): void {
    this.change((recipe) => {
      const photos = recipe.photos.map((photo) => {
        if (photo.id !== photoId) return photo;
        /*
         * ALWAYS FROM THE WHOLE PAGE. This used to record `split.x` and stop —
         * so on the photograph somebody was actually looking at, dragging the
         * gutter stored a number and produced no second page, while
         * `applyToAll` (which skips the source) split every OTHER photograph
         * correctly. The one photo the gesture was performed on was the one
         * photo it did not act on.
         *
         * `joined` and not `pages[0]`, for the same reason the editor draws
         * from it: after the first drag `pages[0]` is the left half, and
         * re-splitting that would halve the page again on every adjustment.
         */
        const whole = joinedQuad(photo.pages.map((page) => page.quad), photo.split);
        const split = splitFromFraction(whole, at);
        const halves = halvesOf(whole, split);
        // Unreachable for a segment built from a fraction — both ends are put
        // on opposite edges by construction — and returning the photograph
        // untouched is the only answer that cannot destroy a page.
        if (halves === null) return photo;
        const [first, second] = halves;
        return {
          ...photo,
          split,
          pages: [
            // Strikes survive a re-drag: which half is a page is a decision
            // about the book, and moving the gutter is not taking it back.
            { id: `${photo.id}:0`, quad: first, struck: photo.pages[0]?.struck ?? false },
            { id: `${photo.id}:1`, quad: second, struck: photo.pages[1]?.struck ?? false },
          ],
        };
      });
      // A split changes which pages exist, so the order grows with it.
      return { ...recipe, photos, order: orderFor(photos, recipe.order) };
    });
  }

  /**
   * APPLY TO ALL — a COPY onto every photograph of the same shape, and a
   * refusal, out loud, for the ones that are not.
   *
   * ── Why shape and not size ──────────────────────────────────────────────────
   *
   * The recipe is in fractions, so a copy between two photographs of the same
   * shape is exact at any resolution. Between two SHAPES it is a stretch that
   * lands inside the frame and looks plausible — the acceptance shoot has
   * twenty-six portrait photographs and one landscape, so this is the shoot we
   * have rather than a hypothetical. `sameShape` (shared/capture.ts) is the 2% test, and
   * the skipped photographs are NAMED rather than silently left out: a copy that
   * quietly did not happen to one card in twenty-seven is worse than one that
   * did the wrong thing loudly.
   *
   * A SPLIT ONLY EVER TOUCHES UNSPLIT PHOTOS, which is the doc's own rule: "a
   * page already split and hand-adjusted is never re-split out from under the
   * user."
   *
   * AND A CROP ONLY COPIES BETWEEN PHOTOS WITH THE SAME NUMBER OF PAGES. Two
   * quads copied onto an unsplit photograph would have to invent a split to hold
   * the second one; one quad onto a split photograph would leave its right-hand
   * page untouched and half-updated. Neither is a thing the person asked for, so
   * both are skips with a reason.
   */
  applyToAll(from: string, gesture: ApplyToAll): ApplyOutcome {
    /*
     * HOISTED OUT OF THE EDIT so the caller can be told what happened. The
     * surface needs it: Owen asked for the BUTTON to acknowledge, and a button
     * that lit up on the click rather than on the act would say "Applied" over
     * a notice bar reporting that everything was skipped.
     */
    const skipped: string[] = [];
    let applied = 0;
    this.change((recipe) => {
      const source = recipe.photos.find((photo) => photo.id === from);
      if (source === undefined) return recipe;
      /*
       * NAMED BY POSITION, NEVER BY FILE.
       *
       * This sentence used to print `photo.file`, which is
       * `originals/<sha>.heic` — content-addressed, because the recipe does not
       * keep the name a photograph arrived under. Owen ran apply-to-all, it
       * worked on twenty-five photographs and skipped the landscape frame
       * exactly as ruled, and the only thing the surface told him was a hex
       * digest. He read the whole act as broken.
       *
       * A person cannot act on a sha. They CAN act on "Photograph 27", because
       * that is what the grid counts and what the editor's own readout says, so
       * the two surfaces agree on how a photograph is referred to. Position is
       * taken from the ARRANGEMENT — first appearance in the order — for the
       * same reason the editor's walk is.
       *
       * THE NAME IT ARRIVED UNDER IS PREFERRED where there is one. P1 added
       * `CapturePhoto.name` after finding that intake had the filename, used it
       * for the refusal and duplicate lists, and then threw it away — so no
       * reach here could ever have printed IMG_0238.HEIC. It is OPTIONAL and
       * must stay so: a recipe written before that field cannot be migrated,
       * because the copy is named by hash and the source path was never
       * recorded. Owen's project is one of those, so position is not a
       * fallback for tidiness — it is the only thing the oldest recipes can say.
       */
      const position = new Map<string, number>();
      for (const pageId of recipe.order) {
        const owner = recipe.photos.find((one) => one.pages.some((page) => page.id === pageId));
        if (owner !== undefined && !position.has(owner.id)) position.set(owner.id, position.size + 1);
      }
      const name = (photo: CapturePhoto): string =>
        photo.name ?? `Photograph ${position.get(photo.id) ?? '?'}`;

      const photos = recipe.photos.map((photo) => {
        if (photo.id === source.id) return photo;
        if (!sameShape(source, photo)) {
          skipped.push(`${name(photo)} (a different shape)`);
          return photo;
        }
        switch (gesture.kind) {
          case 'rotate':
            applied += 1;
            return {
              ...photo,
              pages: photo.pages.map((page) => ({ ...page, quad: rotate(page.quad, gesture.turns) })),
            };
          case 'split': {
            if (photo.split !== null) {
              // It had a sentence in the docblock and none on screen. A skip
              // nobody is told about is the same silence as a skip with no rule.
              skipped.push(`${name(photo)} (already split)`);
              return photo;
            }
            applied += 1;
            // `pages[0]` and not the joined sheet, because this arm has just
            // refused every photograph that is already split: the one page is
            // the whole page.
            const sheet = photo.pages[0]?.quad ?? WHOLE_FRAME;
            const split = splitFromFraction(sheet, gesture.at);
            const halves = halvesOf(sheet, split);
            if (halves === null) return photo;
            const [first, second] = halves;
            return {
              ...photo,
              split,
              pages: [
                { id: `${photo.id}:0`, quad: first, struck: photo.pages[0]?.struck ?? false },
                { id: `${photo.id}:1`, quad: second, struck: false },
              ],
            };
          }
          case 'quad': {
            if (photo.pages.length !== source.pages.length) {
              skipped.push(`${name(photo)} (${photo.pages.length} pages, not ${source.pages.length})`);
              return photo;
            }
            applied += 1;
            return {
              ...photo,
              pages: photo.pages.map((page, index) => ({
                ...page,
                quad: source.pages[index]?.quad ?? page.quad,
              })),
            };
          }
        }
      });

      /*
       * IT ALWAYS SAYS WHAT IT DID, and that is the fix Owen actually needed.
       *
       * This used to speak only when something was SKIPPED, so an apply-to-all
       * that worked perfectly said nothing whatever — and the grid draws raw
       * thumbnails, so twenty-five turned photographs look exactly like
       * twenty-five untouched ones. "didnt work... maybe it takes a while but
       * there was no indicator" is the correct reading of a surface that
       * reports only its own refusals.
       *
       * The verb is the gesture's, because "applied to 25" makes somebody work
       * out what was applied. They pressed a button that said what it would do;
       * the sentence should say it happened.
       */
      const did = gesture.kind === 'rotate'
        ? 'Turned'
        : gesture.kind === 'split' ? 'Split' : 'Set the crop on';
      const count = applied === 1 ? '1 photograph' : `${applied} photographs`;
      this.notices.notice.set(
        skipped.length === 0
          ? `${did} ${count}.`
          : `${did} ${count}. Left alone: ${skipped.join(', ')}.`,
      );
      // A split changes which pages exist, so the order has to grow with it.
      return gesture.kind === 'split'
        ? { ...recipe, photos, order: orderFor(photos, recipe.order) }
        : { ...recipe, photos };
    });
    return { applied, skipped: skipped.length };
  }

  /** The page and the photo it belongs to, or null. */
  private pageIn(
    recipe: CaptureRecipe,
    pageId: string,
  ): { photo: CapturePhoto; page: CapturePhoto['pages'][number] } | null {
    for (const photo of recipe.photos) {
      const page = photo.pages.find((one) => one.id === pageId);
      if (page !== undefined) return { photo, page };
    }
    return null;
  }

  /** The capture time of every card, in the order the grid draws them. */
  private orderedTimes(): readonly string[] {
    const recipe = this.current();
    if (recipe === null) return [];
    const times: string[] = [];
    for (const id of recipe.order) {
      const found = this.pageIn(recipe, id);
      if (found !== null) times.push(found.photo.takenAt);
    }
    return times;
  }

  private change(edit: (recipe: CaptureRecipe) => CaptureRecipe): void {
    const recipe = this.current();
    if (recipe === null) return;
    const next = edit(recipe);
    this.current.set(next);
    this.save(next);
  }

  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Write the recipe, at most once every `SAVE_AFTER_MS` of quiet.
   *
   * The LAST state wins rather than the first: a drag emits a recipe per
   * pointermove and only where the corner came to rest is worth writing. A save
   * that fails says so once and keeps the edit on screen — the recipe in memory
   * is what the person is looking at, and throwing it away to match the disk
   * would lose work to a transient error.
   */
  private save(recipe: CaptureRecipe): void {
    const dir = this.directory();
    // Held in a local rather than read off the module inside the timeout: the
    // narrowing above does not survive into a later callback, and a bridge that
    // was there when the edit happened is the one that should write it.
    const bridge = api;
    if (bridge === null || dir === null) return;
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void bridge.capture.recipeSave(dir, recipe).catch((err: unknown) => this.complain(err));
    }, SAVE_AFTER_MS);
  }

  private complain(err: unknown): void {
    this.notices.notice.set(err instanceof Error ? err.message : String(err));
  }
}

/** What "apply to all" is applying — the gesture, with what it needs to repeat. */
/** What an apply-to-all did, for a surface that has to acknowledge it. */
export interface ApplyOutcome {
  applied: number;
  skipped: number;
}

export type ApplyToAll =
  /** Quarter turns, so every photo gets the TURN rather than this photo's corners. */
  | { kind: 'rotate'; turns: number }
  /** The split line, as a fraction of width. Only unsplit photos are touched. */
  | { kind: 'split'; at: number }
  /** The corners themselves, page for page. */
  | { kind: 'quad' };

const WHOLE: CaptureQuad = [[0, 0], [1, 0], [1, 1], [0, 1]];

/** Quiet before a write. Long enough that a drag is one save, short enough to be invisible. */
const SAVE_AFTER_MS = 400;

/**
 * The order with any newly-split pages folded in beside the page they came from.
 *
 * A split replaces one page with two, and the new right-hand page has to land
 * immediately after its left rather than at the end of the book. Ids not in the
 * photos any more are dropped, which is what removes the pre-split page id.
 */
function orderFor(photos: readonly CapturePhoto[], previous: readonly string[]): string[] {
  const live = new Set(photos.flatMap((photo) => photo.pages.map((page) => page.id)));
  const order: string[] = [];
  const placed = new Set<string>();
  for (const id of previous) {
    const photo = photos.find((one) => one.pages.some((page) => page.id === id));
    if (photo === undefined) {
      // The page this id named is gone — a split replaced it. Its photo's pages
      // go in here, in their own order, so the spread keeps its slot.
      const owner = photos.find((one) => id.startsWith(`${one.id}:`));
      if (owner === undefined) continue;
      for (const page of owner.pages) {
        if (!placed.has(page.id)) { order.push(page.id); placed.add(page.id); }
      }
      continue;
    }
    if (!placed.has(id)) { order.push(id); placed.add(id); }
  }
  for (const id of live) if (!placed.has(id)) order.push(id);
  return order;
}

/**
 * Whether a sequence never moves against `direction`. TIES COUNT AS SORTED,
 * which is the whole reason this is not a comparison of two arrays.
 */
function runsWith(values: readonly string[], direction: 1 | -1): boolean {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1].localeCompare(values[index]) * direction > 0) return false;
  }
  return true;
}

/**
 * What an intake DID, in one sentence a person can act on.
 *
 * Main answers with more than the recipe on purpose (`CaptureIntaken`): a drop
 * containing a screenshot and four photographs this project already holds
 * otherwise looks exactly like a clean import of nothing, and the person is left
 * counting cards to work out what happened to their afternoon. Every clause here
 * exists because its absence is silence.
 *
 * The refusals carry MAIN'S OWN WORDING rather than a rephrasing — it is the
 * side that knows why, and ".txt is not a photograph this stage reads yet" is
 * already a sentence. Two are shown and the rest counted, because a notice bar
 * holding twenty reasons is a notice bar nobody reads.
 */
function reportOn(intaken: CaptureIntaken, unreadable: number): string {
  const said: string[] = [];
  said.push(intaken.added === 1 ? 'One photograph added.' : `${intaken.added} photographs added.`);
  if (intaken.duplicates.length > 0) {
    said.push(
      `${intaken.duplicates.length} already in this project (${intaken.duplicates.slice(0, 2).join(', ')}`
      + `${intaken.duplicates.length > 2 ? ', …' : ''}) — copied once, not twice.`,
    );
  }
  for (const { file, why } of intaken.refused.slice(0, 2)) said.push(`${file}: ${why}`);
  if (intaken.refused.length > 2) said.push(`${intaken.refused.length - 2} more refused.`);
  if (unreadable > 0) {
    said.push(`${unreadable} could not be read from where they were dragged from.`);
  }
  return said.join(' ');
}
