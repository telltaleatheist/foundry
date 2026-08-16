import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';

import type { FoundryApi } from '@shared/api';
import { PDF_BLOCK_CATEGORIES, categoryLabel, pdfCategoryLabel } from '@shared/categories';
import type { CurationLock } from '@shared/curation-lock';
import { positionPicture, positionView, type PositionView } from '@shared/ledger';
import { fold } from '@shared/original';
import {
  amendOverlay,
  chaptersText,
  chaptersOfText,
  decisionFor,
  decisionsOf,
  parseSourceKeys,
  parseTargetKey,
  setChapters,
  targetKey,
  type CurationContent,
  type FrozenCuration,
  type OverlayChapter,
  type OverlayDecision,
  type OverlayField,
  type OverlayFile,
  type OverlayTarget,
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
  TranslationWorld,
  UncommittedCuration,
  UnlinkedNote,
} from '@shared/types';
import { unrenderBlock } from '@shared/unrender';

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
 * The workspace is one to five PANES side by side, and A PANE HOLDS A STACK OF
 * DOCUMENTS AND SHOWS ONE OF THEM. They exist for one comparison in particular:
 * a book beside its translation, the German page and the English page under two
 * hands at once. Everything else about panes follows from that, including the
 * auto-open rule (a translation lands in a pane of its OWN, so it appears beside
 * its source rather than on top of it).
 *
 * ── The strips came back, and this comment is the reversal ───────────────────
 *
 * EACH PANE USED TO CARRY A CHROME-STYLE STRIP of its own — VS Code's editor
 * groups, a stack of tabs per column — and this paragraph used to record why
 * they were taken away: five columns on a 1920-wide window give each strip 370
 * pixels, three tabs in one of them are unreadable stubs, and a VERTICAL LIST in
 * a panel of its own (app-open-documents) does not degrade with the number of
 * columns. Every word of that is still true and it was still the wrong trade,
 * because it measured the strip as a NAVIGATOR and the strip's job was never
 * only navigation.
 *
 * The user specced them back, in these words: *"clicking another file will
 * automatically close the one i was looking at and open the one i just clicked,
 * unless i pin the file by right-clicking the chrome-style tab at the top"*, and
 * *"if they grab the tab and drag it to one of the sides, it enters split screen
 * with the tab that was currently active when they dragged it"*. PIN, DRAG-SPLIT
 * AND CLOSE are what a strip is for this time — three gestures that need
 * something to point at, and a vertical list of every document in the window
 * cannot be that something, because none of the three is about the window. They
 * are about THIS COLUMN: what it is holding, what it may throw away when the next
 * click lands, and what it should tear off into a column of its own.
 *
 * The narrow-strip complaint is answered by the auto-close rule rather than by
 * removing the strip: a column accumulates tabs only where somebody PINNED one,
 * so the ordinary five-column window has one tab per strip and reads exactly as
 * it did without them. The documents list stays — it is the project and export
 * navigator, which is a different job, and it is still the only place a
 * document's order in the WINDOW lives.
 *
 * THE TABS STAY IN ONE FLAT LIST and the panes hold ids into it. A pane owning
 * whole Tab objects would put `patch()` — the one function every edit, save and
 * flag in this file goes through — behind a search of a list of lists, and the
 * first thing to rot would be an edit landing in one pane's copy of a tab while
 * another pane showed the other. One list, one identity per tab; the panes
 * decide only where each is shown and which of theirs is on top.
 *
 * A DOCUMENT IS IN AT MOST ONE PANE, and the strips did not weaken that. It is
 * in at most one STRIP: clicking a row for something already on screen REVEALS
 * it rather than putting a second viewer over one unpack — the rule `adopt()`
 * has always enforced for files — and dragging a tab between strips MOVES it.
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

/**
 * `book` IS THE FOURTH KIND, AND IT IS THE ONLY ONE THAT IS NOT A FILE.
 *
 * The other three are a document on disk and a face of one. A `book` tab is the
 * project's BOOK — the reflowed blocks the renderer draws on the proof sheet
 * (docs/RENDERER.md §5) — which does not live in any one file the user opens: it
 * is made from the bank at the position, main decides which bank that is, and the
 * renderer never learns where it is kept. So the tab carries the PROJECT
 * DIRECTORY in `path` and asks main for the rows by naming it.
 *
 * That is why `projectDirOf` has a case for this kind and nothing else does: for
 * every other tab the project is the folder the file is IN, and for this one the
 * path IS the project.
 */
export type TabKind = 'pdf' | 'epub' | 'editor' | 'book';

export interface Tab {
  id: string;
  kind: TabKind;
  /**
   * The file this tab is showing. For a conversion that has not been saved
   * anywhere, that is the copy in the managed workspace — and it stays that even
   * after Save As, because the saved file is a byte-for-byte copy and re-opening
   * it would throw away an unpack for nothing.
   *
   * FOR A `book` TAB THIS IS THE PROJECT DIRECTORY and not a file at all — see
   * `TabKind`. Everything that treats a path as bytes to open is gated on the
   * kind, and the two prefix tests that group a project's tabs together accept
   * the directory itself for exactly this one.
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
   * fallen behind. A tab can be either, both, or neither.
   *
   * IT IS DRAWN AND NOT ASKED ABOUT. The closing question used to fire on this
   * flag, which is true from birth for every book opened out of a project, so it
   * interrupted people who had lost nothing; the user ruled it out ("only pop up
   * a confirmation alert if changes have been made") and `questionBefore` says
   * the rest. A dot in the corner of a tab is the right weight for "this lives in
   * the library and nowhere else" — a modal is not.
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
   * PINNED — right-clicked in its strip and told to stay.
   *
   * ── What it protects against, which is a rule and not an accident ───────────
   *
   * Clicking a document in the left nav REPLACES what the focused column was
   * showing (see `place`), because the user asked for exactly that: *"clicking
   * another file will automatically close the one i was looking at and open the
   * one i just clicked, unless i pin the file by right-clicking the chrome-style
   * tab at the top."* So the ordinary column holds one tab and browsing a
   * project's documents does not accumulate a strip of them — and a pin is how
   * somebody says "not this one" about the page they are working against.
   *
   * A PINNED TAB ALSO HIDES ITS ✕, which is the same statement said twice on
   * purpose: the gesture that closes and the gesture that closes-by-replacement
   * are one decision, and a pin that stopped only the quiet one would be a pin
   * that fails in the way nobody tests.
   *
   * ON THE TAB, like `blockView` and `selectMode`, and NOT PERSISTED for their
   * reason exactly: five panes can each hold a different document, a global flag
   * would pin all of them, and a pin restored from last week would be the app
   * refusing to reuse a column for a reason nobody in the room remembers.
   */
  pinned: boolean;
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
 * A column of the workspace: a strip of documents, one of them on screen.
 *
 * IT WAS ONE `tabId` AND IT IS A LIST NOW, which is the strips coming back (see
 * this file's header). The two fields are separate rather than "the first of the
 * list is the active one" because the strip's ORDER is the user's — they drag
 * tabs around in it — and which one is on top is a different question they answer
 * by clicking. Folding the two would mean every activation reordered the strip
 * under the hand that clicked it.
 *
 * `activeTabId` of null means this pane is showing HOME — which is what a column
 * with nothing in it has always shown, back when there was only ever one. It is
 * what Ctrl+\ makes (an empty column to drop a document into, with an empty
 * strip), and it is also what the rail's Home button makes of a column that still
 * has a strip: the tabs stay listed, one click from coming back.
 */
export interface Pane {
  id: string;
  /**
   * The strip, left to right. Every id is in the flat tab list, and no id is in
   * two panes' strips — see the header's "a document is in at most one pane".
   */
  tabIds: string[];
  /** Which of them is on screen. Null is Home, including for an empty strip. */
  activeTabId: string | null;
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
 * the two kinds above, which is exactly why they open themselves: somebody
 * asks for an EPUB precisely because they want to read it.
 *
 * `translate` left this set when its product became a records file. Its
 * `.jsonl` is a bank's kind of thing — nobody reads it — and opening it here
 * produced a refusal notice per finished translation. The translated BOOK
 * still arrives in front of the person, by the other door: the position moves
 * onto the translate row, the pane follows through `showPosition`, and the
 * cast that renders it carries `forStep`, which the auto-open effect already
 * skips.
 */
const OPENS_ITSELF: ReadonlySet<JobKind> = new Set<JobKind>(['epub', 'pdf']);

/**
 * No tabs at all — the default for `questionBefore`'s second argument.
 *
 * A shared frozen empty set rather than a `new Set()` per call: an ordinary close
 * asks about one tab and has nothing to carry, and allocating a set to say so on
 * every ✕ is a small thing done often.
 */
const EMPTY_IDS: ReadonlySet<string> = new Set<string>();

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

/**
 * The list under one key, made on first use. Grouping rows for one repaint call.
 *
 * Generic in what it holds as well as in the key: a replay groups ids for the
 * frame to repaint AND the decisions those rows owe the curation, and two
 * copies of four lines is how the two would learn to behave differently.
 */
function bucket<K, V>(map: Map<K, V[]>, key: K): V[] {
  const found = map.get(key);
  if (found) return found;
  const made: V[] = [];
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
  /**
   * The same directory AS MAIN SPELLS IT, kept beside the folded key.
   *
   * The key is folded because on Windows one path arrives spelled three ways and
   * two spellings of one project would be two entries. What must NOT be folded is
   * what goes back over IPC: main proves the directory is one of Home's projects
   * before it reads a byte, and a lowercased path is a project on this filesystem
   * and a stranger to a string comparison. (`LedgerService.Holding` keeps both for
   * the identical reason.)
   */
  dir: string;
  /** What the panes were showing, or null for a project this window has just met. */
  was: ShownPicture | null;
  now: ShownPicture;
}

/**
 * One entry of the chapters spine as the FLOWING BOOK has to know it.
 *
 * TWO NAMES FOR ONE PLACE, and both are needed for the reason `sourceIndexOf`
 * spells out: `target` is the banked answer the file is keyed to and survives
 * the book being cast again; `blockId` is the element in front of the reader,
 * which is the only name a sandboxed frame can speak. A marker whose block this
 * cast of the book does not carry has `member` and `blockId` null — it is still
 * in the file, still listed, and simply has no line to draw.
 */
export interface ChapterMark {
  /** The banked answer, as `page:order[:part]` — the spine's own key. */
  target: string;
  title: string;
  /** The document of the book this block is rendered in, or null. */
  member: string | null;
  /** The `data-bf-id` the line sits above, or null. */
  blockId: string | null;
}

/**
 * The spine as one flowing book is showing it.
 *
 * `confirmed` is the same distinction `chaptersFor` draws over a scan: an
 * overlay with no `chapters` field is the ENGINE's answer, seeded for display,
 * and the first edit takes the whole list over. `editable` is the read-only lock
 * — false while the position stands on a frozen save, so the lines are drawn and
 * nothing on them may be dragged, renamed or removed.
 */
export interface BookSpine {
  chapters: readonly OverlayChapter[];
  marks: readonly ChapterMark[];
  confirmed: boolean;
  editable: boolean;
  /**
   * Whether this app has an account of where this book divides AT ALL — stated
   * by the reader, or detected over a bank it read.
   *
   * ── Why a boolean, when an empty list is right there ────────────────────────
   *
   * Because the two states it tells apart look identical in `chapters` and are
   * not remotely the same fact. A book Foundry read that genuinely has one
   * section has no chapters; a book somebody imported whole — no bank, nothing
   * to key a marker to — has no chapters EITHER, and about that one this app
   * knows nothing rather than knowing there are none.
   *
   * The inspector needs the difference because it decides which list a person
   * is looking at, and *"no fallbacks. i hate fallbacks. fallbacks are bugs.
   * theyre unexpected code paths."* Choosing the book's own table of contents
   * because the marker list came back empty would be exactly that: a second
   * source reached for on emptiness, which would also silently swap the list
   * under a Foundry book that divides nowhere. This is the question asked
   * directly, so the answer is a choice and not a rescue.
   */
  banked: boolean;
  /**
   * The recorded manual JOINS, resolved to the elements that continue — one
   * entry per `join: true` decision whose continuation block this cast renders.
   *
   * It rides the spine rather than a read of its own because it is the same
   * read: the same overlay (live, or the frozen one a save shows), the same
   * provenance index, refreshed by the same two signals. The frame paints each
   * as a seam already decided — the visible merge happens at the next cast, and
   * an affordance that kept offering "join" over a decision already made would
   * read as a gesture that did nothing.
   */
  joins: readonly { member: string; blockId: string }[];
}

/**
 * The `bookSpineKeys` entry for a book no project claims.
 *
 * It opens with the same separator every real key is built out of, so it cannot
 * be spelled by a uuid and two counters however they fall — and it is written as
 * an ESCAPE and never as the byte itself, which is this codebase's rule for the
 * whole control range: a file carrying a raw NUL reads fine through every tool
 * that handles it right up until the one that does not.
 */
const UNBANKED = '\u0000unbanked';

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
  readonly activeId = computed<string | null>(() => this.focusedPane()?.activeTabId ?? null);
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

  /**
   * Paths that will arrive meaning to TAKE THE PLACE of what the focused column
   * is showing — the documents list's click, and nothing else.
   *
   * The user's rule (`Tab.pinned`) is about the nav: browsing a project's
   * documents reuses one column rather than stacking five tabs nobody asked for.
   * Everything else that opens — a drop, a finished job, a step's document —
   * JOINS the strip, because none of those is somebody saying "instead of this".
   */
  private readonly expectReplace = new Set<string>();

  /**
   * Paths that will arrive wanting a NAMED column, keyed the same way.
   *
   * It is how a project's own book gets to the column that project is already
   * being read in, rather than to whichever one happens to be focused. See
   * `place`'s `intoPane`.
   */
  private readonly expectPane = new Map<string, string>();

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
     *
     * A SAVE'S OWN BOOK IS THE EXCEPTION, and it is the one job here nobody
     * ordered. Applying changes casts the book as of that save (`forStep`, the
     * per-save cast), which is a rendering the app made for itself so that
     * standing on an older save shows the book that save made — and it lands in
     * the middle of somebody correcting the next paragraph. Every other job in
     * this list is a thing a person pressed a button for and is waiting on; this
     * one would be a tab arriving in front of work in progress, for a document
     * they can already reach by clicking the row it belongs to.
     */
    let first = true;
    effect(() => {
      const jobs = this.queue.jobs();
      for (const job of jobs) {
        if (!OPENS_ITSELF.has(job.kind) || job.forStep !== undefined || job.state !== 'done') continue;
        if (this.openedJobs.has(job.id)) continue;
        this.openedJobs.add(job.id);
        if (first) continue;
        this.openFinished(job.outputPath, job.kind);
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
        const want = this.titleFor(tab);
        if (want !== tab.title) this.patch(tab.id, { title: want });
      }
    });

    /**
     * WHETHER THERE IS ANYTHING TO APPLY, re-asked whenever the answer could
     * have moved — see `unkept`.
     *
     * THREE THINGS MOVE IT and all three are read here on purpose. The DOCUMENT
     * in front changes which project is being asked about. A CURATION WRITE by
     * this window — a strike on the scan, a strike on the cast book, an undo of
     * either — changes what is unkept. And the POSITION changes what it is
     * measured against: the restore point is the save the pointer stands at or
     * behind, so clicking back through the history changes the answer without a
     * byte being written.
     *
     * The ask itself is untracked, because it writes `unkept` and a signal
     * written inside its own effect is a loop waiting for a slow disk.
     */
    effect(() => {
      const tab = this.activeDocument();
      const seq = this.curationSeq();
      const dir = tab === null ? null : this.projectDirOf(tab);
      const standing = this.ledger.standingIn(dir)?.id ?? '';
      /*
       * ASKED ONCE PER ANSWER, not once per repaint. `activeDocument` is a whole
       * Tab and `patch` replaces one on every edit — a held Delete key is several
       * a second — so without this the effect would put a file read behind every
       * keystroke to be told the same thing it was told a moment ago. The three
       * things that can move the answer are exactly the three in this key.
       */
      const asking = `${tab?.path ?? ''}|${seq}|${standing}`;
      if (asking === this.lastAsked) return;
      this.lastAsked = asking;
      untracked(() => void this.askUnkept(tab));
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
        moves.push({ key, dir, was, now });
      }
      /*
       * WHICH COLUMNS ARE OPEN IS NO LONGER READ HERE, and its absence is the
       * ruling rather than an oversight. This used to be tracked so that a move
       * with nowhere to be shown could put a sentence on the strip and then re-ask
       * once a column appeared. There is no such state any more: clicking a row is
       * an instruction to LOOK at that step, so a document that is open but in no
       * column is put in one and a document that is not open is opened. The app
       * does the thing instead of explaining why it cannot.
       */
      untracked(() => {
        for (const key of [...this.showing.keys()]) {
          if (!open.has(key)) {
            this.showing.delete(key);
            // The resolved document goes with the picture it belonged to, for the
            // same reason: a reopen baselines afresh rather than measuring against
            // what a session nobody is in was showing.
            this.forgetShown(key);
          }
        }
        for (const move of moves) {
          this.showing.set(move.key, move.now);
          if (move.was === null) {
            /*
             * THE FIRST SIGHTING STILL MOVES NOTHING, AND IT NO LONGER LEAVES THE
             * DOCUMENT UNKNOWN.
             *
             * It used to `continue` outright, which was right while the resolved
             * document was bookkeeping for `followDocuments` alone. It is not any
             * more: the rail and the dialogs ask what document the position is
             * showing before they decide what a button does (docs/WORKBENCH.md
             * §6c), and a project met a moment ago answered "I do not know" —
             * which is how Translate came to sit dead over a book that was
             * plainly on screen. Nothing here is put on screen by asking; it
             * records what the position resolves to, exactly as the sweep does on
             * every announce, so that the first question a button asks has an
             * answer.
             */
            void this.baselineShown(move.dir, move.key);
            continue;
          }
          void this.showPosition(move);
        }
      });
    });

    /**
     * THE POSITION DID NOT MOVE AND THE DOCUMENT UNDER IT DID.
     *
     * ── Why the picture above cannot see this by itself ────────────────────────
     *
     * `positionPicture` (shared/ledger.ts) is composed of the reading, the
     * corrections and — for a row that shows its own payload — the row: the three
     * things the LEDGER knows that decide what is on screen. Which file a read row
     * actually resolves to is not one of them, and cannot be: it is main's
     * bookkeeping, answered over IPC (`ledger:document-at`), and the effect above
     * is synchronous. So a project standing still while its document changes
     * underneath is invisible to that key by construction.
     *
     * And it changes, on the one path this app cares most about. Standing on a
     * read row in a project whose book has not been cast resolves to the working
     * PDF, and main answers that fallback by making the book (`towardTheFlowingBook`,
     * electron/main.ts) — so seconds later the same position resolves to an EPUB.
     * Nothing in the ledger moved. Without this effect the pane would sit on the
     * scan until something else happened to move the pointer, which is the exact
     * complaint the position effect was built for in the first place: *"i wanted
     * the document to show."*
     *
     * ── An effect of its own, on the delete effect's precedent ─────────────────
     *
     * The same shape as "a step was deleted, so the panes read their state again"
     * above: a fact the position cannot express, on a trigger of its own, acting
     * only where something actually CHANGED. `projects.items()` is that trigger —
     * main announces the projects whenever a catalogue does anything, which
     * includes the landing that files a cast — and the acting is `showPosition`,
     * the one door that puts a position's document on screen.
     *
     * IT ASKS MAIN AND NEVER GUESSES. Reading the catalogue here to work out
     * whether a cast has appeared would be a second opinion about a resolution
     * that is deliberately main's alone (`showPosition` says why at length), and
     * it would be wrong in exactly the place it is dearest — a branch read, a
     * rotated cast. One IPC per open project per announce, and announces are
     * landings and imports rather than keystrokes.
     *
     * THE FIRST ANSWER FOR A PROJECT IS A BASELINE AND MOVES NOTHING, which is
     * the position effect's own first-sighting rule said about the document
     * instead of the picture: a window that has just met a project has no
     * difference to act on.
     *
     * A BASELINE IS NOT A NO-OP ANY MORE, THOUGH — see the position effect above,
     * which now asks for the document at a position it is meeting for the first
     * time instead of leaving it unknown until something announces.
     */
    effect(() => {
      this.projects.items();
      untracked(() => void this.followDocuments());
    });
  }

