/**
 * capture-pdf-stage — where a dropped PDF's pages land as PNGs.
 */
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { writeAtomically } from './atomic';
/*
 * THE TEMP DIR AND THE IMAGE CODEC COME THROUGH THE PLATFORM PORT (2026-11-04).
 * They were `app.getPath('temp')` and `nativeImage`, the only two reasons capture.ts
 * imported Electron; `mountFoundry` hands over Electron's own `nativeImage`,
 * so every decode, resize and encode below runs exactly the code it ran before.
 */
import { tempDir } from './platform';
import { CaptureError } from './capture-paths';

// ─────────────────────────────────────────────────────────────────────────────
// The PDF staging area
// ─────────────────────────────────────────────────────────────────────────────

/*
 * ── A DROPPED PDF BECOMES A PILE OF PNGs, AND THIS IS WHERE THEY LAND ───────
 *
 * Owen, 2026-09-10: *"give me the ability to drag/drop a pdf into a new book,
 * not just images. if i do, it should take each page as an individual image."*
 *
 * WHO DOES WHAT, and it is the mint's split read backwards. THE RENDERER
 * rasterizes, because pdf.js is over there and has been since the viewer was
 * written — main has no rasterizer at all and adding one would be a second
 * PDF engine in a second language for a job the first one already does. MAIN
 * puts the pages on disk and hands back paths, because `capture:intake` takes
 * paths and this stage's whole design is that a page of an exploded PDF is
 * indistinguishable, from intake onward, from a photograph off a phone.
 *
 * ONE PAGE AT A TIME ACROSS THE BRIDGE, for `mintPage`'s reason exactly: a
 * 300-page scan is gigabytes of PNG, and a call that carried the book would put
 * all of it in one heap in a process that also has an app in it.
 *
 * ── WHY THE SYSTEM TEMP DIRECTORY, WHEN THE MINT REFUSED IT ─────────────────
 *
 * The mint stages inside the project on the argument that a visible mess in one
 * folder beats an invisible one in %TEMP%. That argument does not reach here,
 * because THERE MAY BE NO PROJECT YET: a PDF dropped on Home explodes onto the
 * intake workspace, which is a table of loose images that has not been told what
 * book it is — the whole point of it (`IntakeWorkspaceService`). Staging inside
 * a project would mean inventing one before the person had named anything, which
 * is precisely the commitment the workspace exists to defer.
 *
 * So one rule for both doors rather than two, and the mess is swept rather than
 * left: `pdfStageBegin` deletes every staging directory that is not live in THIS
 * run before it makes a new one, so a crash mid-explosion costs the next drop
 * one `rm` and nothing else. There is no quit hook to forget to register and no
 * age heuristic to be wrong about.
 */

/** Where every staging directory of every run of this app lives, under %TEMP%. */
export const PDF_STAGE = 'foundry-pdf-pages';

/** The staging directories this run of the app is holding open, by id. */
export const pdfStages = new Map<string, string>();

export function pdfStageRoot(): string {
  return path.join(tempDir(), PDF_STAGE);
}

/**
 * Open a staging directory for one PDF and answer with its id.
 *
 * THE SWEEP HAPPENS HERE, BEFORE THE MKDIR. See the section header: it is the
 * whole of the cleanup story, and doing it on the way IN means it runs at the
 * one moment somebody is already waiting for a directory to appear.
 */
export async function pdfStageBegin(): Promise<string> {
  const root = pdfStageRoot();
  await fsp.mkdir(root, { recursive: true });

  const live = new Set(pdfStages.values());
  // Best effort throughout: a leftover we cannot delete is wasted disk in a
  // directory the OS already treats as disposable, and refusing this drop over
  // it would be the tail wagging the dog.
  const leftovers = await fsp.readdir(root).catch(() => [] as string[]);
  for (const name of leftovers) {
    const each = path.join(root, name);
    if (live.has(each)) continue;
    await fsp.rm(each, { recursive: true, force: true }).catch(() => { /* best effort */ });
  }

  const stageId = randomUUID();
  const staging = path.join(root, stageId);
  await fsp.mkdir(staging, { recursive: true });
  pdfStages.set(stageId, staging);
  return stageId;
}

/**
 * One rasterized page, as the renderer finished it. Answers where it landed.
 *
 * THE NAME IS THE RENDERER'S AND IS CHECKED RATHER THAN TRUSTED. It becomes the
 * card's label and, one step later, `path.basename` of a file intake copies — so
 * a name carrying a separator or a `..` would be a renderer choosing where main
 * writes. It is a basename or it is refused.
 */
export async function pdfStagePage(stageId: string, name: string, png: ArrayBuffer): Promise<string> {
  const staging = pdfStages.get(stageId);
  if (staging === undefined) {
    throw new CaptureError(
      `There is no PDF being read under ${stageId}. It was finished, given up on, or belongs to a `
      + 'run of this app that has since closed.',
    );
  }
  if (name !== path.basename(name) || name === '.' || name === '..' || name.length === 0) {
    throw new CaptureError(`${name} is not a page name — a staged page is a plain filename.`);
  }
  const target = path.join(staging, name);
  await writeAtomically(target, Buffer.from(png));
  return target;
}

/**
 * The pages have been copied into a project (or abandoned); the staging goes.
 *
 * SEPARATE FROM THE LAST PAGE, because the two doors let go at different
 * moments. A drop on a light table intakes immediately and releases in the same
 * breath; a drop on Home leaves the pages on the workspace table until somebody
 * says which book they are, which may be an hour later or never. The caller
 * knows which it is; this module does not and must not guess.
 *
 * Releasing twice is releasing once — the second call finds no session and says
 * nothing, the same courtesy `mintAbort` extends to giving up twice.
 */
export async function pdfStageRelease(stageId: string): Promise<void> {
  const staging = pdfStages.get(stageId);
  if (staging === undefined) return;
  pdfStages.delete(stageId);
  await fsp.rm(staging, { recursive: true, force: true }).catch(() => { /* best effort */ });
}
