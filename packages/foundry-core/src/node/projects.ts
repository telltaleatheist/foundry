/**
 * projects — one folder per book, in four layers.
 *
 * A conversion used to write `<libraryDir>/workspace/<slug>-<key>.epub`, the
 * readings bank lived a continent away in `<userData>/readings/<key>.jsonl`, and
 * nothing on disk tied a translation to the book it came from. You could not ask
 * "what has been made from this PDF?" because the answer was spread across two
 * directories and encoded only in a filename prefix.
 *
 * A PROJECT is the answer, and it is one directory:
 *
 *   <libraryDir>/projects/<slug>-<contentkey>/
 *     project.json            the catalogue — see ProjectManifest
 *     archive/                the imported originals. NEVER written.
 *     generated/              the model's cast EPUB, or the imported EPUB, or
 *                             the book reprinted as a real-text PDF. NEVER
 *                             written.
 *     working/                what the user edits: the unpacked EPUB tree, and
 *                             the live PDF.
 *     final/                  what Save and Export produce, named for the book.
 *     readings/<key>.jsonl    the bank of the model's per-page answers
 *     history/<tree>.json     the undo ledger of the working copy of that name,
 *                             bound to the generation that made it
 *
 * ── The rule the layout exists for ───────────────────────────────────────────
 *
 * EVERY DOCUMENT HAS TWO LAYERS: an origin that is never written, and a live
 * copy that is what the user means by "the PDF" or "the EPUB". Saving writes the
 * live copy. The origin is what makes stepping back, or starting over, possible
 * at all — and for a scanned book the imported file may be the only copy of that
 * scan that will ever exist.
 *
 * `generated/` is the second origin and it is sacrosanct on its own argument: it
 * is the single record of what the model ACTUALLY READ, every curation decision
 * downstream is measured against it, and "start over" means throwing the working
 * tree away and unpacking it again from there.
 *
 * ── And the user never sees any of this ──────────────────────────────────────
 *
 * ONE DOCUMENT PER KIND. `Working Towards The Fuhrer. Kershaw, Ian. (1993).pdf`
 * and the matching `.epub`, as one unit. No `.generated`, no `.archive`, no
 * suffixes, no layer names anywhere a person can read them: every file in a
 * project is named from `manifest.stem`, which is the imported document's own
 * name with its extension taken off. The SLUG is for the directory and nothing
 * else, and `final/` is named for the book like everything else.
 *
 * ── The key ──────────────────────────────────────────────────────────────────
 *
 * `<slug>-<8 hex of the import's sha256>`, unchanged from the flat workspace it
 * replaces, and the reason it is unchanged is worth the paragraph:
 *
 *   - the hash is of the document's CONTENT, not of its path, so the same book
 *     lands in the same project no matter where the user dragged it from — a
 *     second run REPLACES the first rather than accumulating `book (1).epub`;
 *   - the READINGS bank keeps that key, so an interrupted run of a book that has
 *     since been moved or renamed still resumes. That bank is GPU-hours; a key
 *     a rename could break would silently cost them;
 *   - and the flat files this migrates FROM already carry it, which is what
 *     makes adoption a regrouping rather than a re-hash of everything on disk.
 *
 * ── Nothing is deleted ───────────────────────────────────────────────────────
 *
 * Re-running a conversion does not clobber the origin it replaces — it rotates
 * it into `generated/archived-<timestamp>/` (`rotateGenerated`), and the working
 * tree unpacked from it goes into the same folder so the next open unpacks the
 * NEW book rather than reopening the old one's edits.
 *
 * A GENERATED BOOK IS ARCHIVED AND A READINGS BANK IS NOT, and the difference is
 * deliberate rather than an inconsistency (docs/BANK-LIFECYCLE.md §5). A
 * generated EPUB can carry a working tree with a person's text edits in it, and
 * labour is kept forever. A bank is a machine's answers: the engine writes the
 * replacement beside the old one and renames it into place only when the run has
 * succeeded, so nothing is destroyed until its successor exists and `readings/`
 * grows no `archived-<stamp>/` hoards.
 *
 * ── Except when the user says so ─────────────────────────────────────────────
 *
 * `deleteProject` is the single exception and the rule survives it intact, because
 * the rule was never "these bytes are sacred" — it is that THIS APP does not get
 * to decide a person's work is finished with. Every rotation above is Foundry
 * choosing, on its own, what to do with something it was not asked about; a
 * delete from Home is the user choosing, about their own folder, having been told
 * in words what is in it. Archiving instead would leave a directory they would
 * then have to go and delete by hand, which is not a kindness, it is a lie about
 * what the button did.
 */
export { ProjectError, projectsDir, projectDirOf, isManaged, isArchived, exportInTray, slugify, stemOf, contentKey } from './projects-paths';
export { onProjectsChanged, readManifest, recordMintMeta, generatedFileFor, generatedRoleFor } from './projects-manifest';
export { onImportLanded, createCaptureProject, importDocument } from './projects-import';
export type { ImportedDocument } from './projects-import';
export { ledgerOf, curationsDir, metadataDir, opsDir, opsPayloadFor, analysisDir, reportForAnalysis, currentArrangement, readStepLedger, goToStep } from './projects-steps';
export type { LedgerView } from './projects-steps';
export { describeStepDelete, deletableStep, deleteStep } from './projects-step-delete';
export type { StepSubject } from './projects-step-delete';
export { recordMint, healMintedArchive } from './projects-mint';
export { recordCuration, recordMetadata, recordBookEdit, recordBookEditAmend, metadataForProduct, positionStepId, recordCorrection } from './projects-edits';
export { readingBank, bankForPosition, bookFileFor, translationBookFileFor, derivedDirFor, narrationStampFileFor, analysisRankFileFor, cleanTriageFileFor, imagesDirFor } from './projects-files';
export { bookAtPosition, documentAtPosition, documentAtStep, standForDocument } from './projects-positions';
export { readingIsComplete, bankForReading, recordsForTextPass, pendingRecordsForTextPass } from './projects-planning';
export type { PlannedBank, PlannedTranslation } from './projects-planning';
export { rotateGenerated, restoreRotation, rotateFinal, restoreFinalRotation } from './projects-rotation';
export type { Rotation, FinalRotation } from './projects-rotation';
export { readAnalysisReport, recordAnalysis, recordTextPass } from './projects-landing-text';
export { recordGenerated, recordFinal, finalDir, recordReading, completionMarkerFor, archiveFileOf } from './projects-landing';
export { noteProjectTitle, listProjects } from './projects-list';
export { inspectProject, deleteProject, deleteDocument, documentAssets } from './projects-delete';
export type { ProjectInventory, DocumentAssets, DocumentRemoval } from './projects-delete';