  /**
   * What main last said was at each project's position — this window's memory of
   * the DOCUMENT, beside `showing`'s memory of the picture.
   *
   * Not a field on `ShownPicture`, and that is on purpose: the view and the string
   * it compares by are made together and never apart (see `pictureIn`), and this
   * one arrives hundreds of milliseconds later over IPC. A picture carrying a
   * field that is empty at the moment it is compared would be an invitation to
   * compare it.
   *
   * ── A SIGNAL NOW, BECAUSE THE DIALOGS READ IT ────────────────────────────────
   *
   * It was a plain `Map`: bookkeeping for `followDocuments`, written and read in
   * one file, and nothing on screen depended on it. There is one selection now
   * (docs/WORKBENCH.md §6c) — "every action keys off the position, never the open
   * tab" — so Translate, Export and Metadata all ask what document the position is
   * showing, and a `Map` cannot tell a template that the answer moved. A dialog
   * standing open while a job casts the book, or while the user clicks a row in
   * the library behind it, would go on describing the document from before.
   *
   * The map inside is replaced rather than mutated on every write, which is what
   * makes the signal's equality check mean anything at all.
   */
  private readonly documentShown = signal<ReadonlyMap<string, string | null>>(new Map());

  /**
   * The document this project's panes are pointed at, for a surface that acts on
   * the position rather than on whatever tab happens to be focused.
   *
   * NULL IS THREE STATES AND THEY ARE DELIBERATELY ONE HERE: nothing has read this
   * project's history yet, the position names no document of its own, or there is
   * no project. Every caller wants the same thing from all three — fall back to
   * what it can see for itself — and a surface that told them apart would be a
   * surface with three empty states for one absence.
   */
  documentShownFor(projectDir: string | null): string | null {
    if (projectDir === null) return null;
    return this.documentShown().get(fold(projectDir)) ?? null;
  }

  /** Main's latest answer about this project's position, kept where it is read. */
  private rememberShown(key: string, target: string | null): void {
    this.documentShown.update((map) => new Map(map).set(key, target));
  }

  /** This project has no tabs left; its answer goes with them. */
  private forgetShown(key: string): void {
    this.documentShown.update((map) => {
      if (!map.has(key)) return map;
      const next = new Map(map);
      next.delete(key);
      return next;
    });
  }

