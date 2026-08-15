import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';

import type { FoundryApi } from '@shared/api';
import { categoryLabel, pdfCategoryLabel } from '@shared/categories';
import type { CurationLock } from '@shared/curation-lock';
import { positionPicture, positionView, type PositionView } from '@shared/ledger';
import { fold } from '@shared/original';
import {
  amendOverlay,
  chaptersText,
  chaptersOfText,
  compareTargets,
  decisionsOf,
  parseTargetKey,
  setChapters,
  type CurationContent,
  type FrozenCuration,
  type OverlayChapter,
  type OverlayDecision,
  type OverlayField,
  type OverlayFile,
} from '@shared/overlay';
import type {
  EpubBook,
  HeadingEcho,
  JobKind,
  LedgerAction,
  LedgerField,
  LedgerLoad,
  LedgerRow,
  LedgerStacks,
  OverlayLoad,
  PdfBlock,
  PdfBlockPage,
  PdfDetectedChapter,
  UnlinkedNote,
} from '@shared/types';

import { LedgerService } from './ledger.service';
import { ProjectsService } from './projects.service';
import { QueueService } from './queue.service';
import { api } from './foundry';

/**
 * The open documents — the list down the left, and the one place that knows
 * which is which.
 *
 * TABS ARE RENDERER STATE, on purpose. Main owns everything with a lifetime — a
 * conversion, an unpacked book's temp directory, the allow-list — but which of
 * them is on screen and in what order is a window's own business, and pushing
 * that through IPC would make a reload of the renderer able to disturb it.
 *
 * The one door in is `document:opened`. The menu, the dialog, a drop, a path on
 * argv and a conversion that just finished all reach main first (which decides
 * whether the file is openable at all) and arrive back here as that event. So
 * this service never has to decide whether a path is real, and there is exactly
 * one code path that creates a tab.
 *
 * ── Panes ────────────────────────────────────────────────────────────────────
 *
 * The workspace is one to five PANES side by side, and A PANE SHOWS EXACTLY ONE
 * DOCUMENT. They exist for one comparison in particular: a book beside its
 * translation, the German page and the English page under two hands at once.
 * Everything else about panes follows from that, including the auto-open rule (a
 * finished job lands in a pane of its OWN, so a translation appears beside its
 * source rather than on top of it).
 *
 * EACH PANE USED TO CARRY A CHROME-STYLE STRIP of its own — VS Code's editor
 * groups, a stack of tabs per column. Five columns on a 1920-wide window give
 * each strip 370 pixels, and three tabs in one of them are unreadable stubs, so
 * the strips are gone and the documents are a VERTICAL LIST in a panel of their
 * own (app-open-documents). A list does not degrade with the number of columns,
 * every pane got its 44px strip back as page, and the list is the only place a
 * document's order exists.
 *
 * THE TABS STAY IN ONE FLAT LIST and the panes hold ids into it. A pane owning
 * whole Tab objects would put `patch()` — the one function every edit, save and
 * flag in this file goes through — behind a search of a list of lists, and the
 * first thing to rot would be an edit landing in one pane's copy of a tab while
 * another pane showed the other. One list, one identity per tab; the panes
 * decide only where each is shown.
 *
 * A DOCUMENT IS IN AT MOST ONE PANE. Clicking a row for something already on
 * screen REVEALS it rather than putting a second viewer over one unpack — the
 * rule `adopt()` has always enforced for files — and dragging a row MOVES it.
 * Two panes on one tab would also share its `chapterHref`, so the two columns
 * would look scroll-locked to each other for reasons nothing on screen explains.
 *
 * ONE PANE IS FOCUSED, and it is what the rail, the menu and the keyboard mean
 * by "the document": `active()` is the focused pane's document and nothing else.
 * With a single pane open, that is exactly the app that existed before panes did
 * — the feature is meant to be invisible until it is used.
 *
 * ── The HTML editor is a tab, not a mode ─────────────────────────────────────
 *
 * "Edit HTML" used to split the book's own tab down the middle. It opens a tab
 * now — kind `editor`, pointed at the book's tab through `sourceTabId` — which
 * the pane rules then place beside the book like anything else. One document
 * with two faces rather than two documents: the editor has no book of its own,
 * reads the source tab's chapter, and writes through the same `writeChapter`
 * that bumps the source's revision and reloads whatever pane is rendering it.
 */

export type TabKind = 'pdf' | 'epub' | 'editor';

export interface Tab {
  id: string;
  kind: TabKind;
  /**
   * The file this tab is showing. For a conversion that has not been saved
   * anywhere, that is the copy in the managed workspace — and it stays that even
   * after Save As, because the saved file is a byte-for-byte copy and re-opening
   * it would throw away an unpack for nothing.
   */
  path: string;
  /**
   * WHAT THIS DOCUMENT IS CALLED, which is never its filename.
   *
   * A stem is built to survive a filesystem — `Working-Towards-The-Fuhrer.-
   * Kershaw-Ian.-1993` — and this app used to put that on the pane, in the
   * window's own title bar and in the list down the left. It is the name of a
   * file, not of a book, and the two surfaces that showed it disagreed with the
   * one that did not: Home has always said "Working Towards the Führer".
   *
   * So it is the BOOK's name — the project's title where a project claims this
   * file, the book's own `dc:title` once it has been unpacked — and only where
   * neither exists does it fall back to the file, said aloud (`spokenName`).
   * The filename itself survives in the row's tooltip and in the save dialog,
   * which are the two places somebody is asking about a file rather than about
   * a book.
   */
  title: string;
  /**
   * True once something CHOSE this title, rather than it being derived from
   * whatever the document happens to be called on disk.
   *
   * IT REPLACES A STRING COMPARISON, and the comparison was the fragile part. The
   * rule has always been "never clobber a title somebody chose" — a book's
   * `dc:title` must survive the file moving between folders — and it used to be
   * enforced by testing whether the title still EQUALLED the basename, which
   * quietly stops working the moment the derived name is anything other than the
   * basename. Written down as a flag, the rule is the same rule and cannot be
   * broken by improving the fallback.
   */
  named: boolean;
  /**
   * The Chrome dot. True while no copy of this book exists anywhere the user
   * chose — it lives in the library workspace and nowhere else.
   *
   * DISTINCT FROM `modified`, and the distinction is the whole point. This one
   * is about a book nobody has filed; that one is about a filed copy that has
   * fallen behind. A tab can be either, both, or neither, and the close warning
   * says something different for each.
   */
  unsaved: boolean;
  /**
   * Edited since the copy at `savedPath` was written.
   *
   * The app DOES edit documents now (the chapter editor), so "nothing in this
   * app modifies a document" is no longer true and this flag is what replaced
   * it. It never means the edits are at risk: every keystroke that lands is
   * written through to the workspace copy before this is set.
   */
  modified: boolean;
  /**
   * Where Save/Save As put it, once it has been anywhere. Seeded with the file
   * itself for a book opened from the user's own disk — that file is already a
   * copy they chose, and Save should update it rather than ask.
   */
  savedPath: string | null;
  /** The unpacked book. Null for a PDF, and for an EPUB that is still opening. */
  book: EpubBook | null;
  /** Which chapter the viewer is showing. */
  chapterHref: string | null;
  /**
   * For an `editor` tab: the EPUB tab whose chapter it is editing.
   *
   * The link runs THIS WAY ONLY. A book pointing at its editor as well would be
   * two facts to keep agreeing, and the one that fell behind would be the one
   * the close cascade reads — so the book's editor is FOUND (`editorFor`) and
   * never stored.
   */
  sourceTabId: string | null;
  /**
   * True while the PDF viewer is showing the text layer beside the page.
   *
   * On the TAB rather than in the component, for the same reason `thumbnails`
   * is: only the active tab's viewer is in the DOM, so a component that held
   * this would forget it the moment the user looked at something else. A view
   * mode that resets itself when you glance away is a view mode you stop using.
   */
  layerView: boolean;
  /** True while the PDF viewer's thumbnail strip is up. ON by default — it sits
   *  along the bottom where it costs little, and Owen wants the pages in reach. */
  thumbnails: boolean;
  /**
   * True while the PDF viewer is outlining the blocks the model read.
   *
   * The scan's answer to select mode, and it lives on the tab for the reason
   * `layerView` and `selectMode` do: five panes can each hold a different
   * document, and a component or a global flag would either forget the mode the
   * moment you looked away or turn it on in all five at once.
   *
   * NOT PERSISTED, like `selectMode`. The mode is a thing you are doing right
   * now; a scan that reopened covered in coloured rectangles would look broken
   * until the user found the button that was already pressed. What IS persisted
   * is everything done in it, which is the overlay file.
   */
  blockView: boolean;
  /**
   * True while this book is in SELECT MODE — blocks outlined, click to select,
   * Delete to cut, Enter to fix a word.
   *
   * ON THE TAB AND NOT ON UiService, and that is not a stylistic preference:
   * five panes can each show a different book, and a global flag would turn the
   * mode on in all of them at once. It is the same reason `layerView` lives
   * here. It is also not persisted anywhere — the mode is a thing you are doing
   * right now, and a book that reopened outlined would be a book that looked
   * broken until you found the button that was already on.
   */
  selectMode: boolean;
  /**
   * Bumped on every flush that reached disk.
   *
   * It is what makes the rendered pane refresh: the chapter's URL does not
   * change when its bytes do, and an <iframe> pointed at a URL it is already
   * showing does nothing at all. This rides along as a query parameter the
   * protocol handler ignores. Cross-pane for free, now that the editor is its
   * own tab: the bytes land, the source tab's revision moves, and every pane
   * rendering that book reloads.
   */
  revision: number;
  /** Why this tab has nothing in it, when that happens. Never swallowed. */
  problem: string | null;
}

/**
 * A column of the workspace: one document, or none.
 *
 * `tabId` of null means this pane is showing HOME — which is what a column with
 * nothing in it has always shown, back when there was only ever one. It is also
 * what Ctrl+\ makes: an empty column to drop a document into.
 */
export interface Pane {
  id: string;
  /** The document on screen here. An id into the flat tab list, or Home. */
  tabId: string | null;
  /**
   * The pane's share of the row, as a flex-grow number.
   *
   * In memory only, and deliberately: a layout is a thing you arrange for the
   * comparison you are doing right now, and restoring last week's column widths
   * over this week's two books would be furniture arriving in the wrong room.
   */
  flex: number;
}

/**
 * Five, and the number is a judgement rather than a limit of the code.
 *
 * A sixth column on a 1920-wide window is 300 pixels of book, which is a column
 * of hyphens. The cap is also what makes the auto-open rule terminate: past it,
 * a finished job takes the RIGHTMOST column's slot instead of narrowing
 * everything — and the book that was there is still open in the list, one click
 * from coming back.
 */
export const MAX_PANES = 5;

/**
 * The job kinds that become a tab when they finish.
 *
 * A set rather than a chain of comparisons because the list has grown twice
 * now, and each time the test lived inline it was one `||` away from a kind
 * that finishes and is never seen. What is NOT here is deliberate: `txt` has no
 * tab to open into, `env-install` made no document at all, and `read` made no
 * document EITHER — its product is the bank, which is not a thing anybody looks
 * at. What you look at is what you generate from it, and generating is one of
 * the three kinds above, which is exactly why they open themselves: somebody
 * asks for an EPUB precisely because they want to read it.
 */
const OPENS_ITSELF: ReadonlySet<JobKind> = new Set<JobKind>(['epub', 'pdf', 'translate']);

/** What a rendered chapter reported being clicked, for the editor to jump to. */
export interface SourceJump {
  /** The EPUB tab the click came from. Its editor, if any, is the one that moves. */
  tabId: string;
  bf: boolean;
  tag: string;
  index: number;
  /**
   * Bumped per click, and it is what makes a SECOND click on the same block do
   * anything at all: the payload would otherwise be identical, the signal would
   * not change, and the editor's effect would never run.
   */
  seq: number;
}

/**
 * The blocks one frame says are selected.
 *
 * A SET, since the marquee: a drag over empty space takes everything it
 * touches, shift and ctrl/cmd extend a click, and every gesture in the mode —
 * Delete, the inspector's relabel — acts on all of them as one batch.
 *
 * IT IS NOT A FACT ABOUT THE BOOK, and it is NOT IN THE UNDO STACK. A selection
 * lives in the frame's DOM and dies with the frame; nothing on disk records it,
 * and a reload starts with nothing selected. It is held here only because the
 * inspector — which is in the shell, not in the pane — has no other way to
 * learn what the user clicked. (BookForge puts its selection in the history and
 * pays for it with a special case in three separate places.)
 */
export interface FrameSelection {
  blockIds: readonly string[];
  /**
   * The `data-bf-cat` they all share, so the inspector can mark the row the
   * selection already is — and null the moment two of them disagree, because a
   * marked row over a mixed selection is the panel asserting something untrue
   * about most of what is highlighted.
   */
  category: string | null;
}

/** How many blocks of each category the rendered chapter holds, and how many are struck. */
export interface CategoryCounts {
  counts: Readonly<Record<string, number>>;
  struck: Readonly<Record<string, number>>;
}

/*
 * `LedgerField`, `LedgerRow`, `LedgerAction` and `LedgerStacks` MOVED TO
 * shared/types.ts, because the ledger is written to disk now and main is what
 * writes it. Main still never replays a row — that is entirely this file's,
 * through the setters — but it does have to recognise the shape, so that a
 * history file carrying a field no setter answers to is refused as the wrong
 * shape rather than handed to a Ctrl+Z that would fall through every branch.
 */

/** The list under one key, made on first use. Grouping rows for one repaint call. */
function bucket<K>(map: Map<K, string[]>, key: K): string[] {
  const found = map.get(key);
  if (found) return found;
  const made: string[] = [];
  map.set(key, made);
  return made;
}

/**
 * The picture one project's panes are showing, and the string that decides
 * whether it has moved.
 *
 * BOTH TOGETHER, never one without the other. The view is what a repaint acts on
 * and the string is what a repaint is decided by, and they are made in one call
 * (`pictureIn`) so that no surface can compare by one answer and act on another.
 */
interface ShownPicture {
  view: PositionView;
  picture: string;
}

/** One project whose position has moved since this window last painted it. */
interface PositionMove {
  /** The project directory, folded — the key `showing` is kept under. */
  key: string;
  /** What the panes were showing, or null for a project this window has just met. */
  was: ShownPicture | null;
  now: ShownPicture;
}

/** Something the shell wants said to one tab's frame. See `frameCommand`. */
export interface FrameCommand {
  tabId: string;
  /** Bumped per command, so the same one twice in a row still fires. */
  seq: number;
  message: Record<string, unknown>;
}

@Injectable({ providedIn: 'root' })
export class TabsService {
  private readonly queue = inject(QueueService);
  /**
   * The library, read only to NAME things.
   *
   * Nothing about a tab's life depends on it — a document opens, unpacks, edits
   * and saves whether or not a project has claimed it — which is why this is the
   * one thing asked of it. The alternative was for every surface that draws a
   * document (the list, the pane's toolbar, the window's title bar) to look the
   * project up for itself, and three lookups of one fact is three chances for
   * two of them to disagree about what a book is called, which is the exact
   * failure this whole change exists to end.
   */
  private readonly projects = inject(ProjectsService);

  /**
   * The step ledger, read for ONE question this service has to answer for itself:
   * may this document be corrected right now?
   *
   * Standing on a save means the pages are showing that frozen copy, while
   * `overlay.save` writes the LIVE curation — so a gesture made there would land
   * somewhere other than the book on screen. The three doors
   * into a curation all ask before they write (see `heldByASave`), and the reason
   * the gate is in this class rather than in the panel is that a panel is not the
   * only way in: the Delete key, the undo chord and the menu reach the same
   * setters.
   *
   * The dependency runs ONE WAY. `LedgerService` knows about projects and the
   * confirm card and nothing about tabs; everything this side wants to happen to a
   * pane after a step changed is arranged here.
   */
  private readonly ledger = inject(LedgerService);

  private readonly all = signal<Tab[]>([]);
  private readonly columns = signal<Pane[]>([]);
  private readonly focused = signal<string | null>(null);

  /**
   * Every open document, in the order the list shows them.
   *
   * THE ORDER IS THIS LIST'S, now that the strips are gone: there is nowhere
   * else a document sits in a sequence, so `reorder` writes here and the panel
   * renders it straight.
   */
  readonly tabs = this.all.asReadonly();
  readonly panes = this.columns.asReadonly();
  readonly focusedPaneId = this.focused.asReadonly();

  readonly focusedPane = computed<Pane | null>(() =>
    this.columns().find((pane) => pane.id === this.focused()) ?? null);

  /** Null means Home — which is also what "no panes open at all" looks like. */
  readonly activeId = computed<string | null>(() => this.focusedPane()?.tabId ?? null);
  readonly active = computed<Tab | null>(() => this.byId(this.activeId()));

  /**
   * The DOCUMENT the user is working on, which is not always the active tab.
   *
   * An editor tab is a face of its book, so with the editor pane focused the
   * rail's Translate, the OCR dialog's source and Ctrl+S must all still mean
   * the book. Everything that acts on "what I am looking at" reads this;
   * `active()` stays literal, for the things that mean the tab itself.
   */
  readonly activeDocument = computed<Tab | null>(() => {
    const tab = this.active();
    if (tab === null) return null;
    return tab.kind === 'editor' ? this.byId(tab.sourceTabId) : tab;
  });

  readonly canSplit = computed(() => this.columns().length < MAX_PANES);

  /**
   * The last thing that went wrong out here rather than inside a tab: a drop
   * this app will not open, a save that failed. Shown as a strip under the tabs
   * and dismissed by hand — a refusal that vanished on a timer is a refusal the
   * user gets to wonder about.
   */
  readonly notice = signal<string | null>(null);

  /** The tab whose chapter is being written right now, for the "Writing…" line. */
  readonly writingTo = signal<string | null>(null);

  /**
   * True from the moment a row leaves the document list until the drag ends.
   *
   * IT EXISTS BECAUSE OF THE <iframe>. A rendered chapter is a frame with its
   * own browsing context, and a drag over it delivers dragover/drop to THAT
   * document — the pane underneath would never see the pointer, so a book could
   * not be dropped onto the one thing a person aims at. The workspace lays a
   * transparent shield over every pane while this is on, and takes it away the
   * instant the drag is over so nothing normal is intercepted.
   *
   * Whether a drag is happening, and NOT what it carries: the id is unreadable
   * until the drop (that is the platform's rule, not ours), so the drop preview
   * is still driven by the pointer's position alone.
   */
  readonly draggingDocument = signal(false);

  /** The most recent click-to-source, for whichever editor is watching that book. */
  readonly sourceJump = signal<SourceJump | null>(null);
  private jumpSeq = 0;

  /**
   * Paths that will arrive as UNSAVED tabs: a conversion's output, or a
   * workspace book re-opened from Home.
   *
   * A set consulted on the way in, rather than a flag on the open call, because
   * the open call and the tab's creation are on opposite sides of an IPC round
   * trip through main.
   */
  private readonly expectUnsaved = new Set<string>();

  /** Paths that will arrive wanting a pane of their own. Same round trip, same trick. */
  private readonly expectOwnPane = new Set<string>();

  /** Conversions already turned into a tab, so a queue push cannot open a second. */
  private readonly openedJobs = new Set<string>();

  /**
   * An open editor's "write what is in the box, now".
   *
   * Registered by the editor component, because the draft lives in its textarea
   * and nothing out here can see it. `close()` awaits it before it asks the user
   * anything: the debounce is 700 ms, and closing a tab inside that window used
   * to throw away the last sentence typed AND ask a question about a `modified`
   * flag that had not been set yet.
   */
  private readonly pendingFlush = new Map<string, () => Promise<void>>();

  private sequence = 0;
  private paneSequence = 0;

