import { Injectable, signal } from '@angular/core';

import type { ProjectSummary } from '@shared/types';

import { api } from './foundry';

/**
 * Home's list of books, mirrored from main.
 *
 * A MIRROR and not a store, the same way QueueService and RecentsService are:
 * main reads `<libraryDir>/projects/` and decides what is in it
 * (electron/projects.ts), and this class never edits a row. There is no push
 * channel and there should not be — a project's contents change when a
 * conversion lands, which the queue already broadcasts, and Home refreshes when
 * it appears.
 *
 * `refresh()` re-reads from disk rather than patching what is here, because the
 * things that change a project happen in MAIN — a job finishing, an output
 * rotated aside — and a renderer that maintained its own copy of that would be
 * a second opinion about a folder it cannot see.
 */
@Injectable({ providedIn: 'root' })
export class ProjectsService {
  private readonly all = signal<ProjectSummary[]>([]);

  readonly items = this.all.asReadonly();

  /**
   * Which rows are open, by project key.
   *
   * IN THE SERVICE rather than in the component, because Home is constructed
   * fresh every time it comes back on screen — including every time a column
   * becomes empty — and an expansion that collapsed itself whenever the user
   * glanced at a book is an expansion nobody would use twice.
   */
  private readonly open = signal<ReadonlySet<string>>(new Set());

  readonly expanded = this.open.asReadonly();

  async refresh(): Promise<void> {
    if (!api) return;
    this.all.set(await api.projects.list());
  }

  toggle(key: string): void {
    this.open.update((keys) => {
      const next = new Set(keys);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  /**
   * Ask main to erase a project, and re-read the list if it did.
   *
   * NOT AN EXCEPTION to "this class never edits a row", which is the point of
   * the round trip: the row does not disappear because this asked for it to, it
   * disappears because the folder it described is no longer in `projects/` when
   * `refresh()` reads that directory again. Main asks the user first, in its own
   * dialog, and may refuse outright — so a renderer that patched its own list on
   * the way out would show a book as deleted that is still sitting on the disk.
   *
   * The expansion is dropped with it, and that is not housekeeping: a project is
   * keyed by its content hash, so re-importing the same book lands on the same
   * key, and a stale key left in this set would make the new project's row
   * arrive already open for a reason nobody could account for.
   *
   * Returns what to say in the notice strip, or null when the user cancelled —
   * a cancel is silence. A refusal throws, and the caller says it.
   */
  async remove(project: ProjectSummary): Promise<string | null> {
    if (!api) return null;
    const said = await api.projects.delete(project.dir);
    if (said === null) return null;
    this.open.update((keys) => {
      const next = new Set(keys);
      next.delete(project.key);
      return next;
    });
    await this.refresh();
    return said;
  }
}