  /**
   * THE FOCUS MIRROR: a document the user has just focused moves the position onto
   * the step that document IS.
   *
   * ── The confusion it exists to end ──────────────────────────────────────────
   *
   * The app had two selectors pretending to be one. The library selected a file,
   * the ledger selected a step, and the actions keyed off a mix — so the user's
   * own report: *"i could have a document open, the epub, but have the pdf import
   * step selected, and id never know that i just ran translate against the
   * original pdf rather than the generated epub because i had the wrong step
   * selected, since the right document was open."* Clicking a library row already
   * moved the position and put its document on screen; this is the other
   * direction, and with both of them there is one selection
   * (docs/WORKBENCH.md §6c).
   *
   * ── THE GUARD, WHICH IS THE WHOLE OF THE CARE HERE ──────────────────────────
   *
   * A document that is ALREADY the one the position is showing moves nothing. A
   * book resolves to the NEWEST step of its chain — the only step you can act from
   * — so without this, somebody standing on an older save and clicking into the
   * pane to read it would be silently walked forward to the newest one, and the
   * next thing they exported would be a book they had deliberately stepped back
   * from. Standing still is not a gesture.
   *
   * ── Only user gestures reach this ───────────────────────────────────────────
   *
   * The strip's own click, a pointerdown in a pane, Ctrl+Tab and Ctrl+1…5, and
   * nothing else. It is emphatically NOT inside `activateInPane` or `reveal`,
   * because `showPosition` reaches both of those on its way to satisfying a click
   * on a library row: a mirror there would answer main's own answer with a
   * question about it, and a position that had just been moved to an older step
   * would move itself back the instant the pane obeyed.
   *
   * A LOOSE FILE HAS NO LEDGER AND NO POSITION, so it is a no-op — its actions go
   * on taking the file, which is the ruling for loose rows everywhere.
   *
   * FIRE AND FORGET, AND A FAILURE IS NEVER IN THE WAY. Focus has already happened
   * by the time this is called; a refusal from main (a catalogue that will not
   * parse) belongs on the notice strip, not in front of a person who was trying to
   * look at a document.
   */
  async standForTab(tabId: string): Promise<void> {
    if (!api) return;
    const tab = this.byId(tabId);
    if (tab === null) return;
    // An editor is a face of its book, exactly as `activeDocument` reads it: one
    // document, two faces, and the position is about the document.
    const subject = tab.kind === 'editor' ? this.byId(tab.sourceTabId) : tab;
    if (subject === null) return;
    /*
     * THE BOOK MOVES NOTHING, because it cannot disagree with the pointer. This
     * mirror exists so that a pane and a position can never describe two different
     * things — it answers "which step is this FILE" — and the book tab is not a
     * file: it is put on screen BY a read row and shows whatever reading that row
     * is about (`showBook`). Asking main which step it belongs to would be asking
     * about a directory, and the honest answer for a directory is nothing. A book
     * open under a project standing on a curate or translate row is showing that
     * chain's own reading, which is the same book — so there is nothing to correct
     * there either.
     */
    if (subject.kind === 'book') return;
    const dir = this.projectDirOf(subject);
    if (dir === null) return;
    const key = fold(dir);
    const known = this.documentShown().get(key);
    /*
     * THE FIRST FOCUS IN A PROJECT ASKS, RATHER THAN ASSUMING THE GUARD CANNOT
     * ANSWER — and this is the case the guard would otherwise miss entirely.
     *
     * Nothing writes `documentShown` for a project until the position MOVES
     * (`showPosition`) or main announces (`followDocuments`), so a project opened
     * from Home and clicked into straight away has no memory of what it is
     * showing. Treating that silence as "not the same document" is exactly the
     * yank this guard exists to prevent: somebody who left the pointer on an
     * older save, reopened the book and clicked into the page would be walked
     * forward to the newest step by the act of looking at it.
     *
     * One extra round trip, once per project per session, for the same question
     * `followDocuments` asks on every announce — and the answer is kept, because
     * it is the same fact those two record.
     */
    const shown = known !== undefined ? known : await this.rememberedShown(dir, key);
    if (shown !== null && fold(shown) === fold(subject.path)) return;
    try {
      /*
       * `adopt` AND NOT A SECOND READ. Main hands back the ledger AND the rows it
       * composed for it — the same whole answer `go` returns, for the same reason
       * — and `LedgerService.adopt` is the door already built for a history that
       * arrived from somewhere other than that class. A `refresh` here would be a
       * second round trip describing a moment later than the one that was acted
       * on, which is the failure `go`'s own comment is about.
       */
      this.ledger.adopt(dir, await api.ledger.standFor(dir, subject.path));
    } catch (err) {
      this.notice.set(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * What main says is at this project's position, asked once and kept.
   *
   * The answer is null for every refusal (`LedgerService.documentAt` says why),
   * and null here means "no document of its own" — which the guard reads as "not
   * the one in front of me", so the mirror goes ahead and lets main decide. That
   * is the right way round: main is the side that knows, and a renderer guessing
   * at a catalogue it could not read is how somebody ends up standing somewhere
   * they did not ask to be.
   */
  private async rememberedShown(projectDir: string, key: string): Promise<string | null> {
    const at = await this.ledger.documentAt(projectDir);
    this.rememberShown(key, at);
    return at;
  }

  /**
   * A project this window has just met, asked once what its position is showing.
   *
   * IT NEVER OVERWRITES AN ANSWER THAT IS ALREADY IN HAND. A first sighting and a
   * gesture can both fire in the same frame — the pointerdown that opened the
   * project's tab is one of them — and this is the older question of the two, so
   * landing last must not replace a newer answer with a staler one.
   */
  private async baselineShown(projectDir: string, key: string): Promise<void> {
    if (this.documentShown().has(key)) return;
    const at = await this.ledger.documentAt(projectDir);
    if (this.documentShown().has(key)) return;
    this.rememberShown(key, at);
  }

  /** True while a sweep is in flight, so two announces do not walk it twice. */
  private following = false;

  /**
   * Re-ask main which document each open project's position resolves to, and put
   * it on screen if the answer moved.
   *
   * ONE SWEEP AT A TIME. Two announces in quick succession — a rendering lands and
   * a catalogue is rewritten — would otherwise interleave two walks over the same
   * projects, each acting on the other's answer.
   *
   * ANY ANSWER IS DROPPED IF THE POSITION MOVED WHILE IT WAS IN FLIGHT, by
   * identity against `showing` exactly as `showPosition` does it: a click that
   * lands mid-sweep is newer than anything this was asking about.
   */
  private async followDocuments(): Promise<void> {
    if (this.following) return;
    this.following = true;
    try {
      const asked = new Set<string>();
      for (const tab of this.all()) {
        const dir = this.projectDirOf(tab);
        if (dir === null) continue;
        const key = fold(dir);
        if (asked.has(key)) continue;
        asked.add(key);
        const now = this.showing.get(key);
        // Nothing has painted this project yet; the position effect baselines it
        // and this has nothing to compare against until it does.
        if (now === undefined) continue;
        const target = await this.ledger.documentAt(dir);
        if (this.showing.get(key) !== now) continue;
        const was = this.documentShown().get(key);
        this.rememberShown(key, target);
        if (was === undefined || was === target) continue;
        await this.showPosition({ key, dir, was: now, now }, target);
      }
    } finally {
      this.following = false;
    }
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
   * Make this project's pane show the position — the DOCUMENT first, and then what
   * is drawn over it.
   *
   * ── What a click used to be worth, and what the user said about it ──────────
   *
   * `b61bfab` made a pointer move drive the block editor's mode and which
   * corrections are drawn, and left the file underneath both of them exactly where
   * it was: `Tab.path` is fixed when a document is opened from the documents panel
   * and nothing else ever moved it. So a project holding the scan and the reprint
   * made from its reading showed one of them however many rows were clicked —
   * *"switching between steps doesnt switch between the original pdf and the
   * rendered facsimile like i expected"* — and when there was nothing this could
   * change it put a sentence on the strip instead, which is the half the user was
   * angrier about: *"i wanted the document to show. instead of showing the
   * document, it gave me an error saying it couldnt show the document… it should be
   * showing me document"*.
   *
   * ── The ruling this is built to ─────────────────────────────────────────────
   *
   * CLICKING A ROW IS AN INSTRUCTION TO LOOK AT THAT STEP, and the app satisfies it
   * rather than explaining why it cannot. In order: swap the pane to the step's
   * document; if that document is open but in no column, put it in one; if it is
   * not open at all, open it. Nothing here reports a state it could have fixed,
   * which is why this function no longer has a sentence to say.
   *
   * ── The three pictures over it, and what each costs ─────────────────────────
   *
   * NO OUTLINES (the import, and any position with no reading above it): the pane
   * comes out of the block editor. Nothing had been read at that point in the
   * book's story, so boxes drawn there would be the pane making a claim about a
   * step the user is standing BEFORE — which is the one thing the revert row exists
   * to let somebody look at without.
   *
   * OUTLINES, PANE NOT IN THE MODE: it goes into the mode and reads the bank. The
   * expensive one, and it is expensive exactly once per genuinely different
   * picture.
   *
   * OUTLINES, PANE ALREADY IN THE MODE: the bank is re-read if the READING moved,
   * or if the pages under it changed — a document swap is a different PDF, and
   * boxes measured against the old one would be drawn over the new one's pages.
   * Otherwise this is a few kilobytes of corrections off a disk, which is what
   * keeps stepping between a reading and its saves as free as a history panel
   * promises. See `refreshCuration`.
   */
  private async showPosition(
    move: PositionMove,
    /**
     * The answer, when the caller already has it — `followDocuments` asks main
     * which document is at the position in order to notice that it MOVED, and
     * asking again here would be a second round trip for the same fact and a
     * second chance to get a different one.
     */
    resolved?: string | null,
  ): Promise<void> {
    const view = move.now.view;
    /*
     * ASKED OF MAIN, EVERY MOVE, AND NEVER COMPOSED HERE. A project's layers are
     * main's bookkeeping — which folder holds the live copy, which of two readings
     * a reprint belongs to — and a renderer that spelled `working/<stem>.pdf` for
     * itself would be a second opinion that goes wrong exactly where it is dearest:
     * a branch read answering with the original reading's file. Main also admits
     * the answer to the viewer's allow-list on the way out, which this side cannot
     * do for itself. Null is the ordinary "this position names no document of its
     * own" and means keep the one we have.
     */
    const target = resolved !== undefined ? resolved : await this.ledger.documentAt(move.dir);
    /*
     * AND THE ANSWER IS DROPPED IF THE USER HAS MOVED AGAIN. Somebody clicking
     * down a history four rows deep issues four of these, and main answers them in
     * whatever order the disk feels like — so without this the pane could settle on
     * the document of a row nobody is standing on any more, and stay there until
     * the next click. `showing` already holds the newest picture (the effect writes
     * it synchronously before starting any of this), so identity against it is the
     * whole test. It is `LedgerService`'s ticket, in the one other place that asks
     * main a question a later question can invalidate.
     */
    if (this.showing.get(move.key) !== move.now) return;
    /*
     * WHAT THE PANES ARE NOW POINTED AT, remembered here because this is the one
     * place that knows it. `followDocuments` compares against it to notice a
     * document that changed under a position that did not move; recording it
     * anywhere else would be recording an intention rather than what happened.
     */
    this.rememberShown(move.key, target);
    /*
     * ── A READ ROW SHOWS THE BOOK, AND THAT IS THE SEAM MOVING AGAIN ──────────
     *
     * `documentAtPosition` answers a read row with the EPUB cast from its reading,
     * and every word of its own comment about why is still true — right up to the
     * ruling this wave is built on: *"we arent supposed to be rendering the book as
     * an epub… the user isnt reading a book on foundry, they're editing the
     * contents of a book"* (docs/RENDERER.md §0). The cast was the flowing document
     * while there was nothing else that flowed. There is now: the book file, drawn
     * as blocks on a proof sheet, which is the surface every op in R3 and after is
     * written against.
     *
     * SO A READ ROW OPENS THE BOOK TAB AND NOT THE CAST, and it is EITHER/OR
     * rather than both — one project, one column, one thing on screen. A row that
     * opened the sheet and then let `showDocument` put the EPUB beside it would be
     * two tabs for one instruction, and the second of them would be the surface
     * this wave exists to replace.
     *
     * CURATE AND TRANSLATE ROWS ARE UNTOUCHED THIS WAVE. Their surfaces still
     * strike, relabel and edit through machinery the book has none of yet (R3
     * builds the ops; R6 deletes what they replace), and moving them now would be
     * taking working gestures away and giving nothing back. The main process still
     * answers `document-at` for a read row exactly as it did — the answer is simply
     * not what the panes are pointed at — which is what keeps the pointer
     * bookkeeping (`rememberShown`, `standForTab`'s guard, the sweep) reading one
     * fact rather than two.
     */
    const swapped = view.step !== null && view.step.action === 'read'
      ? this.showBook(move)
      : await this.showDocument(move, target);
    const readingMoved = (move.was?.view.reading?.id ?? null) !== (view.reading?.id ?? null);
    const curationMoved = (move.was?.view.curation?.id ?? null) !== (view.curation?.id ?? null);
    for (const tab of this.all()) {
      if (tab.kind !== 'pdf') continue;
      const dir = this.projectDirOf(tab);
      if (dir === null || fold(dir) !== move.key) continue;
      // EVERY PDF TAB OF THIS PROJECT, in a column or not. One that is only in the
      // list is a click from being back on screen and must not come back outlined
      // against a step nobody is standing on.
      if (!view.outlines) {
        if (!tab.blockView) continue;
        this.patch(tab.id, { blockView: false });
        this.forgetBlockView(tab.id);
      } else if (!tab.blockView) {
        this.patch(tab.id, { blockView: true });
        void this.loadBlockView(tab.id, tab.path);
      } else if (readingMoved || swapped) {
        void this.loadBlockView(tab.id, tab.path);
      } else if (curationMoved) {
        void this.refreshCuration(tab.id, tab.path);
      }
    }
  }

  /**
   * Put the position's document on screen, and answer whether the pages moved.
   *
   * ── Three ways to satisfy one instruction ───────────────────────────────────
   *
   * ALREADY THE DOCUMENT ON THAT TAB: `reveal`, which is a no-op when it is in a
   * column and PUTS IT IN ONE when it is not. That second case is the exact state
   * the app used to describe back at the user — their book was open, no column was
   * showing it, and they were told to go and click it in the list. Doing it for
   * them is the whole of the fix.
   *
   * A PDF THIS PROJECT ALREADY HAS A TAB FOR: the tab MOVES to the new file. One
   * document per project per pane is what makes "the pane shows the step" true;
   * opening the scan beside the reprint would leave two tabs with the same book's
   * name in the list and neither of them following the pointer. `app-pdf-view`
   * watches `tab.path` and re-opens when the string changes, so the swap is the
   * patch and nothing else — the same mechanism `relocate` uses when an import
   * moves a tab onto the project's copy.
   *
   * ANYTHING ELSE: opened, through the one door every open in this app goes
   * through. That covers a translation's EPUB, which is emphatically NOT swapped
   * into a PDF tab — a book is UNPACKED, and patching a path would leave a viewer
   * serving chapters out of a tree belonging to a different book — and it covers a
   * project whose document nobody has open. `adopt` refuses to make a second tab
   * for a file already open, so this cannot double up.
   *
   * ── Which tab follows the pointer, when the project has several ─────────────
   *
   * The one in the focused column first, then any in a column, then any at all —
   * and ONLY of the kind the target is. A person comparing the scan against the
   * cast EPUB has two tabs of one project on screen, and swapping the EPUB's pane
   * to a PDF because they clicked a read row would take away the book they were
   * reading to answer a question about the pages.
   *
   * ── AND A CHANGE OF KIND IS AN OPEN, NEVER A PATCH ──────────────────────────
   *
   * The position's document can now change KIND under a click: the import row
   * answers the scan and the read and curate rows answer the EPUB cast from the
   * reading (docs/WORKBENCH.md §4, Unit E). Patching a path across that boundary
   * would leave a PDF viewer pointed at a book — or an unpacked book's viewer
   * serving chapters out of a tree belonging to a scan — so the two documents
   * become two TABS IN ONE STRIP, and clicking between the steps activates
   * between them. That is the whole reason the strips are back in a form that can
   * hold more than one thing: nothing threads "this is a PDF" through the
   * renderer, the seam is position → document → show it (DERIVED-BOOK §7), and a
   * strip is what lets one column show whichever of a project's faces the
   * position names without throwing the other away.
   *
   * The same-kind swap SURVIVES for PDF↔PDF, and it is worth keeping for the one
   * thing it does that opening cannot: `app-pdf-view` keeps the page you were on
   * when the path under it moves, and a scan re-opened as a second tab would land
   * you back at page one of a five-hundred-page book.
   */
  private async showDocument(move: PositionMove, target: string | null): Promise<boolean> {
    const mine = this.all().filter((tab) => {
      if (tab.kind === 'editor') return false;
      const dir = this.projectDirOf(tab);
      return dir !== null && fold(dir) === move.key;
    });
    /*
     * THE COLUMN THIS BOOK IS ALREADY IN, worked out before anything moves. A
     * project's documents belong together: the cast book has to arrive in the
     * column the scan is being read in, not in whichever column the pointer
     * happened to leave focused — which, for somebody reading two books, is
     * routinely the other book's.
     */
    const home = this.paneAmong(mine);
    // Right-click → "Open in split" on a step row, consumed exactly once. The
    // menu sets it and then moves the pointer; this is where the move lands.
    const split = this.splitNext.delete(move.key);
    if (target === null) {
      /*
       * NOTHING TO SWAP TO, AND STILL SOMETHING TO DO. A position with no document
       * of its own — a project with no reading yet, a payload since swept — is
       * still a row somebody clicked, so if none of this book's tabs is in a column
       * one of them goes in one. The instruction was "show me this step"; the
       * honest answer is this book, where they can see it.
       */
      const first = mine[0];
      if (first === undefined) return false;
      if (split) {
        this.openInNewPane(first.id, this.indexOfPane(home) + 1);
        return false;
      }
      if (mine.some((tab) => this.paneOf(tab.id) !== null)) return false;
      this.reveal(first.id);
      return false;
    }

    const key = normalise(target);
    const already = mine.find((tab) => normalise(tab.path) === key);
    if (already !== undefined) {
      if (split) this.openInNewPane(already.id, this.indexOfPane(home) + 1);
      else this.reveal(already.id, false, home?.id ?? null);
      return false;
    }

    /*
     * WHETHER FOUNDRY MADE THIS FILE, ASKED OF THE CATALOGUE RATHER THAN ASSUMED.
     * It is what the Chrome dot and the closing question are about: "no copy of
     * this exists anywhere you chose". True of a reprint and a translation; false
     * of the untouched original in `archive/`, which is in this app precisely
     * BECAUSE the user still has their own. Home draws one row per file type and
     * the archive is the layer it never draws, so a path the listing does not name
     * is the original — and false is the right answer for exactly that.
     */
    const madeByUs = this.projects.projectFor(target)?.documents
      .some((row) => normalise(row.path) === key && row.managed) === true;

    const wanted: TabKind = key.endsWith('.epub') ? 'epub' : 'pdf';
    const follower = wanted === 'pdf' ? this.followerAmong(mine) : null;
    if (follower === null) {
      if (split) this.expectOwnPane.add(key);
      else if (home !== null) this.expectPane.set(key, home.id);
      await this.openFile(target, madeByUs);
      return true;
    }
    this.patch(follower.id, {
      path: target,
      // The dot follows the file, for the reason above: the tab is about to stop
      // being about the copy Foundry made and start being about the user's own.
      unsaved: madeByUs,
      /*
       * THE REVISION MOVES WITH THE PATH. It is what makes a pane re-read bytes it
       * is already pointed at (see `openFinished`), and the two files this swaps
       * between can have the same name in two layers of one project — so a viewer
       * that compared only the string would faithfully conclude there was nothing
       * to do, which is the failure that whole comment exists about.
       */
      revision: follower.revision + 1,
      /*
       * AND THE NAME ONLY IF NOBODY CHOSE ONE, which is `relocate`'s rule and its
       * reason: a book's `dc:title` outranks anything derived from a path, and
       * these files are all one book anyway — `nameFor` answers the project's title
       * for every layer of it.
       */
      ...(follower.named ? {} : { title: this.nameFor(target) }),
    });
    if (split) this.openInNewPane(follower.id, this.indexOfPane(home) + 1);
    else this.reveal(follower.id, false, home?.id ?? null);
    return true;
  }

  /**
   * Put the project's BOOK on screen — the proof sheet, not a file.
   *
   * ── One per project, forever ────────────────────────────────────────────────
   *
   * There is exactly one book in a project and one tab for it. Everything else in
   * this file that opens something has to decide between a swap and a second tab,
   * because two paths can be two documents of one project; here there is nothing
   * to decide, because the tab does not name a file at all — it names the project,
   * and main answers with whatever the position's reading reflowed to. A book tab
   * that is already open is therefore already correct for any read row of that
   * project, and revealing it is the whole of the work.
   *
   * IT LANDS IN THE COLUMN THE PROJECT IS ALREADY BEING READ IN, which is
   * `showDocument`'s rule and for `showDocument`'s reason: a project's documents
   * belong together, and a person reading two books must not have this one arrive
   * in the other one's column. "Open in split" is consumed here too — the flag
   * rides on a position move and this is now one of the two places a move lands.
   *
   * ANSWERS FALSE, ALWAYS: the boolean its caller wants is "did the PAGES under
   * the block editor move", and nothing here points a PDF pane anywhere.
   */
  private showBook(move: PositionMove): boolean {
    const mine = this.all().filter((tab) => {
      if (tab.kind === 'editor') return false;
      const dir = this.projectDirOf(tab);
      return dir !== null && fold(dir) === move.key;
    });
    const home = this.paneAmong(mine);
    const split = this.splitNext.delete(move.key);
    const id = this.bookTabIn(move.dir);
    if (split) this.openInNewPane(id, this.indexOfPane(home) + 1);
    else this.reveal(id, false, home?.id ?? null);
    return false;
  }

  /**
   * This project's book tab, made if it has none yet. Never a second one.
   *
   * MADE HERE RATHER THAN THROUGH `openFile`, and that is not a shortcut past a
   * gate. Every other tab in this app is made by `adopt`, on main's own
   * `document:opened` announcement, because main is what decides whether a path
   * may be opened at all. There is no path here to decide about: the tab is the
   * PROJECT, its rows arrive over an IPC that admits nothing (`book.load`,
   * shared/api.ts), and a door answering "yes, you may open this directory" would
   * be a door granting access to a folder for being asked about it.
   */
  private bookTabIn(projectDir: string): string {
    const key = fold(projectDir);
    const already = this.all().find((tab) => tab.kind === 'book' && fold(tab.path) === key);
    if (already !== undefined) return already.id;
    const made = this.blankTab('book', projectDir, this.projectTitleOf(projectDir));
    this.all.update((tabs) => [...tabs, made]);
    return made.id;
  }

  /**
   * The column one of these documents is in — the focused one for preference.
   *
   * "For preference" is the whole of it: with two of a project's faces on screen
   * the answer has to be the one the hand is in, or a click on a step row would
   * repaint the column the user is not looking at.
   */
  private paneAmong(mine: readonly Tab[]): Pane | null {
    const ids = new Set(mine.map((tab) => tab.id));
    const focused = this.focusedPane();
    if (focused && focused.tabIds.some((id) => ids.has(id))) return focused;
    return this.columns().find((pane) => pane.tabIds.some((id) => ids.has(id))) ?? null;
  }

  /** Where a column sits left to right, or the focused one's place when it has none. */
  private indexOfPane(pane: Pane | null): number {
    const panes = this.columns();
    const at = pane === null ? -1 : panes.findIndex((candidate) => candidate.id === pane.id);
    return at >= 0 ? at : panes.findIndex((candidate) => candidate.id === this.focused());
  }

  /**
   * Projects whose next position move puts its document in a COLUMN OF ITS OWN.
   *
   * The inspector's right-click → "Open in split" on a step row, which is two
   * acts that have to arrive as one: stand on the step, and put what it shows
   * beside what is already there. Standing is `LedgerService.go`, and what a step
   * shows is only decided afterwards, by main, in `showDocument` — so the
   * intention is left here for that answer to find. Consumed exactly once, so a
   * later move made for some other reason cannot inherit it.
   */
  private readonly splitNext = new Set<string>();

  /** Set by the inspector's menu immediately before it moves the pointer. */
  splitNextIn(projectDir: string): void {
    this.splitNext.add(fold(projectDir));
  }

  /** Dropped when the move it was set for turns out not to happen. */
  forgetSplitIn(projectDir: string): void {
    this.splitNext.delete(fold(projectDir));
  }

  /**
   * "Open in split" on the step somebody is ALREADY standing on.
   *
   * The flag above rides on a position MOVE, and a right-click on the current row
   * is not one: main answers with the same ledger, the picture does not change,
   * and nothing would ever consume it. So this asks main the same question
   * `showPosition` asks — what document does this position name — and puts the
   * answer in a column of its own.
   */
  async splitAtPosition(projectDir: string): Promise<void> {
    this.forgetSplitIn(projectDir);
    const at = this.indexOfPane(this.focusedPane());
    /*
     * A READ ROW SPLITS THE BOOK, for `showPosition`'s reason and so that the two
     * gestures cannot disagree. Asking main which document this position names
     * would answer with the cast EPUB — the surface the sheet replaces — and put
     * it in a column of its own beside a book somebody was reading, which is the
     * "one tab, not two" rule broken by the one door that went round it.
     */
    if (this.pictureIn(projectDir)?.view.step?.action === 'read') {
      this.openInNewPane(this.bookTabIn(projectDir), at + 1);
      return;
    }
    const target = await this.ledger.documentAt(projectDir);
    if (target === null) {
      // The position names no document of its own, so the honest thing to put in
      // the new column is this book — the same fallback `showDocument` makes.
      const key = fold(projectDir);
      const mine = this.all().find((tab) => {
        const dir = this.projectDirOf(tab);
        return tab.kind !== 'editor' && dir !== null && fold(dir) === key;
      });
      if (mine !== undefined) this.openInNewPane(mine.id, at + 1);
      return;
    }
    const normalised = normalise(target);
    const already = this.all().find(
      (tab) => normalise(tab.path) === normalised && tab.kind !== 'editor');
    if (already !== undefined) {
      this.openInNewPane(already.id, at + 1);
      return;
    }
    const madeByUs = this.projects.projectFor(target)?.documents
      .some((row) => normalise(row.path) === normalised && row.managed) === true;
    this.expectOwnPane.add(normalised);
    await this.openFile(target, madeByUs);
  }

  /** The PDF tab that follows the pointer: focused column, then any column, then any. */
  private followerAmong(mine: readonly Tab[]): Tab | null {
    const pdfs = mine.filter((tab) => tab.kind === 'pdf');
    if (pdfs.length === 0) return null;
    const focused = this.focusedPane()?.activeTabId ?? null;
    return pdfs.find((tab) => tab.id === focused)
      ?? pdfs.find((tab) => this.paneOf(tab.id) !== null)
      ?? pdfs[0]!;
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

  /**
   * What to call this TAB — one step above `nameFor`, which answers about a path.
   *
   * The two are the same question for every tab that is a file. A `book` tab is
   * not one (see `TabKind`): its path is the project's own directory, and
   * `nameFor` would answer with the folder said aloud — a slug with a hash on the
   * end — for the one document in this app whose name is never in doubt. It is
   * the project's title, which is what Home, the library and every other surface
   * already call this book.
   *
   * IT IS RE-DERIVED RATHER THAN FROZEN AT BIRTH, which is why this is a function
   * and not a flag: a metadata step can change a book's title while it is open,
   * and the naming effect above exists precisely so that every tab that did not
   * have a name CHOSEN for it follows.
   */
  private titleFor(tab: Tab): string {
    return tab.kind === 'book' ? this.projectTitleOf(tab.path) : this.nameFor(tab.path);
  }

  /**
   * The title of the project AT this directory, or the folder said aloud.
   *
   * The fallback is `nameFor`'s own last resort rather than a second one: a
   * directory no project claims is a book that has left the library while a tab
   * was open, and the honest thing to say about it is whatever its folder is
   * called.
   */
  private projectTitleOf(dir: string): string {
    const key = fold(dir);
    const project = this.projects.items().find((one) => fold(one.dir) === key) ?? null;
    return project === null || project.problem !== null || project.title.length === 0
      ? this.nameFor(dir)
      : project.title;
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

  /**
   * The documents list's click on a row nothing has opened yet — including an
   * EXPORT row, which is a file in `final/` and opens like any other document.
   *
   * IT REPLACES what the focused column is showing, which is the user's rule
   * about browsing: *"clicking another file will automatically close the one i
   * was looking at and open the one i just clicked, unless i pin the file"*. The
   * displaced tab gets its ordinary closing question, so nothing with work in it
   * goes without being asked.
   */
  async openFromList(filePath: string, managed = false): Promise<void> {
    this.expectReplace.add(normalise(filePath));
    await this.openFile(filePath, managed);
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
      this.expectReplace.delete(key);
      this.expectPane.delete(key);
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
   *
   * ── A COLUMN OF ITS OWN, EXCEPT WHERE THAT IS A SECOND COLUMN OF ONE BOOK ───
   *
   * The pane-of-its-own rule was written for the translation and it is right for
   * the translation: it runs for hours, the person who ordered it is not
   * watching, and the whole point of it appearing is that they can read it
   * AGAINST the source. Two columns is the feature.
   *
   * A READING NOW CASTS THE BOOK BY ITSELF (docs/WORKBENCH.md §4, Unit E), and
   * nobody asked for that one at all. Under the old rule it arrived as a new
   * column, unbidden, next to the scan it was cast from — and then the position
   * effect, which is the thing that actually MEANT to put it on screen, found it
   * already in a column and merely focused it. Two mechanisms, one book, and a
   * column the user did not arrange: the read step's document turning up as
   * furniture rather than as the step's document.
   *
   * So a landing whose project is already open in a column JOINS THAT COLUMN'S
   * STRIP — it is another face of the same book, the same thing clicking the read
   * row means — and only a translation still insists on a column of its own,
   * because only a translation is a thing to be read beside rather than instead.
   * A landing whose project has nothing open takes a column, because there is
   * nothing for it to join.
   */
  private openFinished(filePath: string, kind: JobKind): void {
    const key = normalise(filePath);
    const already = this.all().find((tab) => normalise(tab.path) === key && tab.kind !== 'editor');
    if (already) {
      this.reveal(already.id);
      this.patch(already.id, { revision: already.revision + 1, unsaved: true, savedPath: null });
      return;
    }
    const home = kind === 'translate' ? null : this.paneHolding(filePath);
    if (home !== null) this.expectPane.set(key, home.id);
    else this.expectOwnPane.add(key);
    void this.openFile(filePath, true);
  }

  /**
   * The column this file's PROJECT is already being read in, or null.
   *
   * The focused one first, so a person reading two books gets the answer about
   * the one in front of them; then any column holding a tab of that project.
   */
  private paneHolding(filePath: string): Pane | null {
    const dir = this.projects.projectFor(filePath)?.dir ?? null;
    if (dir === null) return null;
    const key = fold(dir);
    const mine = new Set(this.all()
      .filter((tab) => {
        const own = this.projectDirOf(tab);
        return own !== null && fold(own) === key;
      })
      .map((tab) => tab.id));
    if (mine.size === 0) return null;
    const focused = this.focusedPane();
    if (focused && focused.tabIds.some((id) => mine.has(id))) return focused;
    return this.columns().find((pane) => pane.tabIds.some((id) => mine.has(id))) ?? null;
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
    const replace = this.expectReplace.delete(key);
    const intoPane = this.expectPane.get(key) ?? null;
    this.expectPane.delete(key);
    const existing = this.all().find((tab) => normalise(tab.path) === key && tab.kind !== 'editor');
    if (existing) {
      this.reveal(existing.id, replace, intoPane);
      return;
    }

    const kind: TabKind = key.endsWith('.epub') ? 'epub' : 'pdf';
    const unsaved = this.expectUnsaved.delete(key);
    const tab = this.blankTab(kind, absolutePath, this.nameFor(absolutePath));
    tab.unsaved = unsaved;
    this.all.update((tabs) => [...tabs, tab]);
    this.place(tab.id, ownPane, null, replace, intoPane);
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
      pinned: false,
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

  /**
   * The column HOLDING this document, if any is. At most one, by construction.
   *
   * Holding and not showing: a tab sitting in a strip behind another one is in
   * that column, and every caller of this asks the question that way — "is it on
   * screen somewhere" means "is there a column I can bring it to the front of".
   * `paneShowing` is the narrower question, for the surfaces that draw the
   * difference.
   */
  paneOf(tabId: string): Pane | null {
    return this.columns().find((pane) => pane.tabIds.includes(tabId)) ?? null;
  }

  /** The column with this document ON TOP — what the documents list marks as on screen. */
  paneShowing(tabId: string): Pane | null {
    return this.columns().find((pane) => pane.activeTabId === tabId) ?? null;
  }

  /** True while nothing may close this tab out from under the user. */
  isPinned(tabId: string): boolean {
    return this.byId(tabId)?.pinned === true;
  }

  /**
   * Right-click → Pin / Unpin, on a tab in a strip.
   *
   * A TOGGLE AND NOT TWO METHODS, because the menu draws one item whose label is
   * the answer to the same question this reads.
   */
  togglePin(tabId: string): void {
    const tab = this.byId(tabId);
    if (tab === null) return;
    this.patch(tabId, { pinned: !tab.pinned });
  }

  /**
   * The strip's own click: bring this tab to the front of the column it is in.
   *
   * NOT `reveal`. Reveal would put a tab that is in no column into the FOCUSED
   * one, which is right for a row in the documents list and wrong for a strip —
   * a strip only ever draws tabs that are already in its own pane, so the pane is
   * known and there is nothing to place.
   */
  activateInPane(paneId: string, tabId: string): void {
    this.columns.update((panes) => panes.map((pane) => (
      pane.id === paneId && pane.tabIds.includes(tabId)
        ? { ...pane, activeTabId: tabId }
        : pane)));
    this.focused.set(paneId);
  }

  /**
   * Clicking anywhere in a pane focuses it — that is the whole focus model, and
   * it is why nothing else in the app has to ask which pane it is in.
   */
  focusPane(paneId: string): void {
    if (this.focused() === paneId) return;
    if (this.columns().some((pane) => pane.id === paneId)) this.focused.set(paneId);
  }

  /**
   * Ctrl+1…5. Out of range is a no-op rather than a clamp — 4 means the fourth.
   *
   * IT MIRRORS THE FOCUS ONTO THE POSITION, and it mirrors HERE rather than at the
   * call site because the chord IS this method: `app.ts`'s key handler is its only
   * caller, and nothing in this file reaches it. A pane is focused by the position
   * effect through `this.focused.set` directly, which is the seam that keeps a
   * programmatic reveal out of this door.
   */
  focusPaneAt(index: number): void {
    const pane = this.columns()[index];
    if (!pane) return;
    this.focused.set(pane.id);
    if (pane.activeTabId !== null) void this.standForTab(pane.activeTabId);
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
   *
   * ── And it JOINS a strip rather than emptying one ───────────────────────────
   *
   * Landing in a column used to overwrite what that column held, because a column
   * held one thing. It now inserts into the strip beside the active tab and takes
   * the front — nothing is displaced by arriving.
   *
   * `replace` is the user's auto-close rule and it is a DIFFERENT act, asked for
   * by the caller rather than implied by landing: *"clicking another file will
   * automatically close the one i was looking at… unless i pin the file"*. So the
   * documents list passes it, the position effect does not (a scan and the book
   * cast from it are two rows of one project and must be able to sit in one strip
   * together), and a finished job does not (it is a comparison, not a
   * replacement). What it does is CLOSE the tab it took the front from — through
   * the ordinary close, so a document with something to lose still gets its
   * question and a "keep" leaves it exactly where it was, in the strip, beside
   * the new one. A pinned tab is never the one it takes.
   */
  private place(
    tabId: string,
    ownPane: boolean,
    beside: string | null = null,
    replace = false,
    intoPane: string | null = null,
  ): void {
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
    /*
     * `intoPane` NAMES THE COLUMN THIS BOOK ALREADY LIVES IN, and it is what
     * keeps the position effect from scattering one project across the window.
     * Clicking the read row opens the cast book; without this it would land in
     * whichever column happened to be focused — the OTHER book's, if the user was
     * reading two — and the scan it is meant to replace on screen would stay
     * exactly where it was, in a column nobody was looking at.
     */
    const named = intoPane === null
      ? null
      : panes.find((pane) => pane.id === intoPane) ?? null;
    const target = named
      ?? (ownPane
        ? crowdedTarget(panes, beside)
        : (this.focusedPane() ?? panes[panes.length - 1]!));
    const displaced = replace ? this.byId(target.activeTabId) : null;
    this.columns.set(panes.map((pane) => (
      pane.id === target.id ? addToStrip(pane, tabId) : pane)));
    this.focused.set(target.id);
    if (displaced !== null && displaced.id !== tabId && !displaced.pinned) {
      void this.close(displaced.id);
    }
  }

  private makePane(tabId: string | null): Pane {
    this.paneSequence += 1;
    return {
      id: `pane-${this.paneSequence}`,
      tabIds: tabId === null ? [] : [tabId],
      activeTabId: tabId,
      flex: 1,
    };
  }

  /**
   * Put a document in front of the user — a click on its row in the list, or a
   * step whose document is already open.
   *
   * IN A STRIP ALREADY: it comes to the front of the column it is in, and the
   * focus goes there. A second viewer over one unpack is two scroll positions
   * fighting over one document — the thing `adopt` refuses to make for two files
   * — and (because `chapterHref` lives on the tab) two columns that appear
   * scroll-locked with nothing on screen saying why.
   *
   * IN NO STRIP: it joins the focused pane's. `replace` is the documents list's
   * auto-close rule; everything that reveals for its own reasons leaves it off.
   */
  reveal(tabId: string, replace = false, intoPane: string | null = null): void {
    if (this.byId(tabId) === null) return;
    const pane = this.paneOf(tabId);
    if (pane) {
      this.activateInPane(pane.id, tabId);
      return;
    }
    this.place(tabId, false, null, replace, intoPane);
  }

  /**
   * Show a document in a named column — a row dropped on a pane's middle, or a
   * tab dragged from one strip into another.
   *
   * IT LEAVES THE STRIP IT CAME FROM, when it had one: a document is in at most
   * one pane. The source column survives with its remaining tabs and only goes
   * when the move emptied it — an empty column nobody asked for is furniture in
   * the way of the two the user is comparing. (An empty column somebody DID ask
   * for — Ctrl+\ — is a different thing and stays until it is filled or closed,
   * which is why this only drops a column the move itself emptied.)
   */
  show(tabId: string, paneId: string): void {
    const panes = this.columns();
    if (this.byId(tabId) === null || !panes.some((pane) => pane.id === paneId)) return;
    const from = panes.find((pane) => pane.tabIds.includes(tabId)) ?? null;
    if (from !== null && from.id === paneId) {
      this.activateInPane(paneId, tabId);
      return;
    }
    const going = new Set([tabId]);
    this.columns.set(panes
      .map((pane) => {
        if (pane.id === paneId) return addToStrip(pane, tabId);
        return pane.id === from?.id ? withoutTabs(pane, going) : pane;
      })
      .filter((pane) => pane.id !== from?.id || pane.tabIds.length > 0));
    this.focused.set(paneId);
  }

  /**
   * A tab dropped INTO A STRIP — reordered inside its own column, or moved into
   * another one, landing in front of `beforeTabId` (null means the end).
   *
   * ONE METHOD FOR BOTH, because from the hand's side they are one gesture: pick
   * a tab up, put it down between two others. Which column it started in is this
   * function's problem and not the drag's, and splitting it in two would mean the
   * workspace deciding — from a drop's geometry — which of two service calls it
   * was making, and getting it wrong at exactly the boundary between them.
   *
   * The column it left goes only if the move emptied it, which is `show`'s rule
   * and for `show`'s reason.
   */
  dropInStrip(tabId: string, paneId: string, beforeTabId: string | null): void {
    const panes = this.columns();
    if (this.byId(tabId) === null || tabId === beforeTabId) return;
    const to = panes.find((pane) => pane.id === paneId);
    if (to === undefined) return;
    const from = panes.find((pane) => pane.tabIds.includes(tabId)) ?? null;
    const without = to.tabIds.filter((id) => id !== tabId);
    const at = beforeTabId === null ? -1 : without.indexOf(beforeTabId);
    const index = at < 0 ? without.length : at;
    const landed: Pane = {
      ...to,
      tabIds: [...without.slice(0, index), tabId, ...without.slice(index)],
      activeTabId: tabId,
    };
    const going = new Set([tabId]);
    this.columns.set(panes
      .map((pane) => {
        if (pane.id === paneId) return landed;
        return pane.id === from?.id ? withoutTabs(pane, going) : pane;
      })
      .filter((pane) => pane.id === paneId || pane.id !== from?.id || pane.tabIds.length > 0));
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
    const from = panes.find((pane) => pane.tabIds.includes(tabId)) ?? null;
    const going = new Set([tabId]);
    const fresh = this.makePane(tabId);
    const at = Math.max(0, Math.min(atIndex, panes.length));
    // The source column KEEPS ITS OTHER TABS and only goes when tearing this one
    // out left it with nothing — the strip is what makes the difference from the
    // one-document-per-column version of this, where the source was always empty.
    this.columns.set(equalise([...panes.slice(0, at), fresh, ...panes.slice(at)]
      .map((pane) => (pane.id === from?.id ? withoutTabs(pane, going) : pane))
      .filter((pane) => pane.id !== from?.id || pane.tabIds.length > 0)));
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
    if (at >= 0 && panes[at]!.tabIds.length === 0) {
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

  /**
   * The rail's Home. Home is "this column is showing nothing", not a document.
   *
   * THE STRIP STAYS. Nothing was closed — the tabs are still this column's, still
   * drawn along its top, and one click from coming back — which is a better Home
   * than the one that emptied the column, because it does not make somebody go
   * and find their book in the list again to undo pressing a button.
   */
  goHome(): void {
    const pane = this.focusedPane();
    if (!pane) return;
    this.columns.update((panes) => panes.map((candidate) =>
      (candidate.id === pane.id ? { ...candidate, activeTabId: null } : candidate)));
  }

  showChapter(id: string, href: string): void {
    this.patch(id, { chapterHref: href });
  }

  /**
   * Ctrl/Cmd+Tab. Walks THE FOCUSED COLUMN'S OWN STRIP, wrapping.
   *
   * IT MEANS WHAT IT SAYS NOW. It used to walk the whole window's flat list and
   * pull whichever document came next INTO this column — skipping the ones
   * another column had, because taking one would have swapped two columns'
   * contents rather than advanced one. That was the best a chord called "next
   * tab" could do in an app with no tabs: a cycle that moved documents between
   * columns to simulate a strip that was not there.
   *
   * There is a strip now, so this is the strip's own cycle: the next tab in this
   * column, then round. A column holding one document has nowhere to go and the
   * chord does nothing, which is honest — the other four columns' documents are
   * not this column's to riffle through.
   *
   * AND IT MOVES THE POSITION WITH IT, on `focusPaneAt`'s reasoning: the chord is
   * this method, `app.ts` is its only caller, and stepping from the scan to the
   * book with a keystroke is the same statement as clicking the tab. The mirror is
   * outside `activateInPane` on purpose — that one is also how a library click
   * lands its document (see `standForTab`).
   */
  nextTab(): void {
    const pane = this.focusedPane();
    if (!pane || pane.tabIds.length === 0) return;
    const at = pane.activeTabId === null ? -1 : pane.tabIds.indexOf(pane.activeTabId);
    const next = pane.tabIds[(at + 1) % pane.tabIds.length];
    if (next === undefined) return;
    this.activateInPane(pane.id, next);
    void this.standForTab(next);
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
    /*
     * THE TABS THIS SWEEP HAS ALREADY ACCOUNTED FOR, which is what makes the
     * corrections question fire exactly once for a project with two of them open.
     *
     * `questionBefore` skips the corrections when another open tab still reaches
     * the same project's decisions — see it for why. In a sweep that is every tab
     * of the project, so with nothing carried between iterations each tab would
     * point at the next as the one that still holds them and NOBODY would be
     * asked: the window would close on a project's uncommitted decisions in
     * silence, which is the exact failure this sweep exists to prevent. Carrying
     * the ones already passed makes the LAST tab of each project the one with
     * nothing left to point at, and it is the one that asks.
     */
    const accountedFor = new Set<string>();
    // A copy, because a save made from the dialog can repaint the list underneath
    // this loop, and an iteration over the live signal would be walking an array
    // that moved.
    for (const tab of [...this.all()]) {
      if (await this.questionBefore(tab.id, accountedFor) === 'stay') return false;
      accountedFor.add(tab.id);
    }
    return true;
  }

  /**
   * What this document has to say for itself before it goes, asked once — and
   * ONLY when something would actually be lost.
   *
   * ── THE QUESTION THAT WAS ASKED ABOUT NOTHING ───────────────────────────────
   *
   * This used to ask whenever a tab was `unsaved`, and `unsaved` means "no copy
   * of this exists anywhere you chose" — which is true FROM BIRTH of every book
   * this app opens out of a project, because the project IS where it lives. So
   * closing a tab somebody had done nothing but look at raised a dialog about a
   * loss that had not happened, and a warning that fires when nothing is at stake
   * is how a person learns to dismiss the one that matters. The user ruled on it
   * in a sentence: *"only pop up a confirmation alert if changes have been
   * made."*
   *
   * It is also a warning that outlived its workflow. It was written when Save put
   * a copy somewhere of the user's choosing and the app could reasonably say "you
   * have not done that yet"; saving is the export modal's job now
   * (docs/WORKBENCH.md §6), a project tab that closes loses track of nothing, and
   * Home still lists the book. The DOT stays — `Tab.unsaved` is a fact worth
   * drawing — but it is not a reason to stop somebody on their way out.
   *
   * ── ONE QUESTION FOR TWO LOSSES ─────────────────────────────────────────────
   *
   * A book's filed copy can be out of date, and a scan's corrections can have no
   * save to come back to. Main composes whichever of the two are true into one
   * card, because this codebase has already ruled that a closing document is
   * asked about once (`closeShowing`): a second dialog on top of the first is the
   * app arguing with an answer it already has.
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
  private async questionBefore(
    id: string,
    /**
     * Tabs this same operation has already dealt with — see `letGo`. Empty for
     * an ordinary close, which is dealing with exactly one.
     */
    accountedFor: ReadonlySet<string> = EMPTY_IDS,
  ): Promise<'go' | 'stay'> {
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
     * a document in a project with a reading behind it.
     *
     * ── THE BOOK IS ASKED ABOUT TOO, NOT JUST THE SCAN ─────────────────────────
     *
     * This tested `kind === 'pdf'` because the only surface that could decide
     * anything was the scan's block editor. A cut or a relabel on the CAST BOOK
     * now lands in the same curation (`amendBlocks`, mirrored from the book's own
     * gestures), and main resolves either path to the one project — `locateOverlay`
     * asks which project the path is in and never opens the file it names. So a
     * person who struck four footnotes in the flowing book and closed it was asked
     * nothing at all, which is the same hole one document over.
     *
     * ── AND ONLY WHEN THIS TAB IS THE LAST WAY BACK TO THEM ────────────────────
     *
     * The decisions belong to the PROJECT, not to the tab. A project's scan and
     * its cast book are routinely open together — that is the whole point of the
     * two of them — and both answer this question with the same uncommitted
     * curation. Asking as each one closes would be two dialogs about one set of
     * decisions, and the first of them would be a lie: nothing is losing its way
     * back while the other tab is still open and Apply changes is still on screen.
     * So the question is owed only when the LAST tab holding this project's
     * decisions goes, and a sibling that is not itself going is what makes this
     * tab not that one.
     */
    const holders = this.otherTabsIn(current, accountedFor);
    const corrections = (current.kind === 'pdf' || current.kind === 'epub') && holders === 0
      ? await api.overlay.uncommitted(current.path).catch(() => null)
      : null;
    if (!current.modified && corrections === null) return 'go';

    const answered = await api.confirmClose({
      title: current.title,
      modified: current.modified,
      savedPath: current.savedPath,
      corrections,
    });
    if (answered === 'keep') return 'stay';
    if (answered === 'save') return await this.saveCorrections(id) ? 'go' : 'stay';
    return 'go';
  }

  /**
   * How many OTHER open tabs would still reach this document's project after it
   * goes — the count that decides whether the corrections question is owed.
   *
   * EDITORS DO NOT COUNT. An editor tab is a face of its book rather than a
   * document of its own, and closing the book closes it (`close`), so counting
   * one would be counting the tab that is going with this one.
   *
   * A DOCUMENT IN NO PROJECT HAS NO SIBLINGS: somebody's own PDF out of their
   * Downloads folder has no project, no curation and nothing to be the last way
   * back to. Zero is the honest answer and it is also the one that lets the
   * question be asked, which costs nothing — main answers null for it.
   */
  private otherTabsIn(doomed: Tab, accountedFor: ReadonlySet<string>): number {
    const dir = this.projectDirOf(doomed);
    if (dir === null) return 0;
    const key = fold(dir);
    return this.all().filter((tab) => {
      if (tab.id === doomed.id || tab.kind === 'editor' || accountedFor.has(tab.id)) return false;
      const own = this.projectDirOf(tab);
      return own !== null && fold(own) === key;
    }).length;
  }

  /**
   * Close a tab, asking first when it has something to lose.
   *
   * The question is `questionBefore` above, asked in the app's own card
   * (`ConfirmService`). THE BOOK IS NOT DELETED EITHER WAY (see
   * electron/workspace.ts) and neither are its corrections, so what closing costs
   * is a filed copy left behind and a state they can come back to, never the work
   * itself.
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
   * second card on top of it, asking about saving the thing they just told the
   * app to destroy, is the app arguing with an answer it already has.
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
    /*
     * AND THE PROVENANCE READ OFF THAT BOOK'S CHAPTERS. It is a cache of what a
     * working tree said, the tree is being unpacked-and-forgotten one line above,
     * and an entry under a book id nothing will ever name again is memory held
     * for a document that no longer exists.
     */
    if (current.book) this.forgetSources(current.book.id);

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
      // The world a word edit lands in is keyed by tab id and dies with it —
      // the next tab on this document asks main afresh.
      for (const key of [...this.translationWorlds.keys()]) {
        if (key.startsWith(`${gone}|`)) this.translationWorlds.delete(key);
      }
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
   * CLOSING A DOCUMENT FALLS BACK TO ITS NEIGHBOUR IN THE STRIP, and closing the
   * LAST of a column closes the column.
   *
   * The neighbour is the strips' whole difference here. Before them a pane held
   * one document and had nothing to fall back to, so every close took a column
   * with it; now a column with three tabs in it loses one and keeps its place,
   * which is what a person closing a document out of a stack means.
   *
   * An EMPTIED column still goes. Leaving one behind would mean closing four
   * books left four Home pages side by side, which is a workspace nobody
   * arranged — and closing the last document takes the last column with it, so
   * the window is Home again exactly as it was before any of this.
   *
   * The focus lands on the column that took the closed one's place, which is
   * the browser's rule for tabs one level up.
   */
  private dropFromPanes(going: ReadonlySet<string>): void {
    const panes = this.columns();
    const kept: Pane[] = [];
    let focusAt = -1;
    for (const pane of panes) {
      const left = withoutTabs(pane, going);
      // EMPTIED BY THIS CLOSE, and not merely empty. A column somebody made with
      // Ctrl+\ is empty on purpose and waiting to be filled; dropping it because
      // a document closed three columns away would take away the place they had
      // just made to put something.
      if (pane.tabIds.length > 0 && left.tabIds.length === 0) {
        if (pane.id === this.focused()) focusAt = kept.length;
        continue;
      }
      kept.push(left);
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
    const at = this.columns().findIndex((pane) => pane.tabIds.includes(tabId));
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
    /*
     * NOTHING HAS BEEN READ AT THIS POSITION, SO NOTHING IS ASKED FOR.
     *
     * `overlay:blocks` over a book with no reading behind it is a question with
     * no answer — main now refuses it softly rather than throwing an OverlayError
     * into the console (docs/WORKBENCH.md §4, Unit E), and that refusal is the
     * BACKSTOP rather than the fix. The fix is here, because the app already
     * knows: `positionView().outlines` is false for the import row and for every
     * position standing before a reading, and asking anyway spends an IPC round
     * trip to be told a thing this side had in hand.
     *
     * The mode comes OFF rather than showing a sentence where the outlines would
     * be. Standing before a reading is not a failure to render blocks, it is a
     * point in the book's story at which there are none — and a pane that said
     * "this book has not been read" over a scan the user is looking at, on a step
     * they deliberately clicked back to, would be the app reporting a state it
     * was asked to be in.
     *
     * A project whose history has not arrived yet (`pictureIn` null) is not this
     * case and goes on through: the answer is unknown rather than no.
     */
    const standing = this.pictureIn(dir);
    if (standing !== null && !standing.view.outlines) {
      this.patch(tabId, { blockView: false });
      this.forgetBlockView(tabId);
      return;
    }
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

  /**
   * The project this document belongs to, or null for a file opened from elsewhere.
   *
   * A `book` TAB NAMES ITS PROJECT DIRECTLY (see `TabKind`), so it is answered
   * from the tab rather than looked up: `projectFor` asks which project a FILE is
   * inside, and a directory is not inside itself. Asked of the catalogue anyway,
   * so that a directory this window no longer has a project for answers null like
   * anything else — the alternative is a tab claiming to belong to a book that has
   * left the library.
   */
  private projectDirOf(tab: Tab): string | null {
    if (tab.kind !== 'book') return this.projects.projectFor(tab.path)?.dir ?? null;
    const key = fold(tab.path);
    return this.projects.items().find((project) => fold(project.dir) === key)?.dir ?? null;
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
    /*
     * A BOOK MAY PRESS IT TOO, and that is the whole of Apply changes.
     *
     * This used to refuse anything but a scan, on the reasoning that a curation
     * is the block editor's and the block editor is a PDF surface. The reasoning
     * held exactly as long as the flowing book's strikes went nowhere. They are
     * decisions in the same curation now, so the person who made them is usually
     * standing on the cast book and not on the scan — and a Save that could only
     * be pressed from the document they are NOT looking at would be the app
     * asking them to go and find the right pane before their work could be kept.
     *
     * Main resolves either path to the one project (`locateOverlay`), so what is
     * committed is the same file whichever document is in front.
     */
    if (!api || tab === null || (tab.kind !== 'pdf' && tab.kind !== 'epub')) return false;
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
      // What is now unkept has changed — to nothing, usually — and the button
      // that offered this is drawn from that answer.
      this.curationWritten();
      return true;
    } catch (err) {
      this.notice.set(err instanceof Error ? err.message : String(err));
      return false;
    }
  }

  // ── What no save of this project holds ───────────────────────────────────
  //
  // THE GATE ON APPLY CHANGES, and it is a question only main can answer. The
  // live curation is a file beside the readings bank; whether it says anything a
  // step does not already hold is a comparison against the restore point in the
  // manifest, and neither file is in this window. `overlay:uncommitted` is that
  // comparison and it writes nothing (electron/overlays.ts is explicit about
  // it), so it is safe to ask on a repaint.
  //
  // KEYED BY PROJECT, not by tab. One project has one live curation, and the
  // scan and the cast book are two views of it — so the button must appear on
  // both the moment either of them records a decision, and go quiet on both the
  // moment it is applied. Keyed by tab, a person who struck a paragraph in the
  // book and then clicked the scan would have been shown nothing to apply.

  private readonly unkept = signal<ReadonlyMap<string, UncommittedCuration | null>>(new Map());

  /** The last question asked, so a repaint does not ask it again. See the effect. */
  private lastAsked = '';

  /**
   * A number that changes whenever this window writes a curation — the effect
   * below watches it, so nothing has to remember to re-ask.
   */
  private readonly curationSeq = signal(0);

  private curationWritten(): void {
    this.curationSeq.update((n) => n + 1);
  }

  /** What this project holds that no save of it does, or null. */
  uncommittedIn(projectDir: string | null): UncommittedCuration | null {
    return projectDir === null ? null : this.unkept().get(fold(projectDir)) ?? null;
  }

  /**
   * Ask main, for the document in front of the user.
   *
   * ASKED OF A PATH RATHER THAN OF A PROJECT, because that is the door main
   * offers and because the renderer naming a scan it already has open is the
   * pattern every call in this family follows. Either kind of document resolves
   * to the same curation, so whichever one is in front answers for the project.
   *
   * EVERY FAILURE IS NULL AND NOTHING IS SAID. The question is asked on a
   * repaint, of a document that may be outside the library or unread, and a
   * sentence in the strip for a question nobody asked would be noise on top of
   * whatever the user is actually doing. The button simply does not appear.
   */
  private async askUnkept(tab: Tab | null): Promise<void> {
    if (!api || tab === null) return;
    const dir = this.projectDirOf(tab);
    if (dir === null) return;
    const key = fold(dir);
    const answer = await api.overlay.uncommitted(tab.path).catch(() => null);
    this.unkept.update((map) => new Map(map).set(key, answer));
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
    if (chapters.some((one) => atSameBlock(one.at, at))) {
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
    const going = chapters.find((one) => atSameBlock(one.at, at));
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
    const current = chapters.find((one) => atSameBlock(one.at, at));
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

  // ── The spine, on the flowing book ───────────────────────────────────────
  //
  // ── The same list, drawn as lines instead of as rows ────────────────────────
  //
  // Everything above this comment is the SCAN's projection of the chapters
  // spine: a list in the inspector, over pages this service draws itself, keyed
  // to a block view it holds in memory. The book has no block view and never
  // will — its pages are documents in sandboxed frames — so the marker lines
  // drawn down the continuous book need their own read of the same file, and
  // that is what this section is. The user's ruling, which is what makes the two
  // projections one thing rather than two:
  //
  //   "That dotted line is the definitive chapter info for the book."
  //
  // So: ONE FILE, ONE FIELD, two surfaces that draw it. A line dragged on the
  // book and a row renamed in the panel are the same `setChapters` write, the
  // same ledger row, the same Apply changes.
  //
  // ── Why a marker needs TWO names ────────────────────────────────────────────
  //
  // The spine is keyed to the BANK — `page:order[:part]`, the answer the model
  // gave — because that is the only name that survives the book being cast
  // again. The frame can only speak `data-bf-id`, because that is what is
  // written on the elements in front of the reader. So every marker carries
  // both, resolved through the same provenance read `mirrorChapterMarks` makes,
  // and a chapter whose block this cast of the book does not contain simply has
  // no line to draw — it is still in the file, still in the list, and the next
  // cast puts it back on screen.

  /**
   * One chapter of the spine as the flowing book has to know it: where the file
   * says it is, what it is called, and which element on screen (if any) carries
   * the words it starts at.
   */
  private readonly bookSpines = signal<ReadonlyMap<string, BookSpine>>(new Map());

  /**
   * What the last spine read was ABOUT, so a repaint does not re-read the file.
   *
   * The book's surface asks on every tab patch — a strike, a relabel, a
   * revision bump — because it has no narrower signal to watch, and the answer
   * only moves when this window writes a curation or the position steps onto (or
   * off) a frozen save. Both are in the key.
   */
  private readonly bookSpineKeys = new Map<string, string>();

  /**
   * A number that changes whenever this window writes a curation.
   *
   * Read by the flowing book so that a strike made in one pane redraws the
   * chapter lines in another — the same reason `repaintCurations` re-reads a
   * scan's outlines, said as a signal because the book's surface is a component
   * and not a service.
   */
  readonly curationRevision = this.curationSeq.asReadonly();

  /** The spine as the flowing book draws it, or null while it has not been read. */
  bookSpineFor(tabId: string | null): BookSpine | null {
    return tabId === null ? null : this.bookSpines().get(tabId) ?? null;
  }

  /**
   * ── ADD CHAPTER IS A MODE, AND THIS IS WHO IS IN IT ────────────────────────
   *
   * One tab at a time, held as the tab's id rather than a flag per tab, because
   * that is the rule rather than a convenience: a person is placing ONE chapter
   * in ONE book, and two books both waiting for a click is a state nobody asked
   * for and nobody could see. Standing in it in one book and pressing the button
   * in another moves the mode rather than lighting up both.
   *
   * User ruling, 2026-08-15: *"it should be a button i press - add chapter. then
   * it lets me pick where it goes, then it exits chapter mode."* It was built as
   * a hover — every seam offering itself to a pointer that passed over it —
   * which is what "chapter markers shouldnt light up when i drag the mouse
   * around" is about. Moving a line and deleting one stay free: those act on
   * something already drawn and already visible, and only ADDING was ambient.
   */
  private readonly chapterModeTab = signal<string | null>(null);

  /** True while this book is waiting for a click to say where a chapter starts. */
  chapterModeOn(tabId: string | null): boolean {
    return tabId !== null && this.chapterModeTab() === tabId;
  }

  /** The button. Pressing it again is a cancel, which is what a toggle owes. */
  toggleChapterMode(tabId: string): void {
    this.chapterModeTab.update((current) => (current === tabId ? null : tabId));
  }

  /**
   * The mode ending for any reason that is not the button: the line was placed,
   * Escape was pressed in the frame, or the book stopped being editable.
   *
   * Idempotent and unconditional about WHICH tab — a frame reporting the mode
   * over cannot be reporting it over for somebody else, since only one tab is
   * ever in it.
   */
  endChapterMode(): void {
    this.chapterModeTab.set(null);
  }

  /**
   * Read the spine this book is showing — the live curation, or the frozen one
   * when the position stands on a save.
   *
   * A SAVE'S CHAPTERS ARE THE ONES DRAWN, exactly as `chaptersFor` draws them
   * over a scan's pages and for the same reason: a save is as much a statement
   * about where the book divides as about what is struck, and a page showing
   * frozen outlines under live chapter lines would be half of one curation and
   * half of another. The lines are drawn and not draggable — `editable` — which
   * is the read-only lock the other three doors already enforce, said in the
   * surface so it is visible before anything is pressed.
   */
  async ensureBookSpine(tabId: string): Promise<void> {
    const tab = this.byId(tabId);
    if (!api || tab === null || tab.kind !== 'epub' || tab.book === null) return;
    if (this.projectDirOf(tab) === null) {
      /*
       * A book opened from the user's own disk: no bank, no curation, nothing to
       * key a chapter to. It still reads, and it draws no lines.
       *
       * AN ANSWER RATHER THAN AN ABSENCE, which is the change `BookSpine.banked`
       * is for. A held spine of nothing says "this app has no chapters for this
       * book"; a missing entry says "nobody has asked yet", and they arrive one
       * after the other on every book that opens. The inspector picks which list
       * to draw off this, so conflating them would flash the book's own contents
       * over every Foundry book for as long as its overlay took to read.
       */
      // Keyed like every other answer so that a repaint calling this again does
      // not write an equal-but-new object into the signal on every frame.
      if (this.bookSpineKeys.get(tabId) === UNBANKED) return;
      this.bookSpineKeys.set(tabId, UNBANKED);
      this.putBookSpine(tabId, {
        chapters: [], marks: [], joins: [], confirmed: false, banked: false, editable: false,
      });
      return;
    }
    const held = this.heldByASave(tabId);
    const key = `${tab.book.id}\u0000${this.curationSeq()}\u0000${held ?? ''}`;
    if (this.bookSpineKeys.get(tabId) === key) return;
    this.bookSpineKeys.set(tabId, key);

    let loaded: OverlayLoad;
    try {
      loaded = await api.overlay.load(tab.path);
    } catch {
      /*
       * SILENT, and it is the same silence `provenanceOf` keeps. Nothing the
       * user did has failed: they are reading a book, and what could not be read
       * is the file that says where it divides. The lines are simply not drawn,
       * and the next write of the curation asks again — a sentence in the strip
       * here would be a complaint about this app's bookkeeping appearing over a
       * page nobody touched.
       */
      this.bookSpineKeys.delete(tabId);
      return;
    }
    // The tab was closed, or the book re-opened, while the read was in flight.
    const now = this.byId(tabId);
    if (now === null || now.book === null || now.book.id !== tab.book.id) return;

    const file = loaded.file as OverlayFile;
    const frozen = loaded.frozen as FrozenCuration | null;
    const shown: CurationContent = frozen ?? file;
    const confirmed = shown.chapters !== undefined;
    // Asked and recorded rather than inferred from the length — see `BookSpine.banked`.
    const detected = shown.chapters ?? await this.spineOf(tab, file);
    const chapters = detected ?? [];
    const index = await this.sourceIndexOf(tab);
    /*
     * The joins the shown curation records, resolved through the same index the
     * markers are: a `join: true` decision names the CONTINUATION block's first
     * banked answer, which is exactly the key `sourceIndexOf` files each
     * element under. A decision whose block this cast does not render is
     * simply not drawn — it is still in the file, and the cast that consumes
     * it will not show the seam at all.
     */
    const joins: { member: string; blockId: string }[] = [];
    for (const [key, decision] of decisionsOf(shown)) {
      if (decision.join !== true) continue;
      const found = index.get(key);
      if (found !== undefined) joins.push({ member: found.member, blockId: found.id });
    }
    this.putBookSpine(tabId, {
      chapters,
      confirmed,
      banked: detected !== null,
      editable: held === null,
      joins,
      marks: chapters.map((one) => {
        const target = targetKey(one.at);
        const found = index.get(target) ?? null;
        return {
          target,
          title: one.title,
          member: found?.member ?? null,
          blockId: found?.id ?? null,
        };
      }),
    });
  }

  private putBookSpine(tabId: string, spine: BookSpine | null): void {
    this.bookSpines.update((map) => {
      const next = new Map(map);
      if (spine === null) next.delete(tabId);
      else next.set(tabId, spine);
      return next;
    });
  }

  /**
   * Every banked answer this book renders, and the element that renders it.
   *
   * THE WHOLE BOOK AND NOT THE CHAPTER ON SCREEN, because there is no chapter on
   * screen any more: the flowing book draws every document of the spine at once,
   * so a marker line may belong to any of them. It is one read per member
   * through the cache `mirrorChapterMarks` already fills, held per book and
   * dropped with the book — ids and provenance do not move while a book is open
   * (`provenanceOf` says why), and a re-cast is a new book id.
   *
   * THE FIRST SOURCE PART, and the first element that claims it. A paragraph
   * joined across a page turn names several banked answers and a chapter starts
   * in front of the words that OPENED it; a list and its items are two elements
   * over one answer, and the container is the one a line belongs above.
   */
  private async sourceIndexOf(tab: Tab): Promise<ReadonlyMap<string, { member: string; id: string }>> {
    if (tab.book === null) return new Map();
    const held = this.sourceIndexes.get(tab.book.id);
    if (held !== undefined) return held;
    const index = new Map<string, { member: string; id: string }>();
    for (const member of membersOf(tab.book)) {
      const sources = await this.provenanceOf(tab.book.id, member);
      for (const [id, found] of sources.byBlock) {
        // A note is a piece of a block, never the start of a chapter.
        if (found.note !== null) continue;
        const at = parseSourceKeys(found.src)[0];
        if (at === undefined) continue;
        const key = targetKey(at);
        if (!index.has(key)) index.set(key, { member, id });
      }
    }
    this.sourceIndexes.set(tab.book.id, index);
    return index;
  }

  private readonly sourceIndexes = new Map<string, ReadonlyMap<string, { member: string; id: string }>>();

  // ── The three gestures on a line ─────────────────────────────────────────
  //
  // Every one of them arrives naming a `data-bf-id` — the only name the frame
  // has — and leaves as one `setChapters` write with one ledger row carrying the
  // whole list. They are the same ops the Chapters section makes, from the other
  // projection, and they meet the same read-only lock a strike does.

  /** "The book divides here" — the gutter's click, titled with the block's own words. */
  async addChapterMark(tabId: string, blockId: string, member: string): Promise<void> {
    if (this.refusedByASave(tabId)) return;
    const found = await this.markPlace(tabId, blockId, member);
    if (found === null) return;
    const { spine, at } = found;
    if (spine.chapters.some((one) => atSameBlock(one.at, at.where))) {
      this.notice.set('A chapter already starts at that block.');
      return;
    }
    const title = at.title.length > 0 ? at.title : `Chapter at ${targetKey(at.where)}`;
    await this.writeBookSpine(
      tabId,
      [...spine.chapters, { at: at.where, title }],
      `made “${title}” a chapter start`,
    );
  }

  /**
   * The drag: the marker that was above one block is now above another.
   *
   * ONE OP AND NOT A REMOVE FOLLOWED BY AN ADD, because it is one gesture and
   * one Ctrl+Z has to reverse it — and because the TITLE has to survive the
   * journey. A chapter somebody named "The Windmill" and then dragged two
   * paragraphs up is still called The Windmill; re-seeding it from the block it
   * landed on would silently rename it to whatever that paragraph says.
   */
  async moveChapterMark(
    tabId: string,
    fromBlockId: string,
    toBlockId: string,
    member: string,
  ): Promise<void> {
    if (this.refusedByASave(tabId)) return;
    const from = await this.markPlace(tabId, fromBlockId, member);
    const to = await this.markPlace(tabId, toBlockId, member);
    if (from === null || to === null) return;
    const going = from.spine.chapters.find((one) => atSameBlock(one.at, from.at.where));
    if (going === undefined) return;
    if (atSameBlock(from.at.where, to.at.where)) return;
    if (from.spine.chapters.some((one) => atSameBlock(one.at, to.at.where))) {
      this.notice.set(`A chapter already starts there, so “${going.title}” has been left where it was.`);
      return;
    }
    await this.writeBookSpine(
      tabId,
      from.spine.chapters.map((one) => (one === going ? { at: to.at.where, title: one.title } : one)),
      `moved the chapter “${going.title}”`,
    );
  }

  /** The double-click: a new name, typed on the line itself. */
  async renameChapterMark(
    tabId: string,
    blockId: string,
    member: string,
    title: string,
  ): Promise<void> {
    if (this.refusedByASave(tabId)) return;
    const found = await this.markPlace(tabId, blockId, member);
    if (found === null) return;
    // Collapsed and stripped like every other sentence that arrives from a
    // frame: it is our own element the words were typed into, but they crossed
    // the same channel as everything else and are treated the same way.
    const named = title.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    const current = found.spine.chapters.find((one) => atSameBlock(one.at, found.at.where));
    if (current === undefined || named.length === 0 || named === current.title) return;
    await this.writeBookSpine(
      tabId,
      found.spine.chapters.map((one) => (one === current ? { at: one.at, title: named } : one)),
      `renamed a chapter to “${named}”`,
    );
  }

  /**
   * Hand the book back to the engine's own detection — the book's side of
   * `resetChapters`, and the only gesture that REMOVES the list rather than
   * editing it.
   *
   * It exists here for the reason it exists there: the seeding is one-way
   * otherwise. The first line somebody drags turns "the engine decides" into
   * forty-one blocks stated exactly, and without a way back a person who curated
   * a spine and then wanted the app's answer again would have no gesture for it.
   */
  async resetBookSpine(tabId: string): Promise<void> {
    if (this.refusedByASave(tabId)) return;
    const tab = this.byId(tabId);
    if (!api || tab === null || tab.kind !== 'epub' || tab.book === null) return;
    if (this.projectDirOf(tab) === null) return;
    await this.writeBookSpine(tabId, null, 'gave the chapters back to Foundry to work out');
  }

  /** The ✕ on the line: this is not where the book divides. */
  async removeChapterMark(tabId: string, blockId: string, member: string): Promise<void> {
    if (this.refusedByASave(tabId)) return;
    const found = await this.markPlace(tabId, blockId, member);
    if (found === null) return;
    const going = found.spine.chapters.find((one) => atSameBlock(one.at, found.at.where));
    if (going === undefined) return;
    await this.writeBookSpine(
      tabId,
      found.spine.chapters.filter((one) => one !== going),
      `took out the chapter “${going.title}”`,
    );
  }

  /**
   * A block name out of the frame, resolved to the banked answer a marker is
   * keyed to — and the spine it would be written into.
   *
   * READ FRESH FROM THE FILE, never from the drawn spine. The lines on screen
   * are a picture of a read that happened at some point in the past; between
   * then and this gesture a strike in another pane, an undo, or the other
   * projection's own rename may have moved the list. `mirrorChapterMarks` reads
   * fresh for exactly this reason and says so; a spine written from a stale copy
   * would erase whatever arrived in between, and the spine is the one field
   * where that means the whole book's divisions at once.
   */
  private async markPlace(
    tabId: string,
    blockId: string,
    member: string,
  ): Promise<{ spine: { chapters: readonly OverlayChapter[] }; at: { where: OverlayTarget; title: string } } | null> {
    const tab = this.byId(tabId);
    if (!api || tab === null || tab.kind !== 'epub' || tab.book === null) return null;
    if (this.projectDirOf(tab) === null) return null;
    const sources = await this.provenanceOf(tab.book.id, member);
    const found = sources.byBlock.get(blockId);
    if (found === undefined) return null;
    const where = parseSourceKeys(found.src)[0];
    if (where === undefined) return null;
    let file: OverlayFile;
    try {
      file = (await api.overlay.load(tab.path)).file as OverlayFile;
    } catch (err) {
      this.notice.set(
        `Where this book divides could not be read, so nothing was changed: ${
          err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
    const seeded = await this.spineOf(tab, file);
    if (seeded === null) return null;
    return { spine: { chapters: seeded }, at: { where, title: found.text.slice(0, 120) } };
  }

  /**
   * The book's side of `writeChapters` — the same file, the same one-row ledger
   * entry, a different way of getting at the overlay.
   *
   * The scan's version writes through the block view it holds in memory. There
   * is none here, so the list is folded into the file this gesture just read and
   * handed to `putOverlay`, which writes it and leaves any scan pane of the same
   * project to re-read (`repaintCurations`). The ledger row is IDENTICAL in
   * shape to the scan's — one row, the whole list on each side — because it has
   * to be replayable by an undo that does not know which pane made it.
   *
   * ── ONE THING OUTSIDE THIS UNIT'S REACH, NAMED WHERE IT BITES ───────────────
   *
   * The row is a `chapters` row in a BOOK's ledger, and that is a field a book's
   * ledger has never carried before: the spine was only editable over a scan,
   * whose ledger is the overlay's (`electron/overlays.ts`, whose `FIELDS` set
   * already lists `chapters`). The book's ledger file has its own set — six
   * names, `electron/history.ts` — and `chapters` is not in it. Writing is
   * unvalidated, so the row lands; READING it back refuses the whole file, which
   * archives that book's undo history aside with a sentence the next time it
   * opens.
   *
   * The fix is one entry in that set and a comment that counts to seven, and it
   * is outside this unit's fence, so it is not made here. Undo and redo work
   * within the session either way — the stacks are in memory — and the row is
   * written rather than withheld, because a spine op that quietly could not be
   * taken back is the half-built shape this plan exists to stop.
   */
  private async writeBookSpine(
    tabId: string,
    chapters: readonly OverlayChapter[] | null,
    label: string,
  ): Promise<void> {
    const tab = this.byId(tabId);
    if (!api || tab === null) return;
    let file: OverlayFile;
    try {
      file = (await api.overlay.load(tab.path)).file as OverlayFile;
    } catch (err) {
      this.notice.set(
        `Where this book divides could not be read, so nothing was changed: ${
          err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    const before = chaptersText(file.chapters ?? null);
    const after = chaptersText(chapters);
    if (before === after) return;
    let next: OverlayFile;
    try {
      next = setChapters(file, chapters);
    } catch (err) {
      this.notice.set(err instanceof Error ? err.message : String(err));
      return;
    }
    const refused = await this.putOverlay(tabId, next);
    if (refused !== null) {
      this.notice.set(
        `That correction could not be written to disk, so it has been taken back: ${refused}`,
      );
      return;
    }
    this.record(tabId, label, [{
      member: this.overlayKey(tab),
      target: this.overlayKey(tab),
      field: 'chapters',
      before,
      after,
    }]);
    this.repaintCurations(tab);
    // The lines redraw from the file rather than from what this function was
    // asked for: `putOverlay` bumped the curation counter, the surface's effect
    // is watching it, and `ensureBookSpine` reads the disk again. Nothing here
    // paints optimistically, which is the one place the flowing book differs
    // from a strike — a spine is one statement about the whole book, and a wrong
    // guess at it is forty chapters in the wrong place rather than one paragraph.
  }

  /**
   * One `chapters` row of a book's undo history, put back.
   *
   * ── Why the book's replay needed a branch of its own ────────────────────────
   *
   * Every other row a book's ledger holds names an element of a chapter file and
   * is replayed through the setter that wrote it (`replayRow`). This one names
   * the overlay and is replayed through `setChapters`, which is exactly what the
   * scan's `replayOverlayRow` does — but the scan's replay runs off a block view
   * held in memory, and the book has none. So the file is read, the list is
   * folded in, and the write goes through the same `putOverlay` every other
   * correction uses.
   */
  private async replayBookSpine(tabId: string, text: string): Promise<string | null> {
    const tab = this.byId(tabId);
    if (!api || tab === null) return 'this document is no longer open.';
    let file: OverlayFile;
    try {
      file = (await api.overlay.load(tab.path)).file as OverlayFile;
      file = setChapters(file, chaptersOfText(text, 'this undo entry'));
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    const refused = await this.putOverlay(tabId, file);
    if (refused === null) this.repaintCurations(tab);
    return refused;
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
    if (!tab || !api) return null;
    /*
     * THE PAINT IS THE SCAN'S AND THE WRITE IS EVERYBODY'S, and separating the two
     * is what lets a gesture made on the cast BOOK reach the same file.
     *
     * This used to refuse outright unless a block view was open, because a
     * correction could only be made where the outlines were drawn. It is not true
     * any more: select mode on the flowing book now mirrors its strikes and
     * relabels into the same curation (see `mirrorToCuration`), and that tab has
     * no block view and never will — its pages are a chapter in an iframe, not
     * outlines this service draws. So the state update is conditional on there
     * being state to update, and the write is not.
     *
     * `tab.path` is the EPUB there rather than the scan, and main resolves both to
     * the one curation: `locateOverlay` answers with the project's overlay pair
     * and never opens the file it was named (electron/overlays.ts). One project,
     * one live curation, whichever of its documents is on screen.
     */
    const was = view?.overlay ?? null;
    if (view !== null && was !== null) this.setOverlay(tabId, file);
    try {
      await api.overlay.save(tab.path, file);
      // ONE PLACE, because this is the one write. What the project holds that no
      // save of it does has just changed, and the Apply changes button is drawn
      // from that answer — see `unkept`.
      this.curationWritten();
      return null;
    } catch (err) {
      if (view !== null && was !== null) this.setOverlay(tabId, was);
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
    /*
     * THE FIFTH DOOR MET ON THE WAY IN, and only by the world where it exists.
     * A word edit over the SOURCE book is a decision in the live curation now
     * (`mirrorWords`), so standing on a frozen save it would be the same
     * silent rewrite `cutBlocks` refuses — and refused BEFORE the chapter is
     * written, so the book and the curation cannot end up saying different
     * things. Over a TRANSLATION the mirror is a record row, which no save
     * freezes, and over a book in no project there is no mirror at all: both
     * of those keep typing exactly as they always did.
     */
    const opening = this.byId(id);
    if (opening !== null && opening.kind === 'epub' && opening.book !== null
      && this.projectDirOf(opening) !== null
      && await this.worldOf(opening) === null
      && this.refusedByASave(id)) {
      return;
    }
    let editedMember: string | null = null;
    const unlinked = await this.blockEdit(
      id,
      (bridge, book, member) => bridge.epub.setBlockHtml(book, member, blockId, html),
      (_notes, member) => {
        // The member the write actually landed in, held for the mirror below:
        // the dialogs between here and there can take long enough for the
        // reader to have scrolled another chapter under `chapterHref`.
        editedMember = member;
        return {
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
        };
      },
    );
    // Null is a refusal, and a refusal wrote nothing — there is no new text for
    // either question below to be about.
    if (unlinked === null) return;
    if (unlinked.length > 0 && await this.askAboutUnlinkedNotes(id, blockId, was, unlinked)) {
      // Cancelled: the block is back to the markup it had, so the heading (if
      // this was one) reads what it always read and there is nothing to offer
      // the contents — and nothing to mirror, because the mirror below records
      // what is IN the book, and what is in the book is what was always there.
      return;
    }
    await this.askAboutNavEcho(id, blockId, was);
    /*
     * AND THE WORDS, RECORDED AS A DECISION — LAST, like every mirror in this
     * file, because the only thing it can say is that the correction could not
     * be recorded, and that sentence must not be painted over by anything
     * reporting the success the user already watched land.
     */
    if (editedMember !== null) await this.mirrorWords(id, editedMember, blockId, html);
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
   * MAIN COMPOSES IT and the app's own card draws it (`ConfirmService`, since
   * the ruling that there are zero native alerts left in this program), and main
   * also answers it without asking at all when the user has said "don't ask
   * again": the standing answer is stored per ANSWER in app-settings.json, so
   * "always strike it" and "always leave it" stay two different instructions.
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
      /*
       * THE FIFTH DOOR, and it opened for the reason the fourth one did. Striking
       * a note is a decision in the live curation now (`mirrorNoteCut` below), so
       * standing on a save it would be the same silent rewrite of a frozen copy
       * that `heldByASave` refuses everywhere else — and refused BEFORE the
       * chapter is touched, so the book and the curation cannot end up saying
       * different things.
       *
       * The other two answers are untouched: leaving the note writes nothing at
       * all, and putting the reference number back is an undo of the edit that
       * prompted the question, which a save does not lock.
       */
      if (this.refusedByASave(id)) continue;
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
      /*
       * AND THE STRIKE, RECORDED AS A DECISION — the half that did not exist
       * until the note dimension did.
       *
       * `done === true` is main saying the mark actually moved; false is a note
       * that already carried it, which is not a decision this gesture made and
       * gets no row and no amendment. LAST, and after the paint, for the reason
       * every mirror in this file is last: the only thing it can say is that the
       * decision could not be recorded, and that sentence must not be written
       * over by anything reporting the success the user already saw.
       */
      if (done === true) {
        const current = this.byId(id);
        const href = current === null ? null : current.chapterHref;
        if (href !== null) await this.mirrorNoteCut(id, memberOf(href), note.noteId, 'true');
      }
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
    if (this.refusedByASave(id)) return;
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
    if (changed === null) return;
    if (blockIds.length >= 2) {
      this.notice.set(changed.length === 0
        ? `All ${blockIds.length} of those blocks were already ${kind} — nothing changed.`
        : `Relabelled ${changed.length} block${changed.length === 1 ? '' : 's'} as ${kind}.`);
    }
    /*
     * AND THE SAME RELABEL, RECORDED AS A DECISION. `changed` is what main said
     * moved, which is exactly the list a decision may be made about — the blocks
     * that were already this category were not relabelled by anybody.
     *
     * LAST, AFTER THE SENTENCE ABOVE, so that the one thing the mirror has to say
     * is not painted over half a millisecond later. It speaks only when it could
     * not record what the user has already watched happen, and that sentence
     * outranks "relabelled 30 blocks".
     *
     * ── AND IT FORKS, because two of these are not the same kind of statement ──
     *
     * Ten categories are the model's own answers and become amendments. The
     * eleventh — Chapter Openings — is a fact about the BOOK, and it goes into the
     * spine with the block's own words as its name (`mirrorChapterMarks`). Only
     * the blocks whose relabel actually crosses that line are handed over: main
     * answers with each block's previous label, so a paragraph that was never a
     * chapter and is not becoming one has nothing to say about where the book
     * divides and does not make this door read a file.
     */
    const marks = changed
      .filter((one) => category === CHAPTER_CATEGORY || one.was === CHAPTER_CATEGORY)
      .map((one) => ({ id: one.id, mark: category === CHAPTER_CATEGORY }));
    if (marks.length > 0) await this.mirrorChapterEdit(id, marks);
    const banked = this.bankCategory(category);
    if (banked === null) return;
    await this.mirrorBlockEdit(id, 'category', changed.map((one) => ({ id: one.id, value: banked })));
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
    if (this.refusedByASave(id)) return;
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
    if (changed.length !== 1 || blockIds.length !== 1) {
      const many = changed.length === 1 ? '' : 's';
      this.notice.set(changed.length === 0
        ? `Every one of those ${kind}blocks already ${cut ? 'was struck' : 'stood'} — nothing changed.`
        : cut
          ? `Struck ${changed.length} ${kind}block${many}. Press Delete on them to bring them back.`
          : `Brought back ${changed.length} ${kind}block${many}.`);
    }
    // The strike, recorded as a decision — main's list of what actually moved,
    // and LAST for the reason the relabel above is last: the only thing this can
    // say is that it could not record the strike the user just watched land, and
    // a success sentence written over it would be that failure going unread.
    await this.mirrorBlockEdit(id, 'strike', changed.map((target) => ({
      id: target,
      value: cut ? 'true' : '',
    })));
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

  // ── The book's gestures, written down as decisions ───────────────────────
  //
  // ── WHAT THE OLD BEHAVIOUR COST, WHICH WAS THE WHOLE FEATURE ──────────────
  //
  // Select mode on the cast book wrote `data-bf-cut` and `data-bf-cat` into a
  // chapter of the working tree and stopped there. The step ledger never heard
  // about it: no curation row, nothing to commit, nothing for the Steps panel to
  // show, and — because the flowing book is CAST FROM THE BANK — every strike a
  // person made was thrown away the next time the book was cast. Half of this
  // app's whole model, "every edit is a ledger entry", was true of the scan and
  // false of the document people actually read.
  //
  // It could not be fixed in the shell, and R1 stopped rather than guess: a
  // book's blocks are named `data-bf-id="p47-3"`, a counter over ELEMENTS THE
  // EMITTER WROTE, and a decision is named `page:order[:part]`, the model's own
  // answer. Only the emitter ever held both, and it wrote neither down. It writes
  // `data-bf-src` now (src/vlm/dots-book.ts, `stampSrc`) and this is what reads
  // it: a strike on the flowing page becomes an amendment against the same block
  // the scan's block editor would have amended, in the same file, which is what
  // makes Apply changes a button rather than a plan.
  //
  // TWO WRITES, ONE GESTURE, AND THE SECOND ONE NEVER SPEAKS FIRST. The chapter
  // write is what the user can see happening and it stays exactly as it was —
  // painted in the frame, written by main, reported by its own notice. The
  // curation write is a record of it, and a record is not an event: it mints no
  // ledger row (the book's own action is already recorded, and one gesture must
  // not become two Ctrl+Zs), and it says nothing at all when it cannot be made.

  /**
   * What one chapter of the working tree says about its own blocks — their
   * provenance, their note ordinals and their words.
   *
   * ── Why the file and not the frame's message ────────────────────────────────
   *
   * The reporter carries a `src` beside every id it posts, and that is the frame
   * saying what the user pointed at. It cannot be the source of truth here, for
   * one plain reason: AN UNDO SENDS NO MESSAGE. A Ctrl+Z replays rows that name
   * blocks by id and nothing else — the gesture that made them may have been
   * yesterday, in a window that no longer exists — and the mirror has to un-write
   * exactly what the gesture wrote or the curation drifts away from the book by
   * one strike at a time. The chapter file answers both, so both ask it.
   *
   * IT IS ALSO WHY THE TITLE OF A CHAPTER MARKER IS READ FROM HERE. A relabel to
   * Chapter Openings names the block with the block's own words, and undoing the
   * relabel that took such a marker away has to put those words back — with no
   * message to carry them and no room in a ledger row to hold them. The file has
   * them, and the file is already open.
   *
   * CACHED PER CHAPTER, because ids and provenance do not move while a book is
   * open: a cut writes an attribute, an edit writes words, and neither renames
   * anything. Held Delete on a page of footnotes is one read rather than one per
   * keystroke. Keyed by book AND member, so a chapter change or a re-cast (a new
   * unpack, a new book id) reads again rather than answering from a document that
   * is no longer on screen.
   *
   * A WORD EDIT DOES MOVE the text this holds, and that is the one staleness it
   * accepts: a marker made from a block whose words were corrected in the same
   * session is named with the words as this chapter was last read. The Chapters
   * section renames it, which is what it is for, and the next cast reads again.
   */
  private readonly chapterFacts = new Map<string, ChapterProvenance>();

  private async provenanceOf(bookId: string, member: string): Promise<ChapterProvenance> {
    const key = `${bookId}|${member}`;
    const held = this.chapterFacts.get(key);
    if (held !== undefined) return held;
    if (!api) return EMPTY_PROVENANCE;
    try {
      const found = provenanceIn(await api.epub.readMember(bookId, member));
      this.chapterFacts.set(key, found);
      return found;
    } catch {
      /*
       * SILENT, AND IT IS THE ONLY SWALLOWED FAILURE IN THIS PATH. What failed is
       * a second read of a file main has just successfully written, so the book
       * itself is fine and the gesture the user made has landed. Saying "the
       * provenance could not be read" over a strike that visibly worked would be
       * a sentence about this app's bookkeeping in the strip where refusals go.
       * Nothing is cached, so the next gesture asks again.
       */
      return EMPTY_PROVENANCE;
    }
  }

  /** Everything read off one book's chapters, dropped with the book. */
  private forgetSources(bookId: string): void {
    for (const key of [...this.chapterFacts.keys()]) {
      if (key.startsWith(`${bookId}|`)) this.chapterFacts.delete(key);
    }
    // And the reverse of the same read, which is derived from it and would
    // otherwise outlive the ids it is an index of.
    this.sourceIndexes.delete(bookId);
    /*
     * AND THE DETECTED SPINES, all of them, because a book going away is the
     * moment the detection could have changed underneath one. A re-read renumbers
     * every block on every page, and a seed remembered from before it would put a
     * person's first chapter marker into a list describing a book that no longer
     * exists. Throwing the lot costs one question of main the next time a marker
     * is made, and only for a project that has still never stated a spine.
     */
    this.detectedSpines.clear();
  }

  /**
   * The same mirror, for a gesture made in the chapter that is on screen.
   *
   * The member is the open chapter's, exactly as `blockEdit` resolves it, so the
   * two halves of one gesture are certainly about one file. The undo path calls
   * `mirrorToCuration` directly instead, because a row names the member it was
   * recorded against and that need not be the chapter in front of anybody now.
   */
  private async mirrorBlockEdit(
    tabId: string,
    field: OverlayField,
    moves: readonly { id: string; value: string }[],
  ): Promise<void> {
    const tab = this.byId(tabId);
    if (tab === null || tab.chapterHref === null) return;
    await this.mirrorToCuration(tabId, memberOf(tab.chapterHref), field, moves);
  }

  /** The spine's half of the same lockstep, for the chapter that is on screen. */
  private async mirrorChapterEdit(
    tabId: string,
    marks: readonly { id: string; mark: boolean }[],
  ): Promise<void> {
    const tab = this.byId(tabId);
    if (tab === null || tab.chapterHref === null) return;
    await this.mirrorChapterMarks(tabId, memberOf(tab.chapterHref), marks);
  }

  /**
   * A FOOTNOTE STRUCK BY THE DIALOG, recorded as a decision about that one note.
   *
   * ── Why this needs a door of its own ────────────────────────────────────────
   *
   * Every other strike in the book arrives naming a `data-bf-id`, because that is
   * what select mode addresses. This one does not and cannot: the gesture is the
   * answer to "you deleted this footnote's last reference — should the footnote
   * go too?", and the only name in hand at that moment is the note's OWN id
   * (`fn25`), read out of the `href` the edit removed. Main's setter is addressed
   * the same way, and so is the undo row it writes, so the mirror has to be able
   * to start from that name too.
   *
   * The chapter file answers it. The emitter writes `id="fn25"` and
   * `data-bf-note` on the same start tag, so one scan of the member gives both
   * indexes and this is the second of them — the note dialog's name resolved to
   * the note dimension's target, and from there it is an ordinary strike through
   * the ordinary door.
   *
   * A BOOK CAST BEFORE PROVENANCE IS SKIPPED IN SILENCE, exactly as
   * `mirrorToCuration` skips one: the note is struck in the working copy, the
   * user watched it happen, there is no block in the bank this app can honestly
   * name, and the next cast repairs it.
   */
  private async mirrorNoteCut(
    tabId: string,
    member: string,
    noteId: string,
    value: string,
  ): Promise<void> {
    const tab = this.byId(tabId);
    if (!api || tab === null || tab.kind !== 'epub' || tab.book === null) return;
    if (this.projectDirOf(tab) === null) return;
    const sources = await this.provenanceOf(tab.book.id, member);
    const found = sources.byNote.get(noteId);
    if (found === undefined || found.note === null) return;
    const at = parseSourceKeys(found.src)[0];
    if (at === undefined) return;
    await this.amendCuration(tabId, 'strike', [{ at: { ...at, note: found.note }, value }]);
  }

  /**
   * "THE BOOK DIVIDES HERE" — a relabel to Chapter Openings, written into the
   * spine instead of into a category.
   *
   * ── The fork, and why the gesture had nowhere to go before it ───────────────
   *
   * Ten of the eleven categories a block can be relabelled to are the model's own
   * answers, and a relabel to one of them is an amendment: the bank says Text,
   * the person says Footnote, and `bankCategory` translates the book's spelling
   * into the bank's. The eleventh is foundry's. `chapter` is not something a
   * block IS — dots has no such answer — it is a statement about the BOOK, and
   * the overlay holds it in a list of its own with a title beside each entry
   * (`CurationContent.chapters`). So the relabel had no amendment to write and
   * wrote nothing: the working tree divided where the user said, and the next
   * cast put the chapter back where the detection wanted it.
   *
   * THE TITLE WAS NEVER MISSING. It is the block. A heading relabelled "chapter
   * opening" is a heading, and its own words are what the contents should call
   * the section it opens — which is exactly what the scan's own
   * "Chapter starts here" seeds a marker with, and exactly what the detection
   * proposes. Machine proposes, user owns: the Chapters section renames it
   * afterwards when the printed heading is not the name.
   *
   * AND RELABELLING IT AWAY TAKES THE MARKER OUT, which is why this door handles
   * both directions rather than only the interesting one. A person who marked a
   * paragraph by mistake corrects it by relabelling it back, and a spine that
   * kept the entry would divide the book at a paragraph nothing on screen calls a
   * chapter.
   *
   * ── What an undo of a removal puts back ─────────────────────────────────────
   *
   * The block's words, not the name the marker carried. A ledger row for a
   * relabel holds two category names and has no room for a title, and there is no
   * second row to add — one gesture must not become two Ctrl+Zs. So an undo
   * re-proposes what the gesture itself proposed, which is right for every marker
   * nobody renamed and loses a rename in the one sequence that can produce it:
   * mark it here, rename it in the scan's Chapters section, unmark it here, undo.
   * The row is renameable again the moment it is back.
   */
  private async mirrorChapterMarks(
    tabId: string,
    member: string,
    marks: readonly { id: string; mark: boolean }[],
  ): Promise<void> {
    const tab = this.byId(tabId);
    if (!api || tab === null || tab.kind !== 'epub' || tab.book === null) return;
    if (this.projectDirOf(tab) === null || marks.length === 0) return;

    const sources = await this.provenanceOf(tab.book.id, member);
    if (sources.byBlock.size === 0) return;

    let file: OverlayFile;
    try {
      file = (await api.overlay.load(tab.path)).file as OverlayFile;
    } catch (err) {
      this.notice.set(
        `That change is in your book, but where it divides could not be recorded: ${
          err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    const seeded = await this.spineOf(tab, file);
    if (seeded === null) return;
    const chapters = [...seeded];
    let touched = 0;
    for (const one of marks) {
      const found = sources.byBlock.get(one.id);
      if (found === undefined) continue;
      /*
       * THE FIRST SOURCE PART, and for a heading it is the only one. A block is
       * joined out of several banked answers only when a paragraph broke over a
       * page turn, and where such a paragraph is marked as a chapter opening the
       * book divides in front of the words that OPENED it — the second half of a
       * paragraph is not a place a chapter starts.
       */
      const at = parseSourceKeys(found.src)[0];
      if (at === undefined) continue;
      const already = chapters.findIndex((row) => atSameBlock(row.at, at));
      if (one.mark) {
        if (already >= 0) continue;
        // Capped like the scan's own seeding gesture: a contents entry is a line
        // somebody reads in a list, and a paragraph relabelled by mistake must
        // not put four hundred words in the navigation.
        const title = found.text.slice(0, 120);
        chapters.push({ at, title: title.length > 0 ? title : `Chapter at ${targetKey(at)}` });
      } else {
        if (already < 0) continue;
        chapters.splice(already, 1);
      }
      touched += 1;
    }
    if (touched === 0) return;

    let next: OverlayFile;
    try {
      next = setChapters(file, chapters);
    } catch (err) {
      this.notice.set(err instanceof Error ? err.message : String(err));
      return;
    }
    const refused = await this.putOverlay(tabId, next);
    if (refused !== null) {
      this.notice.set(
        `That change is in your book, but where it divides could not be recorded: ${refused}`,
      );
      return;
    }
    this.repaintCurations(tab);
  }

  /**
   * The spine this project holds, seeded from the detection when nobody has
   * touched it — the book's side of `chaptersFor`.
   *
   * ── Why the seed cannot be skipped ──────────────────────────────────────────
   *
   * An overlay with no `chapters` field means "the engine works the chapters
   * out", which is the state every scan arrives in and where most books stay.
   * Writing one marker into that state would not ADD a chapter — it would state
   * the whole spine, superseding the detection entirely, and a book that divided
   * in forty places would come back divided in one. The scan's Chapters section
   * has always avoided that by seeding the list with the detection's own answer
   * before the first edit (`chaptersFor`), and this is the same rule for the same
   * file from the other pane: one behaviour, two surfaces.
   *
   * IT COSTS ONE QUESTION OF MAIN, ONCE. The detection is the engine's, so the
   * answer comes from `overlay:blocks` — the same door the block editor opens
   * when a scan's outlines are drawn. It is asked only while the field is absent,
   * which is at most once per project: the first marker writes the list, and from
   * then on the file answers.
   *
   * A REFUSAL IS SAID OUT LOUD AND NOTHING IS WRITTEN. This is the one place in
   * the mirror where silence would be destructive rather than merely quiet — a
   * spine written without its seed is forty chapters deleted — so a project whose
   * detection cannot be read keeps its chapters and the user is told the marker
   * did not land.
   */
  private async spineOf(tab: Tab, file: OverlayFile): Promise<readonly OverlayChapter[] | null> {
    if (file.chapters !== undefined) return file.chapters;
    const dir = this.projectDirOf(tab);
    if (!api || dir === null) return null;
    const key = fold(dir);
    const held = this.detectedSpines.get(key);
    if (held !== undefined) return held;
    const answer = await api.overlay.blocks(tab.path).catch(
      (err: unknown) => ({ ok: false as const, reason: err instanceof Error ? err.message : String(err) }),
    );
    if (!answer.ok) {
      // NAMED, because this one is destructive to guess at. Nothing has been
      // written: the marker is in the book and not in the curation, and the
      // sentence says why rather than leaving a gesture that quietly half
      // happened.
      this.notice.set(
        'That change is in your book, but where it divides could not be recorded: nothing here yet '
        + `knows the chapters this book already has, and stating one on its own would throw the rest `
        + `of them away. ${answer.reason}`,
      );
      return null;
    }
    const seeded = seedChapters(answer.chapters);
    this.detectedSpines.set(key, seeded);
    return seeded;
  }

  /**
   * The engine's own chapter detection, per project — asked at most once, and
   * only while nobody has stated a spine.
   *
   * Not dropped with a tab: it is a fact about a bank, it does not change while
   * the bank does not, and the one gesture that reads it stops needing it the
   * moment it succeeds.
   */
  private readonly detectedSpines = new Map<string, readonly OverlayChapter[]>();

  /**
   * Standing on a save, a gesture on the CAST BOOK is refused too — the same
   * answer, at a fourth door.
   *
   * ── Why this door had to open ───────────────────────────────────────────────
   *
   * `heldByASave` guards the three ways a scan's curation is changed and its
   * comment says why: the pages are showing a frozen copy while the write would
   * go into the live one, so the correction would be made to a book nobody is
   * looking at. Select mode on the flowing book used to be none of its business —
   * it wrote `data-bf-cat` into somebody's chapter and had "no more to do with a
   * frozen curation than a translation does", which is what the inspector's lock
   * still says of the panel it draws.
   *
   * That stopped being true one function above this one. A strike on the flowing
   * page is now ALSO a decision in the live curation, so standing on a save it
   * would be the same silent rewrite the other three doors exist to refuse. And
   * it is refused BEFORE the chapter is written rather than after: a gesture that
   * struck the paragraph and then declined to record it would leave the book and
   * the curation saying different things, which is the exact drift this whole
   * unit closes.
   *
   * THE SENTENCE IS THE LOCK'S OWN, in the strip where every refusal in this mode
   * lands. It names the way back — step off the save — because a mode that went
   * quiet under a Delete key is indistinguishable from a broken one.
   */
  private refusedByASave(tabId: string): boolean {
    const tab = this.byId(tabId);
    if (tab === null || tab.kind !== 'epub') return false;
    const held = this.heldByASave(tabId);
    if (held === null) return false;
    this.notice.set(held);
    return true;
  }

  /**
   * The one door a book's cut or relabel goes through on its way into the
   * curation — the gesture's, and the undo's.
   *
   * `moves` are the blocks MAIN SAID MOVED, by `data-bf-id`, with the value each
   * one now carries. Never what the frame asked for: a block already struck was
   * not changed by this gesture, and mirroring it would write a decision nobody
   * made.
   *
   * ── A book cast before provenance existed is skipped, in silence ────────────
   *
   * No `data-bf-src` means the emitter that wrote this chapter predates the
   * attribute — or that the book is not one foundry cast at all, which is a thing
   * this app is happy to open and edit. There is nothing to say about it: the
   * user's gesture landed in their book, the decision cannot be recorded against
   * a block because nothing in the file names one, and the next cast repairs it
   * without anybody being told. A notice here would be a sentence about the
   * app's own history appearing on a keystroke, once per block, on a book that is
   * working exactly as the user sees it working.
   */
  private async mirrorToCuration(
    tabId: string,
    member: string,
    field: OverlayField,
    moves: readonly { id: string; value: string }[],
  ): Promise<void> {
    const tab = this.byId(tabId);
    if (!api || tab === null || tab.kind !== 'epub' || tab.book === null) return;
    // No project, no bank, no curation — a book somebody opened from their own
    // disk. Its select mode still edits it; there is simply nothing to record
    // against, and main would refuse the load by name.
    if (this.projectDirOf(tab) === null) return;
    if (moves.length === 0) return;

    const sources = await this.provenanceOf(tab.book.id, member);
    if (sources.byBlock.size === 0) return;

    const edits: { at: OverlayTarget; value: string }[] = [];
    for (const move of moves) {
      const found = sources.byBlock.get(move.id);
      if (found === undefined) continue;
      /*
       * A STRUCK ASIDE IS ONE NOTE STRUCK, NOT ITS WHOLE BLOCK — the note
       * dimension's first job, and the correction of a wrong the previous unit
       * shipped knowingly.
       *
       * A page that printed five notes under one rule is ONE banked Footnote
       * answer, so pressing Delete on the third `<aside>` used to write
       * `strike: true` against the block all five came out of: one gesture, four
       * notes nobody decided anything about gone from every future cast, and
       * nothing on screen to say so. The emitter names the note now
       * (`data-bf-note`) and the overlay can hold it (`OverlayTarget.note`), so
       * the decision is written where the user pointed.
       *
       * ONLY THE STRIKE FORKS. A relabel of an aside — say, a run of endnotes
       * the model called footnotes and a person calls body text — stays a
       * statement about the whole banked answer, because that is what a category
       * IS: the five notes are five pieces of one thing the model read, and there
       * is no per-note category for the bank to hold. The overlay refuses one by
       * name (`refuseUnlessBlock`), which is the same rule said in the file.
       *
       * THE FIRST SOURCE AND NOT ALL OF THEM. A Footnote block is never joined
       * across a page turn — only prose is — so an aside's `src` names exactly
       * one answer and the loop below would run once anyway. Taking the first is
       * what makes that explicit instead of accidental: an ordinal that belongs
       * to one block cannot be spread over two.
       */
      if (field === 'strike' && found.note !== null) {
        const at = parseSourceKeys(found.src)[0];
        if (at !== undefined) edits.push({ at: { ...at, note: found.note }, value: move.value });
        continue;
      }
      for (const at of parseSourceKeys(found.src)) edits.push({ at, value: move.value });
    }
    await this.amendCuration(tabId, field, edits);
  }

  /**
   * The write itself: read the curation fresh, fold every edit into it, write it
   * once.
   *
   * ── Read fresh, always ──────────────────────────────────────────────────────
   *
   * Unlike the provenance read, nothing here can be retried by the next
   * keystroke — a read that failed is a decision that is lost — so this failure
   * is said out loud. And it is READ rather than held: the scan's block editor
   * keeps the curation in memory and writes it whole, so if this side wrote from
   * a copy of its own, two panes of one project would take turns erasing each
   * other's corrections.
   */
  private async amendCuration(
    tabId: string,
    field: OverlayField,
    edits: readonly { at: OverlayTarget; value: string }[],
  ): Promise<'written' | 'noop' | 'refused'> {
    const tab = this.byId(tabId);
    if (!api || tab === null || edits.length === 0) return 'noop';
    let file: OverlayFile;
    try {
      file = (await api.overlay.load(tab.path)).file as OverlayFile;
    } catch (err) {
      this.notice.set(
        `That change is in your book, but it could not be recorded as a decision: ${
          err instanceof Error ? err.message : String(err)}`,
      );
      return 'refused';
    }
    /*
     * READ BACK OFF THE FILE AFTER EVERY AMENDMENT, and it is not a formality:
     * TWO ELEMENTS OF ONE BLOCK SHARE A SOURCE. A list is a `<ul>` and its
     * `<li>`, a quote is a `<blockquote>` and its `<p>` — two ids, two moves in
     * this batch, one banked answer behind both — so the second move arrives at a
     * decision the first one has already made. Asked of a map made before the
     * loop, it would read the state as it was, count a change that is not one and
     * write the same value twice.
     */
    let decisions = decisionsOf(file);

    let touched = 0;
    for (const edit of edits) {
      // Already saying this: not a change, and not a write. The same rule
      // `amendBlocks` follows over a scan. A block target reads through
      // `decisionFor`, which puts the part-specific amendment over the
      // element-wide one; a note target has no such pair — an amendment about
      // note 3 is the only thing that can be about note 3 — so it is asked of its
      // own key and nothing else.
      const stated = edit.at.note === undefined
        ? fieldValue(decisionFor(decisions, edit.at.page, edit.at.order, edit.at.part ?? 0), field)
        : fieldValue(decisions.get(targetKey(edit.at)), field);
      if (stated === edit.value) continue;
      file = amendOverlay(file, edit.at, field, edit.value);
      decisions = decisionsOf(file);
      touched += 1;
    }
    if (touched === 0) return 'noop';

    const refused = await this.putOverlay(tabId, file);
    if (refused !== null) {
      this.notice.set(
        `That change is in your book, but it could not be recorded as a decision: ${refused}`,
      );
      return 'refused';
    }
    this.repaintCurations(tab);
    return 'written';
  }

  /**
   * The scan panes of this project read the curation again — because this write
   * came from somewhere else.
   *
   * ── The clobber this exists to prevent ──────────────────────────────────────
   *
   * A block view holds the whole curation in memory and writes it WHOLE on every
   * gesture, which is right while it is the only thing writing: the file is a few
   * kilobytes, a person makes a few gestures a minute, and there is no
   * read-modify-write to serialise. It stops being right the moment a second
   * surface writes the same file. Strike a footnote in the cast book with the
   * scan open in the next column, and that column is now holding a copy of the
   * curation from before the strike — the next thing struck over there would be
   * written from it, and the book's decision would be erased by a gesture nobody
   * connected to it.
   *
   * `refreshCuration` is the machinery that already exists for "the curation
   * moved and the outlines have not" — it re-reads the pair and nothing else, a
   * few kilobytes off a disk, which is why the position move is allowed to use
   * it on every click. Same call, one more reason to make it.
   */
  private repaintCurations(source: Tab): void {
    const dir = this.projectDirOf(source);
    if (dir === null) return;
    for (const tab of this.all()) {
      if (tab.kind !== 'pdf' || !tab.blockView || tab.id === source.id) continue;
      const mine = this.projectDirOf(tab);
      if (mine === null || fold(mine) !== fold(dir)) continue;
      void this.refreshCuration(tab.id, tab.path);
    }
  }

  /**
   * The overlay categories, under the names a CAST BOOK's blocks carry.
   *
   * Two vocabularies for one idea, and shared/categories.ts says why: a book's
   * blocks are `data-bf-cat="footnote"` because that is what the emitter writes,
   * and a decision is `Footnote` because that is what the model answered and the
   * bank is never edited. The table is derived from the one list rather than
   * written out, so the two cannot drift.
   *
   * `chapter` IS NOT IN IT, and the null it answers is the FORK rather than a
   * dead end. "The book divides here" is not a category on a scan at all — it is
   * the overlay's `chapters` list, which carries a title for the contents — so a
   * relabel into or out of Chapter Openings goes to `mirrorChapterMarks` instead
   * of becoming an amendment, with the block's own words as the name. This
   * function's job is only to say which of the two a category is.
   */
  private bankCategory(id: string): string | null {
    return BANK_CATEGORY_OF[id] ?? null;
  }

  /**
   * Which world a word edit on this tab's book lands in, asked of main once and
   * held.
   *
   * NULL is the source world — the project's flowing book, a save's cast — where
   * a word edit mirrors to the overlay's `text` field. A `TranslationWorld` is a
   * translate step's own book, where the same edit is a per-language correction
   * in that step's records file. `'unknown'` is a resolve that failed, and it is
   * a THIRD answer rather than a default, because the two defaults are both
   * wrong in a way that writes: treating a translation as the source would
   * record its Hungarian words as a correction to the German bank, and treating
   * the source as a translation would look for records it does not have. An
   * unknown world edits the book and records nothing, which is exactly what
   * every word edit did before this unit.
   *
   * CACHEABLE BECAUSE THE ANSWER CANNOT MOVE under a tab: a re-cast is refused
   * while the book is open, and a re-translation mints a new step and a new
   * filename. Dropped with the tab's ledger on close.
   */
  private readonly translationWorlds = new Map<string, TranslationWorld | null | 'unknown'>();

  private async worldOf(tab: Tab): Promise<TranslationWorld | null | 'unknown'> {
    const dir = this.projectDirOf(tab);
    if (!api || dir === null) return null;
    const key = `${tab.id}|${fold(tab.path)}`;
    const held = this.translationWorlds.get(key);
    if (held !== undefined) return held;
    try {
      const world = await api.translation.ofDocument(dir, tab.path);
      this.translationWorlds.set(key, world);
      return world;
    } catch {
      // Not cached: the next gesture asks again, and a project whose catalogue
      // was briefly unreadable is not condemned to a session of unrecorded
      // edits.
      return 'unknown';
    }
  }

  /**
   * THE WORD EDIT, RECORDED — the two text ops of the derived book, routed by
   * world.
   *
   * ── Source world: the overlay's `text` field ────────────────────────────────
   *
   * The correction becomes an amendment against the banked answer the words
   * came from, in the same live curation every strike and relabel lands in — so
   * it survives the working tree, rides every future cast, and RE-KEYS the
   * block's translations: the masked source changed, so the question changed,
   * and a chained re-run re-asks exactly that block (the closure of D2's named
   * cost (1)). The value is the flowing dialect, recovered from the edited
   * markup by `unrenderBlock`.
   *
   * Two recorded limits, each refused with a sentence rather than widened:
   *
   *  - A MULTI-PART PARAGRAPH — one joined across a page seam, `data-bf-src`
   *    naming several banked answers — cannot carry one correction, because an
   *    amendment names exactly one block and nothing can honestly say where the
   *    edited words divide between the two halves.
   *  - A FOOTNOTE's words are facts about the whole banked answer its notes
   *    were cut from (`refuseUnlessBlock`'s rule), so one aside's edit has no
   *    amendment to become.
   *
   * ── Translated world: a human row in the step's records file ───────────────
   *
   * `{parts, text, author: "user"}`, keyless, appended by main — per-language
   * by construction, newest row wins at the next cast, kept standing by the
   * engine's own refusal while the source it answers is unchanged. Both limits
   * above DISSOLVE here, deliberately: a record's `parts` is the element's
   * whole space-joined provenance, and a note's record carries the `#ordinal`
   * dimension, so a joined paragraph and a single footnote are both exactly one
   * row.
   *
   * A LEGACY TRANSLATION IS REFUSED WITH THE WAY OUT — D2's export sentence,
   * met at the third door.
   */
  private async mirrorWords(
    tabId: string,
    member: string,
    blockId: string,
    html: string,
  ): Promise<void> {
    const tab = this.byId(tabId);
    if (!api || tab === null || tab.kind !== 'epub' || tab.book === null) return;
    const dir = this.projectDirOf(tab);
    if (dir === null) return;
    const world = await this.worldOf(tab);
    if (world === 'unknown') return;
    const sources = await this.provenanceOf(tab.book.id, member);
    const found = sources.byBlock.get(blockId);
    // A book cast before provenance existed: the same silence, for the same
    // reason, as `mirrorToCuration`.
    if (found === undefined) return;

    let text: string;
    try {
      text = unrenderBlock(html);
    } catch (err) {
      this.notice.set(
        `That edit is in your book, but it could not be recorded as a decision: ${
          err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    if (text.trim().length === 0) return;

    if (world !== null) {
      if (world.legacy) {
        this.notice.set(
          'That edit is in this copy of the book, but this translation was made before Foundry '
          + 'kept translations as records, so a corrected sentence has nowhere durable to go — it '
          + 'will not survive this book being cast again. To make corrections that keep, translate '
          + 'again from the step this translation was made from; everything after that is free.',
        );
        return;
      }
      const parts = found.note !== null ? `${found.src}#${found.note}` : found.src;
      try {
        await api.translation.recordEdit(dir, tab.path, parts, text);
      } catch (err) {
        this.notice.set(
          `That edit is in your book, but the translation could not record it: ${
            err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }

    if (found.note !== null) {
      this.notice.set(
        'That edit is in your book, but it could not be recorded as a decision: these are the '
        + 'words of one footnote, and a recorded correction speaks for the whole run of notes it '
        + 'was cut from. The edit stays in this copy of the book and will not survive it being '
        + 'cast again.',
      );
      return;
    }
    const targets = parseSourceKeys(found.src);
    if (targets.length === 0) return;
    if (targets.length > 1) {
      // The recorded limit, stated rather than silently widened: an amendment
      // names one block, and this paragraph is several.
      this.notice.set(
        'That edit is in your book, but it could not be recorded as a decision: this paragraph '
        + `was joined across a page seam out of ${targets.length} blocks `
        + `(${targets.map((one) => targetKey(one)).join(', ')}), and a recorded correction names `
        + 'exactly one. The edit stays in this copy of the book and will not survive it being cast '
        + 'again.',
      );
      return;
    }
    await this.amendCuration(tabId, 'text', [{ at: targets[0]!, value: text }]);
  }

  /**
   * "JOIN THIS PARAGRAPH TO THE ONE BEFORE IT" — the manual join, the flagship
   * recovered half: promised the day the ink test died, built here.
   *
   * The gesture arrives naming the CONTINUATION element — the paragraph that
   * opens the page after the seam — and leaves as one `join` amendment against
   * that element's first banked answer, which is the block whose belonging was
   * in question. The reflow consumes it at the next cast and the two paragraphs
   * become one, provenance intact (`flowBlocks`, src/vlm/dots-book.ts); until
   * then the seam draws a marker so the decision is visible where it was made.
   *
   * IT WRITES NO BOOK, and its ledger row says so (`LedgerField`, `join`): the
   * row exists so one Ctrl+Z takes the decision back, and its replay re-amends
   * the overlay through the same resolution this makes. `join === false` is the
   * taking-back gesture and REMOVES the field — absence is the default, as it
   * is for every decision — never `join: false`.
   */
  async joinBlocks(tabId: string, blockId: string, member: string, join: boolean): Promise<void> {
    if (this.refusedByASave(tabId)) return;
    const tab = this.byId(tabId);
    if (!api || tab === null || tab.kind !== 'epub' || tab.book === null) return;
    if (this.projectDirOf(tab) === null) return;
    const sources = await this.provenanceOf(tab.book.id, member);
    const found = sources.byBlock.get(blockId);
    if (found === undefined || found.note !== null) return;
    const at = parseSourceKeys(found.src)[0];
    if (at === undefined) return;
    const outcome = await this.amendCuration(tabId, 'join', [{ at, value: join ? 'true' : '' }]);
    if (outcome !== 'written') return;
    // Recorded AFTER the write, because the row's only job is to reverse a
    // decision that actually landed — the ordinary rule, with the ordinary
    // spelling: '1' and '' are the two sides, as they are for a cut.
    this.record(
      tabId,
      join ? 'joined the paragraph to the one before it' : 'took back a paragraph join',
      [{
        member,
        target: blockId,
        field: 'join',
        before: join ? '' : '1',
        after: join ? '1' : '',
      }],
    );
  }

  /** One join row put back — the replay's half of `joinBlocks`, same resolution. */
  private async replayJoin(tabId: string, row: LedgerRow, value: string): Promise<boolean> {
    const tab = this.byId(tabId);
    if (!api || tab === null || tab.kind !== 'epub' || tab.book === null) return false;
    // No project, or no provenance: the decision cannot be resolved to a block,
    // and pretending the replay succeeded would pop an action that reversed
    // nothing.
    if (this.projectDirOf(tab) === null) return false;
    const sources = await this.provenanceOf(tab.book.id, row.member);
    const found = sources.byBlock.get(row.target);
    if (found === undefined || found.note !== null) return false;
    const at = parseSourceKeys(found.src)[0];
    if (at === undefined) return false;
    const outcome = await this.amendCuration(tabId, 'join', [{
      at,
      value: value === '1' ? 'true' : '',
    }]);
    // A no-op is a success here: the decision already says this — another pane
    // wrote it, or the row is being replayed over its own landing.
    return outcome !== 'refused';
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
     * THE BOOK HAS NO STACK YET, and saying so is the rule this whole function
     * obeys: a chord that quietly did nothing is indistinguishable from a chord
     * that is broken. Its ops and their in-memory stack are the next wave's
     * (docs/RENDERER.md §9, R3) — until they exist there is nothing on that
     * surface for an undo to take back.
     */
    if (tab.kind === 'book') {
      this.notice.set(`There is nothing to undo in ${tab.title}: the book is read-only on this surface for now.`);
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
    /*
     * THE FOURTH DOOR, ON THE WAY BACK. A cut or a relabel in a cast book is a
     * decision in the project's live curation now (`mirrorToCuration`), so taking
     * one back while standing on a frozen save would change that curation under
     * pages showing the snapshot — the very thing the scan's own replay refuses a
     * few lines above. Only an action that CARRIES one of those rows is refused:
     * a word edit and a renamed heading are the book's markup and nothing else's,
     * and freezing a curation was never a reason to stop typing.
     *
     * `note-cut` JOINED THEM when the overlay learned to name one note of a
     * block. It was the third field this list could safely leave out, because
     * nothing mirrored it in either direction; it is a decision in the same file
     * now, so taking it back meets the same door.
     */
    /*
     * `chapters` JOINED THEM when the flowing book grew lines you can hold. A
     * marker dragged, renamed, added or removed is a write of the live
     * curation's spine and nothing else — no member of the book moves at all —
     * so taking one back while a frozen save is on screen would change where the
     * book divides underneath pages showing somebody else's divisions.
     */
    if (action.rows.some((row) =>
      row.field === 'cut' || row.field === 'category' || row.field === 'note-cut'
      || row.field === 'chapters' || row.field === 'join')) {
      const heldBook = this.heldByASave(tab.id);
      if (heldBook !== null) {
        this.notice.set(heldBook);
        return;
      }
    }
    /*
     * A WORD EDIT JOINED THEM CONDITIONALLY, because it stopped being "the
     * book's markup and nothing else's" the day it started mirroring to the
     * overlay's text field. Over the SOURCE book, taking an edit back
     * un-records that correction in the live curation — the same silent
     * rewrite the door above refuses — so it meets the same door. Over a
     * TRANSLATION it does not: the mirror there is a record row, records are
     * not what a save freezes, and a person may correct the Hungarian while
     * standing wherever they like.
     */
    if (action.rows.some((row) => row.field === 'html')
      && this.projectDirOf(tab) !== null
      && (await this.worldOf(tab)) === null) {
      const heldBook = this.heldByASave(tab.id);
      if (heldBook !== null) {
        this.notice.set(heldBook);
        return;
      }
    }
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
    /** The decisions this replay owes the curation, by field. See the loop. */
    const mirrored = new Map<OverlayField, { id: string; member: string; value: string }[]>();
    /** The struck footnotes it owes, which are named by the note's own id. */
    const noteCuts: { noteId: string; member: string; value: string }[] = [];
    /** And the spine entries, which are not amendments at all. */
    const chapterMarks: { id: string; member: string; mark: boolean }[] = [];
    /**
     * The word edits it owes — each one un-rendered and re-mirrored after the
     * loop, exactly as the gesture mirrored it, so a Ctrl+Z that puts a
     * sentence back also puts the recorded correction back to what it was.
     */
    const wordEdits: { member: string; target: string; html: string }[] = [];
    // A contents entry put back is a row in the sidebar, which is drawn from
    // `book.chapters` and not from the file — so undoing the write without this
    // would leave the panel showing a label the navigation document no longer
    // carries. It is the same line the rename itself runs.
    const renamed = new Map<string, string>();
    let reload = false;

    for (let at = action.rows.length - 1; at >= 0; at -= 1) {
      const row = action.rows[at]!;
      const value = direction === 'undo' ? row.before : row.after;
      /*
       * THE SPINE IS NOT A CALL INTO THE BOOK, so it goes round `replayRow`
       * rather than through it. Every other row here names an element of a
       * chapter file and is put back by the setter that wrote it; this one names
       * the overlay, carries the whole list on each side, and is put back by
       * `setChapters` — which is precisely what the scan's replay does with the
       * identical row from the other projection. No member changed, so nothing
       * is reloaded and no `memberChanged` is owed; the lines redraw because the
       * write bumps the curation counter the surface is watching.
       */
      if (row.field === 'chapters') {
        const stopped = await this.replayBookSpine(tab.id, value);
        if (stopped !== null) {
          this.notice.set(
            `${direction === 'undo' ? 'Undo' : 'Redo'} stopped at where this book divides: ${stopped}`,
          );
          return;
        }
        continue;
      }
      /*
       * A JOIN IS NOT A CALL INTO THE BOOK EITHER — the chapters' reasoning,
       * one decision over. The row names the continuation element and the
       * chapter it is in; putting the decision back means resolving that name
       * to its banked answer through the same provenance read the gesture
       * made, and re-amending the overlay with the other value. Nothing in the
       * working tree moves, so nothing reloads; the seam's marker redraws
       * because the write bumps the curation counter the surface watches.
       */
      if (row.field === 'join') {
        const put = await this.replayJoin(tab.id, row, value);
        if (!put) {
          this.notice.set(
            `${direction === 'undo' ? 'Undo' : 'Redo'} stopped at a paragraph join: the decision `
            + 'could not be rewritten.',
          );
          return;
        }
        continue;
      }
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
      /*
       * AND THE CURATION FOLLOWS THE BOOK BACK. The row landed — the setter above
       * is the same one the gesture used — so the decision it recorded has to be
       * un-recorded, or a Ctrl+Z would take the strike out of the book and leave
       * it in the ledger for the next Apply changes to freeze. Gathered PER
       * MEMBER, because an action's rows may name a chapter that is not the one
       * on screen, and written after the loop so forty rows are one read of each
       * chapter and one write of the curation.
       *
       * `note-cut` IS IN HERE NOW, and its absence used to be honest rather than
       * an oversight: it names a footnote by its own id, and a curation had no
       * word for one note of a Footnote answer, so there was nothing to take
       * back. The overlay has the word (`OverlayTarget.note`), the emitter writes
       * the name (`data-bf-note`), and the row's target resolves through the
       * chapter file exactly as the gesture's did — so an undo of a struck
       * footnote un-strikes the decision too.
       *
       * `chapters` is the fourth bucket and the odd one, because a relabel to or
       * from Chapter Openings is not an amendment at all: it is an entry in the
       * spine, and putting it back means the block's own words again. See
       * `mirrorChapterMarks` for what that costs a marker somebody renamed.
       */
      if (row.field === 'cut') {
        bucket(mirrored, 'strike').push({ id: row.target, member: row.member, value: value === '1' ? 'true' : '' });
      } else if (row.field === 'note-cut') {
        noteCuts.push({ noteId: row.target, member: row.member, value: value === '1' ? 'true' : '' });
      } else if (row.field === 'category') {
        const banked = this.bankCategory(value);
        if (banked !== null) {
          bucket(mirrored, 'category').push({ id: row.target, member: row.member, value: banked });
        }
        // The row's other side: undoing a relabel INTO Chapter Openings has to
        // take the marker out, and undoing one OUT of it has to put one back, so
        // both directions are read off the pair rather than off the value alone.
        const other = direction === 'undo' ? row.after : row.before;
        if (value === CHAPTER_CATEGORY || other === CHAPTER_CATEGORY) {
          chapterMarks.push({ id: row.target, member: row.member, mark: value === CHAPTER_CATEGORY });
        }
      }
      if (row.field === 'cut' || row.field === 'note-cut') bucket(cutIds, value === '1').push(row.target);
      else if (row.field === 'category') bucket(labelled, value).push(row.target);
      else if (row.field === 'nav-label') renamed.set(row.target, value);
      // `html` and `page-heading` are the two that change WORDS the frame is
      // showing. There is no attribute to flip that would put a sentence back,
      // so these — and only these — reload the chapter.
      else reload = true;
      // And the word edit owes the record back too — the html now in the file
      // is `value`, and the mirror is recomputed from it after the loop.
      if (row.field === 'html') wordEdits.push({ member: row.member, target: row.target, html: value });
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
    /*
     * AN ACTION MADE ONLY OF SPINE OR JOIN ROWS DID NOT TOUCH THE BOOK.
     * `modified` means "the copy you filed is older than this one", and where
     * the book divides — and where its seams join — lives in the curation
     * beside the bank, not in a single byte of the working tree. Marking it
     * would put a dot on the tab and raise the close-with-unsaved-work question
     * over a file nothing wrote to, which is the same reason the scan's own
     * replay sets no flag at all.
     */
    const touchedBook = action.rows.some((row) => row.field !== 'chapters' && row.field !== 'join');
    this.patch(tab.id, {
      ...(touchedBook ? { modified: true } : {}),
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
    /*
     * AND THE CURATION FOLLOWS, LAST. Grouped per member because an action's rows
     * can name a chapter that is not the one on screen, and per field because the
     * two are two decisions; after the sentence above for the reason the gesture
     * itself mirrors last — the only thing this can say is that the decision could
     * not be taken back, and "Undid: struck 14 blocks" written over that would be
     * the app reporting success it did not have.
     */
    for (const [field, moves] of mirrored) {
      for (const member of new Set(moves.map((one) => one.member))) {
        await this.mirrorToCuration(
          tab.id,
          member,
          field,
          moves.filter((one) => one.member === member),
        );
      }
    }
    // A note at a time, because each is one amendment about one note and there is
    // no batch behind them: the dialog asks once per orphaned footnote, so an
    // action holds one of these or two, never forty.
    for (const one of noteCuts) {
      await this.mirrorNoteCut(tab.id, one.member, one.noteId, one.value);
    }
    // The spine last of all, grouped per member like the amendments: it is one
    // list for the whole book, so a batch that touched two chapters is still one
    // read and one write of the curation per chapter it names.
    for (const member of new Set(chapterMarks.map((one) => one.member))) {
      await this.mirrorChapterMarks(
        tab.id,
        member,
        chapterMarks.filter((one) => one.member === member),
      );
    }
    // And the words — one at a time, because a word-edit action carries one
    // row. The mirror is the gesture's own (`mirrorWords`), so a restored
    // sentence re-records exactly what the edit recorded, in whichever world
    // this book's words land.
    for (const one of wordEdits) {
      await this.mirrorWords(tab.id, one.member, one.target, one.html);
    }
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
    /*
     * THE BOOK IS NOT A FILE, so there is nothing for a picker to write. It is
     * made from the pages this project was read from and it is remade from them at
     * will; what a person actually wants from Save here is a finished copy, which
     * is Export — the door that renders the position through the whole ledger and
     * files the result. Said rather than silently ignored, because a chord that
     * does nothing reads as a broken app.
     */
    if (tab.kind === 'book') {
      this.notice.set(
        `${tab.title} is the book itself, not a file — Export files a finished copy of it.`);
      return;
    }
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
  /*
   * THE SCAN'S BLOCK EDITOR NEVER WRITES THIS ROW. A join is a decision about
   * the flowing page's seam, made on the book and recorded through the book's
   * own ledger (`joinBlocks`), where its row is a BOOK row that writes no book.
   * The entry exists because this table's type promises a ledger spelling for
   * every overlay field, and a hole in it would be a compile error one field
   * addition away from being papered over with a cast.
   */
  join: 'join',
};

const OVERLAY_FIELD_OF: Readonly<Record<string, OverlayField>> = {
  strike: 'strike',
  'block-category': 'category',
  'block-text': 'text',
};

/**
 * What a cast book says about ONE stamped element, read off its start tag (and,
 * for `text`, off what stands between its tags).
 */
interface BlockProvenance {
  /** `data-bf-src` verbatim — the banked answers this element's words came from. */
  src: string;
  /**
   * `data-bf-note` — which note of its Footnote block this aside is, counted
   * from 0. Null for every element that is not a note, which is nearly all of
   * them, and null too for an aside in a book cast before the emitter wrote it.
   */
  note: number | null;
  /**
   * The element's own words, tags stripped and whitespace collapsed — what a
   * chapter marker made from this block is CALLED.
   *
   * Read here because it is read from the same file in the same pass, and
   * because the alternative is worse: the frame could send the text with the
   * gesture, but an undo sends no message at all and would then have no title to
   * put back. See `mirrorChapterMarks`.
   */
  text: string;
}

/** One chapter's stamped elements, indexed the two ways the mirror asks for them. */
interface ChapterProvenance {
  /** By `data-bf-id` — the name every write in select mode uses. */
  byBlock: ReadonlyMap<string, BlockProvenance>;
  /**
   * By the element's OWN id (`fn25`) — the name a footnote is addressed by once
   * the reference that pointed at it has been deleted, which is the only name
   * the note dialog and its undo rows ever have.
   */
  byNote: ReadonlyMap<string, BlockProvenance>;
}

const EMPTY_PROVENANCE: ChapterProvenance = { byBlock: new Map(), byNote: new Map() };

/**
 * Every stamped element in a chapter, with what the book says about it.
 *
 * ── Read off the START TAGS and nothing else ────────────────────────────────
 *
 * A chapter of a cast book is XHTML this program wrote, and what is wanted from
 * it is a handful of attributes on the same tag. Parsing it as a document would
 * mean handing somebody's book to `DOMParser` on every keystroke of a held
 * Delete; scanning the start tags reads the names where they were written,
 * ignores everything in between, and cannot be confused by the prose because a
 * `<` in text is `&lt;` in a file that parses as XML at all — which this one
 * must, since the reader renders it.
 *
 * ORDER-BLIND WITHIN THE TAG. The emitter writes page, category, id, src and
 * note in that order today, and `foundry epub-stamp` writes ids into books that
 * were never cast here at all. A scan that depended on the order would be a scan
 * that broke the day either of them changed a line.
 *
 * An element with an id and no src is simply absent from the answer: that is the
 * pre-provenance book, and `mirrorToCuration` treats "no entry" and "no
 * attribute" as the one state, which is what they are.
 */
function provenanceIn(xhtml: string): ChapterProvenance {
  const byBlock = new Map<string, BlockProvenance>();
  const byNote = new Map<string, BlockProvenance>();
  for (const match of xhtml.matchAll(/<([a-zA-Z][a-zA-Z0-9:-]*)\b[^>]*>/g)) {
    const tag = match[0];
    const name = match[1];
    if (name === undefined || match.index === undefined) continue;
    const src = /\sdata-bf-src="([^"]*)"/.exec(tag);
    if (src === null || src[1] === undefined || src[1].length === 0) continue;
    const blockId = /\sdata-bf-id="([^"]*)"/.exec(tag);
    const noteId = /\sid="([^"]*)"/.exec(tag);
    const ordinal = /\sdata-bf-note="(\d+)"/.exec(tag);
    const record: BlockProvenance = {
      src: src[1],
      note: ordinal === null || ordinal[1] === undefined ? null : Number(ordinal[1]),
      text: elementText(xhtml, name, match.index + tag.length, /\/\s*>$/.test(tag)),
    };
    if (blockId !== null && blockId[1] !== undefined && blockId[1].length > 0) {
      byBlock.set(blockId[1], record);
    }
    // ONLY AN ASIDE THAT SAYS WHICH NOTE IT IS goes in the second index. Every
    // element in a chapter has an `id` of some kind — a heading's anchor, a page
    // marker's — and a note is the one addressed by it, so the ordinal is what
    // separates the note index from a map of every anchor in the book.
    if (record.note !== null && noteId !== null && noteId[1] !== undefined && noteId[1].length > 0) {
      byNote.set(noteId[1], record);
    }
  }
  return { byBlock, byNote };
}

/**
 * What one element SAYS — its markup from just past the start tag to its
 * matching close, with the tags taken out and the whitespace collapsed.
 *
 * DEPTH-COUNTED OVER ITS OWN TAG NAME, which is all a well-formed XHTML document
 * needs: a `<blockquote>` inside a `<blockquote>` must close before the outer
 * one does, and nothing between them can close either. It is the same walk
 * main's own surgery makes (`closeTagOffset`, electron/epub-reader.ts), written
 * again here rather than imported because that module is main's and this file is
 * the renderer's — and because what is wanted differs: main needs an offset to
 * splice at, this needs the words.
 *
 * The entities are decoded by hand and only the five a book actually carries.
 * This is a TITLE somebody will read in a contents, not a document being
 * rebuilt, and `&amp;` standing in the middle of a chapter name is the only
 * failure mode worth spending five lines to avoid.
 */
function elementText(xhtml: string, name: string, from: number, selfClosing: boolean): string {
  if (selfClosing) return '';
  const pattern = new RegExp(`</?${name}\\b[^>]*>`, 'gi');
  pattern.lastIndex = from;
  let depth = 1;
  for (let match = pattern.exec(xhtml); match !== null; match = pattern.exec(xhtml)) {
    if (match[0].startsWith('</')) {
      depth -= 1;
      if (depth === 0) return plainWords(xhtml.slice(from, match.index));
    } else if (!/\/\s*>$/.test(match[0])) {
      depth += 1;
    }
  }
  // An element the file never closes. The book is malformed and the reader would
  // have refused it; there is nothing here worth guessing at.
  return '';
}

function plainWords(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&(?:apos|#39);/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A cast book's category names to the bank's — `footnote` to `Footnote`.
 *
 * Derived from the one table in shared/categories.ts rather than written out
 * again: those ids ARE the overlay's categories (`OVERLAY_CATEGORIES`), spelled
 * as the model spells them, and a second hand-kept list is a translation waiting
 * to disagree with itself. `chapter` has no entry, which is the whole of why
 * `bankCategory` can answer null — and the null is the fork into the spine.
 */
/**
 * `data-bf-cat="chapter"` — the one label in a cast book that is not a category.
 *
 * It is BookForge's own, written by the emitter on the headings a section opens
 * at (`CHAPTER_ATTRIBUTE`, src/vlm/dots-book.ts) and offered by the inspector's
 * palette as "Chapter opening". dots has no such answer, the bank cannot hold
 * one, and the relabel that writes it is a statement about the SPINE — which is
 * why the mirror forks on this exact string and nothing else.
 *
 * Written out here rather than looked up: it is a value crossing a seam, and the
 * comparison is against what the book says, not against what a table of the
 * app's happens to contain today.
 */
const CHAPTER_CATEGORY = 'chapter';

const BANK_CATEGORY_OF: Readonly<Record<string, string>> = Object.fromEntries(
  PDF_BLOCK_CATEGORIES.map((one) => [one.id.toLowerCase(), one.id]),
);

/** What a decision says about one field, as a ledger row spells it. */
function fieldValue(decision: OverlayDecision | undefined, field: OverlayField): string {
  if (decision === undefined) return '';
  if (field === 'strike') return decision.strike === true ? 'true' : '';
  if (field === 'join') return decision.join === true ? 'true' : '';
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
 * accordion is silently change their own spine.
 *
 * ── AND `part: 0` IS DROPPED, which is exactness rather than a departure ──────
 *
 * The engine's dump writes a part on every location because a block always has
 * one, and 0 is what an answer nothing split carries. A chapter list resolves an
 * absent part AS 0 (`chapterStarts`, src/vlm/overlay.ts), so the two spellings
 * name the same block and render the same book — and only one of them is the
 * spelling everything else in this app uses. `BlockElement.key` is `page:order`,
 * one outline per answer element; `data-bf-src` omits the part wherever the
 * markdown pass never cut the answer up. Seeding the OTHER spelling meant a
 * detected chapter and the block under it could not be matched: the scan's
 * "a chapter already starts at that block" never fired for one, and a marker
 * made from the flowing book would have been ADDED beside it — two entries at
 * one location, which the engine's own reader refuses by name and which would
 * take the whole curation down at the next cast.
 *
 * A part that is not 0 is carried through untouched: that names one piece of a
 * split answer and there is nothing to collapse.
 */
function seedChapters(detected: readonly PdfDetectedChapter[]): OverlayChapter[] {
  return detected.map((one) => ({
    at: {
      page: one.page,
      order: one.order,
      ...(one.part === undefined || one.part === 0 ? {} : { part: one.part }),
    },
    title: one.title,
  }));
}

/**
 * Do these two locations name one block, as the ENGINE reads them?
 *
 * `compareTargets` cannot answer it, and the difference is not a detail. That
 * function orders AMENDMENTS as well as chapters, and for an amendment a missing
 * part means "every piece of this answer" — genuinely not the same target as
 * "piece 0" — so it sorts the two apart, which is right there and wrong here. A
 * chapter list has no such distinction: `chapterStarts` looks a location up as
 * `page:order:(part ?? 0)`, so `30:1` and `30:1:0` are one block and a spine
 * holding both is a spine the engine refuses.
 *
 * Used everywhere a chapter row is matched to a location, so that a list written
 * by an older build — which seeded `part: 0` — still answers to the block the
 * user is pointing at instead of quietly gaining a duplicate beside it.
 */
function atSameBlock(a: OverlayTarget, b: OverlayTarget): boolean {
  return a.page === b.page && a.order === b.order && (a.part ?? 0) === (b.part ?? 0);
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
 * Put a document into this column's strip and bring it to the front.
 *
 * DIRECTLY AFTER THE ACTIVE TAB rather than at the end, because that is where a
 * person looking at one thing expects the next thing to appear — the browser's
 * rule for "open in new tab" from the page you are on, and the only placement
 * under which the auto-close rule leaves the strip in the order it was in.
 *
 * Already in this strip is an ACTIVATION and nothing else: the order is the
 * user's and re-inserting a tab they had dragged somewhere would move it under
 * the click that only meant "show me that one".
 */
function addToStrip(pane: Pane, tabId: string): Pane {
  if (pane.tabIds.includes(tabId)) return { ...pane, activeTabId: tabId };
  const at = pane.activeTabId === null ? -1 : pane.tabIds.indexOf(pane.activeTabId);
  const index = at < 0 ? pane.tabIds.length : at + 1;
  return {
    ...pane,
    tabIds: [...pane.tabIds.slice(0, index), tabId, ...pane.tabIds.slice(index)],
    activeTabId: tabId,
  };
}

/**
 * Take documents out of a strip, and answer what the column shows now.
 *
 * THE NEIGHBOUR TO THE RIGHT, then the one to the left — the browser's rule for
 * closing a tab, and the one that does not make a person hunt for where they
 * were. A strip emptied entirely goes to Home, which is what the caller then
 * decides whether to keep as a column at all.
 */
function withoutTabs(pane: Pane, going: ReadonlySet<string>): Pane {
  if (!pane.tabIds.some((id) => going.has(id))) return pane;
  const at = pane.activeTabId === null ? -1 : pane.tabIds.indexOf(pane.activeTabId);
  const tabIds = pane.tabIds.filter((id) => !going.has(id));
  if (pane.activeTabId !== null && !going.has(pane.activeTabId)) {
    return { ...pane, tabIds };
  }
  const after = pane.tabIds.slice(at + 1).find((id) => !going.has(id));
  const before = [...pane.tabIds.slice(0, Math.max(0, at))].reverse().find((id) => !going.has(id));
  return { ...pane, tabIds, activeTabId: after ?? before ?? tabIds[0] ?? null };
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

/**
 * The book's documents, in reading order, once each.
 *
 * IT READS `members` AND NOT `chapters`, and that is the whole of this function
 * now. It used to fold the chapter rows down to their member files, on the
 * argument that the contents list WAS the spine with labels laid over it — true
 * only while a document the book would not name got a row of its own anyway,
 * carrying its filename. `EpubBook.members` says why that row had to go and why
 * the spine is now carried in its own right; the short version is that a table of
 * contents must never be the thing that decides which pages exist.
 */
export function membersOf(book: EpubBook): readonly string[] {
  return book.members.map((member) => member.href);
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