  constructor() {
    api?.onDocumentOpened((absolutePath) => { this.adopt(absolutePath); });
    api?.onDocumentRelocated(({ from, to }) => { this.relocate(from, to); });

    /**
     * A finished conversion opens itself.
     *
     * Watching the queue MIRROR rather than being told by whatever enqueued the
     * job: the job outlives the dialog that started it, outlives a trip to
     * Settings, and (because main owns the queue) outlives a reload of this
     * window. The only fact that matters is that a row reached `done`.
     *
     * EPUB and PDF both, because both have a tab to open into and looking at
     * the result is the next thing anybody does — a reprinted PDF is a claim
     * about every page of a book, and the claim is checked by eye. txt stays
     * shelf-only:
     * there is no text tab, and the OS opens it from reveal.
     *
     * A TRANSLATION IS THE THIRD, and it is the one this matters most for: it
     * runs for hours, so the person who ordered it is not watching, and the
     * book appearing in a tab is how they find out it finished at all.
     *
     * IN A PANE OF ITS OWN, which is what the panes are for: the translation
     * arrives beside the book it was made from, and the two are readable
     * against each other without a single gesture from the user.
     *
     * Jobs already finished when this window loaded are marked as seen without
     * opening: a reload should not reopen five books somebody closed.
     */
    let first = true;
    effect(() => {
      const jobs = this.queue.jobs();
      for (const job of jobs) {
        if (!OPENS_ITSELF.has(job.kind) || job.state !== 'done') continue;
        if (this.openedJobs.has(job.id)) continue;
        this.openedJobs.add(job.id);
        if (first) continue;
        this.openFinished(job.outputPath);
      }
      if (jobs.length > 0) first = false;
    });

    /**
     * A DOCUMENT LEARNS ITS BOOK'S NAME LATE, and this is what tells it.
     *
     * A file opened from outside the library is imported in the background: the
     * tab exists before the project does, so at the moment it is made there is
     * nothing to ask and the name falls back to the file. The project arrives
     * some hundreds of milliseconds later as `projects:changed`, and without
     * this the tab would keep the fallback for the rest of the session — the
     * list on the left saying one thing about a book while Home said another,
     * which is the disagreement this is all for.
     *
     * ONLY WHERE NOBODY CHOSE A NAME. `named` is the whole guard: an unpacked
     * book's `dc:title` is a better answer than any project title and is never
     * overwritten by this. Nor is the editor's "<book> — HTML".
     *
     * It converges in one pass and cannot loop: the patch below is the only
     * write, it happens only when the name actually moved, and the run it
     * triggers finds the same answer already in place.
     */
    effect(() => {
      this.projects.items();
      for (const tab of this.all()) {
        if (tab.named) continue;
        const want = this.nameFor(tab.path);
        if (want !== tab.title) this.patch(tab.id, { title: want });
      }
    });

    /**
     * A STEP WAS DELETED, so the panes showing that book read their state again.
     *
     * ── Why a delete has an effect of its own at all ──────────────────────────
     *
     * A delete may not move the pointer, and the effect below only ever acts on a
     * picture that has CHANGED. Delete a stale translation while standing on the
     * reading and every field of `positionView` answers exactly what it answered a
     * moment ago — same bank, same corrections — so nothing there would fire, and
     * yet the disk underneath the panes is not the disk they were painted from.
     *
     * A delete is the other thing entirely: it UNLINKS PAYLOADS. An open block
     * editor may be drawing a readings bank that has just stopped existing, and a
     * mode left holding ten thousand boxes off a deleted file is a mode where the
     * next strike is written against blocks nothing can render. So the whole state
     * is read again through the one path that reads it — which is also where the
     * refusal ("has not been read yet") is already written, so a project whose
     * reading was just deleted says so in its own words rather than going blank.
     *
     * ONLY THE TABS OF THAT PROJECT. A delete in one book must not make the four
     * other panes re-read banks nothing happened to.
     */
    effect(() => {
      const destroyed = this.ledger.payloadsDestroyed();
      if (destroyed === null) return;
      untracked(() => {
        const gone = fold(destroyed.dir);
        for (const tab of this.all()) {
          if (tab.kind !== 'pdf' || !tab.blockView) continue;
          const dir = this.projectDirOf(tab);
          if (dir === null || fold(dir) !== gone) continue;
          void this.loadBlockView(tab.id, tab.path);
        }
      });
    });

    /**
     * THE POINTER MOVED, SO THE PANES SHOW THE STEP THE USER IS STANDING ON.
     *
     * ── What clicking a row used to do, which was very nearly nothing ────────
     *
     * `docs/STEP-LEDGER.md` has promised since the day the ledger was designed
     * that the position decides what the viewers show, and this effect used to
     * keep about a third of that promise. It re-read the CURATION and left the
     * blocks under it exactly where they were, which is correct only while both
     * rows are about one reading: move between two readings and the pane went on
     * drawing the first reading's boxes with the second reading's corrections over
     * them, silently, with nothing on screen admitting the swap. And it was
     * guarded on the pane already being in the block editor, so for a scan nobody
     * had pressed Blocks on — and for the import row, where the honest picture is
     * no outlines at all — a click on a row in somebody's own history did
     * literally nothing. That is what a user with a two-step project saw: they
     * clicked the import, they clicked the read, and the app sat there.
     *
     * ── What it does now: make the pane match the answer ─────────────────────
     *
     * `positionView` (shared/ledger.ts) says what the picture at the position IS —
     * which reading's bank, which corrections over it, whether there are outlines
     * at all — and this effect's whole job is to make the panes of that project
     * agree with it. Nothing here re-derives any of that; the day a read row comes
     * to mean a reflowed HTML document rather than a scan with boxes on it
     * (docs/DERIVED-BOOK.md §6 phase B), the answer changes shape and this loop
     * does not.
     *
     * A MOVE THAT CHANGES THE BANK RELOADS; A MOVE THAT CHANGES ONLY THE
     * CORRECTIONS DOES NOT. Re-reading a bank is a spawn of the engine and a
     * re-measure of five hundred pages, and putting that behind the one gesture in
     * this app that is meant to be free is the exact ceremony a history panel
     * promises it does not have. So a save and the reading it was made from — two
     * rows, one bank — cost one small file read between them, and only a genuinely
     * different reading pays for the blocks. `positionPicture` is what makes that
     * distinction; the step id would have been wrong in both directions.
     *
     * ── Keyed by PROJECT, and the first sighting is a baseline ───────────────
     *
     * By project because the position is a fact about a book rather than about a
     * viewer of one, and because two panes onto one project must not each decide
     * separately what that book is standing on.
     *
     * THE FIRST SIGHTING RECORDS AND ACTS ON NOTHING, which is what keeps this
     * from turning the block editor on by itself. Block view is deliberately not
     * persisted — a scan that reopened covered in coloured rectangles looks broken
     * until you find the button that was already pressed (see `Tab.blockView`) —
     * so opening a document must not be read as a move. A pointer move is a
     * DIFFERENCE from what this window was last showing, and a project it has
     * never seen has no difference to be. The entry is dropped again when the last
     * tab of that project closes, so a reopen baselines afresh rather than
     * inheriting a picture from a session nobody is in any more.
     */
    effect(() => {
      const moves: PositionMove[] = [];
      const open = new Set<string>();
      for (const tab of this.all()) {
        const dir = this.projectDirOf(tab);
        if (dir === null) continue;
        const key = fold(dir);
        if (open.has(key)) continue;
        open.add(key);
        const now = this.pictureIn(dir);
        // Nobody has read this project's history yet, so there is no position to
        // obey. It arrives as its own change and is baselined then.
        if (now === null) continue;
        const was = this.showing.get(key) ?? null;
        if (was !== null && was.picture === now.picture) continue;
        moves.push({ key, was, now });
      }
      /*
       * WHICH DOCUMENTS ARE ACTUALLY IN A COLUMN, read here in the tracked part
       * rather than inside the work below. It decides whether this move has
       * anywhere to be shown, and a move that has nowhere says so out loud — so
       * reading it untracked would mean a book dragged into a column afterwards
       * never re-asked the question, and the app would be holding a refusal about
       * a pane that has since appeared.
       */
      const inAColumn = new Set(this.columns()
        .map((pane) => pane.tabId)
        .filter((id): id is string => id !== null));
      untracked(() => {
        for (const key of [...this.showing.keys()]) {
          if (!open.has(key)) this.showing.delete(key);
        }
        for (const move of moves) {
          this.showing.set(move.key, move.now);
          if (move.was === null) continue;
          this.showPosition(move, inAColumn);
        }
      });
    });
  }

  /**
   * The picture each project's panes are currently showing, keyed by the folded
   * directory — this window's memory of where every open book was standing.
   */
  private readonly showing = new Map<string, ShownPicture>();

  /**
   * What this project's panes OUGHT to be showing, or null while nothing has read
   * its history.
   *
   * The view and the string it compares by are made together and never apart: a
   * caller holding one without the other would either compare pictures it cannot
   * act on or act on a picture it cannot compare.
   */
  private pictureIn(projectDir: string | null): ShownPicture | null {
    const history = this.ledger.historyFor(projectDir);
    if (history === null) return null;
    const view = positionView(history.ledger);
    return { view, picture: positionPicture(view) };
  }

  /**
   * Make every pane of this project show the position — and SAY SO when none of
   * them can.
   *
   * ── The three pictures, and what each costs ─────────────────────────────────
   *
   * NO OUTLINES (the import, and any position with no reading above it): the pane
   * comes out of the block editor. Nothing had been read at that point in the
   * book's story, so boxes drawn over the scan there would be the pane making a
   * claim about a step the user is standing BEFORE — which is the one thing the
   * revert row exists to let somebody look at without.
   *
   * OUTLINES, PANE NOT IN THE MODE: it goes into the mode and reads the bank. This
   * is the click the user was actually making when they reported that nothing
   * happened, and it is the expensive one — but it is expensive exactly once per
   * genuinely different picture, and it is what they asked for by clicking the row.
   *
   * OUTLINES, PANE ALREADY IN THE MODE: the bank is re-read only if the READING
   * moved. Otherwise this is a few kilobytes of corrections off a disk, which is
   * what keeps stepping between a reading and its saves as free as the panel
   * promises. See `refreshCuration`.
   *
   * ── And why "nothing to do" is a sentence rather than silence ───────────────
   *
   * A gesture that produces no visible change is indistinguishable from a broken
   * app, and this one has three honest ways to produce none: the book's pages are
   * not in any column, the row's payload is a document no pane can open yet, or
   * the pane is already showing exactly this. All three are things the person who
   * clicked deserves to be told, in words, rather than left to conclude that the
   * history panel does not work. That was the whole of the original complaint.
   */
  private showPosition(move: PositionMove, inAColumn: ReadonlySet<string>): void {
    const view = move.now.view;
    const readingMoved = (move.was?.view.reading?.id ?? null) !== (view.reading?.id ?? null);
    const curationMoved = (move.was?.view.curation?.id ?? null) !== (view.curation?.id ?? null);
    let reachable = false;
    let repainted = false;
    for (const tab of this.all()) {
      if (tab.kind !== 'pdf') continue;
      const dir = this.projectDirOf(tab);
      if (dir === null || fold(dir) !== move.key) continue;
      // A document open in the list but not in any column still has its state put
      // right — it is one click from being back on screen and must not come back
      // showing a step nobody is standing on — but it cannot be what makes this
      // move visible.
      const seen = inAColumn.has(tab.id);
      if (!view.outlines) {
        if (!tab.blockView) continue;
        this.patch(tab.id, { blockView: false });
        this.forgetBlockView(tab.id);
        if (seen) repainted = true;
      } else if (!tab.blockView) {
        this.patch(tab.id, { blockView: true });
        void this.loadBlockView(tab.id, tab.path);
        if (seen) repainted = true;
      } else if (readingMoved) {
        void this.loadBlockView(tab.id, tab.path);
        if (seen) repainted = true;
      } else if (curationMoved) {
        void this.refreshCuration(tab.id, tab.path);
        if (seen) repainted = true;
      }
      if (seen) reachable = true;
    }
    const said = this.unshownAt(view, reachable, repainted);
    if (said !== null) this.notice.set(said);
  }

  /**
   * Why this move produced nothing to look at, or null when it produced something.
   *
   * ONE SENTENCE PER REASON, and each one names the row in the app's own words —
   * never a filename, because a step is named by the action it was (the rule
   * `labelFor` exists to keep). A person who clicks a row in their own history and
   * sees the page not move has to be able to find out why from the app rather than
   * from us.
   */
  private unshownAt(view: PositionView, reachable: boolean, repainted: boolean): string | null {
    const label = view.step?.label ?? null;
    if (label === null) return null;
    if (!reachable) {
      return `You are standing on “${label}”, and none of the open columns is showing this book’s `
        + 'pages — so there is nothing on screen for that to change. Put the scan in a column, by '
        + 'clicking it in the list down the left or opening it from Home, and the pages will show '
        + 'the step you are standing on.';
    }
    if (view.elsewhere) {
      // The one row whose own payload this app cannot yet put in a pane. Said
      // every time it is stood on rather than once, because it is not an error
      // that has been noted — it is the standing state of that row, and somebody
      // stepping between two translations is asking the same question again.
      return `You are standing on “${label}”. Foundry cannot open a translated book from its row `
        + 'yet, so these pages are still the ones it was translated from, with your live '
        + 'corrections drawn on them — which is where a strike made here would land. Generate '
        + 'from this row to read the translation itself.';
    }
    if (repainted) return null;
    if (!view.outlines) {
      return `You are standing on “${label}” — the pages exactly as they came in. Nothing had been `
        + 'read from this book at that point in its story, so there is nothing outlined over them, '
        + 'and that is what this column is already showing.';
    }
    return `You are standing on “${label}”, and this column is already showing it.`;
  }

  /**
   * What to call a document at this path — the book, and the file only as a last
   * resort.
   *
   * THE SAME STRING HOME SHOWS, and it is one call rather than a rule repeated
   * here precisely so that it cannot become a second opinion: see
   * `ProjectsService.nameFor`, which every surface that draws a document's name
   * goes through.
   */
  private nameFor(filePath: string): string {
    return this.projects.nameFor(filePath);
  }

  // ── Opening ──────────────────────────────────────────────────────────────

  /** The rail's and Home's Open button. The tab arrives on `document:opened`. */
  async openViaDialog(): Promise<void> {
    await api?.openDocumentDialog();
  }

  /**
   * A drop. Main decides whether the path is openable; a refusal is SAID rather
   * than ignored, because a file that lands in the window and does nothing is
   * indistinguishable from a broken app.
   */
  async openDropped(file: File): Promise<void> {
    if (!api) return;
    const candidate = api.pathForFile(file);
    if (!candidate) return;
    const admitted = await api.openPath(candidate);
    if (admitted === null) {
      this.notice.set(`${file.name} is not something Foundry opens — it reads PDFs and the EPUBs it casts.`);
    }
  }

  /** Open a path this window already knows about: Home's list, the shelf's Open. */
  async openFile(filePath: string, managed = false): Promise<void> {
    if (!api) return;
    const key = normalise(filePath);
    if (managed) this.expectUnsaved.add(key);
    const admitted = await api.openPath(filePath);
    if (admitted === null) {
      this.expectUnsaved.delete(key);
      this.expectOwnPane.delete(key);
      // NAMED, NOT SPELLED OUT. A path in the strip is this app showing its own
      // bookkeeping to somebody who asked for a book — and the whole path was
      // never readable in one line of a notice anyway. The row that failed to
      // open still carries the path in its tooltip, which is where a person
      // debugging their own library goes looking.
      this.notice.set(`${this.nameFor(filePath)} is no longer there.`);
    }
  }

  /**
   * A rendering's output: unsaved, and in a pane of its own if there is room.
   *
   * ── A NEW FILE UNDER AN OLD NAME ───────────────────────────────────────────
   *
   * Generating a real-text PDF appeared to do nothing at all. The run finished,
   * the shelf said so, and the page on screen did not change — because a
   * PDF-producing rendering REPLACES the project's live PDF at the same path
   * (`refreshLivePdf`), `adopt` finds a tab already on that path and merely
   * reveals it, and `app-pdf-view` re-reads only when the path STRING changes.
   * Same name, new bytes, and every layer of the app faithfully concluded there
   * was nothing to do.
   *
   * So a document already open is REVEALED AND RELOADED. The revision bump is
   * this app's own idiom for exactly this — it is what makes an edited chapter
   * repaint in an <iframe> pointed at a URL it is already showing — and the PDF
   * pane now watches it for the same reason.
   *
   * A document that is NOT open takes the ordinary path and opens fresh.
   */
  private openFinished(filePath: string): void {
    const key = normalise(filePath);
    const already = this.all().find((tab) => normalise(tab.path) === key && tab.kind !== 'editor');
    if (already) {
      this.reveal(already.id);
      this.patch(already.id, { revision: already.revision + 1, unsaved: true, savedPath: null });
      return;
    }
    this.expectOwnPane.add(key);
    void this.openFile(filePath, true);
  }

  /**
   * The single tab factory. Focuses an existing tab for the same file rather
   * than opening a second — two tabs onto one book are two scroll positions
   * fighting over one document, and with panes it would be two of them fighting
   * over one unpack.
   */
  private adopt(absolutePath: string): void {
    const key = normalise(absolutePath);
    const ownPane = this.expectOwnPane.delete(key);
    const existing = this.all().find((tab) => normalise(tab.path) === key && tab.kind !== 'editor');
    if (existing) {
      this.reveal(existing.id);
      return;
    }

    const kind: TabKind = key.endsWith('.epub') ? 'epub' : 'pdf';
    const unsaved = this.expectUnsaved.delete(key);
    const tab = this.blankTab(kind, absolutePath, this.nameFor(absolutePath));
    tab.unsaved = unsaved;
    this.all.update((tabs) => [...tabs, tab]);
    this.place(tab.id, ownPane);
    if (kind === 'epub') void this.unpack(tab.id, absolutePath);
  }

  /**
   * The document this tab is showing has moved to the copy this app works on.
   *
   * ── What this fixes ─────────────────────────────────────────────────────────
   *
   * A file opened from outside the library is IMPORTED — copied into the
   * project's `archive/` untouched, and again into the live layer, which is what
   * "the PDF" means in every other sentence this app says. The tab kept the
   * outside path, because the import is deliberately not awaited and there was
   * nothing else to name at the moment the tab was made.
   *
   * Everything then asked the wrong question. `projectFor(tab.path)` answers
   * null for a path outside the library, so Generate said a book that had just
   * been read had not been read, the dock's waiting light stayed lit on a
   * finished project, the nav could not group the document under its own book,
   * and the block editor had no bank to fetch. One stale string, six broken
   * features, and nothing on screen to explain any of it.
   *
   * ── The same tab, never a second one ────────────────────────────────────────
   *
   * `adopt` would make a new tab for the new path, which is exactly the failure
   * this exists to prevent: two viewers onto one document, two scroll positions,
   * and the user watching their book apparently open twice. So this PATCHES —
   * the tab keeps its id, its pane, its ledger, its selection and its place in
   * the list, and only its idea of where the file is changes.
   *
   * A PDF pane reloads by itself: `app-pdf-view` watches `tab.path` through a
   * computed and re-opens when the string changes, which is a repaint of the
   * same pages from the same bytes. A book does not reload at all — it is
   * already unpacked, and it is unpacked from the SAME project, because the
   * import is keyed by the file's content and both paths reach it.
   *
   * `savedPath` MOVES WITH IT WHEN IT NAMED THE FILE WE ARE LEAVING. It is a
   * grant — for a book opened from the user's own disk it names their file, and
   * Save updating the copy they chose is what they asked for by opening it — but
   * that stops being true the moment the tab stops showing that file. A Save
   * that repacked the working tree over a document on another drive, while every
   * label on screen said the library's copy, is the same invariant `meta:write-pdf`
   * broke: THE APP NEVER SILENTLY WRITES OUTSIDE ITS LIBRARY. Main revokes the
   * matching grant in the same breath. Where `savedPath` names something else
   * entirely — a Save As the user made — it is left exactly alone.
   *
   * Silent when nothing matches — the tab was closed inside the import's own
   * round trip, which is a race with no consequence.
   */
  private relocate(from: string, to: string): void {
    const was = normalise(from);
    const now = normalise(to);
    if (was === now) return;
    const moving = this.all().find(
      (tab) => normalise(tab.path) === was && tab.kind !== 'editor');
    if (!moving) return;
    /*
     * THE DESTINATION IS ALREADY OPEN — one book reached two ways.
     *
     * Somebody opened the project's copy from Home and then dropped their own
     * file on the window (or the reverse). This used to give up and leave the
     * outside-path tab exactly where it was, which is the worst of the three
     * outcomes: that tab keeps every identity bug the relocation exists to fix,
     * and the user is looking at two tabs of one book with only one of them
     * working.
     *
     * ONE BOOK, ONE TAB. The outside tab closes and the one already on the
     * working copy is revealed. Nothing is lost — they are the same bytes, and
     * the surviving tab is the one with a project behind it. `ask: false`
     * because there is no question here: this is not a document being put away,
     * it is two views of one document becoming one.
     */
    const already = this.all().find((tab) => normalise(tab.path) === now && tab.id !== moving.id);
    if (already) {
      void this.close(moving.id, false);
      this.reveal(already.id);
      return;
    }
    this.patch(moving.id, {
      path: to,
      /*
       * AND THE SAVE TARGET GOES WITH THE PATH. `savedPath` names the copy the
       * user chose, and for a book opened from their own disk that is their own
       * file — which is a deliberate design and stays right up until the moment
       * the tab stops showing that file. Keeping it here would mean Ctrl+S
       * repacking the working tree over a document on E:\\ while every label on
       * screen said the library's. Main revokes the matching write grant at the
       * same instant, so the two sides cannot disagree; clearing it here is what
       * makes Save fall through to Save As, which is the door that asks.
       */
      ...(moving.savedPath !== null && normalise(moving.savedPath) === was
        ? { savedPath: null, unsaved: true }
        : {}),
      /*
       * THE TITLE ONLY IF NOBODY HAS SET A BETTER ONE. A book's title becomes
       * its `dc:title` when it unpacks — "Working Towards the Führer" rather
       * than the name it arrived under — and overwriting that because the file
       * moved between folders would undo the one piece of naming this app does
       * on the user's behalf.
       *
       * RE-DERIVED RATHER THAN CARRIED, because this move is the exact moment
       * the answer changes: the file is going from a folder of the user's into
       * a project, so the name it should now be wearing is the project's, and
       * `nameFor` is where that is decided once for the whole app.
       */
      ...(moving.named ? {} : { title: this.nameFor(to) }),
    });
    // The editor tab that is a face of this book points at the same file.
    const editor = this.all().find(
      (tab) => tab.kind === 'editor' && tab.sourceTabId === moving.id);
    if (editor) this.patch(editor.id, { path: to });
  }

  private blankTab(kind: TabKind, path: string, title: string): Tab {
    this.sequence += 1;
    return {
      id: `tab-${this.sequence}`,
      kind,
      path,
      title,
      named: false,
      unsaved: false,
      modified: false,
      savedPath: null,
      book: null,
      chapterHref: null,
      sourceTabId: null,
      layerView: false,
      thumbnails: true,
      blockView: false,
      selectMode: false,
      revision: 0,
      problem: null,
    };
  }

  /**
   * Ask main to unpack the book, and put the failure IN THE TAB when it will not.
   *
   * A book that cannot be read is a fact about that book: it belongs on its own
   * tab with the reason on it, not in a toast that outlives the tab or a console
   * line nobody sees.
   */
  private async unpack(id: string, filePath: string): Promise<void> {
    if (!api) return;
    try {
      const book = await api.epub.open(filePath);
      this.patch(id, {
        book,
        title: book.title,
        // The book said what it is called, which outranks anything derived from
        // a project or a path. See `Tab.named`.
        named: true,
        chapterHref: book.chapters[0]?.href ?? null,
        // A book from the user's own disk already IS a copy somewhere they
        // chose, so Save has a destination from the start: the file itself.
        // Main measured `managed` and granted that path; edits never touch it
        // until Save is pressed (electron/epub-reader.ts writes through to a
        // workspace copy instead).
        ...(book.managed ? {} : { savedPath: filePath }),
        problem: book.chapters.length > 0 ? null : 'This book has no chapters in its spine.',
      });
      // Not a `problem` — the book is open and readable. It is something the app
      // could not do BESIDE opening it (today: stamp an imported EPUB), and the
      // strip is where a shut door says so on the way in rather than by doing
      // nothing when somebody presses Select.
      if (book.notice !== null) this.notice.set(book.notice);
      /*
       * AND THE UNDO HISTORY THIS DOCUMENT WAS LEFT WITH, from the project it
       * lives in. Awaited inside this same call so that Ctrl+Z reaches the last
       * session's work from the moment the book is on screen rather than from
       * whenever a background read happened to finish — and after the notice
       * above, so that a book which had something to say about opening still
       * says it, with whatever the history has to say landing on top as the
       * newer sentence.
       */
      await this.restoreLedger(id);
    } catch (err) {
      this.patch(id, { problem: err instanceof Error ? err.message : String(err) });
    }
  }

  // ── Panes ────────────────────────────────────────────────────────────────

  byId(id: string | null): Tab | null {
    if (id === null) return null;
    return this.all().find((tab) => tab.id === id) ?? null;
  }

