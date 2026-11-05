/**
 * workspace — which file inside which project a job is about to write.
 *
 * The OCR dialog used to ask for an output path. It no longer does, and this is
 * the module that made that possible: every conversion writes into the PROJECT
 * for the document it was run on, opens in a tab the moment it finishes, and is
 * copied out of there only when the user presses Save As. Nothing is ever
 * written beside the source PDF, so a folder of scans stays a folder of scans.
 *
 * This file used to own the naming too — a flat `<libraryDir>/workspace/` and a
 * key derived from the source's content. The key is unchanged and the reasons
 * for it are unchanged; both moved to electron/projects.ts, which is now the one
 * module that decides where anything lives. What is left here is the two
 * questions a JOB asks, and the answers are three paths inside one folder.
 *
 * ── Into `generated/`, unless it is terminal ─────────────────────────────────
 *
 * What the engine writes is an ORIGIN, not a working copy: it is the record of
 * what the model actually read, every curation decision downstream is measured
 * against it, and "start over" means unpacking a fresh working tree from it. So
 * a conversion writes into `generated/` and nothing ever writes there again —
 * a second run of the same book rotates the first aside rather than replacing
 * it (electron/projects.ts, `rotateGenerated`).
 *
 * AN EXPORT IS THE EXCEPTION AND IT PROVES THE SENTENCE. `planExport` runs the
 * identical rendering and aims it at `final/`, because what comes out is not an
 * origin: nothing is ever made from it, no working tree is unpacked from it, and
 * no step in anybody's history points at it. The user's ruling is what draws the
 * line — "it wont go into the working files as a step because it isnt the base for
 * new steps. its a terminal step. so its an export." Two plans, one composition,
 * and the layer is the whole of the difference.
 *
 * The FILE is named for the book and not for its role:
 * `Working Towards The Fuhrer. Kershaw, Ian. (1993).epub`, beside the `.pdf` of
 * the same name. The slug is for the project's directory and nothing else.
 *
 * ── The readings bank ────────────────────────────────────────────────────────
 *
 * `--readings` is passed on EVERY job, always. Not a checkbox: there is no
 * version of "read three hundred pages again because the window closed" that
 * anyone wants.
 *
 * WHICH BANK IS A QUESTION NOW, and it used to be a fact. It was
 * `<project>/readings/<key>.jsonl` composed from the key at both plans, on the
 * belief that a project has one bank — and a re-read asking for a different page
 * range branches by design, so a project can hold two readings and both of them
 * named that one file. Neither plan composes it any more: a rendering asks the
 * step at the position which bank its row is about, and `planReading` decides
 * whether this reading replaces one that exists or gets a bank of its own. Both
 * answers come from electron/projects.ts, which is the module that decides where
 * anything lives.
 *
 * WHAT CHANGED IS WHICH JOB IT IS THE PRODUCT OF. There are two plans below
 * because there are two jobs: `planReading` names the bank an OCR run FILLS, and
 * the rendering plans name the file written out of a bank that already exists.
 * They were one function while reading and writing were one act, and
 * that is precisely what made the output format a question somebody had to
 * answer before a single page had been read.
 *
 * A rendering passes `--reuse-readings` with it (electron/job-queue.ts), which
 * is the flag that keeps it free. Without it the engine treats a completed bank
 * beside its marker as a book to read AGAIN — its own rule, and the right one
 * for a command line, but the wrong answer to somebody pressing a button
 * labelled with a file format.
 *
 * The bank living IN the project also fixes something the flat layout got wrong
 * by accident. The engine's completion marker is named FOR ITS BANK —
 * `<key>.completed.json`, beside `<key>.jsonl` — and it did not always used to
 * be: it was once a bare `completed.json` in the bank's directory, so a folder
 * holding every book's bank held exactly one marker, belonging to whichever run
 * happened to finish last. One bank per directory would have fixed that on its
 * own; the engine fixed it properly by naming the marker after the thing it is
 * about (src/vlm/readings.ts), and this app reads it under that name
 * (`readingState`).
 */
export { planReading, planFacsimile } from './workspace-reading';
export { identifyExport, materializeExport } from './workspace-export';
export { renderingCompiles } from './workspace-rendering-guards';
export { identifyTranslation, materializeTranslation } from './workspace-translation';
export { identifySimplification, materializeSimplification } from './workspace-simplify';
export { identifyCleanup, materializeCleanup, materializeCleanTriage } from './workspace-cleanup';
export { identifyAnalysis, materializeAnalysis } from './workspace-analysis';

/*
 * `samePath` USED TO LIVE HERE and went with the rotation, which is worth a line
 * because the comparison itself is unchanged and only moved house.
 *
 * It existed for one caller: `planTranslation` asking whether the edition it was
 * about to rotate aside was also the file the run would read. That question is
 * now asked at the moment of rotating, in electron/job-queue.ts, and it is asked
 * there with the same case-folded resolve — the per-module path fold this
 * codebase keeps beside whoever needs it (electron/recents.ts has its own;
 * electron/overlays.ts had one too, until the overlay system went with
 * docs/RENDERER.md §7). A copy left here would be a helper for nobody.
 */
