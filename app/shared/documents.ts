import type { ConversionKind, ProjectDocument, ProjectGeneratedRole } from './types';

/**
 * Which role a conversion of each kind produces — the one mapping, shared.
 *
 * `electron/projects.ts` writes these into `project.json` when a job lands, and
 * the OCR dialog reads them to work out whether the source somebody picked is
 * the very file their run would write over. Two copies of this table would let
 * the renderer's warning disagree with the catalogue's own record of what a run
 * produces, which is the failure the warning exists to prevent.
 */
export const GENERATED_ROLE_FOR: Readonly<Record<ConversionKind, ProjectGeneratedRole>> = {
  epub: 'cast',
  pdf: 'searchable',
  txt: 'text',
};

/**
 * What a document IS, in two or three words — because its NAME does not say.
 *
 * ── The bug this exists for ─────────────────────────────────────────────────
 *
 * A project's scan and the real-text PDF made from it have the SAME FILENAME.
 * `working/Kershaw-1993.pdf` is the scan the user imported;
 * `generated/Kershaw-1993.pdf` is the reprint made from it. They differ only in
 * the directory, which is this app's bookkeeping and something the user is
 * deliberately never shown. So everywhere a document was drawn by its basename —
 * the OCR dialog's source picker, the nav's rows — those two were one string,
 * and picking the wrong one earned a refusal after the whole form was filled in.
 *
 * It went unnoticed because it could not happen until this session: the reprint
 * used to REPLACE the scan as the project's live PDF, so there was only ever one
 * of them. Giving it a row of its own is what made the collision reachable.
 *
 * ── The wording ─────────────────────────────────────────────────────────────
 *
 * The same words Home already puts on its tags, so the two surfaces agree and
 * somebody who has read one row can read the other. `archive` is "original"
 * rather than "the scan" because a project started from an EPUB has an original
 * that was never scanned — and because `originalOf` calls it that, which is the
 * word the delete card uses when it explains what taking it would cost.
 */
export function typeLabel(kind: ProjectDocument['kind']): string {
  switch (kind) {
    case 'pdf': return 'PDF';
    case 'epub': return 'EPUB';
    case 'txt': return 'text';
    default: return '';
  }
}

/**
 * A document named so it cannot be confused with its own siblings.
 *
 * `Kershaw-1993.pdf · original` against `Kershaw-1993.pdf · real text`. The
 * middle dot rather than brackets because the shelf and the OCR dialog already
 * separate a thing from its qualifier that way, and a list of parentheses reads
 * as a list of asides.
 *
 * A FILE OUTSIDE ANY PROJECT HAS NO ROLE, and falls back to the folder it is in
 * — which is what actually distinguishes two files of the same name reached from
 * two directories, and is the only thing available that does.
 */
export function qualify(label: string, kind: ProjectDocument['kind'] | null, folder: string): string {
  const said = kind === null ? folder : typeLabel(kind);
  return said.length > 0 ? `${label} · ${said}` : label;
}

/**
 * The one sentence for "this run would read and write the same file".
 *
 * MAIN REFUSES AND THE RENDERER WARNS, and they say the same thing because they
 * say it from here. `workspace.ts` throws this after the plan has resolved a
 * path — the guard that actually matters, since a renderer's check is a
 * courtesy — and the OCR dialog shows it the moment the source is picked, which
 * is the moment it becomes knowable. Two hand-written versions of one sentence
 * drift, and the pair that drifts here would have main refusing something the
 * dialog had just said was fine.
 */
export function selfOverwriteMessage(file: string): string {
  return `That document IS this project's ${file}, so this run would have to read and replace the `
    + 'same file. Run it on the original instead, or ask for a different format or language.';
}