  /** The column showing this document, if any is. At most one, by construction. */
  paneOf(tabId: string): Pane | null {
    return this.columns().find((pane) => pane.tabId === tabId) ?? null;
  }

  /**
   * Clicking anywhere in a pane focuses it — that is the whole focus model, and
   * it is why nothing else in the app has to ask which pane it is in.
   */
  focusPane(paneId: string): void {
    if (this.focused() === paneId) return;
    if (this.columns().some((pane) => pane.id === paneId)) this.focused.set(paneId);
  }

  /** Ctrl+1…5. Out of range is a no-op rather than a clamp — 4 means the fourth. */
  focusPaneAt(index: number): void {
    const pane = this.columns()[index];
    if (pane) this.focused.set(pane.id);
  }

  /**
   * Put a newly opened tab in a pane and give it the focus.
   *
   * The first document makes the first pane. After that: a finished job asks
   * for one of its own (up to the cap, past which it takes the rightmost pane's
   * slot), and everything else — a drop, Home's list, the shelf's Open — lands
   * in the pane the user is working in, because they aimed at it.
   *
   * LANDING IN THE FOCUSED PANE NOW REPLACES what that pane was showing, since
   * a pane holds one document. Nothing is lost: the displaced document stays
   * open in the list with its unpack, its edits and its dot, one click from
   * being back on screen. What it is NOT allowed to do is displace a book with
   * a translation of it — that is why a finished job still asks for a column of
   * its own, and why the two rules read differently.
   *
   * `beside` names a pane the new one must open DIRECTLY to the right of, which
   * is what an HTML editor asks for: it is a face of one particular book, and a
   * column of source three panes away from the page it belongs to helps nobody.
   * A conversion's output passes nothing and lands on the end.
   */
  private place(tabId: string, ownPane: boolean, beside: string | null = null): void {
    const panes = this.columns();
    if (panes.length === 0) {
      const pane = this.makePane(tabId);
      this.columns.set([pane]);
      this.focused.set(pane.id);
      return;
    }
    if (ownPane && panes.length < MAX_PANES) {
      const pane = this.makePane(tabId);
      const at = beside === null ? -1 : panes.findIndex((candidate) => candidate.id === beside);
      const next = at < 0
        ? [...panes, pane]
        : [...panes.slice(0, at + 1), pane, ...panes.slice(at + 1)];
      this.columns.set(equalise(next));
      this.focused.set(pane.id);
      return;
    }
    const target = ownPane
      ? crowdedTarget(panes, beside)
      : (this.focusedPane() ?? panes[panes.length - 1]!);
    this.columns.set(panes.map((pane) => (pane.id === target.id ? { ...pane, tabId } : pane)));
    this.focused.set(target.id);
  }

  private makePane(tabId: string | null): Pane {
    this.paneSequence += 1;
    return { id: `pane-${this.paneSequence}`, tabId, flex: 1 };
  }

  /**
   * Put a document in front of the user — a click on its row in the list.
   *
   * ON SCREEN ALREADY: only the focus moves. A second viewer over one unpack is
   * two scroll positions fighting over one document — the thing `adopt` refuses
   * to make for two files — and (because `chapterHref` lives on the tab) two
   * columns that appear scroll-locked with nothing on screen saying why.
   *
   * NOT ON SCREEN: it lands in the focused pane, replacing what was there. The
   * displaced document stays in the list — nothing about it is thrown away.
   */
  reveal(tabId: string): void {
    if (this.byId(tabId) === null) return;
    const pane = this.paneOf(tabId);
    if (pane) {
      this.focused.set(pane.id);
      return;
    }
    this.place(tabId, false);
  }

  /**
   * Show a document in a named column — a row dropped on a pane's middle.
   *
   * THE COLUMN IT CAME FROM GOES WITH IT, when it had one: a document is in at
   * most one pane, so the source is left empty by the move, and an empty column
   * nobody asked for is furniture in the way of the two the user is comparing.
   * (An empty column somebody DID ask for — Ctrl+\ — is a different thing and
   * stays until it is filled or closed.)
   */
  show(tabId: string, paneId: string): void {
    const panes = this.columns();
    if (this.byId(tabId) === null || !panes.some((pane) => pane.id === paneId)) return;
    const from = panes.find((pane) => pane.tabId === tabId) ?? null;
    if (from !== null && from.id === paneId) {
      this.focused.set(paneId);
      return;
    }
    this.columns.set(panes
      .map((pane) => (pane.id === paneId ? { ...pane, tabId } : pane))
      .filter((pane) => from === null || pane.id !== from.id));
    this.focused.set(paneId);
  }

  /**
   * Insert a column at `atIndex` showing this document — a row dropped on the
   * left or right edge band of a pane.
   *
   * THE CAP IS SAID BY NAME. The drop preview does not light up an edge band
   * once there are five columns (a target that lights and then does nothing is
   * worse than one that visibly will not take it), so this is only reachable by
   * a drop the preview never promised — and a gesture that lands on nothing has
   * to say why. Refused even when the document is already in a column and the
   * move would be net-zero: the preview cannot offer that without knowing what
   * the drag carries, and an operation that works only when you cannot see that
   * it will is not an operation.
   */
  openInNewPane(tabId: string, atIndex: number): void {
    const panes = this.columns();
    if (this.byId(tabId) === null) return;
    if (panes.length >= MAX_PANES) {
      this.notice.set(`${MAX_PANES} columns is as wide as this window splits — close one first.`);
      return;
    }
    const from = panes.find((pane) => pane.tabId === tabId) ?? null;
    const fresh = this.makePane(tabId);
    const at = Math.max(0, Math.min(atIndex, panes.length));
    this.columns.set(equalise([...panes.slice(0, at), fresh, ...panes.slice(at)]
      .filter((pane) => from === null || pane.id !== from.id)));
    this.focused.set(fresh.id);
  }

  /**
   * Ctrl+\ and View → Split right: an EMPTY column beside the focused one.
   *
   * It used to move the active tab out of a stack, which is an operation that
   * no longer exists — a pane holds one document, so there is nothing to move
   * out of it. What the chord means now is "make me somewhere to put something",
   * and the user fills it by clicking a row in the list, dragging one onto it,
   * or opening a book from the Home page it shows until they do.
   *
   * ALL THREE REFUSALS ARE SAID. This is reachable from a menu item and a
   * keyboard chord, neither of which can grey itself out against renderer
   * state, so the ways it cannot happen have to arrive as sentences — a Ctrl+\
   * that silently does nothing is indistinguishable from a Ctrl+\ that is broken.
   */
  newEmptyPane(): void {
    const panes = this.columns();
    if (panes.length === 0) {
      this.notice.set('There is nothing open to put a column beside — open a document first.');
      return;
    }
    if (panes.length >= MAX_PANES) {
      this.notice.set(`${MAX_PANES} columns is as wide as this window splits — close one first.`);
      return;
    }
    const at = panes.findIndex((pane) => pane.id === this.focused());
    if (at >= 0 && panes[at]!.tabId === null) {
      this.notice.set('This column is already empty — put a document in it before making another.');
      return;
    }
    const fresh = this.makePane(null);
    const index = at < 0 ? panes.length : at + 1;
    this.columns.set(equalise([...panes.slice(0, index), fresh, ...panes.slice(index)]));
    this.focused.set(fresh.id);
  }

  /**
   * Take a column away without closing what is in it.
   *
   * The ✕ on an empty column's Home page, which is the only way an empty one
   * can go: a column with a document in it is closed by closing the document
   * (see `dropFromPanes`), and there is deliberately no gesture that puts a book
   * away and leaves a hole where it was.
   */
  closePane(paneId: string): void {
    const panes = this.columns();
    const at = panes.findIndex((pane) => pane.id === paneId);
    if (at < 0) return;
    const kept = panes.filter((pane) => pane.id !== paneId);
    // Not equalised, for the reason `dropFromPanes` gives: the survivors keep
    // the shares the user dragged and flex reflows them across the width.
    this.columns.set(kept);
    if (this.focused() === paneId) {
      this.focused.set(kept[Math.min(at, kept.length - 1)]?.id ?? null);
    }
  }

  /**
   * Move a document in the list — a row dragged onto another row.
   *
   * `beforeTabId` names the document it lands in front of; null means the end.
   * This is the ONLY place a document's order is decided now that the strips
   * are gone, which is why it writes the flat list rather than any pane.
   */
  reorder(tabId: string, beforeTabId: string | null): void {
    if (tabId === beforeTabId) return;
    const tabs = this.all();
    const moving = tabs.find((tab) => tab.id === tabId);
    if (!moving) return;
    const without = tabs.filter((tab) => tab.id !== tabId);
    const at = beforeTabId === null ? -1 : without.findIndex((tab) => tab.id === beforeTabId);
    const index = at < 0 ? without.length : at;
    this.all.set([...without.slice(0, index), moving, ...without.slice(index)]);
  }

  /**
   * A divider drag. Two neighbours, one number moved between them.
   *
   * Only the pair either side of the divider changes, so the rest of the row
   * does not twitch while a divider is dragged — the caller does the pixel
   * arithmetic against the real widths and hands back the two shares.
   */
  resize(leftPaneId: string, leftFlex: number, rightPaneId: string, rightFlex: number): void {
    this.columns.update((panes) => panes.map((pane) => {
      if (pane.id === leftPaneId) return { ...pane, flex: Math.max(0.05, leftFlex) };
      if (pane.id === rightPaneId) return { ...pane, flex: Math.max(0.05, rightFlex) };
      return pane;
    }));
  }

  // ── Living with them ─────────────────────────────────────────────────────

  /** The rail's Home. Home is "this column has nothing in it", not a document. */
  goHome(): void {
    const pane = this.focusedPane();
    if (!pane) return;
    this.columns.update((panes) => panes.map((candidate) =>
      (candidate.id === pane.id ? { ...candidate, tabId: null } : candidate)));
  }

  showChapter(id: string, href: string): void {
    this.patch(id, { chapterHref: href });
  }

  /**
   * Ctrl/Cmd+Tab. Walks the FOCUSED column through the list, wrapping.
   *
   * DOCUMENTS ALREADY IN ANOTHER COLUMN ARE SKIPPED, because putting one there
   * would take it off the screen it is currently on — the cycle would swap two
   * columns' contents rather than advance one. The walk always terminates: at
   * worst every other document is taken and it arrives back at this column's
   * own, which is a no-op nobody notices.
   */
  nextTab(): void {
    const pane = this.focusedPane();
    const tabs = this.all();
    if (!pane || tabs.length === 0) return;
    const taken = new Set(this.columns()
      .filter((candidate) => candidate.id !== pane.id)
      .map((candidate) => candidate.tabId)
      .filter((id): id is string => id !== null));
    const at = pane.tabId === null ? -1 : tabs.findIndex((tab) => tab.id === pane.tabId);
    for (let step = 1; step <= tabs.length; step += 1) {
      const candidate = tabs[(at + step) % tabs.length];
      if (candidate === undefined || taken.has(candidate.id)) continue;
      this.show(candidate.id, pane.id);
      return;
    }
  }

  /**
   * Close every tab showing one of these files — the window letting go of what is
   * about to be erased.
   *
   * ── Why it is the paths and not a tab id ────────────────────────────────────
   *
   * A step delete names PAYLOADS, not tabs: main is destroying `generated/<book>
   * (en).epub` and knows nothing about which panes this window has open, and only
   * this side can close one. So the caller hands over the list main gave it and
   * this matches whole paths, folded — never a basename, because a project holds
   * `archive/Book.pdf`, `working/Book.pdf` and `generated/Book.pdf` at once and
   * closing by last segment would shut the scan for a delete aimed at a reprint.
   *
   * WITHOUT ASKING. Every caller has already put a confirm on screen naming
   * exactly these losses, and a second dialog about unsaved changes in a document
   * that is being destroyed is a question with no useful answer.
   *
   * A COPY OF THE LIST FIRST, because closing mutates the very signal this reads.
   */
  async closeShowing(files: readonly string[]): Promise<void> {
    const doomed = new Set(files.map((file) => fold(file)));
    const ids = this.all()
      .filter((tab) => doomed.has(fold(tab.path)))
      .map((tab) => tab.id);
    for (const id of ids) await this.close(id, false);
  }

  /**
   * The window is going — every open document gets the question first.
   *
   * ── Why quitting comes back to this class ───────────────────────────────────
   *
   * Quit used to skip closing altogether: the window was destroyed and the tabs
   * went with it, so nothing was asked about any of them. That was survivable
   * while the only thing at stake was a copy of a file the user had been warned
   * about, and it stopped being survivable the moment closing a scan became the
   * event that ends a session's undo history — quitting with four books open
   * converted "undoable" into "permanent" four times over, silently. Main cannot
   * ask on its own: it knows which files were ever opened, not which documents
   * are open now, and that is renderer state.
   *
   * THE SAME QUESTION, DOCUMENT BY DOCUMENT, and not a summary of all of them.
   * Every one of these losses is about a particular book — its corrections, its
   * save, its copy — and a dialog that pooled four books into one number would be
   * asking somebody to make four decisions with one button. `keep` on any of them
   * stops the quit where it stands: the person said they wanted that book, and
   * carrying on to ask about the next one would be the app negotiating.
   *
   * NOTHING IS CLOSED HERE. The tabs are asked about and left exactly as they are;
   * main destroys the window if the answer is yes. Closing them one by one first
   * would leave a cancelled quit with a window somebody had emptied on their way
   * to changing their mind.
   */
  async letGo(): Promise<boolean> {
    // A copy, because a save made from the dialog can repaint the list underneath
    // this loop, and an iteration over the live signal would be walking an array
    // that moved.
    for (const tab of [...this.all()]) {
      if (await this.questionBefore(tab.id) === 'stay') return false;
    }
    return true;
  }

  /**
   * What this document has to say for itself before it goes, asked once.
   *
   * ── ONE QUESTION FOR THREE LOSSES ───────────────────────────────────────────
   *
   * A book's copy can be unfiled, a book's copy can be out of date, and a scan's
   * corrections can have no save to come back to. Main composes whichever of the
   * three are true into one box, because this codebase has already ruled that a
   * closing document is asked about once (`closeShowing`): a second dialog on top
   * of the first is the app arguing with an answer it already has.
   *
   * A PENDING EDIT IS FLUSHED FIRST. The editor writes 700 ms after the last
   * keystroke, and a close inside that window used to lose the sentence being
   * typed and then ask about a `modified` flag that had not been set yet — the
   * dialog would say the book was untouched while the last edit evaporated.
   *
   * ── And the offer to save is a button, not advice ───────────────────────────
   *
   * A dialog whose only route to keeping the work is *cancel, hunt for Save, close
   * again* has made the user do the app's job, and the way that ends is that they
   * stop reading the box. So the answer can be "save these corrections, then
   * close" — and it goes through `saveCorrections`, the same path the Steps
   * accordion's Save button takes, rather than a second commit written for this
   * dialog. A COMMIT MAIN REFUSES LEAVES THE TAB OPEN: closing anyway would have
   * thrown away the very thing the answer asked to keep, and main's own sentence
   * is already in the notice strip saying why it would not freeze.
   */
  private async questionBefore(id: string): Promise<'go' | 'stay'> {
    const doomed = this.byId(id);
    if (doomed === null || !api) return 'go';
    await this.flushPending(doomed.kind === 'editor' ? doomed.id : this.editorFor(doomed.id)?.id ?? null);

    // Re-read: the flush may have set `modified`, which is the whole reason the
    // question is asked after it rather than before.
    const current = this.byId(id);
    if (current === null) return 'go';
    /*
     * ASKED OF MAIN, EVERY TIME, AND NOT READ OFF THE BLOCK VIEW. The live
     * curation is only in this window while the Blocks mode is on — turning it off
     * drops the state, because the overlay is on disk and holding a book's worth
     * of boxes for a mode nobody is in is memory spent on nothing. So a person who
     * corrected forty blocks, left Blocks, and closed would have been asked
     * nothing at all, which is precisely the person this whole question exists
     * for. Main has the files; main answers. It is null for everything that is not
     * a scan in a project with a reading behind it.
     */
    const corrections = current.kind === 'pdf'
      ? await api.overlay.uncommitted(current.path).catch(() => null)
      : null;
    if (!current.unsaved && !current.modified && corrections === null) return 'go';

    const answered = await api.confirmClose({
      title: current.title,
      unsaved: current.unsaved,
      modified: current.modified,
      savedPath: current.savedPath,
      corrections,
    });
    if (answered === 'keep') return 'stay';
    if (answered === 'save') return await this.saveCorrections(id) ? 'go' : 'stay';
    return 'go';
  }

  /**
   * Close a tab, asking first when it has something to lose.
   *
   * The question is `questionBefore` above, and it is main's native box — modal
   * to the window, like every other dialog in this app. THE BOOK IS NOT DELETED
   * EITHER WAY (see electron/workspace.ts) and neither are its corrections, so
   * what closing costs is a copy the user can find again and a state they can
   * come back to, never the work itself.
   *
   * CLOSING A BOOK CLOSES ITS EDITOR. They are one document with two faces, and
   * an editor pane left holding a book that is no longer open is a pane with
   * nothing it can do.
   *
   * `ask: false` FOR A CLOSE THAT IS PART OF A DELETE, and it is the difference
   * between one question and two. The question's whole subject is work the user
   * might want to keep — a copy to keep track of, corrections to keep a way back
   * to — and a document being deleted is one where all of that is false and the
   * offer to save it is an offer to write bytes into a file about to be
   * unlinked. The delete's own confirmation asked the only question there is; a
   * second box on top of it, in the OS's own chrome, asking about saving the
   * thing they just told the app to destroy, is the app arguing with an answer it
   * already has.
   */
  async close(id: string, ask = true): Promise<void> {
    const doomed = this.all().find((candidate) => candidate.id === id);
    if (!doomed) return;

    const editor = doomed.kind === 'epub' ? this.editorFor(doomed.id) : null;
    await this.flushPending(doomed.kind === 'editor' ? doomed.id : editor?.id ?? null);

    // Re-read: the flush may have set `modified`, which is the whole reason the
    // question is asked after it rather than before.
    const current = this.all().find((candidate) => candidate.id === id);
    if (!current) return;
    if (ask && await this.questionBefore(id) === 'stay') return;

    // The list is re-read AFTER the dialog: that box is modal to the window but
    // not to the app, and a conversion can finish and open a tab while it is up.
    const going = new Set<string>([id]);
    if (editor) going.add(editor.id);
    const tabs = this.all();
    if (!tabs.some((candidate) => candidate.id === id)) return;

    // The temp directory the chapters were served from goes with the tab. Not
    // awaited: the tab must close now, and a %TEMP% removal that loses a race
    // with the iframe's last read is retried on quit.
    if (current.book && api) void api.epub.close(current.book.id);

    this.all.set(tabs.filter((candidate) => !going.has(candidate.id)));
    for (const gone of going) {
      this.pendingFlush.delete(gone);
      // The selection and the category tally are the frame's, and the frame is
      // going with the tab. Left behind they would be the inspector's answer for
      // whatever tab id gets reused next.
      this.forgetFrameState(gone);
      /*
       * AND THE LEDGER GOES WITH THE DOCUMENT, which is the whole difference
       * from the singleton this replaces: there is no shared stack to clear
       * field by field, and no way for one book's undo to reach into another's.
       *
       * THE MAP ENTRY GOES; THE FILE STAYS. Every mutation was flushed as it
       * happened, so there is nothing to write on the way out — and reopening
       * the book reads `<project>/history/<tree>.json` back, which is what makes
       * closing a tab no longer the end of what Ctrl+Z can reach. Deleting a
       * history here would be deleting somebody's work on the strength of them
       * having shut a window.
       */
      this.ledgers.delete(gone);
      this.editing.delete(gone);
      /*
       * AND THE BLOCKS GO WITH THE TAB, for the frame state's reason exactly: a
       * book's worth of boxes held for a document nobody is looking at is memory
       * spent on nothing, and the overlay they describe is on disk. Reopening the
       * scan and pressing Blocks reads both back.
       */
      this.forgetBlockView(gone);
    }
    this.dropFromPanes(going);
  }

  /**
   * CLOSING A DOCUMENT CLOSES THE COLUMN IT WAS IN, and the survivors reflow.
   *
   * A pane holds one document, so there is nothing for the column to fall back
   * to — and leaving an empty one behind would mean closing four books left four
   * Home pages side by side, which is a workspace nobody arranged. Closing the
   * last document takes the last column with it and the window is Home again,
   * exactly as it was before any of this.
   *
   * The focus lands on the column that took the closed one's place, which is
   * the browser's rule for tabs one level up.
   */
  private dropFromPanes(going: ReadonlySet<string>): void {
    const panes = this.columns();
    const kept: Pane[] = [];
    let focusAt = -1;
    for (const pane of panes) {
      if (pane.tabId !== null && going.has(pane.tabId)) {
        if (pane.id === this.focused()) focusAt = kept.length;
        continue;
      }
      kept.push(pane);
    }
    // Not equalised: the panes that remain keep their shares and flex reflows
    // them across the width, which is what the user arranged. Only ADDING a
    // pane resets to equal, because a new column has no share to keep.
    this.columns.set(kept);
    if (focusAt >= 0) {
      this.focused.set(kept[Math.min(focusAt, kept.length - 1)]?.id ?? null);
    }
  }

  async closeActive(): Promise<void> {
    const tab = this.active();
    if (tab) await this.close(tab.id);
  }

  // ── The HTML editor ──────────────────────────────────────────────────────

  /** The editor tab pointed at this book, if one is open. */
  editorFor(bookTabId: string): Tab | null {
    return this.all().find((tab) => tab.kind === 'editor' && tab.sourceTabId === bookTabId) ?? null;
  }

  /**
   * "Edit HTML" — opens the editor beside the book, or closes it.
   *
   * ONE EDITOR PER BOOK, and it goes in a pane of its own by the same rule a
   * finished conversion does: the point of editing a chapter is watching the
   * rendered page change as you fix it, which is a thing you cannot do if the
   * editor is in the column the book was in. At the cap it takes the slot of the
   * column NEXT TO the book (see `crowdedTarget`) — whatever was there stays
   * open in the list, and the two faces of the one document the user just asked
   * to edit are on screen beside each other, which is the whole promise.
   */
  async toggleEditor(bookTabId: string): Promise<void> {
    const book = this.byId(bookTabId);
    if (!book || book.kind !== 'epub' || book.book === null) return;
    const open = this.editorFor(bookTabId);
    if (open) {
      await this.close(open.id);
      return;
    }
    const tab = this.blankTab('editor', book.path, `${book.title} — HTML`);
    // Named after the book it is a face of, and never re-derived from the path
    // it shares with it — an editor called "Working Towards The Fuhrer" with no
    // "— HTML" on it would be a second row for the book, twice over.
    tab.named = true;
    tab.sourceTabId = bookTabId;
    this.all.update((tabs) => [...tabs, tab]);
    this.place(tab.id, true, this.paneOf(bookTabId)?.id ?? null);
  }

