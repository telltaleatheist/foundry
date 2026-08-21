import { Injectable, computed, inject, signal } from '@angular/core';

import type {
  CaptureIntaken,
  CaptureIntakeProgress,
  CapturePage,
  CapturePhoto,
  CapturePrepared,
  CaptureQuad,
  CaptureRecipe,
  CaptureSplit,
} from '@shared/types';

import {
  arrangementOf, halvesOf, joinedQuad, sameShape, turnedLike, turnQuad, turnsOf, WHOLE_FRAME,
} from '@shared/capture';

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
        // The pixels the quad is a fraction OF -- what the card needs to know
        // which way round the page it draws will come out.
        width: found.photo.width,
        height: found.photo.height,
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

    /*
     * THE WINDOW GOING AWAY IS AN EXIT LIKE ANY OTHER, and it is the one exit
     * that cannot wait 400ms.
     *
     * BEST EFFORT, AND SAID PLAINLY RATHER THAN IMPLIED: `beforeunload` cannot
     * await anything, so this starts the write immediately instead of leaving it
     * on a timer. That turns "up to 400ms of unwritten work, guaranteed lost"
     * into "a write already in flight", which is a large improvement and not a
     * guarantee. The guarantee would have to be main refusing to close while a
     * recipe write is outstanding, which is a bigger change than this defect
     * earns and belongs to whoever asks for it.
     */
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => void this.flush());
    }
  }

  /**
   * WRITE THE RECIPE NOW, AND WAIT FOR IT.
   *
   * ── The defect this exists for ──────────────────────────────────────────────
   *
   * The save is debounced 400ms, and `mintBegin` READS THE RECIPE FROM DISK.
   * So a gesture made less than 400ms before Mint is pressed is not in the
   * minted PDF -- and, because the mint records its arrangement from the same
   * disk read, it is not in the recorded arrangement either. The two agree with
   * each other, so the divergence sentence stays QUIET about a book that is
   * missing the last thing somebody did. A silent wrong page in a finished book
   * is the most expensive shape this feature has.
   *
   * ── Why callers do not each remember to call it ────────────────────────────
   *
   * The mint press awaits it, and `open` calls it before replacing what is in
   * memory with what is on disk -- which covers every read-over path there is,
   * including switching to another project and back, rather than the one path
   * somebody thought of. A rule enforced at the door beats the same rule
   * restated at each caller.
   *
   * Nothing pending is the ordinary case and costs one comparison: the timer is
   * null whenever the last write has already gone.
   */
  async flush(): Promise<void> {
    if (this.saveTimer === null) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    const dir = this.directory();
    const recipe = this.current();
    if (api === null || dir === null || recipe === null) return;
    try {
      await api.capture.recipeSave(dir, recipe);
    } catch (err) {
      this.complain(err);
    }
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
    /*
     * THE PREVIOUS PROJECT'S LAST GESTURE, BEFORE THIS ONE OVERWRITES IT.
     *
     * This method replaces the recipe in memory with the one on disk, so
     * anything still sitting on the save timer would be gone -- and the light
     * table calls it whenever the tab changes project, which is an ordinary
     * thing to do half a second after moving a corner. It flushes the OLD
     * directory because `this.directory()` has not moved yet.
     */
    await this.flush();
    try {
      const opened = await api.capture.recipeLoad(projectDir);
      this.directory.set(projectDir);
      this.door.set(opened.token);
      this.mintedFrom.set(opened.mintedFrom);
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

  /**
   * WHICH STAGE THE MODAL OPENS IN — DERIVED, NEVER STORED.
   *
   * Wave 21 gives the editor two stages: one crop for the whole shoot, then
   * per-page corrections. The dangerous reading of that design is a stage kept
   * as state, because the state has to start somewhere and the somewhere is
   * stage 1 -- so an evening of per-page work, closed and reopened to fix page
   * 31, would put a person in front of the one button that stamps over all of
   * it. And pressing that button is how you REACH per-page mode, so it is not
   * even a button they could avoid.
   *
   * A virgin project is the one thing stage 1 is for, and it is visible in the
   * recipe: nothing split, one page each, every quad still the whole frame, no
   * page claiming a hand. Anything else is a project somebody has started, and
   * a project somebody has started opens where they left off.
   *
   * IT IS ALSO NOT THE ONLY GUARD, WHICH IS THE POINT. The stamp always skips
   * hand-set pages and names them, so a derivation that got this wrong would
   * refuse and explain rather than destroy. Ruled at channel seq 129 on exactly
   * that argument: the cheap rule is allowed to be the outer one because the
   * expensive rule is underneath it.
   *
   * EXACT EQUALITY against the whole frame, no tolerance: intake writes that
   * constant, so an untouched quad is those literal numbers rather than a
   * computation that landed near them.
   */
  readonly stage = computed<1 | 2>(() => {
    const recipe = this.current();
    if (recipe === null) return 1;
    const untouched = recipe.photos.every((photo) =>
      photo.split === null
      && photo.pages.length === 1
      && photo.pages.every((page) => page.byHand !== true && isWholeFrame(page.quad)));
    return untouched ? 1 : 2;
  });

  /**
   * WHAT THE PREPARE RAIL SAYS ABOUT THE BOOK — facts, counted, never judged.
   *
   * The rail's three rows each carry a live status beside a tick. The tick is
   * the PERSON speaking and these numbers are the derivation, and the two are
   * kept apart on purpose: THE DERIVATION NEVER CLEARS A TICK. Nothing here
   * decides whether a step is finished, because two of the three cannot be
   * known and the third would still be answering a question nobody asked.
   *
   * ── There is no "turned" count here, and that is a ruling ──────────────────
   *
   * A turn is a CYCLIC PERMUTATION of a quad's corners (geometry.ts rotate);
   * no orientation is stored anywhere, so "upright" is not merely unrecorded,
   * it is unstatable. A count of turns PERFORMED is derivable -- only rotate
   * moves which corner is corner 0, and halvesOf preserves the roles -- and it
   * was proposed and WITHDRAWN, because a count needs a denominator and a
   * denominator asserts a target. On this shoot the correct final state is
   * twenty-five sideways spreads turned and at least two photographs NOT
   * turned: the framed letters are landscape and the magazine advertisement is
   * portrait, and neither wants a turn. "25 of 27 turned" would read as two
   * left to do, and the rail would spend the project quietly asking him to
   * break two pages that are already right. A progress count without a true
   * denominator is a lie with a number in it.
   */
  readonly prepare = computed<PrepareCounts>(() => {
    const recipe = this.current();
    if (recipe === null) return { photos: 0, cropped: 0, byHand: 0, split: 0, pagesFromSplits: 0 };
    let cropped = 0;
    let byHand = 0;
    let split = 0;
    let pagesFromSplits = 0;
    for (const photo of recipe.photos) {
      /*
       * THE SHEET, NOT THE PAGES. Two false positives live in the obvious
       * version of this test, and Owen walks straight into both:
       *
       * A SPLIT photograph has no half that is the whole frame -- halvesOf cuts
       * it in two -- so a spread split down the middle and never cropped would
       * count as cropped. joinedQuad reassembles the sheet the halves came
       * from, which is the thing the question is actually about.
       *
       * A TURNED photograph fails an exact whole-frame test as well, because a
       * turn permutes the corners. He turns twenty-five sideways spreads before
       * he places a single corner, so the rail would have told him "25 cropped"
       * the moment he finished turning.
       */
      const sheet = joinedQuad(photo.pages.map((page) => page.quad), photo.split);
      if (!isWholeFrameTurned(sheet)) cropped += 1;
      if (photo.pages.some((page) => page.byHand === true)) byHand += 1;
      if (photo.split !== null) {
        split += 1;
        pagesFromSplits += photo.pages.length;
      }
    }
    return { photos: recipe.photos.length, cropped, byHand, split, pagesFromSplits };
  });

  /**
   * WHAT THE BOOK ON THE SHELF WAS MINTED FROM — main's answer, not ours.
   *
   * A fingerprint of the arrangement the current book was made from, or null.
   * Main resolves WHICH book that is by walking the catalogue's pdf chain from
   * the tip down to the nearest step that recorded one, and this is simply
   * carried: the renderer computes the LIVE side and never the stored one, so
   * there is one answer to "which book is a person looking at" rather than two
   * that can disagree.
   */
  private readonly mintedFrom = signal<string | null>(null);

  /**
   * THE BOOK ON THE SHELF WAS MINTED FROM AN EARLIER ARRANGEMENT.
   *
   * False whenever there is nothing to say: no recipe, and -- ruled -- no
   * stored arrangement at all. Absent means SILENCE, which covers three true
   * cases at once (no book, a mint from before the field existed, a book this
   * app did not mint), and either claim in that state would be a false sentence
   * from one direction or the other.
   *
   * THE LIVE SIDE IS COMPUTED FROM THE SAME BODY MAIN MINTS WITH.
   * `arrangementOf` lives in shared/ and `mintBegin` calls the same page plan,
   * so the fingerprint cannot drift from the thing it describes: if the two ever
   * disagree the mint is wrong, not this sentence.
   *
   * AND IT IS A HASH OF THE MINT INPUT, NOT OF THE RECIPE FILE, which is what
   * keeps this surface honest about the feature it sits inside. The ticks and
   * the hand-set marks live in the recipe and the mint never reads them -- so a
   * file hash would light this sentence the moment somebody ticked "Turn
   * pages", answering a person who had just said "yes, I turned them" with
   * "the book on the shelf is out of date".
   */
  readonly diverged = computed<boolean>(() => {
    const recipe = this.current();
    const minted = this.mintedFrom();
    if (recipe === null || minted === null) return false;
    return arrangementOf(recipe) !== minted;
  });

  /**
   * After a mint: the shelf moved, so re-read what it was minted from.
   *
   * ONLY THAT. It would be one line shorter to re-open the project, and that
   * would replace the recipe this window is holding with the one on disk --
   * which is the same bytes today and would not be the day somebody adjusts a
   * corner while the mint is still running. The sentence is worth a round trip;
   * it is not worth reaching into the work.
   *
   * A failure leaves the old answer standing rather than clearing it: a stale
   * true sentence is better than a false silence, and the next open corrects it.
   */
  async refreshMintedFrom(): Promise<void> {
    const directory = this.directory();
    if (api === null || directory === null) return;
    try {
      this.mintedFrom.set((await api.capture.recipeLoad(directory)).mintedFrom);
    } catch {
      // Deliberately quiet: nothing a person did failed, and the mint that just
      // landed has already spoken for itself.
    }
  }

  /**
   * HOW MANY PHOTOGRAPHS A BULK TURN WOULD ACTUALLY TURN.
   *
   * The button carries this number, so it has to count what the gesture DOES
   * rather than what the book contains: same shape (the others are named and
   * skipped, exactly as a stamp names them) and sitting at a different turn.
   * A button reading "turn the other 24" that turns twenty-three is the label
   * lying about the act, which is the complaint this whole wave came from.
   *
   * Zero is the ordinary end state -- once the book is uniform the control has
   * nothing to do, and the surface says so rather than going grey in silence.
   */
  outOfTurnWith(photoId: string): number {
    const recipe = this.current();
    if (recipe === null) return 0;
    const source = recipe.photos.find((photo) => photo.id === photoId);
    const like = source?.pages[0]?.quad;
    if (source === undefined || like === undefined) return 0;
    const facing = turnsOf(like);
    return recipe.photos.filter((photo) =>
      photo.id !== source.id
      && sameShape(source, photo)
      && photo.pages.some((page) => turnsOf(page.quad) !== facing)).length;
  }

  /**
   * HOW MANY PHOTOGRAPHS WOULD END UP WITH THIS CONFIGURATION -- the number the
   * crop and split acts carry.
   *
   * The source counts, because it already has it: "use this crop on all 25"
   * describes the state the press leaves the book in, and the source is one of
   * the twenty-five. What is NOT counted is a photograph of another shape,
   * which the stamp refuses and names -- the trio's rule, that a count on a
   * button is what the button does and not what the book contains.
   */
  stampReach(photoId: string): number {
    const recipe = this.current();
    if (recipe === null) return 0;
    const source = recipe.photos.find((photo) => photo.id === photoId);
    if (source === undefined) return 0;
    return recipe.photos.filter((photo) =>
      photo.id === source.id || sameShape(source, photo)).length;
  }

  /**
   * WHAT THE PAGES SOMEBODY SET BY HAND ARE CALLED -- for the sentence that
   * asks before overwriting them.
   *
   * Named rather than counted, because "override 3 pages" and "override
   * IMG_0212, IMG_0227 and IMG_0238" are different questions: the second one a
   * person can check against what they remember doing. The same fallback the
   * skip notice uses, so the two sentences about the same pages cannot call
   * them different things.
   */
  handSetNames(): readonly string[] {
    const recipe = this.current();
    if (recipe === null) return [];
    const at = new Map(recipe.photos.map((photo, index) => [photo.id, index + 1]));
    return recipe.photos
      .filter((photo) => photo.pages.some((page) => page.byHand === true))
      .map((photo) => photo.name ?? `Photograph ${at.get(photo.id) ?? '?'}`);
  }

  /** Whether the person has ticked one of the rail's three verbs. */
  ticked(verb: keyof CapturePrepared): boolean {
    return this.current()?.prepared?.[verb] === true;
  }

  /**
   * The person saying they have looked, or taking it back.
   *
   * IT WRITES A BOOLEAN AND LEAVES THE TIDYING TO MAIN. The validator drops
   * unticked verbs rather than storing false, and removes the key entirely once
   * none are set, so the file says what was answered and stays silent about the
   * rest. Repeating that rule here would be a second implementation of it, free
   * to drift the day a fourth verb exists; both readings answer through
   * `=== true`, so an in-memory false and an absent field are the same answer
   * to every caller.
   */
  tick(verb: keyof CapturePrepared): void {
    this.change((recipe) => ({
      ...recipe,
      prepared: { ...recipe.prepared, [verb]: recipe.prepared?.[verb] !== true },
    }));
  }

  /**
   * THE MINT GATE: every verb ticked, and not one of them derived.
   *
   * Tonight is the argument for it -- he minted before turning because the
   * surface offered the last act first. It applies to projects that already
   * exist, which was decided rather than discovered: a gate that exempted
   * existing projects would exempt exactly the project it was built for.
   */
  readonly readyToMint = computed<boolean>(() => {
    const prepared = this.current()?.prepared;
    return prepared?.turned === true
      && prepared.cropped === true
      && prepared.split === true;
  });

  /**
   * STAGE 2'S PER-PAGE APPLY: this photograph was set by hand and stays that way.
   *
   * It changes no corner. The corners were already saved -- a drag writes
   * through to the recipe as it happens, which is what stops a person losing an
   * adjustment by flipping to the next photograph -- so what is left for this
   * button to do is the part that was never expressible before: say that the
   * setting on this page was CHOSEN FOR THIS PAGE, and that the next global
   * must not quietly take it away.
   *
   * On the photograph, not on one page: a spread is two pages of one picture,
   * and somebody who adjusts the crop has adjusted the picture. Marking only
   * the half whose corner they happened to drag would leave the other half
   * exposed to the next stamp, which is half a protection and reads as none.
   */
  keep(photoId: string): void {
    this.change((recipe) => ({
      ...recipe,
      photos: recipe.photos.map((photo) => {
        if (photo.id !== photoId) return photo;
        // A TOGGLE, because a mark set by mistake would otherwise be permanent
        // and the only escape from it would be a global with the override on --
        // which changes every other page to fix one.
        const marked = photo.pages.some((page) => page.byHand === true);
        return { ...photo, pages: photo.pages.map((page) => ({ ...page, byHand: !marked })) };
      }),
    }));
  }

  /**
   * The editor moved corners on one photograph — WHICH IS WHAT A HAND IS.
   *
   * ── The mark used to wait for a button, and that lost work ──────────────────
   *
   * Only the per-page Apply set `byHand`, so somebody who adjusted page 12's
   * corners and flipped onward without pressing anything had an unprotected
   * crop: the next apply-to-all overwrote it silently and named it in no skip
   * list. That is the one loss the mark exists to prevent, happening on the live
   * path instead of the migration path.
   *
   * And it could not heal. The derivation that infers the mark for old recipes
   * runs only WHILE THE FILE HAS NOT SPOKEN, and the stamp writes `byHand:
   * false` on every page it touches — so the first apply anybody ever pressed
   * switched the inference off for the life of the project, and every drag
   * after that was unprotected for good. The live path was permanently weaker
   * than the migration path, in the direction that costs an evening.
   *
   * ── One rule, two paths ────────────────────────────────────────────────────
   *
   * The migration reads "a quad that is neither the whole frame nor the stamp
   * was dragged". This is the same sentence, written at the moment the drag
   * happens rather than inferred from its result afterwards, and the two must
   * not disagree about what a hand is — two rules for one fact is the shape
   * this feature has paid for repeatedly.
   *
   * ── THE PHOTOGRAPH, NOT THE PAGE ───────────────────────────────────────────
   *
   * A spread is two pages of one picture, and the stamp copies a whole
   * configuration rather than a single quad — so marking only the half whose
   * corner was dragged would leave the other half to be replaced by the next
   * stamp. Half a protection reads as none.
   */
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
                byHand: true,
              })),
            },
      ),
    }));
  }

  /**
   * Turn photographs where they sit on the table — the grid's own act.
   *
   * ── It is the same turn the editor makes, through the same body ────────────
   *
   * `turnQuad` permutes the corner assignment without moving a corner, so a
   * turn from the table and a turn from the editor cannot come out differently:
   * there is one answer to "which way round is this page" and it is `turnsOf`
   * reading the order these four points are in. A second rotation written here
   * would be a second opinion about the same photograph.
   *
   * ── AND IT MARKS BY HAND, for the reason setQuads does ─────────────────────
   *
   * Turning a photograph on the table IS setting it by hand — the person looked
   * at that one and said which way up it goes. Leaving the mark off would let
   * the next apply-to-all silently undo a turn somebody performed deliberately,
   * which is the exact loss the mark exists to prevent, arriving through a new
   * door. Every page of the photograph is marked, not the one that was clicked:
   * a spread is two pages of one picture and half a protection reads as none.
   */
  turnPhotos(photoIds: readonly string[], turns: number): void {
    const wanted = new Set(photoIds);
    if (wanted.size === 0) return;
    this.change((recipe) => ({
      ...recipe,
      photos: recipe.photos.map((photo) => (wanted.has(photo.id) ? turned(photo, turns) : photo)),
    }));
  }

  /** The editor dragged one end of the gutter, or slid the whole cut. */
  setSplit(photoId: string, split: CaptureSplit): void {
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
        const halves = halvesOf(whole, split);
        /*
         * Unreachable for anything the editor can produce -- `seatSplit` is the
         * only way a segment is built from a pointer and it cannot return one
         * that lands on adjacent edges -- and returning the photograph
         * untouched is the only answer that cannot destroy a page.
         *
         * That refusal-by-construction is the whole reason the seating lives in
         * shared/ rather than in the component: a gutter that DRAWS FINE AND
         * REFUSES TO SAVE is this feature's own precedent, from the session
         * where a corner dragged off the frame passed every surface and then
         * stopped the recipe saving for an hour while the light table went on
         * looking alive.
         */
        if (halves === null) return photo;
        const [first, second] = halves;
        return {
          ...photo,
          split,
          pages: [
            // Strikes survive a re-drag: which half is a page is a decision
            // about the book, and moving the gutter is not taking it back.
            /*
             * byHand, for setQuads' reason: placing a cut on THIS photograph is
             * setting it by hand, and the pages were being rebuilt from scratch
             * here -- so the mark was not preserved, it was dropped. A page
             * somebody cut themselves was unprotected from the next
             * apply-to-all, which is the one loss the mark exists to prevent,
             * arriving through the one gesture nobody thought to check.
             */
            { id: `${photo.id}:0`, quad: first, struck: photo.pages[0]?.struck ?? false, byHand: true },
            { id: `${photo.id}:1`, quad: second, struck: photo.pages[1]?.struck ?? false, byHand: true },
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
    /*
     * KEPT AS A REASON PER PHOTOGRAPH so the sentence can GROUP them.
     *
     * It used to be a list of finished strings, which forced the reason to be
     * repeated once per name: "Left alone: IMG_0212 (you set that one by hand),
     * IMG_0215 (you set that one by hand), IMG_0220 (you set that one by hand)."
     * docs/CAPTURE.md asks for the other shape -- "Left alone: pages 3, 7 --
     * you set those by hand" -- which says the reason once and is the voice the
     * rest of this surface already speaks in.
     */
    const skipped: { name: string; why: 'byHand' | 'shape' }[] = [];
    let applied = 0;
    this.change((recipe) => {
      const source = recipe.photos.find((photo) => photo.id === from);
      if (source === undefined) return recipe;
      /*
       * THE ORIENTATION EVERY OTHER PHOTOGRAPH IS BEING ASKED TO MATCH, read
       * once from the source's FIRST page. Any page of it would answer the same
       * -- a split photograph's halves both carry the sheet's turn -- and one
       * read is one answer rather than one per target.
       */
      const like = source.pages[0]?.quad ?? null;
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
        if (photo.id === source.id) {
          /*
           * ONLY THE STAMP CLEARS THE MARK, and the narrowing is a fix rather
           * than a tidy. This arm used to clear it for EVERY gesture, so
           * pressing the bulk-turn button silently handed the source's hand-set
           * crop back to the next global -- a protection lost to a press that
           * had nothing to do with cropping, and lost invisibly.
           *
           * A turn copies no crop, so the source's crop has not become anything
           * and its mark still means what it meant.
           */
          if (gesture.kind !== 'stamp') return photo;
          /*
           * THE SOURCE'S CROP HAS JUST BECOME THE GLOBAL, so it is no longer an
           * outlier and its mark has to go with the rest.
           *
           * Without this, setting the global would permanently exclude the
           * photograph it was set ON from every later global -- the drag that
           * placed it marks it (see setQuads), the stamp skips the source, and
           * the mark would stand forever. The person would have made one page
           * un-stampable by using it to stamp everything else.
           *
           * It needs no idea of which stage it is in, which was the point of
           * putting it here: whatever the source was before, being the source
           * is what it is now.
           */
          return { ...photo, pages: photo.pages.map((page) => ({ ...page, byHand: false })) };
        }
        if (!sameShape(source, photo)) {
          skipped.push({ name: name(photo), why: 'shape' });
          return photo;
        }
        switch (gesture.kind) {
          case 'turn': {
            /*
             * MAKE THIS ONE MATCH THAT ONE -- a question about the book, and
             * never about how many times somebody pressed a button just now.
             *
             * The gesture it replaced applied a RELATIVE number of quarters
             * counted during the current visit to the editor, which had two
             * consequences and neither was intended: the control was dead on
             * arrival at every photograph (the counter resets when the picture
             * changes), so it could not be used at all without first turning
             * something; and stepping to the next page and back forgot the
             * turns you had already made while the page stayed turned.
             *
             * Reading the ORIENTATIONS instead answers the same way ten seconds
             * later or next Tuesday, which is the property `arrangementOf` has
             * for the same reason: a question about state is stable, a question
             * about a visit is not.
             *
             * A PAGE AT A TIME, because a split photograph's halves each carry
             * the sheet's own turn -- measured rather than assumed, P1's
             * twenty-seven checks -- so every page of a spread lands in the same
             * orientation with no special case for the split.
             *
             * It moves no corner. `turnedLike` is a relabelling, so every crop
             * on every photograph survives this to the last decimal.
             */
            if (like === null) return photo;
            applied += 1;
            return {
              ...photo,
              pages: photo.pages.map((page) => ({ ...page, quad: turnedLike(page.quad, like) })),
            };
          }
          case 'stamp': {
            /*
             * THE HAND-SET SKIP, WHICH IS THE ONLY GUARD LEFT ON THIS ARM.
             *
             * Two older skips retired into it. "Already split" was standing in
             * for hand-adjusted from before there was a word for it, and
             * keeping it would have made the first global split permanently
             * un-re-splittable -- a gutter placed slightly wrong on the first
             * pass could never be placed again except by hand, twenty-seven
             * times over. And the page-count refusal existed because a quad
             * copy alone could not invent a split; this arm copies the split
             * too, so a one-page photograph can now receive a two-page
             * configuration and the count follows rather than blocking.
             */
            if (photo.pages.some((page) => page.byHand === true) && !gesture.includeHandSet) {
              skipped.push({ name: name(photo), why: 'byHand' });
              return photo;
            }
            applied += 1;
            /*
             * IT COPIES THE WHOLE CONFIGURATION, NOT THREE GESTURES IN ORDER.
             *
             * The plan-back worried about ordering -- split before rect, or
             * every unsplit photograph is refused on page-count grounds with a
             * reasonable-sounding list of refusals. That ordering problem does
             * not exist once the stamp copies the SOURCE'S PAGES rather than
             * replaying what was done to them: the split, the crop and the turn
             * are all already in those quads, because the corner order IS the
             * orientation and the halves ARE the split.
             *
             * BUT THE TURN IS THE ONE THING IT DOES NOT COPY, and this
             * paragraph used to say the opposite.
             *
             * It said that copying a quad copies the turn -- true, because the
             * corner order IS the orientation -- and drew the conclusion that
             * stage 1 therefore needed no bulk-turn control. Owen ruled the
             * other way: "copy the crop, keep the turn". A photograph you
             * turned upright stays upright when you hand its corners back to
             * the global, because the way round a page sits is a fact about
             * THAT photograph and the crop is a fact about the shoot.
             *
             * So the crop arrives in the TARGET'S OWN ORIENTATION.
             * `turnedLike` moves no corner -- it is a relabelling of which
             * corner prints top-left -- so the region every page gets is the
             * source's region exactly, to the last decimal, with no arithmetic
             * in it to be wrong by a pixel.
             *
             * AND THE CONCLUSION DIED WITH THE PREMISE. Stage 1 now needs the
             * bulk turn as much as stage 2 does, because this button no longer
             * carries one; that control landed in the commit before this one,
             * deliberately in that order, so that the capability existed on
             * purpose before this stopped supplying it by accident.
             *
             * STRIKES BELONG TO THE PHOTOGRAPH, NOT TO THE CONFIGURATION, so
             * they stay where they are. A page struck because it was a blurred
             * retake is still a blurred retake after somebody adjusts the crop.
             */
            /*
             * THE WAY THIS PHOTOGRAPH ALREADY SITS, read before its pages are
             * replaced. Any of its pages would answer the same -- both halves
             * of a spread carry the sheet's turn -- and a target that somehow
             * had none keeps the source's orientation rather than inventing an
             * answer.
             */
            const facing = photo.pages[0]?.quad;
            return {
              ...photo,
              split: source.split,
              pages: source.pages.map((page, index) => ({
                id: `${photo.id}:${index}`,
                quad: facing === undefined ? page.quad : turnedLike(page.quad, facing),
                struck: photo.pages[index]?.struck ?? false,
                // THE GLOBAL CLEARS THE MARK, ruled at channel seq 129. Left
                // standing, the first stamp would mark every page hand-set and
                // the second would skip every one -- a feature that works
                // exactly once per project. And after an explicit include-them
                // override the page is no longer hand-set; it is globally set,
                // and a mark saying otherwise would cost the next global too.
                byHand: false,
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
      const did = gesture.kind === 'turn' ? 'Turned' : 'Applied to';
      const count = applied === 1 ? '1 photograph' : `${applied} photographs`;
      this.notices.notice.set(
        skipped.length === 0
          ? `${did} ${count}.`
          : `${did} ${count}. Left alone: ${leftAlone(skipped)}.`,
      );
      /*
       * ALWAYS REBUILT, because a stamp can now change how many pages a
       * photograph has IN EITHER DIRECTION -- it copies the source's page list,
       * so an unsplit photograph gains a page and a split one can lose the one
       * it had. This used to be rebuilt only for the split gesture, which was
       * true for exactly as long as splitting was the only way to change the
       * count.
       */
      return { ...recipe, photos, order: orderFor(photos, recipe.order) };
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

/** What the prepare rail counts. Facts about the recipe, said in numbers. */
export interface PrepareCounts {
  /** Photographs on the table, struck included -- the rail counts pictures. */
  photos: number;
  /** Photographs whose SHEET has been moved off the whole frame. */
  cropped: number;
  /** Photographs carrying a hand-set page, which the stamp will not overwrite. */
  byHand: number;
  /** Photographs cut into pages. */
  split: number;
  /** The pages those cuts produced, which is what makes the count worth saying. */
  pagesFromSplits: number;
}

export type ApplyToAll =
  /**
   * Quarter turns, so every photo gets the TURN rather than this photo's
   * corners. Kept for STAGE 2 ONLY (ruled, channel seq 129): it is the one act
   * that changes every page without overwriting hand-set crops, because a turn
   * permutes each page's own corners rather than replacing them.
   */
  | { kind: 'turn' }
  /**
   * THE WHOLE CONFIGURATION OF ONE PHOTOGRAPH, COPIED ONTO THE REST.
   *
   * This one arm is what used to be `quad` and `split` and, on a virgin
   * project, `rotate` as well -- three gestures replaying three separate
   * decisions onto every photograph, each with its own skip rule, each free to
   * disagree with the others about which photographs it had touched.
   *
   * `includeHandSet` is the explicit override behind the skip. Off, a stamp
   * leaves hand-set pages alone and names them; on, it takes them too, which is
   * what somebody wants when the global they are correcting is the one that was
   * wrong in the first place.
   */
  | { kind: 'stamp'; includeHandSet?: boolean };

const WHOLE: CaptureQuad = [[0, 0], [1, 0], [1, 1], [0, 1]];

/**
 * Whether a quad is still the whole photograph, corner for corner.
 *
 * Exact, because the value being compared against is the one intake WROTE.
 * A tolerance here would be inventing a question about numbers that were
 * copied rather than computed, and its answer would drift with the tolerance.
 */
/**
   * Whether a quad is the whole photograph UP TO A TURN.
   *
   * Still exact, for `isWholeFrame`'s own reason: intake WROTE those numbers and
   * a turn only reorders them, so nothing here is a computation that landed
   * near a value and no tolerance is being invented.
   *
   * NOT A REPLACEMENT FOR `isWholeFrame`, which `stage` is right to use as it
   * stands: a turn IS something a person did, so a turned project is not virgin
   * and should open where they left off. Same shape, two different questions --
   * written down so the next reader does not fix one into the other.
   */
function isWholeFrameTurned(quad: CaptureQuad): boolean {
  for (let turns = 0; turns < 4; turns += 1) {
    if (isWholeFrame(rotate(quad, turns) as CaptureQuad)) return true;
  }
  return false;
}

function isWholeFrame(quad: CaptureQuad): boolean {
  return quad.every((corner, index) =>
    corner[0] === WHOLE_FRAME[index]![0] && corner[1] === WHOLE_FRAME[index]![1]);
}

/**
 * The photographs a stamp would not touch, said once per reason.
 *
 * Grouped rather than listed, because the reason belongs to the GROUP and
 * repeating it per name is how a sentence stops being read: three hand-set
 * photographs produced the same eight words three times over. The order is the
 * order the reasons were first met, so the sentence follows the arrangement
 * rather than an alphabet nobody chose.
 */
function leftAlone(skipped: readonly { name: string; why: 'byHand' | 'shape' }[]): string {
  const groups: { why: 'byHand' | 'shape'; names: string[] }[] = [];
  for (const one of skipped) {
    const group = groups.find((each) => each.why === one.why);
    if (group === undefined) groups.push({ why: one.why, names: [one.name] });
    else group.names.push(one.name);
  }
  return groups
    .map(({ why, names }) => {
      const many = names.length !== 1;
      const because = why === 'byHand'
        ? `you set ${many ? 'those' : 'that one'} by hand`
        : `${many ? 'different shapes' : 'a different shape'}`;
      return `${names.join(', ')} — ${because}`;
    })
    .join('; ');
}

/** Quiet before a write. Long enough that a drag is one save, short enough to be invisible. */
const SAVE_AFTER_MS = 400;

/**
 * The order with any newly-cut pages folded in beside the page they came from.
 *
 * ── IT USED TO PUT THEM ALL AT THE BACK OF THE BOOK ─────────────────────────
 *
 * The docblock promised this and the code did not do it, and the gap is one
 * assumption: it recognised a new page by the OLD PAGE'S ID HAVING VANISHED.
 * An unsplit photograph's only page is `<photoId>:0` and a split one's pages
 * are `:0` and `:1`, so the old id never vanishes -- the cut ADDS `:1` and
 * leaves `:0` exactly where it was. The "a split replaced it" branch below
 * therefore never ran for a split, and every new right-hand page fell through
 * to the sweep at the end.
 *
 * Measured on four photographs split in one act: A:0 B:0 C:0 D:0 became
 * A:0 B:0 C:0 D:0 A:1 B:1 C:1 D:1 -- every left page, then every right page.
 * A whole book of versos followed by a whole book of rectos, in the minted PDF
 * and nowhere else, because the light table draws the same cards either way and
 * the number in the footer is the same fifty-four.
 *
 * AND THE SINGLE GESTURE IS THE QUIETER ONE (P1, channel seq 138): split ONE
 * spread on a shoot of twenty-five and A:0 B:0 becomes A:0 B:0 A:1 -- one page
 * adrift at the back of an otherwise perfect book. That is the version somebody
 * reaches for first, and the version that survives a reading of the grid.
 *
 * It has been live for as long as splitting has, and it survived because
 * nothing had split a real shoot yet: Owen's recipe holds twenty-five
 * photographs and no splits at all.
 *
 * ── THE RULE, AND WHY IT IS NOT SIMPLY "KEEP A PHOTOGRAPH'S PAGES TOGETHER" ─
 *
 * A page that the arrangement ALREADY NAMES keeps its own slot, and only a page
 * the arrangement has never heard of is folded in beside its sibling. That
 * distinction is the whole of it: somebody who has dragged the two halves of a
 * spread apart on purpose has an order that says so, and a rule that gathered
 * each photograph's pages together would quietly undo it on the next stamp.
 */
function orderFor(photos: readonly CapturePhoto[], previous: readonly string[]): string[] {
  const known = new Set(previous);
  const order: string[] = [];
  const placed = new Set<string>();
  const place = (id: string): void => {
    if (!placed.has(id)) { order.push(id); placed.add(id); }
  };

  for (const id of previous) {
    const owner = photos.find((one) => one.pages.some((page) => page.id === id))
      // The page itself is gone — a stamp can now take a photograph from two
      // pages back down to one — so its photograph is found by the id it was
      // built from, and its remaining pages take the slot.
      ?? photos.find((one) => id.startsWith(`${one.id}:`));
    if (owner === undefined) continue;

    if (owner.pages.some((page) => page.id === id)) place(id);
    for (const page of owner.pages) if (!known.has(page.id)) place(page.id);
  }

  // Whole photographs the arrangement has never seen — an intake since the last
  // save — go on the end, which is where new photographs belong.
  for (const photo of photos) for (const page of photo.pages) place(page.id);
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

/**
 * ONE PHOTOGRAPH, TURNED — AND ITS SPLIT RE-SEATED WITH IT.
 *
 * ── A turn does not move a corner, but it does move a PAGE ─────────────────
 *
 * `turnQuad` permutes the corner assignment without moving any point, so the
 * crop stays on exactly the same part of the photograph however many times it
 * is turned. That is why turning each page's quad on its own LOOKS right.
 *
 * It is not right for a spread, and the measurement says so exactly. Turning
 * the two halves of a centre-split independently, against re-deriving them
 * from the turned sheet:
 *
 *   a quarter turn      the same, both ways
 *   a half turn         THE HALVES SWAP READING ORDER
 *   three quarters      THE HALVES SWAP READING ORDER
 *
 * Which is obvious once seen: turn a spread upside down and the page that was
 * on the left is on the right. The independent turn keeps the old order, so
 * the book silently gets two pages in the wrong sequence -- and it is
 * invisible on the table, because both cards are there and both look correct.
 *
 * So a photograph with a cut in it is turned by rebuilding the WHOLE sheet,
 * turning that, and asking `halvesOf` for the halves again. The split itself
 * is untouched: it is a segment in the photograph's own fraction space and a
 * turn moves nothing, so the cut is still across the same gutter.
 *
 * ── WHAT FOLLOWS A HALF, AND WHAT FOLLOWS AN INDEX ────────────────────────
 *
 * A strike is a decision about a PHYSICAL page -- "this one is a duplicate" --
 * so when the order swaps, the strike has to travel with the half rather than
 * stay on the seat. Each re-derived half is matched back to the turned quad it
 * equals, and carries that page's strike with it. Matching by GEOMETRY rather
 * than by a swap rule means this stays right if `halvesOf` ever orders a turn
 * differently than it does today.
 */
function turned(photo: CapturePhoto, turns: number): CapturePhoto {
  const marked = (page: CapturePage, quad: CaptureQuad): CapturePage =>
    ({ ...page, quad, byHand: true });

  if (photo.split === null || photo.pages.length !== 2) {
    return { ...photo, pages: photo.pages.map((page) => marked(page, turnQuad(page.quad, turns))) };
  }

  const whole = joinedQuad(photo.pages.map((page) => page.quad), photo.split);
  const halves = halvesOf(turnQuad(whole, turns), photo.split);
  // Unreachable for a split this app can produce, and leaving the photograph
  // untouched is the only answer that cannot put a page in the wrong place.
  if (halves === null) return photo;

  const spun = photo.pages.map((page) => turnQuad(page.quad, turns));
  return {
    ...photo,
    pages: halves.map((quad, seat) => {
      const came = spun.findIndex((one) => sameQuad(one, quad));
      const from = photo.pages[came === -1 ? seat : came]!;
      return { ...marked(from, quad), id: `${photo.id}:${seat}` };
    }),
  };
}

/** Two quads, corner for corner. Fractions out of one turn, so exact is honest. */
function sameQuad(a: CaptureQuad, b: CaptureQuad): boolean {
  return a.every((point, index) => point[0] === b[index]![0] && point[1] === b[index]![1]);
}
