/**
 * workspace-export — which file an export is, and making it.
 */
import * as path from 'node:path';
import { materializeBook } from './book';
import { ProjectError } from './projects';
// A TYPE ONLY, deliberately: shared/pending.ts derives promises from QUEUE ROWS,
// and this module must not learn about a queue. What it is handed is the answer
// (`Deferral`), composed at the door by the side that holds both lists.
import type { Deferral } from '../shared/pending';
import type { ConversionKind, LedgerStep, WorkspacePlan } from '../shared/types';
import { FINAL, planRendering } from './workspace-rendering';
import { narrowedStamp, renderingCompiles } from './workspace-rendering-guards';

/**
 * Where this book's EXPORT goes — the same rendering, aimed at `final/`.
 *
 * ── One run, two landings, and which of them this is ────────────────────────
 *
 * An export IS a Generate. Same bank, same curation, same `--format`, same
 * translate stage when the position stands under a translation — everything that
 * reaches a command line is identical, which is why it is composed by the same
 * function above rather than by a second copy of that composition. The user's
 * ruling is about what happens AFTERWARDS: "it wont go into the working files as a
 * step because it isnt the base for new steps. its a terminal step. so its an
 * export." So the file lands in the project's tray instead of in the layer this
 * app treats as an origin, and the queue records a `ProjectFinal` row rather than a
 * step on a chain (`GenerateRequest.export`).
 *
 * ── What `final/` does not owe, and why that is not laxity ──────────────────
 *
 * `generated/` is rotated aside rather than replaced, catalogued as a chain,
 * unpacked into working trees, and REFUSED while a tab is reading one of those
 * trees. Only the first of those follows an export into the tray, and it follows it
 * for its own reason (`rotateFinal`): the name is composed from the book, so
 * exporting twice writes one path twice, and a second run silently overwriting the
 * first is the failure the rotation exists to prevent wherever a name is composed
 * rather than chosen. The refusal does NOT follow, because there is no working tree
 * hanging off a filed document for a rename to pull out from under anybody — and a
 * refusal here would stop somebody exporting the book they are looking at, which is
 * the most ordinary reason to export at all.
 *
 * ── AND IT IS THE ONE RENDERING THAT COMPILES THE EDITED BOOK ───────────────
 *
 * *"Export → materialize (replay) → engine compiles EPUB/txt."* (docs/RENDERER.md
 * §6.) A position with applied changes on the way to it used to be refused here,
 * because the engine builds from the pages that were read and the changes live
 * beside them — so the book that came out would have had none of them in it. It
 * is not refused any more: main replays the chain into a derived book file and
 * the engine compiles THAT (`vlm-compile`), which is what makes a person who
 * struck forty running heads and pressed Export get a book without them.
 *
 * The other renderings still refuse, each for its own reason — see
 * `refuseOverEdits` — and a FACSIMILE export never touches any of this: it
 * reprints the reading's own pages from the raw bank, which is a statement about
 * what was read rather than about any state of the book downstream of it.
 *
 * ── The refusals it DOES keep, verbatim ─────────────────────────────────────
 *
 * The reading has to be finished, said in the same words about the same bank: an
 * export that quietly resumed a half-read book would put a vision model behind a
 * button labelled with a file format, which is the rule this whole layer is built
 * around (`--reuse-readings`, docs/DERIVED-BOOK.md §7). And a position standing
 * under a translation can only be exported as an EPUB, because there is no version
 * of `vlm-convert --format pdf` that reprints the scan's own pages in Hungarian.
 */