  /**
   * A click in the rendered chapter, on its way to the editor's textarea.
   *
   * Through the service because the two are in different panes now — the same
   * Calibre gesture, one component further apart. The editor decides whether the
   * jump is for it (it names its own source tab) and does the counting.
   */
  reportSourceClick(tabId: string, bf: boolean, tag: string, index: number): void {
    const editor = this.editorFor(tabId);
    if (!editor) return;
    this.jumpSeq += 1;
    this.sourceJump.set({ tabId, bf, tag, index, seq: this.jumpSeq });
    /**
     * The jump is no use in a column nobody can see.
     *
     * ON SCREEN IS ENOUGH — the caret has already moved and the focus stays
     * with the book, because the hand that clicked a paragraph is reading the
     * page, not the source. `reveal` is deliberately NOT used: it would put the
     * editor in the FOCUSED pane, which is the book's, and swap the page the
     * user just clicked in for its own markup.
     *
     * Off screen, it comes back beside the book. At the cap that is refused by
     * name inside `openInNewPane` rather than silently doing nothing, which is
     * the one thing a click-to-source must never do.
     */
    if (this.paneOf(editor.id) !== null) return;
    const at = this.columns().findIndex((pane) => pane.tabId === tabId);
    this.openInNewPane(editor.id, at + 1);
  }

  /**
   * The editor lends the service its "write the box now".
   *
   * Registered while the component is alive and dropped on destroy, so `close()`
   * can make the draft real before it asks a question about it.
   */
  registerFlush(editorTabId: string, flush: () => Promise<void>): void {
    this.pendingFlush.set(editorTabId, flush);
  }

  unregisterFlush(editorTabId: string): void {
    this.pendingFlush.delete(editorTabId);
  }

  private async flushPending(editorTabId: string | null): Promise<void> {
    if (editorTabId === null) return;
    const flush = this.pendingFlush.get(editorTabId);
    if (flush) await flush();
  }

  // ── The PDF viewer's two view modes ──────────────────────────────────────

  toggleLayerView(id: string): void {
    this.all.update((tabs) =>
      tabs.map((tab) => (tab.id === id ? { ...tab, layerView: !tab.layerView } : tab)));
  }

  toggleThumbnails(id: string): void {
    this.all.update((tabs) =>
      tabs.map((tab) => (tab.id === id ? { ...tab, thumbnails: !tab.thumbnails } : tab)));
  }

  // ── The block editor ─────────────────────────────────────────────────────
  //
  // SELECT MODE FOR A SCAN, and the differences from the EPUB's are all
  // consequences of one fact: there is no markup to edit. A cast book's blocks
  // are elements with ids, and a cut is an attribute written into somebody's
  // chapter. A scan's blocks are the MODEL'S ANSWER — `(page, order, part)` in a
  // readings bank this app will never edit — so a decision about one cannot be
  // written where it is. It goes into a file beside the bank, and every
  // rendering becomes bank + overlay.
  //
  // WHAT FOLLOWS FROM THAT, in the order it bites:
  //
  //   THE STATE IS HERE, not in the frame. There is no iframe and no reporter:
  //   the pages are drawn by app-pdf-view out of this service's own signals, so
  //   the selection, the tallies and the outlines are read straight rather than
  //   posted across an opaque origin. The inspector reads the same signals it
  //   reads for a book (`selectionFor`, and the counts below), which is why one
  //   panel serves both modes.
  //
  //   THE WRITE IS OPTIMISTIC AND WHOLE. Main is handed the entire overlay on
  //   every gesture, atomically, exactly as the undo ledger is — the file is a
  //   few kilobytes and a person makes a few gestures a minute. There is no
  //   read-modify-write to serialise and no "what actually moved" to hear back:
  //   this side holds the file, so it knows what moved before it asks.
  //
  //   AND THE LEDGER IS THE SAME LEDGER. The rows below name a block instead of
  //   a `data-bf-id` and their setter is `amendOverlay` instead of a call into a
  //   chapter, but an undo is still the same call with the old value, through the
  //   same validator, and one gesture over forty blocks is still one action with
  //   forty rows.

  /** One scan's blocks, and what has been decided about them. */
  private readonly blockViews = signal<ReadonlyMap<string, BlockView>>(new Map());

  /** The block editor's state for a tab, or null while it is not in it. */
  blocksFor(tabId: string | null): BlockView | null {
    return tabId === null ? null : this.blockViews().get(tabId) ?? null;
  }

  /**
   * The rail's Blocks toggle.
   *
   * TURNING IT ON READS THE BANK, which is a spawn of the engine and can take a
   * moment (or minutes, for an old bank whose pages have to be measured again),
   * so the state exists from the first instant with `loading` on it and the pane
   * says so. Turning it off drops the state entirely: the overlay is on disk, the
   * blocks are re-derivable, and holding a book's worth of boxes for a mode
   * nobody is in is memory spent on nothing.
   */
  async toggleBlockView(id: string): Promise<void> {
    const tab = this.byId(id);
    if (!tab || tab.kind !== 'pdf') return;
    if (tab.blockView) {
      this.patch(id, { blockView: false });
      this.forgetBlockView(id);
      return;
    }
    this.patch(id, { blockView: true });
    await this.loadBlockView(id, tab.path);
  }

  /**
   * The blocks, the curation and the undo history, in that order, for one scan.
   *
   * ALL THREE BEFORE THE MODE IS USABLE, and awaited in one call rather than
   * raced, because each answer decides how the next is read: the blocks say what
   * exists, the overlay says what was decided about it, and the ledger is only
   * meaningful against the overlay it was recorded over. Main archives an overlay
   * and a ledger that belong to an earlier READING of this book before either
   * gets here (electron/overlays.ts), so what arrives is always about the blocks
   * that arrived — and it says so in the strip when that has just happened.
   */
  private async loadBlockView(tabId: string, pdfPath: string): Promise<void> {
    if (!api) return;
    /*
     * THE HISTORY IS ASKED FOR BEFORE THE BLOCKS, because whether this mode may
     * WRITE depends on it. Standing on a frozen save makes the editor read-only —
     * see `heldByASave` — and a mode that came up editable and then locked itself
     * a moment later, after the bank had been read, would hand somebody a window
     * in which a Delete key does the one thing this design exists to prevent.
     * `ensure` is silent and idempotent: a project already held is a no-op.
     */
    const dir = this.projects.projectFor(pdfPath)?.dir ?? null;
    this.ledger.ensure(dir);
    this.setBlockView(tabId, {
      pages: [], detected: [], overlay: null, frozen: null, problem: null, loading: true,
    });
    try {
      const blocks = await api.overlay.blocks(pdfPath);
      if (!this.stillInBlockView(tabId)) return;
      if (!blocks.ok) {
        this.setBlockView(tabId, {
          pages: [], detected: [], overlay: null, frozen: null, problem: blocks.reason, loading: false,
        });
        return;
      }
      /*
       * THE PICTURE THIS LOAD IS ABOUT, read BEFORE the call and not after it.
       * Somebody who clicks a save row while the mode is still coming up has moved
       * the pointer under this load, and recording where they ended up would tell
       * the effect above that the pre-move picture on screen is the one they asked
       * for. Recorded as it was asked, the effect sees the mismatch and puts it
       * right — which is the same recovery a move at any other moment gets.
       */
      const at = this.pictureIn(dir);
      const loaded: OverlayLoad = await api.overlay.load(pdfPath);
      if (!this.stillInBlockView(tabId)) return;
      this.setBlockView(tabId, {
        pages: blocks.pages,
        detected: blocks.chapters,
        overlay: loaded.file as OverlayFile,
        /*
         * THE SAVE THIS POSITION SHOWS, drawn instead of the live outlines when
         * there is one — which is when the row being stood on IS a save, and never
         * otherwise (`DISPLAYS_ITSELF`, shared/ledger.ts). Main decides:
         * `locateOverlay.displayed`. The gate that turns correcting off is derived
         * from the same answer (`curation-lock.ts`), so the outlines on the pages
         * and the refusal a Delete key meets can never be about two different
         * curations.
         */
        frozen: loaded.frozen as FrozenCuration | null,
        problem: null,
        loading: false,
      });
      // So the effect that watches for a pointer move does not immediately ask
      // again for blocks and corrections that have just arrived.
      if (dir !== null && at !== null) this.showing.set(fold(dir), at);
      if (loaded.notice !== null) this.notice.set(loaded.notice);
      /*
       * AND THE UNDO HISTORY, from the same pair of files. `restoreLedger` is
       * called from the EPUB unpack and from here and from nowhere else: a
       * ledger is restored when a document's editable surface OPENS, and for a
       * scan that moment is entering this mode rather than opening the tab.
       */
      await this.restoreLedger(tabId);
    } catch (err) {
      if (!this.stillInBlockView(tabId)) return;
      // ON THE MODE, not on the tab. The scan still renders and every other
      // thing this tab does still works; what failed is the curation surface,
      // and it says so where the outlines would have been.
      this.setBlockView(tabId, {
        pages: [],
        detected: [],
        overlay: null,
        frozen: null,
        problem: err instanceof Error ? err.message : String(err),
        loading: false,
      });
    }
  }

  /** The tab is still open and still in the mode — the guard every await owes. */
  private stillInBlockView(tabId: string): boolean {
    return this.byId(tabId)?.blockView === true;
  }

  /**
   * The one writer of the block view, and where everything derived is derived.
   *
   * ONCE PER CHANGE, NOT ONCE PER PAINT. A page of outlines asks the decision map
   * twice per block and there are five hundred pages; the elements are a regroup
   * of the whole book. Both are pure functions of the two things a caller
   * actually has — the engine's answer and the overlay — so making them here is
   * what keeps every consumer from making its own slightly different copy.
   */
  private setBlockView(
    tabId: string,
    state: Omit<BlockView, 'decisions' | 'elements' | 'byKey'>,
  ): void {
    const elements = new Map<number, readonly BlockElement[]>();
    const byKey = new Map<string, BlockElement>();
    for (const page of state.pages) {
      const made = elementsOfPage(page);
      elements.set(page.page, made);
      for (const element of made) byKey.set(element.key, element);
    }
    this.blockViews.update((map) => new Map(map).set(tabId, {
      ...state,
      elements,
      byKey,
      decisions: decisionsShown(state),
    }));
  }

  /**
   * The overlay changed and nothing else did — the path every gesture takes.
   *
   * Separate from `setBlockView` so that a strike does not regroup ten thousand
   * blocks into elements again to produce the identical map. The elements are a
   * function of the ENGINE'S answer, which does not move while the mode is open.
   */
  private setOverlay(tabId: string, file: OverlayFile): void {
    this.blockViews.update((map) => {
      const view = map.get(tabId);
      if (view === undefined) return map;
      const next = { ...view, overlay: file };
      // `decisionsShown` and not `decisionsOf(file)`, so that a gesture cannot
      // repaint the pages with the live curation while a frozen one is what this
      // position renders. It cannot happen — every gesture is refused at the three
      // doors while a save is in effect — and the derivation is asked the one way
      // anyway, because "it cannot happen" is how it eventually does.
      return new Map(map).set(tabId, { ...next, decisions: decisionsShown(next) });
    });
  }

  /**
   * The frozen save if the position is standing on one, and the live overlay
   * otherwise — the ONE overlay read this window makes on a pointer move.
   *
   * ── Why this is not `loadBlockView` ─────────────────────────────────────────
   *
   * Clicking a row in the history is meant to be instant, and the effect that
   * calls this fires on every one of them. Reloading the whole mode would put a
   * spawn of the engine and a re-measure of five hundred pages behind the one
   * gesture in this app that genuinely costs nothing — see the delete's own effect
   * for why THAT one is allowed to. The blocks do not move when the pointer moves:
   * they are the model's answer over the bank, and what changes is which
   * corrections are drawn over them. So this re-reads the curation and nothing
   * else, which is a few kilobytes off a disk.
   */
  private async refreshCuration(tabId: string, pdfPath: string): Promise<void> {
    if (!api) return;
    try {
      const loaded = await api.overlay.load(pdfPath);
      if (!this.stillInBlockView(tabId)) return;
      this.blockViews.update((map) => {
        const view = map.get(tabId);
        if (view === undefined) return map;
        const next: BlockView = {
          ...view,
          overlay: loaded.file as OverlayFile,
          frozen: loaded.frozen as FrozenCuration | null,
        };
        return new Map(map).set(tabId, { ...next, decisions: decisionsShown(next) });
      });
      // Main's sentence, and it is the only account of a snapshot it would not
      // draw: standing on a save whose reading has moved shows the plain blocks,
      // and a mode that did that silently would look like a save that lost its
      // corrections.
      if (loaded.notice !== null) this.notice.set(loaded.notice);
    } catch (err) {
      // The position moved and the corrections could not be re-read, so what is on
      // screen is now about a step nobody is standing on. Said out loud rather
      // than left: the pages still draw, and the sentence is why they are wrong.
      if (this.stillInBlockView(tabId)) {
        this.notice.set(err instanceof Error ? err.message : String(err));
      }
    }
  }

  private forgetBlockView(tabId: string): void {
    this.blockViews.update((map) => {
      const next = new Map(map);
      next.delete(tabId);
      return next;
    });
    /*
     * `showing` IS DELIBERATELY LEFT ALONE HERE, and that is a change of key
     * rather than an omission. It used to be per tab and was dropped with the
     * mode; it is now per PROJECT — the record of where this window last painted
     * a book standing, which is still true of a project whose pane somebody has
     * pressed Blocks off in. Dropping it here would re-baseline the project, and
     * the very next pointer move would be read as this window's first sighting of
     * it and obeyed by doing nothing. It is dropped when the last tab of the
     * project closes, which is where "this window is no longer showing that book"
     * is actually true.
     */
    this.forgetFrameState(tabId);
  }

  /**
   * What this overlay says about one block — the element's amendment with the
   * part's on top.
   *
   * The one accessor the drawing surface and the inspector share, so that an
   * outline and the row describing it can never disagree about what was decided.
   */
  decisionFor(tabId: string, element: BlockElement): OverlayDecision {
    const view = this.blocksFor(tabId);
    return view === null ? {} : elementDecision(view.decisions, element);
  }

  /** What a block IS after the overlay: the person's word, or the model's. */
  categoryOf(tabId: string, element: BlockElement): string {
    return this.decisionFor(tabId, element).category ?? element.category;
  }

  /** One page's outlines, in the model's own answer order. */
  elementsOn(tabId: string, page: number): readonly BlockElement[] {
    return this.blocksFor(tabId)?.elements.get(page) ?? [];
  }

  /** The element a target names, if this reading still has one. */
  elementAt(tabId: string, target: string): BlockElement | null {
    return this.blocksFor(tabId)?.byKey.get(target) ?? null;
  }

  // ── Standing on a save: the one state where this mode does not write ─────
  //
  // A curation step is a COPY OF SOMEBODY'S CORRECTIONS THAT NEVER CHANGES
  // AGAIN, which is the whole of what makes it worth keeping and the whole of
  // what makes clicking its row worth anything. Main protects that on the disk
  // side by keeping two paths apart rather than resolving one: `locateOverlay.file`
  // is always the LIVE curation, because that is where a correction goes, and
  // `.displayed` is the snapshot when the position stands on one, because that is
  // what the pages draw. Its own comment says the rest — resolving `file` to the
  // snapshot would mean the next strike anybody made while standing on a save
  // silently rewrote that save.
  //
  // WHAT THAT LEAVES IS THIS SIDE'S JOB. This service writes through
  // `overlay.save`, which writes the live file, while the pages at that position
  // are showing the frozen one. Somebody striking a paragraph there would be
  // correcting a book they are not looking at, and the first they would hear of
  // it is a Generate that comes back without their strike in it. So the mode is
  // READ-ONLY exactly where the two diverge.
  //
  // AND IT DIVERGES ON ONE KIND OF ROW ONLY — the row a save made. Nothing in
  // this file decides that: `curationLock` and `OverlayLoad.frozen` are both the
  // one display answer (`DISPLAYS_ITSELF`, shared/ledger.ts), so this mode goes
  // read-only exactly when a snapshot is what is on the pages, and it inherits
  // that rather than restating it. Standing on a TRANSLATION is live and editable
  // for that reason: the translation retained a bank of translated blocks and
  // froze nobody's corrections, so the outlines there are the live ones, a strike
  // lands in the file it came from, and the walkthrough this app is for — strike
  // some blocks after translating, save, generate that row — is a thing a person
  // can do.

  /** The project this document belongs to, or null for a file opened from elsewhere. */
  private projectDirOf(tab: Tab): string | null {
    return this.projects.projectFor(tab.path)?.dir ?? null;
  }

  /**
   * Why this document cannot be corrected right now, or null — the whole gate.
   *
   * AT THE THREE DOORS AND NOT AT THE WRITE. `putOverlay` is the single function
   * every correction goes through and would be the tempting place to put this, and
   * it is the wrong one: its refusals are reported as "that correction could not
   * be written to disk", which is a sentence about a failing filesystem, and this
   * is not a failure at all — it is the app declining to do something on purpose
   * and owing an explanation of how to get back to editing. The doors are
   * `amendBlocks` (every block gesture), `writeChapters` (the spine) and `replay`
   * (undo and redo), and between them they are every way a curation is changed.
   */
  private heldByASave(tabId: string): string | null {
    const tab = this.byId(tabId);
    if (tab === null) return null;
    return this.ledger.lockIn(this.projectDirOf(tab))?.why ?? null;
  }

  /**
   * The same answer, for the surfaces that have to DRAW the state rather than
   * refuse a gesture: the strip across the pages and the Steps accordion's hint.
   *
   * A refusal that only arrives after somebody has pressed Delete is a refusal
   * they meet by being surprised. This is what lets the mode say so first.
   */
  lockOn(tabId: string | null): CurationLock | null {
    const tab = tabId === null ? null : this.byId(tabId);
    return tab === null ? null : this.ledger.lockIn(this.projectDirOf(tab));
  }

