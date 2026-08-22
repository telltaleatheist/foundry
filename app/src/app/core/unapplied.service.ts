import { Injectable, inject } from '@angular/core';

import { fold } from '@shared/original';
import type { MakeAct } from '@shared/types';

import { BookStacksService } from './book-stacks.service';
import { OpenDocumentsService, type Tab } from './documents.service';
import { StageService } from './stage.service';
import { api } from './foundry';

/**
 * THE GATE BEFORE A MAKE-ACT — nothing this app makes runs past work nobody
 * applied without somebody being asked first.
 *
 * ── The defect, in Owen's own project ───────────────────────────────────────
 *
 * He renamed a chapter and retyped a block in the book pane, did not press Apply
 * a second time, pressed Export — and the EPUB came out without either, with
 * nothing anywhere saying so (2026-08-21). It is not a bug in the export. Every
 * make-act in this app is arithmetic over the RECORDED STEPS: the export walks
 * the ledger, the translation is made from the book the ledger produces, and a
 * host act asks Foundry for an export of a step before it starts. The pane's
 * stack is a delta that has not become a step, so the book that came out was
 * perfectly honest about the ledger and completely silent about the page in front
 * of him. Hours of GPU, and the wrong book at the end of it.
 *
 * The half of the fix that lives here is the QUESTION. The other half is that the
 * stack now survives on disk (`BookStacksService`, the sidecar) so that pressing
 * Cancel here costs nothing.
 *
 * ── Why a service of its own, and where it sits ─────────────────────────────
 *
 * It has to see three things at once — which tabs are open, what each book pane
 * is holding, and which document the person is standing in — and no existing
 * service sees all three without growing an edge it was written not to have.
 * `UiService` is the one that would have been tidiest (its `openExport` and its
 * two siblings are the doors every make-act dialog opens through) and it is the
 * one that CANNOT hold this: the chain `stage → documents → stacks → ledger →
 * confirm → ui` closes into a dependency cycle the moment `UiService` injects
 * anything on it. So the gate is called by the presses instead, which is five
 * call sites and no cycle.
 *
 * ── ASKED AT OPEN, NOT AT ADD ───────────────────────────────────────────────
 *
 * Owen's own preference and the honest one here: resolve it before configuring,
 * so nobody fills in a target language and a model and then meets a card about
 * something they could have settled first.
 *
 * IT IS ONLY HONEST BECAUSE NONE OF THE THREE DIALOGS HAS A SOURCE PICKER, and
 * that was checked rather than assumed. All three compute `source()` the same
 * way — the ACTIVE DOCUMENT's project, resolved to the project's original — and
 * the export card says why in its own words: *"NO SOURCE PICKER, unlike the OCR
 * dialog… This is one free export of the thing you are looking at."* So the book
 * the dialog will act on is the book this gate looks at, for the whole life of
 * the card. The day one of them grows a picker, the check has to move to the Add
 * press and follow the chosen source; that is written here so the day is not a
 * surprise.
 *
 * ── AND THE ONE PRESS IT CANNOT REACH ───────────────────────────────────────
 *
 * An export the HOST orders directly through the mount seam —
 * `exportEpubFromStep` in app/electron/mount.ts — runs in main, with no window
 * and no card. It is how a host act declared on `'book'` gets a file to consume
 * when the step has none. That press cannot be asked here and is not: the gate
 * covers the act the person pressed IN THIS WINDOW, which is the one that reaches
 * `hostOps.invoke`, and the host's own subsequent export of the same step is a
 * consequence of an answer already given. Known limit, named where it lives.
 */
@Injectable({ providedIn: 'root' })
export class UnappliedService {
  private readonly documents = inject(OpenDocumentsService);
  private readonly stacks = inject(BookStacksService);
  private readonly stage = inject(StageService);

  /**
   * The book tab this act would be made from, or null.
   *
   * ── One book tab per project, which is what makes this a lookup ────────────
   *
   * `bookTabIn` (core/documents.service.ts) says it in three words — *"Never a
   * second one"* — so a project directory names at most one editable book pane
   * and there is nothing to sum, choose between or reconcile. Folded, because on
   * Windows one directory arrives spelled three ways and two spellings would be
   * two panes for one book.
   *
   * A VIEW-ONLY TAB IS NOT ONE. An exploded export opens in a book tab too
   * (`openExportView`), keyed by the FILE rather than by the project — so it can
   * never match a project directory here — and it has no stack to hold anything
   * anyway.
   */
  private paneFor(projectDir: string): Tab | null {
    const key = fold(projectDir);
    return this.documents.tabs().find(
      (tab) => tab.kind === 'book' && tab.viewOnly !== true && fold(tab.path) === key,
    ) ?? null;
  }

  /**
   * The project the three dialogs would act on — the ACTIVE DOCUMENT's, exactly
   * as each of them computes its own `source()`.
   *
   * NOT THE STANDING PROJECT and not the library's selection: those are questions
   * about where somebody has been clicking, and a card that guarded the wrong book
   * is worse than no card. This is the tab in front of them, which is the only
   * thing all three dialogs agree to be about.
   */
  private activeProject(): string | null {
    const tab = this.stage.activeDocument();
    return tab === null ? null : this.documents.projectDirOf(tab);
  }

  /**
   * ASK, IF THERE IS ANYTHING TO ASK ABOUT — true when the act may go ahead.
   *
   * ── The three answers ──────────────────────────────────────────────────────
   *
   * Apply-and-continue goes through the ONE press (`applyUnapplied`), which is the
   * same press the closing card makes and the same amend-or-land decision the
   * sheet's own button makes; an apply main refuses answers false, because
   * continuing would make the very book the person just asked not to make.
   * Without-them proceeds exactly as the app did before this gate existed — it is
   * a real thing to want, and it is not the default. Cancel, and a card nobody
   * answered, stop.
   *
   * NOTHING WAITING IS THE ORDINARY CASE and costs two map lookups: no card, no
   * round trip, no await anybody can see.
   *
   * `projectDir` NULL IS A YES. A press with no project behind it has no book pane
   * to be holding anything, and refusing it here would be this gate deciding
   * something about an act it knows nothing about — the act's own refusals are
   * better informed than any guess made here.
   */
  async cleared(projectDir: string | null, act: MakeAct): Promise<boolean> {
    if (projectDir === null || !api) return true;
    const pane = this.paneFor(projectDir);
    if (pane === null) return true;
    const edits = this.stacks.unappliedIn(pane.id);
    if (edits === 0) return true;
    const answered = await api.confirmUnapplied({ title: pane.title, edits, act });
    if (answered === 'cancel') return false;
    if (answered === 'without') return true;
    return await this.stacks.applyUnapplied(pane);
  }

  /**
   * The same question for the three dialogs, which act on whatever document is in
   * front of the person rather than on a directory a caller names.
   *
   * A SECOND DOOR RATHER THAN A NULLABLE ARGUMENT, because "the book I am looking
   * at" and "this particular book" are two different intentions and a caller that
   * passed null would be indistinguishable from a caller that had failed to work
   * out which project it meant.
   */
  async clearedHere(act: MakeAct): Promise<boolean> {
    return await this.cleared(this.activeProject(), act);
  }
}