export async function identifyExport(
  inputPath: string,
  kind: ConversionKind = 'epub',
  /**
   * THE ROW TO EXPORT, when the asking did not come from the pointer.
   *
   * Every export a person presses is an export of where they are standing, which
   * is null and is what this parameter has meant by its absence since the door
   * existed. What is not a press is the export a HOST orders from a step in the
   * tree — Owen's ruling that any step can be narrated, and that the EPUB is made
   * for them when there is none (`exportEpubFromStep`, electron/mount.ts) — and
   * that ask names its own row, because the person may be standing anywhere.
   *
   * IT IS NOT THE FACSIMILE PARAMETER, and the two were one thing until this
   * wave. `planRendering` took a single step and read it as both "render from
   * here" and "name the file after this row", which is true of a facsimile and
   * false of everything else: an export from a step is still the BOOK's export
   * and still lands on the book's own name in `final/`. See that function.
   */
  from: LedgerStep | null = null,
  /**
   * THE EXPORT IS OF A ROW THAT HAS NOT LANDED — Owen's *"i click the grayed out
   * row and hit the export epub tile"*, arriving at the one plan that can be asked
   * for it.
   *
   * ── What it changes, which is what it REMOVES ──────────────────────────────
   *
   * Everything about this export that a chain decides — the book with the changes
   * replayed into it, the narration stamp, the translated words and the language
   * they declare — is an answer about a row that does not exist, so none of them is
   * composed. What is composed is the four deterministic facts (`WorkspacePlan.
   * deferred` names them and says why they are the same at every row of one chain),
   * and they are composed at `from`, which for this call is the nearest LANDED
   * ancestor rather than the row the person pressed on.
   *
   * THE STAMP IS THE FIELD THIS EXISTS FOR. An export of a promised cleanup that
   * carried the ancestor's stamp — or none — would be exactly the file BookForge
   * narrates, saying the wrong thing about the one fact the cleanup was ordered to
   * establish. Leaving it out and re-planning at spawn is the only shape that
   * cannot get that wrong.
   */
  deferral?: Deferral,
): Promise<WorkspacePlan> {
  const planned = await planRendering(inputPath, kind, FINAL, from);
  /*
   * ── THE DEFERRED ANSWER, AND WHY IT RETURNS BEFORE THE MATERIALISE ─────────
   *
   * `planRendering` has already composed every path out of the project's own
   * catalogue, which is all a deferred plan is allowed to claim. What comes next is
   * `materializeBook`, which replays a chain from a step — and the step is a
   * promise, so there is no chain and nothing to replay. Returning here rather than
   * materialising at the landed ancestor and throwing the file away is the honest
   * version: this plan is not a book, it is the four names the book will have.
   */
  if (deferral !== undefined) {
    return {
      key: planned.plan.key,
      sourcePath: planned.plan.sourcePath,
      outputPath: planned.plan.outputPath,
      readingsPath: planned.plan.readingsPath,
      deferred: { from: deferral.from },
    };
  }
  /*
   * ── AND THE BOOK IS NOT MADE HERE ANY MORE (PK6) ──────────────────────────
   *
   * *"Export → materialize (replay) → engine compiles EPUB/txt."* (docs/RENDERER.md
   * §6.) The materialise half is `materializeExport` below, run at the SPAWN, for
   * `TranslateRequest.at`'s reason: a derived book is unlinked at every settle, so
   * a path minted at the press is a path that outlives its own file the moment a
   * row is retried, resumed or restored.
   *
   * WHAT THAT COSTS IS NOTHING A PERSON CAN SEE, because the answer is the same
   * answer: the row is pinned here (`at`), so the spawn replays the chain of the
   * row the person pressed on, not of wherever the pointer has since moved to.
   */
  return { ...planned.plan, at: from?.id ?? planned.at };
}

/**
 * THE SAME EXPORT, AT THE SPAWN — the book, and the stamp narrowed over it.
 *
 * ── The two things only this moment can do ─────────────────────────────────
 *
 * THE BOOK. The row's own book file with its whole chain replayed into it, as a
 * book file of its own, which is the only language main and the engine both
 * speak. Into the OS temp directory under a folder of foundry's own — the same
 * place the metadata stage puts the file it stamps — because it is scratch: it
 * belongs to one job, nothing catalogues it, and the queue removes it when the
 * job settles. `generated/` was the other candidate and is worse: everything in
 * there is drawn, swept and reasoned about by the ledger, and a file nobody can
 * name would be the one exception.
 *
 * THE NARROWED STAMP. This is the single place in the app that holds a cleanup's
 * claim and the derived book the claim is about to be checked against, at the
 * same moment (see `narrowedStamp`) — so the narrowing cannot be done earlier
 * and must not be done twice.
 *
 * A NON-COMPILING RENDERING ANSWERS NOTHING, and that is not a refusal: a
 * facsimile reprints the scan's own photographed lines from the raw bank and has
 * no book to read. `renderingCompiles` is the one test, asked here and by
 * `planRendering`, so the press and the spawn cannot disagree about whether this
 * export was ever going to carry a replay.
 */
export async function materializeExport(
  projectDir: string,
  kind: ConversionKind,
  /** The row this export is made from, resolved from the request's `at`. */
  at: LedgerStep | null,
  /** The cleanup's own stamp as the press named it, or undefined for no claim. */
  claimedStamp?: string,
): Promise<{ bookPath?: string; narrationStamp?: string }> {
  if (!renderingCompiles(kind)) return {};
  const derived = await materializeBook(projectDir, at);
  /*
   * A REFUSAL HERE IS THE PERSON'S OWN SENTENCE. `materializeBook` answers in
   * words for everything a person can be told about — a book file whose bank has
   * moved, a step whose payload will not read — and the shelf shows main's
   * sentences verbatim, which is where those belong. What it will not do is
   * compile over a book it could not read: an export that ran anyway would be the
   * cast of an unedited book filed as an edition.
   */
  if (!derived.ok) throw new ProjectError(derived.reason);
  const narrowed = claimedStamp === undefined
    ? undefined
    : await narrowedStamp(claimedStamp, derived.path, derived.restructured);
  /*
   * AN EMPTY ANSWER IS AN ABSENT FLAG, `narrationStampFor`'s rule restated for the
   * one narrowing that can leave nothing behind: the field is dropped rather than
   * carried as a path of no characters, so no reader of a `GenerateRequest` has to
   * know that the empty string means anything.
   */
  return {
    bookPath: derived.path,
    ...(narrowed === undefined || narrowed.length === 0 ? {} : { narrationStamp: narrowed }),
  };
}