  /**
   * Save: freeze the corrections as they stand, as a step in the history.
   *
   * ── This is not the Save people are used to, and the difference is the point ─
   *
   * The live curation is already on disk — written whole and atomically after
   * every gesture, which is what `commitOverlay` above is — so there is no unsaved
   * work for this to rescue and a button that claimed to be rescuing some would be
   * lying about the file it was writing. What it makes is a COPY THAT WILL NEVER
   * CHANGE AGAIN, with a step of its own, clickable in Steps and renderable from.
   * It is the difference between a document that autosaves and one you can name a
   * version of.
   *
   * A COMMIT WITH NOTHING IN IT IS REFUSED BY MAIN, and the refusal is shown as
   * main wrote it rather than pre-empted by a disabled button. A dead Save teaches
   * nobody why it is dead; main's sentence says what to correct first and what
   * pressing this will then keep.
   *
   * IT SAYS WHETHER IT LANDED, for the one caller that cannot go on without
   * knowing: the closing question's "save these corrections, then close" has to
   * leave the tab open when the commit was refused, because closing anyway would
   * throw away the exact thing that answer asked to keep. The button in the Steps
   * accordion ignores the answer and reads the notice strip, which is where every
   * one of these sentences goes.
   */
  async saveCorrections(tabId: string): Promise<boolean> {
    const tab = this.byId(tabId);
    if (!api || tab === null || tab.kind !== 'pdf') return false;
    const dir = this.projectDirOf(tab);
    if (dir === null) {
      this.notice.set(
        `${tab.title} is not in Foundry's library yet, so there is no history to keep a save in. `
        + 'Opening it from Home imports it and gives this book a project of its own.',
      );
      return false;
    }
    try {
      // The whole updated history comes back — ledger and rows — so the new row
      // appears from the answer rather than from a second question asked of a
      // catalogue that has moved on.
      this.ledger.adopt(dir, await api.overlay.commit(tab.path));
      /*
       * IT SAYS THAT NOTHING HAS BEEN TAKEN AWAY, because the thing people expect
       * of a Save in this app is the thing it deliberately does not do.
       *
       * This sentence used to explain that correcting had just stopped, which was
       * true and was the bug: the pointer followed the snapshot, so pressing Save
       * made the editor read-only that instant. A save retains what you have and
       * leaves you holding it (`RETAINED_BESIDE_YOU`, shared/ledger.ts), so the
       * live corrections are still live and still exactly what they were — and
       * what is worth saying is that the copy is now a row you can come back to.
       */
      this.notice.set(
        'Saved. That copy of your corrections is in this book’s history now and nothing later can '
        + 'change it. Carry on correcting — you are still on your live corrections, and this save '
        + 'stays exactly as it is until you click its row in Steps to stand on it.',
      );
      return true;
    } catch (err) {
      this.notice.set(err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  // ── The gestures ─────────────────────────────────────────────────────────

  /**
   * Strike — or bring back — a list of blocks in ONE action, and SAY IT.
   *
   * THE ONE STRIKE PATH: Delete on a selection, the inspector's
   * strike-all-of-this-category, and an undo all arrive here. Only the blocks
   * that actually MOVE get a row, which is the same rule the book's cut follows
   * and for the same reason — a block already struck was not changed by this
   * gesture and must not be brought back by undoing it.
   */
  async strikeBlocks(tabId: string, targets: readonly string[], strike: boolean): Promise<void> {
    const moved = await this.amendBlocks(
      tabId,
      targets,
      'strike',
      strike ? 'true' : '',
      (count) => `${strike ? 'struck' : 'brought back'} ${count} block${count === 1 ? '' : 's'}`,
    );
    if (moved === null || (moved === 1 && targets.length === 1)) return;
    this.notice.set(moved === 0
      ? `Every one of those blocks already ${strike ? 'was struck' : 'stood'} — nothing changed.`
      : strike
        ? `Struck ${moved} block${moved === 1 ? '' : 's'}. Press Delete on them to bring them back.`
        : `Brought back ${moved} block${moved === 1 ? '' : 's'}.`);
  }

  /**
   * Relabel the whole selection — the inspector's Category rows over a scan.
   *
   * A relabel BACK TO WHAT THE MODEL SAID removes the amendment rather than
   * writing an override that happens to agree, which is `amendOverlay`'s
   * canonical rule reaching the gesture: the overlay is what a person decided,
   * and agreeing with the model is not a decision worth carrying into every
   * future rendering of the book.
   */
  async relabelBlocks(tabId: string, targets: readonly string[], category: string): Promise<void> {
    const view = this.blocksFor(tabId);
    if (view === null) return;
    const kind = pdfCategoryLabel(category).toLowerCase();
    const moved = await this.amendBlocks(
      tabId,
      targets,
      'category',
      category,
      (count) => `relabelled ${count} block${count === 1 ? '' : 's'} as ${kind}`,
      // Relabelling a block to what the model already called it REMOVES the
      // amendment rather than writing an override that agrees with it. See
      // `amendOverlay`: the overlay is what a person decided, and agreeing is
      // not a decision worth carrying into every future rendering.
      (element) => (element.category === category ? '' : category),
    );
    if (moved === null || targets.length < 2) return;
    this.notice.set(moved === 0
      ? `All ${targets.length} of those blocks were already ${kind} — nothing changed.`
      : `Relabelled ${moved} block${moved === 1 ? '' : 's'} as ${kind}.`);
  }

  /**
   * Correct what a block SAYS — the line the model read as `1V` where the page
   * prints `IV`.
   *
   * ONE BLOCK AT A TIME, because the value is different for each: this is the one
   * gesture in the mode that cannot be applied to a selection, and the inspector
   * offers it only when exactly one block is picked. An empty string clears the
   * override and puts the model's own reading back.
   */
  async setBlockText(tabId: string, target: string, text: string): Promise<void> {
    await this.amendBlocks(
      tabId,
      [target],
      'text',
      text.trim(),
      () => (text.trim().length === 0
        ? `put ${target} back to what the model read`
        : `corrected the words of ${target}`),
    );
  }

  /**
   * Every block gesture, and the one place their optimism is spelled out.
   *
   * `moved` is what actually changed — a block whose value is already the one
   * being written is not a change, gets no row, and is not counted in the
   * sentence. Zero of them means the action is not recorded at all, because a
   * Ctrl+Z that appears to do nothing is worse than no entry.
   *
   * `valueFor` lets a caller decide per block, which the relabel needs: writing
   * the model's own category is spelled as removing the amendment.
   */
  private async amendBlocks(
    tabId: string,
    targets: readonly string[],
    field: OverlayField,
    value: string,
    label: (moved: number) => string,
    valueFor?: (element: BlockElement) => string,
  ): Promise<number | null> {
    const view = this.blocksFor(tabId);
    const tab = this.byId(tabId);
    if (view === null || view.overlay === null || !tab) return null;

    // The first of the three doors. See `heldByASave`: standing on a save, the
    // pages are showing that frozen copy while this gesture would be written into
    // the LIVE curation, which is not the book on screen.
    const held = this.heldByASave(tabId);
    if (held !== null) {
      this.notice.set(held);
      return null;
    }

    const ledgerField = LEDGER_FIELD_OF[field];
    const rows: LedgerRow[] = [];
    let file = view.overlay;
    for (const target of targets) {
      const element = view.byKey.get(target);
      if (element === undefined) continue;
      const wanted = valueFor === undefined ? value : valueFor(element);
      const before = fieldValue(elementDecision(view.decisions, element), field);
      // Already saying this: not a change, no row, and not counted in the
      // sentence. The same rule main enforces for a book's cut, enforced here
      // because here this side is the one holding the file.
      if (before === wanted) continue;
      file = amendOverlay(file, parseTargetKey(target), field, wanted);
      rows.push({ member: this.overlayKey(tab), target, field: ledgerField, before, after: wanted });
    }
    if (rows.length === 0) return 0;
    await this.commitOverlay(tabId, file, label(rows.length), rows);
    return rows.length;
  }

  // ── The spine ────────────────────────────────────────────────────────────

  /**
   * The chapters as the accordion shows them: the person's list, or the
   * engine's until somebody touches it.
   *
   * `confirmed` is the difference and it is the whole of the seeding design. An
   * overlay with no `chapters` field hands the book to the engine's own
   * detection — which is what every conversion in this app's history has done —
   * so the rows drawn are the detection's, marked as its. The first edit writes
   * the whole list out as the person's, and from then on it is definitive: the
   * detection is superseded rather than consulted, because somebody curating
   * chapters is doing it precisely because the detection got something wrong.
   */
  chaptersFor(tabId: string): { chapters: readonly OverlayChapter[]; confirmed: boolean } {
    const view = this.blocksFor(tabId);
    if (view === null) return { chapters: [], confirmed: false };
    // THE SPINE OF WHAT IS ON SCREEN, which is the frozen save when the position
    // stands on one. A save is as much a statement about where the book divides as
    // it is about which paragraphs are struck, and a Chapters section that kept
    // showing the live list beside frozen outlines would be half of one curation
    // and half of another.
    const shown = shownCuration(view);
    if (shown === null) return { chapters: [], confirmed: false };
    if (shown.chapters !== undefined) return { chapters: shown.chapters, confirmed: true };
    return { chapters: seedChapters(view.detected), confirmed: false };
  }

  /**
   * The curation this document is SHOWING — for a surface that has to say whether
   * there is one, without being able to write it.
   *
   * `CurationContent` rather than `OverlayFile`, so a caller cannot pass what it
   * was given here to anything that writes: the answer may be a frozen save.
   */
  curationShown(tabId: string | null): CurationContent | null {
    const view = this.blocksFor(tabId);
    return view === null ? null : shownCuration(view);
  }

  /** "The book divides here" — a chapter added at the one selected block. */
  async addChapter(tabId: string, target: string, title: string): Promise<void> {
    const at = parseTargetKey(target);
    const { chapters } = this.chaptersFor(tabId);
    if (chapters.some((one) => compareTargets(one.at, at) === 0)) {
      this.notice.set('A chapter already starts at that block.');
      return;
    }
    const named = title.trim();
    await this.writeChapters(
      tabId,
      [...chapters, { at, title: named.length > 0 ? named : `Chapter at ${target}` }],
      `made ${target} a chapter start`,
    );
  }

  async removeChapter(tabId: string, target: string): Promise<void> {
    const at = parseTargetKey(target);
    const { chapters } = this.chaptersFor(tabId);
    const going = chapters.find((one) => compareTargets(one.at, at) === 0);
    if (going === undefined) return;
    await this.writeChapters(
      tabId,
      chapters.filter((one) => one !== going),
      `took out the chapter “${going.title}”`,
    );
  }

  async renameChapter(tabId: string, target: string, title: string): Promise<void> {
    const at = parseTargetKey(target);
    const { chapters } = this.chaptersFor(tabId);
    const named = title.trim();
    const current = chapters.find((one) => compareTargets(one.at, at) === 0);
    if (current === undefined || named.length === 0 || named === current.title) return;
    await this.writeChapters(
      tabId,
      chapters.map((one) => (one === current ? { at: one.at, title: named } : one)),
      `renamed a chapter to “${named}”`,
    );
  }

  /**
   * Hand the book back to the engine's own detection — the only gesture that
   * REMOVES the list rather than editing it.
   *
   * It exists because the seeding is one-way otherwise: the first chapter edit
   * turns "the engine decides" into "these forty-one blocks, exactly", and
   * without this there would be no way back to the state every unconverted scan
   * is already in. It is one ledger row like any other, so Ctrl+Z brings the
   * list back.
   */
  async resetChapters(tabId: string): Promise<void> {
    const view = this.blocksFor(tabId);
    if (view === null || view.overlay === null || view.overlay.chapters === undefined) return;
    await this.writeChapters(tabId, null, 'gave the chapters back to Foundry to work out');
  }

  /**
   * The spine, written whole.
   *
   * ONE ROW CARRYING THE WHOLE LIST, which is the shape `LedgerField` explains:
   * adding, removing, renaming and seeding are all "it used to run like this and
   * now runs like that", and the seeding gesture in particular turns an ABSENT
   * field into forty rows at once — a state no per-chapter scheme could undo
   * back to.
   */
  private async writeChapters(
    tabId: string,
    chapters: readonly OverlayChapter[] | null,
    label: string,
  ): Promise<void> {
    const view = this.blocksFor(tabId);
    const tab = this.byId(tabId);
    if (view === null || view.overlay === null || !tab) return;
    // The second door. A chapters list is one statement about the whole book and
    // is exactly as much of somebody's judgement as a strike; it goes into the
    // same file, so it meets the same gate.
    const held = this.heldByASave(tabId);
    if (held !== null) {
      this.notice.set(held);
      return;
    }
    const before = chaptersText(view.overlay.chapters ?? null);
    const after = chaptersText(chapters);
    if (before === after) return;
    let file: OverlayFile;
    try {
      file = setChapters(view.overlay, chapters);
    } catch (err) {
      this.notice.set(err instanceof Error ? err.message : String(err));
      return;
    }
    await this.commitOverlay(tabId, file, label, [{
      member: this.overlayKey(tab),
      // The spine is one statement about the whole book rather than about a
      // block, so the row names the overlay itself. Nothing replays it against
      // a target and nothing should be able to.
      target: this.overlayKey(tab),
      field: 'chapters',
      before,
      after,
    }]);
  }

  // ── Writing it down ──────────────────────────────────────────────────────

  /**
   * Paint it, file it, and write it — in that order, and the order is the feel of
   * the mode.
   *
   * THE SIGNAL FIRST, so the outline changes under the pointer that struck it.
   * The disk write is a few kilobytes through IPC and the gesture has already
   * landed as far as the user is concerned; a mode that waited for a rename in
   * the library folder before drawing a line through a paragraph would be a mode
   * nobody uses on four hundred of them.
   *
   * A REFUSAL PUTS IT BACK. Main will not write over a file it could not read or
   * archive, and it says so by name — so the state returns to what the disk
   * still holds rather than leaving the screen describing a curation that was
   * never saved. The ledger entry goes with it, because an action that did not
   * happen is not an action to undo.
   */
  private async commitOverlay(
    tabId: string,
    file: OverlayFile,
    label: string,
    rows: readonly LedgerRow[],
  ): Promise<void> {
    const refused = await this.putOverlay(tabId, file);
    if (refused !== null) {
      this.notice.set(
        `That correction could not be written to disk, so it has been taken back: ${refused}`,
      );
      return;
    }
    /*
     * RECORDED AFTER THE WRITE LANDED, and the order of the two files matters.
     *
     * An action that was refused is not an action, so it must not reach the
     * ledger at all — recording first and un-recording on failure would also
     * have to put back the REDO stack that `record` clears, which is a second
     * thing to get right for no gain.
     *
     * And the overlay is written before the ledger deliberately. Dying between
     * them leaves a correction whose undo entry is missing, which costs one
     * Ctrl+Z; the other order leaves an undo entry for a correction that never
     * happened, which takes back somebody else's work.
     */
    this.record(tabId, label, rows);
  }

  /**
   * Paint an overlay and write it — the one write, shared by a gesture and by a
   * replay of one.
   *
   * Resolves to NULL for a write that landed and to the reason for one that did
   * not, having already put the state back to what the disk still holds. It is a
   * returned value rather than a throw because both callers have something
   * different to say about it: a gesture takes its ledger entry back, and a
   * replay leaves its action where it is so that pressing undo again after the
   * problem is fixed tries the same rows.
   */
  private async putOverlay(tabId: string, file: OverlayFile): Promise<string | null> {
    const view = this.blocksFor(tabId);
    const tab = this.byId(tabId);
    if (view === null || view.overlay === null || !tab || !api) return null;
    const was = view.overlay;
    this.setOverlay(tabId, file);
    try {
      await api.overlay.save(tab.path, file);
      return null;
    } catch (err) {
      this.setOverlay(tabId, was);
      return err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * One action's rows put back into the overlay — every one of them, then ONE
   * write.
   *
   * WHERE THE BOOK'S REPLAY WRITES A FILE PER ROW, this writes once for the
   * action, and the difference is not an optimisation. A book's rows land in
   * different chapters through different validated setters, so each is its own
   * commit and a failure halfway is a real half-done state the code has to
   * report. A scan's rows all land in ONE file: forty strikes taken back are
   * forty edits of one object and a single atomic write of it, so the action is
   * whole or it never happened, which is exactly what an action should be.
   *
   * IN REVERSE ORDER, like the book's, so that an action whose rows touch one
   * target twice unwinds in the order it was made.
   */
  private async replayOverlay(
    tabId: string,
    action: LedgerAction,
    direction: 'undo' | 'redo',
  ): Promise<string | null> {
    const view = this.blocksFor(tabId);
    if (view === null || view.overlay === null) {
      return 'the block editor is not open on this document any more.';
    }
    let file = view.overlay;
    for (let at = action.rows.length - 1; at >= 0; at -= 1) {
      const row = action.rows[at]!;
      const value = direction === 'undo' ? row.before : row.after;
      try {
        file = replayOverlayRow(file, row, value);
      } catch (err) {
        // Nothing has been written: the edits above were made to a copy. So the
        // curation on screen is still exactly the curation on disk, and the
        // action stays on its stack.
        return `${row.target}: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
    return this.putOverlay(tabId, file);
  }

  /**
   * The overlay's key, which is what a block row's `member` is.
   *
   * The renderer does not know the project's content key — main does, and main
   * is what files the ledger — so this uses the document's own path, folded. It
   * is never resolved back to anything: `member` for these rows is an identity
   * rather than a route, since the setter is the overlay itself and there is only
   * ever one of those per document.
   */
  private overlayKey(tab: Tab): string {
    return normalise(tab.path);
  }

  // ── What the inspector reads ─────────────────────────────────────────────

  /**
   * How many blocks of each category this SCAN holds, and how many are struck.
   *
   * DERIVED HERE rather than reported, which is the one structural difference
   * from the book's tallies: a chapter's counts come from the frame because
   * nothing outside it can see into an opaque origin, and a scan's blocks are
   * this service's own data. The shape is identical (`CategoryCounts`) so the
   * inspector draws one panel for both.
   *
   * COUNTED AFTER THE OVERLAY, always. A block relabelled Footnote counts as a
   * footnote, because that is what it now is — a tally that reported the model's
   * opinion would be a legend for outlines that are no longer that colour.
   */
  blockCountsFor(tabId: string | null): CategoryCounts | null {
    const view = this.blocksFor(tabId);
    if (view === null || view.overlay === null) return null;
    const counts: Record<string, number> = {};
    const struck: Record<string, number> = {};
    for (const element of view.byKey.values()) {
      const decision = elementDecision(view.decisions, element);
      const category = decision.category ?? element.category;
      counts[category] = (counts[category] ?? 0) + 1;
      if (decision.strike === true) struck[category] = (struck[category] ?? 0) + 1;
    }
    return { counts, struck };
  }

  /** Every block of one category, by name — the inspector's strike-all. */
  targetsOfCategory(tabId: string, category: string): string[] {
    const view = this.blocksFor(tabId);
    if (view === null) return [];
    const targets: string[] = [];
    for (const element of view.byKey.values()) {
      if (this.categoryOf(tabId, element) === category) targets.push(element.key);
    }
    return targets;
  }

  /**
   * A click, a ctrl-click or a marquee, reported as the selection.
   *
   * THE SAME CHANNEL THE FRAME USES (`reportSelection`), so the inspector's
   * "three blocks are selected" is one code path over two kinds of document. The
   * shared category is worked out here for the same reason it is worked out in
   * the frame: a marked row over a mixed selection is the panel asserting
   * something untrue about most of what is highlighted.
   */
  selectBlocks(tabId: string, targets: readonly string[], add: boolean): void {
    const existing = add ? this.selectionFor(tabId)?.blockIds ?? [] : [];
    const picked = new Set(existing);
    for (const target of targets) {
      // Ctrl-clicking a block that is already picked takes it out, which is what
      // every list in every app does and what makes a mis-click cheap.
      if (add && picked.has(target)) picked.delete(target);
      else picked.add(target);
    }
    const blockIds = [...picked];
    let category: string | null = null;
    for (const target of blockIds) {
      const element = this.elementAt(tabId, target);
      const mine = element === null ? null : this.categoryOf(tabId, element);
      if (category === null) category = mine;
      else if (category !== mine) { category = null; break; }
    }
    this.reportSelection(tabId, blockIds, category);
  }

  /** The inspector's Category rows, over the focused scan. */
  relabelSelectedBlocks(category: string): void {
    const tab = this.activeDocument();
    if (!tab || tab.kind !== 'pdf' || !tab.blockView) return;
    const picked = this.selectionFor(tab.id);
    if (picked === null) {
      this.notice.set('Click a block on the page first, or drag a rectangle over several; the '
        + 'category is applied to everything that is selected.');
      return;
    }
    void this.relabelBlocks(tab.id, picked.blockIds, category);
  }

  /** The inspector's strike-all-of-this-kind, over the focused scan. It TOGGLES. */
  strikeBlockCategory(category: string): void {
    const tab = this.activeDocument();
    if (!tab || tab.kind !== 'pdf' || !tab.blockView) return;
    const targets = this.targetsOfCategory(tab.id, category);
    if (targets.length === 0) return;
    const counts = this.blockCountsFor(tab.id);
    // With every one of them already struck the gesture brings them back, which
    // is what makes a two-hundred-block strike feel undoable with the tool that
    // did it. Same rule as the book's.
    const allStruck = (counts?.struck[category] ?? 0) === targets.length;
    void this.strikeBlocks(tab.id, targets, !allStruck);
  }

  /**
   * Put a block in front of the reader — a click on a chapter row.
   *
   * A SIGNAL NAMING THE TAB, exactly like `frameCommand` and for a milder version
   * of its reason: the inspector is in the shell and the five viewers are a
   * component tree away, so it names a document and whichever pane is drawing
   * that document scrolls. The sequence number is what makes clicking the same
   * row twice do anything at all.
   */
  readonly blockReveal = signal<{ tabId: string; target: string; seq: number } | null>(null);
  private revealSeq = 0;

  revealBlock(tabId: string, target: string): void {
    this.revealSeq += 1;
    this.blockReveal.set({ tabId, target, seq: this.revealSeq });
  }


  // ── Select mode ──────────────────────────────────────────────────────────

  /**
   * ONE WRITE IN FLIGHT PER MEMBER, and every write of a chapter goes through
   * it: an editor flush, a cut, an un-cut, an edited paragraph.
   *
   * Each of them is a read-modify-write of one file in the working tree. Two
   * that overlap both read the SAME text and the second one's write erases the
   * first one's change — and select mode is a gesture stream, so two cuts a
   * quarter of a second apart is the normal case rather than a race somebody
   * has to contrive. Serialised per member rather than globally, because two
   * chapters are two files and there is nothing for them to fight over.
   *
   * A failed write does not poison the chain: the next one runs regardless, and
   * its caller hears about its own failure.
   */
  private readonly memberWrites = new Map<string, Promise<unknown>>();

  private queueMemberWrite<T>(bookId: string, member: string, work: () => Promise<T>): Promise<T> {
    const key = `${bookId} :: ${member}`;
    const previous = this.memberWrites.get(key) ?? Promise.resolve();
    const next = previous.then(work, work);
    // The tail is dropped once nothing is behind it, so a long session does not
    // accumulate one settled promise per chapter it ever touched.
    const settled = next.then(() => { /* kept */ }, () => { /* kept */ }).then(() => {
      if (this.memberWrites.get(key) === settled) this.memberWrites.delete(key);
    });
    this.memberWrites.set(key, settled);
    return next;
  }

  /**
   * The rail's Select toggle.
   *
   * TURNING IT ON STAMPS A BOOK THAT HAS NOT BEEN. Select mode outlines
   * `data-bf-cat` and records a cut against `data-bf-id`, and a book carrying
   * neither — one cast before ids existed, or a publisher's EPUB imported by a
   * build that could not stamp it — has nothing this mode can address. Main
   * decides whether a stamping run is worth making and then spawns
   * `foundry epub-stamp` on the working tree, which is the ONE implementation
   * of the scheme; this side only says so in the log and reloads the rendered
   * pane — the single revision bump select mode makes, because the frame is
   * showing markup that has just gained attributes on every block and no
   * gesture in the mode would work against it.
   *
   * The mode is turned on AFTER the stamping lands, so the first click already
   * has a name to report.
   */
  async toggleSelectMode(id: string): Promise<void> {
    const tab = this.byId(id);
    if (!tab || tab.kind !== 'epub' || tab.book === null) return;
    if (tab.selectMode) {
      this.patch(id, { selectMode: false });
      // The frame drops its selection and stops counting when the mode closes,
      // so the inspector must stop showing last minute's numbers as this
      // minute's truth.
      this.forgetFrameState(id);
      return;
    }
    if (api) {
      // The spine, in reading order, without the #fragment rows: those name a
      // heading inside a document that is already in the list.
      const members = [...new Set(tab.book.chapters.map((chapter) => memberOf(chapter.href)))];
      try {
        const stamped = await api.epub.stamp(tab.book.id, members);
        if (stamped.minted > 0) {
          console.log(
            `[select] ${tab.title} carried no block ids: the engine stamped `
            + `${stamped.minted} elements across ${stamped.documents} documents.`,
          );
          const current = this.byId(id);
          this.patch(id, { modified: true, revision: (current?.revision ?? tab.revision) + 1 });
        }
      } catch (err) {
        this.notice.set(err instanceof Error ? err.message : String(err));
        return;
      }
    }
    this.patch(id, { selectMode: true });
  }

  /**
   * An edited block: optimistic and repainted on a refusal, like the cut — and
   * then the ONE question this mode has to ask out loud.
   *
   * `was` is the block's markup as it stood before the edit, handed over by the
   * frame. It is carried this far for exactly one purpose: the third answer to
   * the footnote question is "put the number back", and nothing else in the app
   * is holding the text that had it. Main wrote the new words over the old ones
   * and the old ones are gone from disk.
   *
   * THE WRITE HAPPENS FIRST AND THE QUESTION SECOND, which is deliberate and is
   * the whole feel of select mode: what you typed lands the instant you stop
   * typing. A dialog that interrupted the edit to ask permission would put a
   * modal between a person and their own sentence. Cancel undoes.
   */
  async setBlockHtml(id: string, blockId: string, html: string, was: string): Promise<void> {
    const unlinked = await this.blockEdit(
      id,
      (bridge, book, member) => bridge.epub.setBlockHtml(book, member, blockId, html),
      (_notes, member) => ({
        label: `edited the words of ${blockId}`,
        /*
         * NO `was`, NO ROW. The frame hands over the block's previous markup
         * and it is the only copy of it anywhere — main wrote the new words
         * over the old ones. A row with an empty `before` would be a Ctrl+Z
         * that blanks the paragraph, so an edit that arrives without it is
         * applied and simply is not undoable. It cannot happen for an edit this
         * app's own frame made; it is the shape of the message that allows it.
         */
        rows: was.length === 0 ? [] : [{
          member,
          target: blockId,
          field: 'html' as const,
          before: was,
          after: html,
        }],
      }),
    );
    // Null is a refusal, and a refusal wrote nothing — there is no new text for
    // either question below to be about.
    if (unlinked === null) return;
    if (unlinked.length > 0 && await this.askAboutUnlinkedNotes(id, blockId, was, unlinked)) {
      // Cancelled: the block is back to the markup it had, so the heading (if
      // this was one) reads what it always read and there is nothing to offer
      // the contents.
      return;
    }
    await this.askAboutNavEcho(id, blockId, was);
  }

  /**
   * "You edited this heading — should the contents entry change too?"
   *
   * THE DIRECTION THAT DID NOT EXIST. An in-place heading edit wrote the page
   * and stopped there, so a typo fixed on the page stayed in the table of
   * contents forever with nothing on screen to say so. That was a bug: the
   * divergence this design protects is a DELIBERATE one — the caster composes
   * labels the page never carried, and "Part II — The Road to War" over a page
   * reading "II" is correct — and a misspelling nobody chose is not that.
   *
   * Main answers the four questions that decide whether there is anything to
   * ask at all (`navEchoForBlock`), and it is null far more often than not: the
   * block is a paragraph, the book has no contents, no entry points here, or
   * the entry already says something else on purpose. Only the last case is
   * interesting, and it is exactly the case where asking would be wrong.
   *
   * ASKED AFTER THE WRITE, like every other question in this mode. The page is
   * already showing what was typed; the contents is what has not moved.
   */
  private async askAboutNavEcho(id: string, blockId: string, was: string): Promise<void> {
    const bridge = api;
    const tab = this.byId(id);
    if (!bridge || !tab || tab.book === null || tab.chapterHref === null) return;
    if (was.length === 0) return;
    const bookId = tab.book.id;
    const member = memberOf(tab.chapterHref);
    try {
      const echo = await bridge.epub.navEchoForBlock(bookId, member, blockId, was);
      if (echo === null) return;
      const answer = await bridge.confirmNavEcho(echo);
      if (answer !== 'update') return;

      /*
       * The nav half, through the ordinary rename door. It cannot ask about
       * the page in return — that door offers the heading only when the
       * heading still reads the OLD label, and this heading is the thing that
       * just changed — so the two directions cannot bounce a question between
       * them.
       *
       * ITS OWN LEDGER ACTION, and not part of the edit that prompted it. They
       * are two answers a person gave separately — the words, then "yes, change
       * the contents as well" — and one Ctrl+Z that took back both would undo a
       * question the user answered on purpose.
       */
      await bridge.epub.renameHeading(bookId, echo.href, echo.now);
      const navMember = tab.book.navMember;
      this.record(id, `carried the heading through to the contents as "${echo.now}"`,
        navMember === null ? [] : [{
          member: navMember,
          target: echo.href,
          field: 'nav-label',
          before: echo.was,
          after: echo.now,
        }]);
      const current = this.byId(id);
      if (!current || current.book === null) return;
      const chapters = current.book.chapters.map((chapter) =>
        (chapter.href === echo.href ? { ...chapter, label: echo.now } : chapter));
      // NO REVISION BUMP: the rendered pane is showing the chapter, and the
      // chapter did not move. Reloading it would cost the reader their place
      // to repaint a sidebar row this line has already repainted.
      this.patch(id, { book: { ...current.book, chapters }, modified: true });
    } catch (err) {
      this.notice.set(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * "You deleted this footnote's last reference — should the footnote go too?"
   *
   * MAIN ASKS IT (a native box, modal to the window, like every other dialog in
   * this app) and main also answers it without asking when the user has said
   * "don't ask again": the standing answer is stored per ANSWER in
   * app-settings.json, so "always strike it" and "always leave it" stay two
   * different instructions.
   *
   * One edit can orphan more than one note — a paragraph carrying two reference
   * numbers, both deleted in one pass — so this walks them. A CANCEL STOPS THE
   * WALK: it restores the block to the markup that had every one of those
   * numbers in it, so there is nothing left to ask about, and asking anyway
   * would be asking about a note that is reachable again.
   */
  private async askAboutUnlinkedNotes(
    id: string,
    blockId: string,
    was: string,
    notes: readonly UnlinkedNote[],
  ): Promise<boolean> {
    const bridge = api;
    if (!bridge) return false;
    for (const note of notes) {
      const answer = await bridge.confirmUnlinkedNote(note);
      if (answer === 'cancel') {
        await this.restoreBlockHtml(id, blockId, was);
        // Said out loud rather than left for the caller to infer from the
        // absence of anything: the edit has been UNDONE, and every later
        // question about "the new text" would be a question about text that is
        // no longer there.
        return true;
      }
      if (answer === 'keep') continue;
      const done = await this.blockEdit(
        id,
        (b, book, member) => b.epub.setNoteCut(book, member, note.noteId, true),
        (moved, member) => ({
          label: `struck the footnote ${note.noteId}`,
          // False means the note already carried the mark, so this gesture
          // changed nothing and must not leave a row promising to bring back a
          // footnote somebody else struck.
          rows: moved === true ? [{
            member,
            target: note.noteId,
            field: 'note-cut' as const,
            before: '',
            after: '1',
          }] : [],
        }),
      );
      // PAINTED AFTER THE WRITE, and only when the write landed — the opposite
      // of every other mark in this mode. A cut the user pressed Delete for is
      // painted first because the hand is already moving; this one was decided
      // in a dialog that has just closed, there is no gesture to keep up with,
      // and painting a strike over a footnote main then refused to mark would
      // be a lie with nothing on screen to correct it.
      if (done !== null) this.commandFrame(id, { type: 'foundry:mark-note', noteId: note.noteId, cut: true });
    }
    return false;
  }

  /**
   * The "put the number back" answer: the block's previous markup, written back.
   *
   * A SEPARATE MAIN CALL, because the ordinary edit door forbids markup being
   * gained and a restored reference number is a `<sup>` and an anchor
   * reappearing — see `restoreBlockHtml` in electron/epub-reader.ts for the
   * mirror check it makes instead.
   *
   * IT BUMPS THE REVISION, which no other select-mode write does. The frame is
   * showing the sentence WITHOUT the number, because that is what the user
   * typed; there is no attribute to flip that would put it back, so the honest
   * repaint is to reload the chapter from the file that now has it. The cost is
   * the reader landing at the top of the chapter, which is the price of an undo.
   */
  private async restoreBlockHtml(id: string, blockId: string, html: string): Promise<void> {
    const bridge = api;
    const tab = this.byId(id);
    if (!bridge || !tab || tab.book === null || tab.chapterHref === null) return;
    /*
     * NOTHING TO PUT BACK IS SAID, NEVER GUESSED AT. The previous markup comes
     * from the frame and is dropped by the message check if it is missing or
     * absurdly long — and an empty string here would be a request to blank the
     * paragraph, which for a block whose words carried no other tags main would
     * accept as a legal word edit. This is the one place that can tell the
     * difference between "restore to nothing" and "we never had it".
     */
    if (html.length === 0) {
      this.notice.set(
        `The reference number cannot be put back into ${blockId}: this app is no longer holding `
        + 'the words that had it. The footnote was left in the book — press Delete on it to strike '
        + 'it, or type the number back into the sentence.',
      );
      return;
    }
    const bookId = tab.book.id;
    const member = memberOf(tab.chapterHref);
    try {
      await this.queueMemberWrite(bookId, member, () =>
        bridge.epub.restoreBlockHtml(bookId, member, blockId, html));
      /*
       * THE CANCELLED EDIT LEAVES THE LEDGER RATHER THAN GAINING A SECOND ROW.
       *
       * This IS an undo, performed by a dialog: the block now says exactly what
       * it said before the user typed. Recording the restore as an action of
       * its own would leave two entries whose net effect is nothing, and the
       * next Ctrl+Z would REDO the edit the user just cancelled — pressing undo
       * to bring back a footnote reference they had chosen to keep. Dropping
       * the edit's own action instead leaves the ledger describing the book as
       * it actually stands.
       */
      this.dropLastAction(id, blockId);
      this.memberChanged(id, member);
    } catch (err) {
      this.notice.set(err instanceof Error ? err.message : String(err));
    }
    const current = this.byId(id);
    if (current) this.patch(id, { modified: true, revision: current.revision + 1 });
  }

  /**
   * Relabel THE WHOLE SELECTION — the inspector's Category rows, applied to
   * every block the frame says is highlighted, in one read and one write.
   *
   * IT CHANGES THE LABEL AND NOT THE SHAPE: a paragraph relabelled `footnote`
   * stays a `<p>` in the prose and does not move into the footnotes section.
   * That re-shaping is `foundry epub-final`'s and is not in this app.
   *
   * Same optimism as the cut — the frame set the attributes and repainted its
   * own colours off them before this ran — so no revision bump on success, and a
   * bump on a refusal to let the file repaint over the guess. And SAID OUT LOUD
   * once it is more than one block: relabelling thirty paragraphs from a panel
   * on the far side of the window is a gesture whose effect is off screen.
   */
  async setBlockCategories(
    id: string,
    blockIds: readonly string[],
    category: string,
  ): Promise<void> {
    const kind = categoryLabel(category).toLowerCase();
    const changed = await this.blockEdit(
      id,
      (bridge, book, member) => bridge.epub.setCategories(book, member, [...blockIds], category),
      (moved, member) => ({
        label: `relabelled ${moved.length} block${moved.length === 1 ? '' : 's'} as ${kind}`,
        // ONE ROW PER BLOCK, each carrying the label THAT block used to have.
        // A marquee over a page catches paragraphs and captions together, so an
        // undo that put them all back to one category would be inventing a past
        // the book never had — which is why main answers with `was` rather than
        // with a count.
        rows: moved.map((one) => ({
          member,
          target: one.id,
          field: 'category' as const,
          before: one.was,
          after: category,
        })),
      }),
    );
    if (changed === null || blockIds.length < 2) return;
    this.notice.set(changed.length === 0
      ? `All ${blockIds.length} of those blocks were already ${kind} — nothing changed.`
      : `Relabelled ${changed.length} block${changed.length === 1 ? '' : 's'} as ${kind}.`);
  }

  /**
   * Strike — or bring back — a list of blocks in ONE write, and SAY IT.
   *
   * THE ONE CUT PATH. Delete on a single block, Delete on a marquee's worth of
   * them, and the inspector's select-all-by-category all arrive here; `category`
   * is the only thing that differs, and it only changes the sentence. One path
   * means one undo entry shape and one place the count is read.
   *
   * The number comes back from main rather than from the count the frame sent,
   * because they can differ — a block already carrying the mark is not a change
   * — and a gesture that reports what it asked for rather than what it did is a
   * gesture nobody can trust with two hundred paragraphs.
   */
  async cutBlocks(
    id: string,
    blockIds: readonly string[],
    cut: boolean,
    category: string | null,
  ): Promise<void> {
    const kind = category === null ? '' : `${categoryLabel(category).toLowerCase()} `;
    const changed = await this.blockEdit(
      id,
      (bridge, book, member) => bridge.epub.setCuts(book, member, [...blockIds], cut),
      (moved, member) => ({
        label: `${cut ? 'struck' : 'brought back'} ${moved.length} ${kind}`
          + `block${moved.length === 1 ? '' : 's'}`,
        // ONE ACTION, MANY ROWS — Owen's action number. Sixteen blocks struck by
        // one marquee are sixteen rows here, and one Ctrl+Z reverses all
        // sixteen. Only the ids MAIN says moved get a row: a block that was
        // already struck was not changed by this gesture and must not be
        // brought back by undoing it.
        rows: moved.map((target) => ({
          member,
          target,
          field: 'cut' as const,
          before: cut ? '' : '1',
          after: cut ? '1' : '',
        })),
      }),
    );
    if (changed === null) return;
    /*
     * ONE BLOCK SAYS NOTHING, and that is deliberate. Pressing Delete on a
     * paragraph paints a line through it under the pointer; a notice strip
     * repeating what the user is already looking at would train them to stop
     * reading the strip, which is where every refusal in this mode lands.
     */
    if (changed.length === 1 && blockIds.length === 1) return;
    const many = changed.length === 1 ? '' : 's';
    this.notice.set(changed.length === 0
      ? `Every one of those ${kind}blocks already ${cut ? 'was struck' : 'stood'} — nothing changed.`
      : cut
        ? `Struck ${changed.length} ${kind}block${many}. Press Delete on them to bring them back.`
        : `Brought back ${changed.length} ${kind}block${many}.`);
  }

  /**
   * Every select-mode write, and the one place their optimism is spelled out.
   *
   * Resolves with whatever main answered, or NULL when the write was refused or
   * there was nothing to write to — which is what lets a caller tell "main did
   * this" from "main would not", without a second try/catch at every call site.
   *
   * IT IS ALSO WHERE THE ACTION IS WRITTEN INTO THE LEDGER. `entry` is asked
   * for the label and the rows AFTER main has answered, because both need what
   * main said MOVED rather than what the frame asked for — "struck 14 blocks"
   * when fourteen tags actually changed, whatever the marquee caught, and a row
   * for each of those fourteen and no others.
   */
  private async blockEdit<T>(
    id: string,
    // THE WRITE COMES FIRST so TypeScript can infer `T` from it before it has
    // to type the callback below — with the two the other way round, `answer`
    // infers as `{}` and every call site has to restate main's return type by
    // hand, which is two declarations of one thing waiting to disagree.
    write: (bridge: FoundryApi, bookId: string, member: string) => Promise<T>,
    entry: (answer: T, member: string) => { label: string; rows: readonly LedgerRow[] },
  ): Promise<T | null> {
    const bridge = api;
    const tab = this.byId(id);
    if (!bridge || !tab || tab.book === null || tab.chapterHref === null) return null;
    const bookId = tab.book.id;
    const member = memberOf(tab.chapterHref);
    try {
      const answer = await this.queueMemberWrite(bookId, member, () => write(bridge, bookId, member));
      const { label, rows } = entry(answer, member);
      this.record(id, label, rows);
      this.patch(id, { modified: true });
      this.memberChanged(id, member);
      return answer;
    } catch (err) {
      this.notice.set(err instanceof Error ? err.message : String(err));
      const current = this.byId(id);
      if (current) this.patch(id, { revision: current.revision + 1 });
      return null;
    }
  }

  /** Something the frame itself refused, said where the user can read it. */
  reportSelectRefusal(reason: string): void {
    this.notice.set(reason);
  }

  // ── Undo / redo: the ledger ──────────────────────────────────────────────
  //
  // A LEDGER OF ACTIONS, not a stack of chapter snapshots. Owen's shape, and it
  // is right for a reason particular to this app: every document action ALREADY
  // has a targeted, validated setter in main, keyed by `data-bf-id` —
  // `setCuts`, `setCategories`, `setBlockHtml`, `setNoteCut`, `renameHeading`.
  // So an undo is not a new way of writing a book. IT IS THE SAME CALL WITH THE
  // OLD VALUE, through the same validators, which means undo cannot corrupt a
  // book in any way an ordinary edit could not. A snapshot undo would have been
  // a second route into somebody's chapters that no validator ever saw — the
  // one thing this codebase spends its refusals avoiding.
  //
  // It is also the difference between a few dozen bytes per action and fifty
  // kilobytes of it, and — the part that matters more — A SNAPSHOT CANNOT SAY
  // WHAT IT IS. From a row the notice strip can say "Undid: relabelled 16
  // blocks as footnote". From a pair of chapter texts it can only say "Undid".
  //
  // AN ACTION HAS A NUMBER AND MANY ROWS. Sixteen blocks struck by one marquee
  // are sixteen rows of one action, and Ctrl+Z reverses all sixteen — which is
  // exactly what Owen asked for, and it falls out rather than being arranged:
  // the gesture is ONE call to main, main answers with everything it moved, and
  // that answer IS the rows.
  //
  // THE FIVE ACTIONS ARE THE WHOLE OF IT: cut/un-cut, relabel, edit words,
  // strike a footnote, rename a heading. Nothing else in this app writes a
  // document, and a sixth would have to add a `LedgerField` to exist.
  //
  // PER DOCUMENT, created on its first edit and dropped with the tab (`close`),
  // never a singleton cleared field by field. Keyed by tab id in a plain Map
  // rather than stored on the `Tab` itself, because `Tab` is replaced wholesale
  // by `patch()` on every edit and a growing array riding along in it would be
  // copied on each one.
  //
  // ── AND IT IS ON DISK ────────────────────────────────────────────────────
  //
  // The stacks used to die with the tab. Owen: "lets flush those to disk every
  // time a change is made. i want the user to be able to open a project and edit
  // a file, and if foundry dies randomly, i want the stack to still be
  // available." So every mutation of either stack — `record`, `undo`, `redo`,
  // and the footnote dialog's `unrecord` — is followed by `flush`, which hands
  // both stacks to main to write whole and atomically into the book's own
  // project (`electron/history.ts`).
  //
  // WHAT IS STILL IN MEMORY ONLY IS THIS MAP. Closing a book drops its entry, as
  // it always did; THE FILE STAYS, and reopening the book reads it back, so
  // Ctrl+Z reaches yesterday's actions the moment the book is on screen. The tab
  // id never reaches disk — it is minted fresh every launch, and a history filed
  // under one would be a history nothing could find. Main keys the file by the
  // WORKING TREE and binds it to that tree's generation; this side names a book
  // and nothing else.
  //
  // AND THE SELECTION IS NOT IN IT. It is not a fact about the book, it dies
  // with the frame anyway, and BookForge — which does put it in the stack —
  // special-cases it in three separate places for the privilege.

  private readonly ledgers = new Map<string, LedgerStacks>();
  private actionSeq = 0;

  /**
   * How many actions one document's ledger holds.
   *
   * A COUNT IS SAFE HERE and would not have been for a snapshot stack. The plan
   * warns against action-count caps because BookForge's entries embed whole
   * blocks and one of them reached 15.57 MB, so 200 actions is either a few
   * megabytes or several gigabytes depending on the book. A row here is a
   * member path, an id, a field name and two short values — the one unbounded
   * field is a word edit's markup, which is one block of prose. Five hundred of
   * them is a few megabytes at the outside, and it is more curation than
   * anybody does to one chapter in a sitting.
   */
  private static readonly LEDGER_ACTIONS = 500;

  /**
   * File one action away, however many rows it moved.
   *
   * `label` is a sentence fragment in the past tense — "struck 14 blocks" — so
   * that undoing it reads as "Undid: struck 14 blocks." It is written by the
   * caller AFTER main has answered, because the number in it has to be what
   * moved rather than what was asked for.
   */
  private record(tabId: string, label: string, rows: readonly LedgerRow[]): void {
    // An action that moved nothing is not an action. Relabelling thirty blocks
    // that were already that category writes no bytes, and a Ctrl+Z that
    // appears to do nothing is worse than no entry at all.
    if (rows.length === 0) return;
    this.actionSeq += 1;
    const ledger = this.ledgers.get(tabId) ?? { done: [], undone: [] };
    ledger.done.push({ seq: this.actionSeq, label, rows });
    /*
     * A NEW ACTION ENDS THE FUTURE. Undo three cuts, then cut something else,
     * and the three are gone — the standard rule, and the only one that does
     * not require deciding what a branching history looks like on screen.
     */
    ledger.undone = [];
    // Oldest first. The user is at the new end, so what is dropped is the work
    // furthest from what they are doing.
    while (ledger.done.length > TabsService.LEDGER_ACTIONS) ledger.done.shift();
    this.ledgers.set(tabId, ledger);
    this.flush(tabId);
  }

  /**
   * Take the newest action back off the ledger without replaying anything.
   *
   * FOR ONE CALLER ONLY: the footnote dialog's "put the number back", which
   * writes the block's previous markup itself and so has already reversed the
   * action it is cancelling. See `restoreBlockHtml`. It is deliberately not a
   * general facility — anything else that wanted to erase history would be
   * hiding a write from the person who made it.
   *
   * IT NAMES THE ACTION IT EXPECTS TO FIND, and drops nothing otherwise. An
   * edit that arrived without the frame's `was` records NO rows and so no
   * action at all, and a blind pop would then throw away whatever the user did
   * before it — a cut of some other paragraph, silently ungettable back.
   */
  private dropLastAction(tabId: string, blockId: string): void {
    const done = this.ledgers.get(tabId)?.done;
    const last = done?.[done.length - 1];
    if (!done || !last) return;
    if (last.rows.length !== 1) return;
    const row = last.rows[0]!;
    if (row.field !== 'html' || row.target !== blockId) return;
    done.pop();
    // The file has to lose it too. The dialog has already written the block's
    // old markup back, so a history still carrying that action would offer a
    // Ctrl+Z that puts an edit the user cancelled back into the book — and
    // after a crash it would be the ONLY record of it, with nothing on screen
    // to explain where it came from.
    this.flush(tabId);
  }

  /**
   * Write both stacks out, after every mutation of either.
   *
   * NOT AWAITED BY ITS CALLERS, deliberately. The write is a few kilobytes of
   * JSON and the gesture that triggered it has already landed in the book — the
   * member write is the commit — so blocking the next keystroke on a rename in
   * the project folder would be paying latency for a file nothing on screen is
   * reading. What it must not do is fail quietly: a history that has stopped
   * being written is a Ctrl+Z that will silently have nothing to reach after the
   * next crash, so a refusal goes to the strip BY NAME (ARCHITECTURE §8).
   *
   * A tab whose book is still opening has nothing to flush and no book id to
   * flush it against; it cannot have recorded an action either, since every
   * gesture that records one needs a book.
   */
  private flush(tabId: string): void {
    const ledger = this.ledgers.get(tabId);
    const store = this.ledgerStore(this.byId(tabId));
    if (store === null || ledger === undefined) return;
    void store.save({ done: ledger.done, undone: ledger.undone })
      .catch((err: unknown) => {
        this.notice.set(
          `This document's undo history could not be written to disk, so it will not survive a `
          + `crash or a restart: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
  }

  /**
   * Read back the ledger this document was left with, as it opens.
   *
   * THE GENERATION CHECK IS MAIN'S, and it is the reason a restored stack is
   * safe to press Ctrl+Z on. A row names `data-bf-id="p47-3"` in a member, and
   * that name means one thing in ONE working copy: "start over" rebuilds
   * `working/` from `generated/`, a re-cast reassigns ids, and a row from a
   * previous life would then put a paragraph into a block that is not the one it
   * came from. So the file carries the generation of the working copy it was
   * recorded against, main compares it with `project.json`'s, and a history that
   * does not match is archived aside rather than handed back here. Same for one
   * that will not parse. Either way this side receives EMPTY STACKS AND A
   * SENTENCE, and the sentence names the file.
   *
   * RESTORED INTO A LEDGER THAT MAY ALREADY EXIST? It cannot: this runs once,
   * from the open, before the tab can have been edited. It is still written as a
   * set rather than a merge, because a merge would be inventing an order between
   * two sessions' actions that no LIFO stack can honour.
   */
  /**
   * WHICH LEDGER IS THIS DOCUMENT'S, and the two answers this app has.
   *
   * A BOOK'S is keyed by its working tree and bound to the generation of that
   * tree, because its rows name `data-bf-id="p47-3"` in an unpacked EPUB. A
   * SCAN'S is keyed by its readings bank and bound to the generation of that
   * READING, because its rows name `7:14` in the model's answer. Neither key is a
   * runtime id, and neither side of that is the renderer's to know — main
   * resolves both, exactly as it always has, and this only decides which door to
   * knock on.
   *
   * Null for a document that has no editable surface open: a book still
   * unpacking, a scan not in block view, an HTML editor tab (whose typing is the
   * textarea's own undo and never the book's).
   */
  private ledgerStore(tab: Tab | null): {
    load(): Promise<LedgerLoad>;
    save(stacks: LedgerStacks): Promise<void>;
  } | null {
    const bridge = api;
    if (bridge === null || bridge === undefined || tab === null) return null;
    if (tab.kind === 'epub' && tab.book !== null) {
      const bookId = tab.book.id;
      return {
        load: () => bridge.history.load(bookId),
        save: (stacks) => bridge.history.save(bookId, stacks),
      };
    }
    if (tab.kind === 'pdf' && tab.blockView) {
      const filePath = tab.path;
      return {
        load: () => bridge.overlay.loadLedger(filePath),
        save: (stacks) => bridge.overlay.saveLedger(filePath, stacks),
      };
    }
    return null;
  }

  private async restoreLedger(tabId: string): Promise<void> {
    const store = this.ledgerStore(this.byId(tabId));
    if (store === null) return;
    let loaded: LedgerLoad;
    try {
      loaded = await store.load();
    } catch (err) {
      // Not a `problem` on the tab: the book is open and every edit still
      // works. What is gone is the undo history, and that is a sentence.
      this.notice.set(
        `This document's undo history could not be read, so it starts empty: `
        + `${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    // Closed while the read was in flight — a book opened and dismissed inside
    // one IPC round trip. `close()` has already dropped this tab's entry, and
    // putting one back would leave a ledger nothing will ever flush or free.
    if (this.byId(tabId) === null) return;
    const { done, undone } = loaded.actions;
    if (done.length > 0 || undone.length > 0) {
      this.ledgers.set(tabId, { done, undone });
      /*
       * THE ACTION NUMBERS CONTINUE from the highest one restored. They are one
       * counter across every open document, and starting again from where this
       * process happens to be would file this session's first action under a
       * number the book's own history already used — two different actions
       * called 12, in one stack, in one file.
       */
      for (const action of [...done, ...undone] as LedgerAction[]) {
        this.actionSeq = Math.max(this.actionSeq, action.seq);
      }
    }
    if (loaded.notice !== null) this.notice.set(loaded.notice);
  }

  /** Ctrl/Cmd+Z, from the Edit menu. The focused document's, never a global one. */
  async undo(): Promise<void> {
    await this.replay('undo');
  }

  /** Ctrl/Cmd+Shift+Z. */
  async redo(): Promise<void> {
    await this.replay('redo');
  }

  /**
   * Put one action back, row by row, through the setters that made it.
   *
   * A CARET IN THE PAGE MEANS THE TYPING FIRST. While a block is being edited in
   * place, Ctrl+Z is about the sentence being typed and not about the book — so
   * it is handed back to the frame, which is the only thing that can reach a
   * contenteditable's own history. Main swallowed the keypress on its way past
   * (it is a menu accelerator), which is why the frame has to be told rather
   * than left to see it.
   *
   * ROWS ARE REPLAYED IN REVERSE ORDER, which matters for the one action that
   * writes two files: a rename put the contents entry first and the page
   * heading second, so undoing takes the heading back before the entry, and
   * `renamePageHeading`'s check that the heading still reads what the dialog
   * saw is made against a book nothing else has moved in between.
   *
   * EVERY REFUSAL IS A SENTENCE, including "there is nothing to undo": the menu
   * item cannot grey itself out against renderer state, so a chord that quietly
   * did nothing would be indistinguishable from a chord that is broken.
   */
  private async replay(direction: 'undo' | 'redo'): Promise<void> {
    const tab = this.activeDocument();
    if (!api || !tab) {
      this.notice.set('There is no document in front of you to undo anything in.');
      return;
    }
    if (this.editing.has(tab.id)) {
      this.commandFrame(tab.id, { type: 'foundry:undo-typing', redo: direction === 'redo' });
      return;
    }
    /*
     * A SCAN GOES THROUGH THIS FUNCTION AND NOT AROUND IT. Its rows name a block
     * in a readings bank instead of an element in a chapter and its setter is a
     * line of the overlay instead of a call into somebody's markup, but an action
     * is still an action, one gesture over forty blocks is still forty rows that
     * go back together, and the notice still says what was undone by name. A
     * second replay loop for the second kind of document is how the two would
     * start behaving differently.
     */
    if (tab.kind === 'pdf') {
      if (!tab.blockView) {
        this.notice.set(
          `There is nothing to undo in ${tab.title}. Press Blocks to correct what the model read `
          + 'off its pages.',
        );
        return;
      }
      /*
       * THE THIRD DOOR, and the one it would be easiest to forget. An undo is a
       * write like any other — it puts the rows of an action back into the live
       * curation and saves the whole file — so taking a correction BACK while
       * standing on a frozen save changes the live state under a book the pages
       * are showing from the snapshot, exactly as making one would. The stacks are
       * left where they are, so the chord works again the moment the user steps
       * off the save onto a row that edits.
       */
      const held = this.heldByASave(tab.id);
      if (held !== null) {
        this.notice.set(held);
        return;
      }
    } else if (tab.book === null) {
      this.notice.set(`${tab.title} is still opening.`);
      return;
    }
    const ledger = this.ledgers.get(tab.id);
    const from = direction === 'undo' ? ledger?.done : ledger?.undone;
    const action = from === undefined ? undefined : from[from.length - 1];
    if (ledger === undefined || from === undefined || action === undefined) {
      this.notice.set(direction === 'undo'
        ? `There is nothing to undo in ${tab.title}. A document's history is kept in its project `
          + 'and survives closing the book, so this one has had nothing done to it yet.'
        : `There is nothing to redo in ${tab.title}.`);
      return;
    }

    /*
     * A SCAN'S ROWS ALL LAND IN ONE FILE, so its whole replay is one call and
     * one atomic write, and there is nothing to repaint by hand: the overlay is
     * a signal and the outlines are drawn from it.
     *
     * A REFUSAL LEAVES THE ACTION WHERE IT IS, exactly as it does below. The
     * difference is that nothing partial can have happened — the rows were
     * applied to a copy and the write is one rename — so there is no frame to
     * reload and nothing on screen that the file does not back.
     */
    if (tab.kind === 'pdf') {
      const stopped = await this.replayOverlay(tab.id, action, direction);
      if (stopped !== null) {
        this.notice.set(`${direction === 'undo' ? 'Undo' : 'Redo'} stopped at ${stopped}`);
        return;
      }
      from.pop();
      (direction === 'undo' ? ledger.undone : ledger.done).push(action);
      this.flush(tab.id);
      /*
       * NO `modified` FLAG. That flag means "the copy you filed is older than
       * this one", and nothing here touched the PDF: a curation is a file beside
       * the readings bank, and the scan on screen is the same bytes it always
       * was. Setting it would put a dot on a tab whose Save has nothing to write.
       */
      this.notice.set(`${direction === 'undo' ? 'Undid' : 'Redid'}: ${action.label}.`);
      return;
    }

    // Guarded above — a book still opening was turned away with a sentence — and
    // repeated here because the two branches merge what TypeScript knew.
    if (tab.book === null) return;
    const bookId = tab.book.id;
    /*
     * REPAINTED WITHOUT A RELOAD WHERE THE ROW IS AN ATTRIBUTE, and with one
     * where it is words. Because the replay goes through the same setters, a
     * cut or a relabel put back is one attribute on one start tag — exactly
     * what the original gesture wrote — so the frame can flip it in place the
     * way it does for a Delete, and the reader keeps their place in the
     * chapter. A word edit and a renamed heading change text the frame is
     * showing, and there is no attribute that would put a sentence back, so
     * those bump `Tab.revision` and the chapter repaints from the file. That is
     * the same rule the rest of select mode follows, applied per row rather
     * than as a blanket reload — a needless bump costs the reader their place
     * in the chapter, which is the cost `cutBlocks` exists to avoid paying on
     * every keystroke.
     */
    const cutIds = new Map<boolean, string[]>();
    const labelled = new Map<string, string[]>();
    // A contents entry put back is a row in the sidebar, which is drawn from
    // `book.chapters` and not from the file — so undoing the write without this
    // would leave the panel showing a label the navigation document no longer
    // carries. It is the same line the rename itself runs.
    const renamed = new Map<string, string>();
    let reload = false;

    for (let at = action.rows.length - 1; at >= 0; at -= 1) {
      const row = action.rows[at]!;
      const value = direction === 'undo' ? row.before : row.after;
      try {
        await this.replayRow(bookId, row, value, direction);
      } catch (err) {
        /*
         * THE ACTION STAYS WHERE IT IS. The write is what the undo IS, so a
         * refused write means the undo did not happen — and an action quietly
         * popped off the ledger would be a Ctrl+Z that reported nothing and
         * threw away the only record of how to reverse the edit. Pressing it
         * again after fixing whatever main named will try the same rows.
         *
         * AND THE FRAME IS RELOADED, which is the replay rule's second half:
         * some rows of this action may have landed and the page is now showing
         * a state the book does not back. Repainting from the file is the only
         * honest fix.
         */
        this.notice.set(
          `${direction === 'undo' ? 'Undo' : 'Redo'} stopped at ${row.target}: `
          + `${err instanceof Error ? err.message : String(err)}`,
        );
        const stalled = this.byId(tab.id);
        if (stalled) this.patch(tab.id, { modified: true, revision: stalled.revision + 1 });
        return;
      }
      this.memberChanged(tab.id, row.member);
      if (row.field === 'cut' || row.field === 'note-cut') bucket(cutIds, value === '1').push(row.target);
      else if (row.field === 'category') bucket(labelled, value).push(row.target);
      else if (row.field === 'nav-label') renamed.set(row.target, value);
      // `html` and `page-heading` are the two that change WORDS the frame is
      // showing. There is no attribute to flip that would put a sentence back,
      // so these — and only these — reload the chapter.
      else reload = true;
    }

    for (const [cut, ids] of cutIds) {
      this.commandFrame(tab.id, { type: 'foundry:mark-blocks', ids, cut });
    }
    for (const [category, ids] of labelled) {
      this.commandFrame(tab.id, { type: 'foundry:mark-labels', ids, cat: category });
    }

    from.pop();
    (direction === 'undo' ? ledger.undone : ledger.done).push(action);
    // The action has moved from one stack to the other, which is a mutation of
    // both — and the reason it is flushed HERE rather than at the top is that a
    // replay which refused halfway returned above without moving anything, so
    // the file still describes the book as it stands.
    this.flush(tab.id);

    const current = this.byId(tab.id);
    const revision = current?.revision ?? tab.revision;
    this.patch(tab.id, {
      modified: true,
      revision: reload ? revision + 1 : revision,
      ...(renamed.size > 0 && current?.book
        ? {
          book: {
            ...current.book,
            chapters: current.book.chapters.map((chapter) => {
              const label = renamed.get(chapter.href);
              return label === undefined ? chapter : { ...chapter, label };
            }),
          },
        }
        : {}),
    });
    // BY NAME, always. "Undid" on its own leaves a person checking three panes
    // to find out what moved; the label was written when the action was
    // recorded precisely so this sentence could exist.
    this.notice.set(`${direction === 'undo' ? 'Undid' : 'Redid'}: ${action.label}.`);
  }

  /**
   * One row, through the setter its field names.
   *
   * THE VALIDATORS ARE THE POINT. Each of these is the call the original
   * gesture made, with the other value — so an undo is refused by exactly the
   * checks an edit is refused by, and a ledger row cannot put a book into a
   * shape a person could not have typed.
   */
  private async replayRow(
    bookId: string,
    row: LedgerRow,
    value: string,
    direction: 'undo' | 'redo',
  ): Promise<void> {
    const bridge = api;
    if (!bridge) return;
    if (row.field === 'cut') {
      await this.queueMemberWrite(bookId, row.member, () =>
        bridge.epub.setCuts(bookId, row.member, [row.target], value === '1'));
      return;
    }
    if (row.field === 'note-cut') {
      await this.queueMemberWrite(bookId, row.member, () =>
        bridge.epub.setNoteCut(bookId, row.member, row.target, value === '1'));
      return;
    }
    if (row.field === 'category') {
      await this.queueMemberWrite(bookId, row.member, () =>
        bridge.epub.setCategories(bookId, row.member, [row.target], value));
      return;
    }
    if (row.field === 'html') {
      /*
       * UNDOING WORDS GOES THROUGH `restoreBlockHtml`, NEVER `setBlockHtml`,
       * and getting this backwards is the one way this design could lose a
       * footnote. An edit is allowed to DELETE a reference number — a `<sup>`
       * and its anchor may disappear — and `setBlockHtml` forbids markup being
       * GAINED, so undoing that edit through it would be refused every single
       * time. `restoreBlockHtml` exists for exactly this shape (it was built
       * for the footnote dialog's "put the number back") and makes the mirror
       * check instead: what is on disk NOW must be a legal word-edit OF the
       * text being restored, so it still refuses to overwrite a change made
       * underneath it.
       *
       * REDO GOES THE OTHER WAY, through `setBlockHtml`, because redoing is
       * replaying the original edit and the original edit was legal by
       * definition — while the mirror check would refuse it, a reference number
       * being removed not being a legal word-edit in reverse. The notes it
       * answers with are DROPPED here: the question "should the footnote go
       * too?" was asked and answered when the edit was first made, and asking
       * it again on a Ctrl+Shift+Z would be re-litigating a decision the user
       * has already recorded as its own ledger action.
       */
      if (direction === 'undo') {
        await this.queueMemberWrite(bookId, row.member, () =>
          bridge.epub.restoreBlockHtml(bookId, row.member, row.target, value));
      } else {
        await this.queueMemberWrite(bookId, row.member, () =>
          bridge.epub.setBlockHtml(bookId, row.member, row.target, value));
      }
      return;
    }
    if (row.field === 'nav-label') {
      // The echo it answers with is dropped: "should the page's heading change
      // too?" is a question about a rename somebody is making, not about one
      // being taken back.
      await this.queueMemberWrite(bookId, row.member, () =>
        bridge.epub.renameHeading(bookId, row.target, value));
      return;
    }
    if (row.field === 'page-heading') {
      // `was` is the OTHER side of the row, which is what the page reads right
      // now — main checks it against the file and refuses if the heading moved
      // underneath, exactly as it does for the dialog.
      const was = direction === 'undo' ? row.after : row.before;
      await this.queueMemberWrite(bookId, row.member, () =>
        bridge.epub.renamePageHeading(bookId, row.target, value, was));
      return;
    }
    /*
     * A BLOCK-EDITOR FIELD IN A BOOK'S LEDGER — which cannot happen, and is
     * refused rather than falling through.
     *
     * The two ledgers are separate files with separate validators and neither
     * accepts the other's field names, so the only way here is a bug in this app.
     * The old shape of this function ended with `page-heading` as the fallthrough
     * `else`, which meant a field it had never heard of would have been replayed
     * as a heading rename against a target that is not an href. Naming the last
     * branch and refusing the rest costs one line and removes a whole class of
     * silent wrong write.
     */
    throw new Error(
      `"${row.field}" is not something a book's undo history can replay — it names a correction to `
      + 'a scan\'s blocks, which lives in that document\'s own overlay.',
    );
  }

  /**
   * Which tabs have a caret sitting in a block right now.
   *
   * Reported by the frame, because nothing out here can see into it: the parent
   * holds an <iframe> element whose document is behind an opaque origin, and
   * `document.activeElement` in the shell says only "the iframe". It exists for
   * exactly one decision — what Ctrl+Z means — and a plain Set is enough,
   * because nothing on screen is drawn from it.
   */
  private readonly editing = new Set<string>();

  reportEditing(tabId: string, on: boolean): void {
    if (on) this.editing.add(tabId);
    else this.editing.delete(tabId);
  }

  // ── The inspector, and the frame it cannot reach ─────────────────────────

  /**
   * What the frame in one pane says is selected, and what it says the chapter
   * holds — kept PER TAB.
   *
   * A single pair of signals would have five panes writing over each other: two
   * books can be in select mode at once, and the second one's frame announcing
   * "nothing is selected" as it loads would blank the inspector for the first.
   * The map is small (one entry per book in select mode) and it is dropped with
   * the tab, because both facts die with the frame that reported them.
   */
  private readonly selections = signal<ReadonlyMap<string, FrameSelection>>(new Map());
  private readonly counts = signal<ReadonlyMap<string, CategoryCounts>>(new Map());

  selectionFor(tabId: string | null): FrameSelection | null {
    return tabId === null ? null : this.selections().get(tabId) ?? null;
  }

  countsFor(tabId: string | null): CategoryCounts | null {
    return tabId === null ? null : this.counts().get(tabId) ?? null;
  }

  /** An empty list is "nothing is selected", and drops the entry rather than storing one. */
  reportSelection(tabId: string, blockIds: readonly string[], category: string | null): void {
    this.selections.update((map) => {
      const next = new Map(map);
      if (blockIds.length === 0) next.delete(tabId);
      else next.set(tabId, { blockIds, category });
      return next;
    });
  }

  reportCategoryCounts(tabId: string, counts: CategoryCounts): void {
    this.counts.update((map) => new Map(map).set(tabId, counts));
  }

  private forgetFrameState(tabId: string): void {
    this.selections.update((map) => {
      const next = new Map(map);
      next.delete(tabId);
      return next;
    });
    this.counts.update((map) => {
      const next = new Map(map);
      next.delete(tabId);
      return next;
    });
  }

  /**
   * PARENT → FRAME, for the panel that cannot see it.
   *
   * The inspector lives in the shell, one component tree away from the five
   * viewers, and the frame is behind a sandboxed origin that only its own
   * <iframe> element can post into. So a command is a SIGNAL naming the tab it
   * is for, and whichever viewer is rendering that tab picks it up and posts it
   * — the same shape `sourceJump` uses for a click going the other way, down to
   * the sequence number, which is what makes the same command twice in a row do
   * anything at all.
   */
  readonly frameCommand = signal<FrameCommand | null>(null);
  private commandSeq = 0;

  private commandFrame(tabId: string, message: Record<string, unknown>): void {
    this.commandSeq += 1;
    this.frameCommand.set({ tabId, seq: this.commandSeq, message });
  }

  /**
   * The inspector's two gestures, refused BY NAME when the mode is off.
   *
   * The rows are a legend as well as a control — with nothing selected they say
   * how many blocks of each kind this chapter holds — so they are clickable in
   * states where they cannot act, and a click that quietly did nothing would be
   * indistinguishable from a broken panel.
   */
  relabelSelected(category: string): void {
    const tab = this.activeDocument();
    if (!tab || tab.kind !== 'epub' || tab.book === null) return;
    if (!tab.selectMode) {
      this.notice.set('Relabelling a block needs select mode on — press Select, then click the block.');
      return;
    }
    if (this.selectionFor(tab.id) === null) {
      this.notice.set('Click a block in the page first, or drag a rectangle over several; the '
        + 'category is applied to everything that is selected.');
      return;
    }
    this.commandFrame(tab.id, { type: 'foundry:relabel', cat: category });
  }

  strikeCategory(category: string): void {
    const tab = this.activeDocument();
    if (!tab || tab.kind !== 'epub' || tab.book === null) return;
    if (!tab.selectMode) {
      this.notice.set('Striking a whole category needs select mode on — press Select first.');
      return;
    }
    this.commandFrame(tab.id, { type: 'foundry:cut-category', cat: category });
  }

  /**
   * A chapter that changed on disk without the HTML editor doing it.
   *
   * THE HAZARD THIS EXISTS FOR IS SILENT AND COSTS WORK. The editor holds a
   * WHOLE chapter in its textarea, loaded when that chapter opened. Cut three
   * blocks in select mode with the editor open on the same chapter, then type
   * one character in the editor: its next flush writes the entire textarea
   * back, which is the text from before the cuts. The marks are gone, nothing
   * says so, and the only evidence is that `epub-final` later finds nothing to
   * remove.
   *
   * A REVISION BUMP CANNOT SAY THIS. That signal reloads the rendered iframe,
   * which is exactly what a cut must not do — the frame already painted the
   * mark. So this is its own counter: the editor watches it, the viewer does
   * not, and a cut stays as cheap as it was.
   *
   * Carries the member, because an editor showing a DIFFERENT chapter of the
   * same book has nothing to reload and must not be disturbed.
   */
  readonly memberWritten = signal<{ tabId: string; member: string; seq: number } | null>(null);
  private memberSeq = 0;

  private memberChanged(tabId: string, member: string): void {
    this.memberSeq += 1;
    this.memberWritten.set({ tabId, member, seq: this.memberSeq });
  }

  /** One chapter's XHTML source, for the editor pane. */
  async chapterSource(tab: Tab, href: string): Promise<string> {
    if (!api || tab.book === null) return '';
    // A section-header row's href carries a #fragment; the FILE is the member.
    return api.epub.readMember(tab.book.id, memberOf(href));
  }

  /**
   * Write an edited chapter back.
   *
   * Main writes the member AND repacks the workspace copy in the same call
   * (electron/epub-reader.ts), so by the time this resolves the edit is in a
   * real EPUB on disk. That is what lets `modified` mean "the copy you filed is
   * older" rather than "your work is in a temp directory".
   *
   * `revision` is bumped last, because it is what reloads the rendered pane and
   * reloading it before the bytes landed would show the previous version. The
   * pane doing the reloading may now be a different one from the pane the
   * keystroke happened in, which costs this code nothing: the revision is on the
   * tab, and every viewer of that tab is watching it.
   *
   * THROUGH THE SAME PER-MEMBER QUEUE select mode's writes use. The editor and
   * the mode can be open on one chapter at once, and a flush of the whole
   * chapter overlapping a cut of one block in it is two read-modify-writes of
   * one file where the loser's change simply vanishes.
   */
  async writeChapter(id: string, href: string, text: string): Promise<void> {
    const bridge = api;
    const tab = this.all().find((candidate) => candidate.id === id);
    if (!bridge || !tab || tab.book === null) return;
    const bookId = tab.book.id;
    const member = memberOf(href);
    this.writingTo.set(id);
    try {
      await this.queueMemberWrite(
        bookId,
        member,
        () => bridge.epub.writeMember(bookId, member, text),
      );
      /*
       * NOT IN THE LEDGER, and that is a decision rather than an omission. The
       * ledger's five actions each name an ELEMENT and a FIELD, and replaying
       * one goes back through the validator that accepted it. A whole chapter
       * flushed out of a textarea names nothing and has no validator — it is
       * the one write in this app that is allowed to be anything at all — so
       * the only way to record it would be the chapter's whole text, which is
       * the snapshot design this one deliberately is not. The editor is a text
       * editor: its Ctrl+Z is the textarea's own, which is what the Edit menu
       * hands it (see `app.ts`), and that is the undo that belongs to typing.
       */
      // Re-read rather than +1 on the tab captured before the queue: a refused
      // cut repaints by bumping the revision too, so the number this write
      // lands on may not be the one it started from.
      this.patch(id, { modified: true, revision: (this.byId(id)?.revision ?? tab.revision) + 1 });
    } catch (err) {
      this.notice.set(err instanceof Error ? err.message : String(err));
    } finally {
      if (this.writingTo() === id) this.writingTo.set(null);
    }
  }

  /**
   * Rename a TOC entry — a chapter, or a section header inside one.
   *
   * MAIN RENAMES THE CONTENTS AND STOPS. The nav is the table of contents'
   * truth and renaming the row is exactly what was asked, so that half always
   * happens; the page's heading is a SECOND statement and is only offered. It
   * used to follow automatically and silently whenever its text matched, which
   * quietly made one of the two a copy of the other — and they are allowed to
   * differ, because the text should say what the book says and the contents
   * should say what the book's apparatus says.
   *
   * The question is asked only when the heading still reads what this entry
   * used to read. Where the two already differ that is a decision somebody has
   * made about this book, and re-asking it on every rename would train a person
   * to dismiss the dialog unread.
   *
   * The tab's TITLE does not change either — that is the book's dc:title, not a
   * chapter's name, and it is the Metadata dialog's business. Returns whether
   * the rename happened, so the sidebar can keep its input open on a refusal.
   */
  async renameHeading(id: string, href: string, newLabel: string): Promise<boolean> {
    const tab = this.all().find((candidate) => candidate.id === id);
    if (!api || !tab || tab.book === null) return false;
    const label = newLabel.trim();
    if (label.length === 0) return false;

    /*
     * THE ONE ACTION THAT WRITES TWO FILES, and the reason a ledger action is a
     * LIST of rows rather than a single one. The contents entry lives in the
     * navigation document and the heading lives in the chapter; a rename that
     * changed both has to be taken back as one gesture, or an undo would put
     * the page's heading back and leave the table of contents saying something
     * else — which is worse than either state on its own.
     *
     * `navMember` is on the book because the renderer can name every other
     * member it edits from a chapter href it is already holding, and this is
     * the exception. A book with no navigation document has none, and the
     * rename's nav half writes nothing anyway.
     */
    const bookId = tab.book.id;
    const rows: LedgerRow[] = [];
    const navMember = tab.book.navMember;
    // What the row is being renamed FROM. Read off the sidebar rather than out
    // of the file, because it is what this app has been showing the user and so
    // what an undo owes them.
    const wasLabel = tab.book.chapters.find((chapter) => chapter.href === href)?.label ?? '';

    let echo: HeadingEcho | null;
    let navChanged: boolean;
    try {
      ({ echo, navChanged } = await api.epub.renameHeading(bookId, href, label));
    } catch (err) {
      this.notice.set(err instanceof Error ? err.message : String(err));
      return false;
    }
    if (navChanged && navMember !== null && wasLabel.length > 0) {
      rows.push({ member: navMember, target: href, field: 'nav-label', before: wasLabel, after: label });
    }

    let pageChanged = false;
    if (echo !== null) {
      const answer = await api.confirmHeadingEcho(echo);
      if (answer === 'update') {
        try {
          await api.epub.renamePageHeading(bookId, href, label, echo.was);
          pageChanged = true;
          rows.push({
            member: echo.member,
            target: href,
            field: 'page-heading',
            before: echo.was,
            after: label,
          });
        } catch (err) {
          // The contents HAS been renamed and the page has not. Said rather
          // than swallowed, because the user answered "yes" and something
          // else happened — main refuses this write when the heading moved
          // underneath the question, which is a fact about their book.
          this.notice.set(err instanceof Error ? err.message : String(err));
        }
      }
    }

    // BOTH HALVES, ONE ACTION. Whichever of the two files actually moved has a
    // row; undoing replays each rename in reverse, so a change that touched the
    // contents and the page is taken back as the one thing it was.
    this.record(id, `renamed a contents entry to "${label}"`, rows);

    const current = this.byId(id);
    if (!current || current.book === null) return true;
    const chapters = current.book.chapters.map((chapter) =>
      (chapter.href === href ? { ...chapter, label } : chapter));
    /*
     * THE REVISION IS BUMPED ONLY WHEN THE PAGE CHANGED. A bump reloads the
     * rendered pane, which is showing the chapter and not the contents — so a
     * rename that touched only the nav would cost the reader their scroll
     * position to repaint a sidebar row this line has already repainted.
     */
    this.patch(id, {
      book: { ...current.book, chapters },
      // A book with no nav at all, whose one offer was declined, has had NOTHING
      // written to it — and a tab marked edited by a question somebody answered
      // "no" to is a Save prompt with nothing behind it.
      modified: current.modified || navChanged || pageChanged,
      revision: pageChanged ? current.revision + 1 : current.revision,
    });
    return true;
  }

  /**
   * Something outside this service edited the document on disk.
   *
   * Today that is the Metadata dialog, which writes the package (or the working
   * PDF) through the engine rather than through any of the member writes above.
   * The flag it sets is the one that matters: the working copy has moved ahead
   * of whatever was last filed, so Save has work to do.
   *
   * NO REVISION BUMP, deliberately. Nothing in any chapter's markup moved, and
   * reloading the rendered pane would cost the reader their place in order to
   * repaint a page that looks identical.
   */
  noteDocumentEdited(id: string): void {
    this.patch(id, { modified: true });
  }

  // ── Saving ───────────────────────────────────────────────────────────────

  /**
   * Ctrl/Cmd+S. Writes to the file the user already chose, or asks once.
   *
   * The fallback to Save As is the behaviour of every editor, and it is what
   * makes the editor's Save button worth having: after the first time it stops
   * asking a question the user has already answered.
   *
   * A PDF always goes through the picker instead. Nothing in this app edits a
   * PDF, so a silent re-save to the same destination would copy identical bytes
   * over identical bytes — the one thing Ctrl+S could do for it is ask where.
   */
  async save(id: string): Promise<void> {
    const tab = this.byId(id);
    if (!tab) return;
    // A save typed into the editor is a save of the book it edits.
    if (tab.kind === 'editor') {
      await this.flushPending(tab.id);
      if (tab.sourceTabId !== null) await this.save(tab.sourceTabId);
      return;
    }
    if (tab.kind === 'pdf' || tab.savedPath === null) {
      await this.saveAs(tab.id);
      return;
    }
    await this.flushPending(this.editorFor(tab.id)?.id ?? null);
    // Re-read: the flush wrote through the workspace copy this repack reads.
    await this.writeBook(this.byId(tab.id) ?? tab, tab.savedPath);
  }

  /**
   * Ctrl/Cmd+Shift+S. Always the picker.
   *
   * A PDF saves as a COPY of the finished file: a conversion's output lives in
   * the workspace until this puts it somewhere the user chose, and that is the
   * whole difference between "foundry made me a PDF I can read" and "there is a
   * PDF I can read in a folder I know about". An EPUB repacks from its working
   * copy instead (electron/epub-reader.ts), because its edits live there.
   */
  async saveAs(id: string): Promise<void> {
    const tab = this.byId(id);
    if (!api || !tab) return;
    if (tab.kind === 'editor') {
      await this.flushPending(tab.id);
      if (tab.sourceTabId !== null) await this.saveAs(tab.sourceTabId);
      return;
    }
    if (tab.kind === 'pdf') {
      try {
        const destination = await api.documentSaveCopy(
          tab.path, suggestName(baseName(tab.path), '.pdf'));
        if (destination === null) return;
        this.patch(tab.id, { unsaved: false, savedPath: destination });
      } catch (err) {
        this.notice.set(err instanceof Error ? err.message : String(err));
      }
      return;
    }
    if (tab.book === null) {
      this.notice.set('This book is still opening — try again in a moment.');
      return;
    }
    await this.flushPending(this.editorFor(tab.id)?.id ?? null);
    const chosen = await api.epub.chooseSavePath(
      tab.book.id, suggestName(baseName(tab.path), '.epub'));
    if (chosen === null) return;
    await this.writeBook(this.byId(tab.id) ?? tab, chosen);
  }

  /** The menu's Save / Save As. The focused pane's document, editor or book. */
  async saveActive(): Promise<void> {
    const tab = this.active();
    if (tab) await this.save(tab.id);
  }

  async saveActiveAs(): Promise<void> {
    const tab = this.active();
    if (tab) await this.saveAs(tab.id);
  }

  /**
   * Repack the working copy to `destination` and settle both flags.
   *
   * A failure leaves BOTH flags where they were: a save that did not happen must
   * not clear a dot, or the tab would claim a file exists that does not.
   */
  private async writeBook(tab: Tab, destination: string): Promise<void> {
    if (!api || tab.book === null) return;
    try {
      await api.epub.save(tab.book.id, destination);
      this.patch(tab.id, { unsaved: false, modified: false, savedPath: destination });
    } catch (err) {
      this.notice.set(err instanceof Error ? err.message : String(err));
    }
  }

  private patch(id: string, changes: Partial<Tab>): void {
    this.all.update((tabs) =>
      tabs.map((tab) => (tab.id === id ? { ...tab, ...changes } : tab)));
  }
}

/**
 * One scan's block editor: what the model read, and what a person has said
 * about it.
 *
 * HELD PER TAB and dropped when the mode closes. Five panes can each be showing
 * a different scan, and a single set of signals would have the second one's
 * pages blanking the first's — the same reason `selections` and `counts` are
 * maps rather than pairs of signals.
 */
export interface BlockView {
  /** Every page's blocks, in the frame their boxes are measured in. */
  pages: readonly PdfBlockPage[];
  /**
   * The same blocks as the things a PERSON points at, by page number.
   *
   * ONE OUTLINE PER ANSWER ELEMENT, not per part. The model answered once for a
   * region of the page and the engine cut that answer into parts where the
   * markdown said to; the parts are text, they share the element's box, and
   * drawing them would put three identical rectangles on top of each other for a
   * person to try to click between. So the editing surface addresses `page:order`
   * — which is exactly what the overlay contract calls the useful default, "every
   * part of that element" — and the split stays where it belongs, inside the
   * renderer that made it.
   */
  elements: ReadonlyMap<number, readonly BlockElement[]>;
  /** The same elements by target key, for a ledger row or a chapter row. */
  byKey: ReadonlyMap<string, BlockElement>;
  /** Where the ENGINE would divide the book. What the chapter list seeds from. */
  detected: readonly PdfDetectedChapter[];
  /**
   * THE LIVE CURATION — the write target, and null while it is being read (or
   * could not be).
   *
   * It is the live file whatever the position is, exactly as `locateOverlay.file`
   * is on the disk side: this is where a correction goes, and resolving it to a
   * snapshot while somebody stands on one would mean the next strike rewrote a
   * save. What is DRAWN is `shown` below.
   */
  overlay: OverlayFile | null;
  /**
   * The frozen save the position renders with, when it is standing on one — the
   * thing the outlines, the tallies and the chapter list are made of.
   *
   * NULL IS THE ORDINARY ANSWER and means the live overlay is what is being
   * rendered, which is every project nobody has pressed Save in and every position
   * that is not standing where a save is in effect.
   *
   * ITS TYPE IS NOT WRITABLE. `FrozenCuration` is not assignable to `OverlayFile`,
   * so `amendOverlay`, `setChapters` and `overlay.save` all refuse it at compile
   * time — the display copy cannot become a write however it is passed around.
   */
  frozen: FrozenCuration | null;
  /**
   * Every amendment by target — derived once per change, read once per outline,
   * and derived from WHAT IS BEING SHOWN rather than from what would be written.
   */
  decisions: ReadonlyMap<string, OverlayDecision>;
  /** Why there is nothing to correct, when that happens. Never swallowed. */
  problem: string | null;
  /** True from the moment the mode opens until the engine has answered. */
  loading: boolean;
}

/** One thing on a page a person can point at: the model's answer element. */
export interface BlockElement {
  /** `page:order` — the overlay target, the ledger's target, the DOM key. */
  key: string;
  page: number;
  order: number;
  /** The pieces the engine cut this answer into, in order. Usually one. */
  parts: readonly PdfBlock[];
  /** What the model called it. The parts of one element agree in practice. */
  category: string;
  /** The union of the parts' boxes, in the page's render frame. */
  box: { x1: number; y1: number; x2: number; y2: number };
  /** What the model read, the parts run together — for the inspector to show. */
  text: string;
}

/**
 * The blocks of one page, gathered into the elements a person points at.
 *
 * The union rather than the first part's box, because a renderer that splits an
 * answer is free to give the pieces boxes of their own one day — and an outline
 * that covered the first third of a paragraph would be an outline you cannot
 * click on the words it is about.
 */
function elementsOfPage(page: PdfBlockPage): BlockElement[] {
  const byOrder = new Map<number, PdfBlock[]>();
  for (const block of page.blocks) {
    const found = byOrder.get(block.order);
    if (found === undefined) byOrder.set(block.order, [block]);
    else found.push(block);
  }
  const elements: BlockElement[] = [];
  for (const [order, blocks] of byOrder) {
    const parts = [...blocks].sort((a, b) => a.part - b.part);
    const first = parts[0]!;
    const box = { ...first.box };
    for (const part of parts) {
      box.x1 = Math.min(box.x1, part.box.x1);
      box.y1 = Math.min(box.y1, part.box.y1);
      box.x2 = Math.max(box.x2, part.box.x2);
      box.y2 = Math.max(box.y2, part.box.y2);
    }
    elements.push({
      key: `${page.page}:${order}`,
      page: page.page,
      order,
      parts,
      category: first.category,
      box,
      text: parts.map((part) => part.text).join('\n').trim(),
    });
  }
  return elements.sort((a, b) => a.order - b.order);
}

/**
 * THE CURATION THE PAGES ARE DRAWN FROM: the frozen save when the position stands
 * on one, and the live overlay otherwise.
 *
 * ── The wrong picture this replaces ─────────────────────────────────────────
 *
 * Standing on a save used to draw the LIVE outlines, read-only, with a banner
 * admitting it. That is honest and it is the wrong book: everything Foundry
 * renders from that position is made with the snapshot, and the entire reason to
 * click an old save is to see what it looks like. So a person comparing two saves
 * saw one set of corrections twice, and the only way to find out what a save
 * actually contained was to export from it.
 *
 * `frozen` WINS WHEREVER IT EXISTS, and every derivation that describes what is on
 * the page — the outlines, the category tallies, the chapter rows — goes through
 * here rather than reaching for `overlay`. That is what stops half the panel
 * showing one curation and half showing the other, which is a harder thing to
 * notice than showing the wrong one outright.
 */
function shownCuration(view: Pick<BlockView, 'overlay' | 'frozen'>): CurationContent | null {
  return view.frozen ?? view.overlay;
}

/** The same answer as a decision map, for a view being built or amended. */
function decisionsShown(view: Pick<BlockView, 'overlay' | 'frozen'>): Map<string, OverlayDecision> {
  const shown = shownCuration(view);
  return shown === null ? new Map() : decisionsOf(shown);
}

/**
 * What the overlay says about a whole element.
 *
 * The element-wide amendment, then any part-specific ones folded over it in part
 * order — which is what the engine will do with the same file. THIS APP ONLY EVER
 * WRITES ELEMENT-WIDE amendments, so the fold is a copy in every file it made;
 * it is here so that a file somebody edited by hand is DRAWN as it will RENDER,
 * rather than drawn as though the parts said nothing.
 */
function elementDecision(
  decisions: ReadonlyMap<string, OverlayDecision>,
  element: BlockElement,
): OverlayDecision {
  let decision = decisions.get(element.key) ?? {};
  for (const part of element.parts) {
    const piece = decisions.get(`${element.page}:${element.order}:${part.part}`);
    if (piece !== undefined) decision = { ...decision, ...piece };
  }
  return decision;
}

/**
 * The ledger's name for each overlay field.
 *
 * Two vocabularies because two files: `strike`/`category`/`text` are what the
 * OVERLAY calls them, and the ledger has to spell two of those differently
 * because `category` is already a book's `data-bf-cat` route and `text` would be
 * indistinguishable from one. One table, in one direction, so the mapping cannot
 * be written twice and drift.
 */
const LEDGER_FIELD_OF: Readonly<Record<OverlayField, LedgerField>> = {
  strike: 'strike',
  category: 'block-category',
  text: 'block-text',
};

const OVERLAY_FIELD_OF: Readonly<Record<string, OverlayField>> = {
  strike: 'strike',
  'block-category': 'category',
  'block-text': 'text',
};

/** What a decision says about one field, as a ledger row spells it. */
function fieldValue(decision: OverlayDecision | undefined, field: OverlayField): string {
  if (decision === undefined) return '';
  if (field === 'strike') return decision.strike === true ? 'true' : '';
  if (field === 'category') return decision.category ?? '';
  return decision.text ?? '';
}

/**
 * One ledger row applied to an overlay — the setter its field names, with the
 * other value.
 *
 * A PURE FUNCTION, deliberately: a replay of forty rows is forty of these over
 * one object and then a single write, so nothing here may touch the disk or the
 * signals. It is also what makes the whole action atomic — a row that refuses
 * throws before anything has been written anywhere.
 */
function replayOverlayRow(file: OverlayFile, row: LedgerRow, value: string): OverlayFile {
  if (row.field === 'chapters') {
    return setChapters(file, chaptersOfText(value, 'this undo entry'));
  }
  const field = OVERLAY_FIELD_OF[row.field];
  if (field === undefined) {
    throw new Error(
      `"${row.field}" is not something a scan's corrections can replay — it names an edit to a `
      + 'book\'s markup, which lives in that book\'s own history.',
    );
  }
  return amendOverlay(file, parseTargetKey(row.target), field, value);
}

/**
 * The engine's detected chapters as an overlay's own list.
 *
 * The seed, and it has to be EXACT: saving it back unchanged must render the
 * identical book, or the first thing somebody does after opening the chapter
 * accordion is silently change their own spine. So the part is carried when the
 * engine gave one and nothing is normalised, rounded or re-derived on the way
 * through.
 */
function seedChapters(detected: readonly PdfDetectedChapter[]): OverlayChapter[] {
  return detected.map((one) => ({
    at: { page: one.page, order: one.order, ...(one.part === undefined ? {} : { part: one.part }) },
    title: one.title,
  }));
}

/**
 * Every pane an equal share.
 *
 * Applied when a pane is ADDED and not when one is removed: a new column has no
 * share of its own to keep, and taking the row back to equal is the only
 * arrangement that does not favour whichever neighbour happened to be widest.
 * Removing a pane leaves the others alone — flex already reflows them in
 * proportion, which is the arrangement the user made.
 */
function equalise(panes: readonly Pane[]): Pane[] {
  return panes.map((pane) => ({ ...pane, flex: 1 }));
}

/**
 * Which column a document that wanted one of its OWN has to settle for, once
 * there are five and there are no more to make.
 *
 * The rightmost, normally — a conversion's output has no opinion about where it
 * lands, and the far end displaces the least of what the user was looking at.
 *
 * BUT NOT WHEN IT ASKED TO BE BESIDE SOMETHING. An HTML editor is a face of one
 * particular book, and at the cap "the rightmost column" can BE that book's
 * column: pressing Edit HTML would then replace the page with its own source,
 * which is the one arrangement the feature exists to avoid. So it takes the
 * column just right of the book instead, or just left when the book is already
 * the last one. Something is displaced either way — that is what a full window
 * means — but never the document the gesture was about.
 */
function crowdedTarget(panes: readonly Pane[], beside: string | null): Pane {
  const last = panes[panes.length - 1]!;
  if (beside === null) return last;
  const at = panes.findIndex((pane) => pane.id === beside);
  if (at < 0) return last;
  return panes[at + 1] ?? panes[at - 1] ?? last;
}

/** Windows paths differ by case and separator and are the same file. */
function normalise(filePath: string): string {
  return filePath.replace(/\\/g, '/').toLowerCase();
}

/** A sidebar href without its #fragment — the member file it lives in. */
function memberOf(href: string): string {
  return href.split('#')[0] ?? href;
}

function baseName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

/**
 * What the save dialog opens pre-filled with.
 *
 * THE FILE'S OWN NAME, AND THIS IS ONE OF THE TWO PLACES A FILENAME BELONGS.
 * Everywhere else in this window a document is called by its book — the pane's
 * toolbar, the list on the left, the window's title bar — because a person
 * reading their library is thinking about books. A person in a save dialog is
 * thinking about a FILE: it is going into a folder of theirs, beside things they
 * named, and it has to be findable there by whatever their other copy of it is
 * called. It used to be fed the tab's title, which was the same string as the
 * basename for a PDF and quietly stopped being one the moment titles became the
 * book's.
 *
 * The characters removed are the ones Windows refuses outright; a name with a
 * colon in it is common (`Working Towards The Fuhrer: …`) and a save dialog that
 * opened pre-filled with an illegal name would fail on OK with a message from
 * the OS rather than from us.
 */
function suggestName(fileName: string, extension: '.epub' | '.pdf'): string {
  const cleaned = fileName.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
  const stem = cleaned.length > 0 ? cleaned : 'book';
  return stem.toLowerCase().endsWith(extension) ? stem : `${stem}${extension}`;
}
