/**
 * vlm/bridge — the seam between foundry and MLX.
 *
 * One `vlm_page.py` per BOOK: the config goes in on stdin, one JSON object per
 * page comes back on stdout, and this module turns that stream into pages while
 * reporting each one as it lands. The header of `vlm_page.py` carries the
 * reasons for the shape; what lives here is everything that must FAIL rather
 * than be accepted.
 *
 * Four ways a page is refused, and all four are the same refusal:
 *
 *  - **the process exits nonzero** — the tail of its stderr is the message
 *  - **a page hit the token cap** (`finishReason === 'length'`) — the model was
 *    still writing when it was cut off, so that page is TRUNCATED. Half a page
 *    reads as a whole one in the finished book: the prose simply stops
 *    mid-sentence and nothing anywhere says it was cut
 *  - **a page came back empty** — a blank page in a book is a claim, and a
 *    model that answered with nothing did not make it
 *  - **the pages do not arrive once each, in order** — a book assembled out of
 *    a stream that skipped page nine is wrong in a way no reader can see. A
 *    page named by `excludePages` is expected NOT to arrive; every other page
 *    of the document is, exactly once, in ascending order
 *
 * The interpreter is not searched for on PATH. `python3` on this machine is a
 * Homebrew build with neither mlx-vlm nor PyMuPDF in it, and MLX lives in one
 * specific environment; picking up the wrong interpreter would produce an
 * ImportError from a subprocess for a package the operator installed an hour
 * ago somewhere else. So the candidates are named, tried in order, and a
 * failure prints every one of them.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// The helper's source, embedded at build time so a compiled binary carries it.
// See `scriptPath()` for why this is text rather than a file on disk.
import VLM_PAGE_SOURCE from './vlm_page.py' with { type: 'text' };

import type { VlmModelDef } from './models.js';

export class VlmBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VlmBridgeError';
  }
}

/**
 * The pixel budget the MLX path hands the processor, and it is a measurement.
 *
 * dots.ocr's own processor allows 11,289,600 pixels, which at 200 dpi means a
 * page is passed through untouched — and costs about twice as long per page on
 * this machine as the same page capped here, with no difference anybody could
 * see in the text or in the boxes. So the MLX path caps it, and the SAME number
 * goes to the dialect: the model answers in the frame the processor resized to,
 * and a box scaled with the wrong budget is a few per cent out everywhere.
 *
 * The endpoint path does NOT cap. A vLLM server was started with a processor
 * config and this program did not choose it; the model's own cap is the honest
 * assumption there, and it makes the scale 1.0 at 200 dpi.
 */
export const MLX_MAX_PIXELS = 2_000_000;

/** One page, as the model and the rasteriser measured it. */
export interface VlmPage {
  number: number;
  /** Rendered pixel size, at the pinned dpi. */
  width: number;
  height: number;
  renderSeconds: number;
  /** Inference only — the render is separate because they scale differently. */
  seconds: number;
  chars: number;
  tokens: number;
  finishReason: string | null;
  /** The model's answer, verbatim, in its own dialect. Empty when not read. */
  text: string;
  /**
   * The page was rendered and NOT read — either its answer was already on disk
   * (`--readings`) or this run only wanted the render (the endpoint path).
   * Never a failure, and never confused with one: an unreadable page is in
   * `VlmRunResult.unreadable`, by name.
   */
  skipped: boolean;
}

/** A page the model could not usefully answer for. Always carries a reason. */
export interface VlmUnreadablePage {
  number: number;
  reason: string;
}

/** What the PDF says about itself, before a model has seen a page of it. */
export interface VlmDocumentInfo {
  pages: number;
  /** Empty when the PDF does not carry one. Never invented. */
  title: string;
  author: string;
  widthPt: number;
  heightPt: number;
}

export interface VlmRunResult {
  document: VlmDocumentInfo;
  pages: VlmPage[];
  /** Empty unless `unreadablePages: 'record'` — see the option. */
  unreadable: VlmUnreadablePage[];
  /** Process start through model resident. The fixed cost, paid once. */
  loadSeconds: number;
  renderSeconds: number;
  inferenceSeconds: number;
  /**
   * macOS reports this in bytes; the helper normalises Linux's kilobytes.
   *
   * NULL on Windows, where there is no `resource` module to ask. That is a real
   * absence — the platform cannot answer — and it is carried as null rather than
   * as 0, which would be indistinguishable from a run that used no memory.
   */
  peakRssBytes: number | null;
}

export interface VlmRunOptions {
  pdfPath: string;
  model: VlmModelDef;
  dpi: number;
  /** Explicit interpreter, from `--python`. Tried first and never skipped. */
  python?: string;
  /** Keep the page renders here instead of deleting them. */
  rendersDir?: string;
  /**
   * The processor's pixel budget for this run. Absent means the model's own,
   * which is what the model card says and what a server would use.
   */
  maxPixels?: number;
  /**
   * Render every page and read NONE of them — no model is loaded at all.
   *
   * The endpoint path (`endpoint.ts`) does its own inference over HTTP but
   * still needs the pages rasterised, and rasterising is PyMuPDF's job on the
   * far side of this seam (see `vlm_page.py`). One flag rather than a second
   * script.
   */
  renderOnly?: boolean;
  /**
   * Also write a grayscale PGM beside each PNG.
   *
   * The dots dialect measures ink in the render to decide a page-turn join, and
   * PGM is the one raster format foundry reads with no decoder (`scan/pgm.ts`).
   * PyMuPDF is already holding the pixmap, so the conversion is free here and
   * would be a dependency anywhere else.
   */
  grayscale?: boolean;
  /**
   * Pages whose answers are already in hand. Rendered, never inferred.
   *
   * NOT `excludePages`, and the difference is the difference between a cache
   * and a curation: a page in this list is still part of the book and still
   * arrives, it just costs no GPU.
   */
  skipPages?: readonly number[];
  /**
   * Pages that are not part of the book at all — `--skip-pages`.
   *
   * Never rasterised, never read, never reported: a page somebody deleted in a
   * picker costs nothing, which is the entire point of passing the deletions
   * rather than converting a physically-subsetted PDF (see `pages.ts`). Such a
   * page never appears in `VlmRunResult.pages`, and the pages that survive
   * keep their true PDF numbers rather than being renumbered around the gap.
   */
  excludePages?: readonly number[];
  /**
   * What an unusable page does: stop the run, or be recorded and carried on
   * past.
   *
   * `stop` is the default and the rule for the markdown dialects: their answer
   * is prose, a short page is invisible in the finished book, and the run has
   * to fail where a person can see it. `record` is for a dialect whose answer
   * is per-page structured data that a report can name and a cached re-read can
   * repair — see the header of `dots.ts`.
   */
  unreadablePages?: 'stop' | 'record';
  /** Called as each page lands, for progress. */
  onPage?: (page: VlmPage, total: number) => void;
  onLoaded?: (seconds: number) => void;
}

/**
 * Where `vlm_page.py` is.
 *
 * The helper is EMBEDDED as text (`with { type: 'text' }`), so a compiled
 * binary carries its own copy and materialises it beside the machine's cache
 * on first use. The earlier reading — that a Python environment is a
 * prerequisite anyway, so the script may as well be one too — conflated two
 * different things. The ENVIRONMENT is the operator's: their python, their
 * mlx-vlm, their PyMuPDF, and foundry can only name what it could not find.
 * The SCRIPT is foundry's own source, versioned with the bridge that speaks to
 * it, and a release that ships the caller without the callee is incomplete.
 * `bun build --compile` cannot hand an external interpreter a path inside the
 * executable (`/$bunfs/root/vlm_page.py`, which is what a user got), so the
 * text is written out to a real file that python can open.
 *
 * The materialised copy is named for the CONTENT's hash: a foundry that
 * changed the helper writes a different file rather than running the old one
 * out of a cache, and two foundry versions on one machine cannot fight over
 * the same path.
 */
function scriptPath(): string {
  const override = process.env['FOUNDRY_VLM_SCRIPT'];
  if (override) {
    if (!fs.existsSync(override)) {
      throw new VlmBridgeError(`FOUNDRY_VLM_SCRIPT points at ${override}, which does not exist`);
    }
    return override;
  }
  // Source tree: the file beside this module IS the helper, and running it
  // directly is what makes an edit take effect without a build step.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const beside = path.join(here, 'vlm_page.py');
  if (fs.existsSync(beside)) return beside;

  const digest = createHash('sha256').update(VLM_PAGE_SOURCE).digest('hex').slice(0, 16);
  const dir = path.join(os.tmpdir(), 'foundry-vlm');
  const materialised = path.join(dir, `vlm_page-${digest}.py`);
  if (!fs.existsSync(materialised)) {
    fs.mkdirSync(dir, { recursive: true });
    // Written beside the target and renamed: two foundry runs starting at once
    // must never hand python a half-written script.
    const partial = `${materialised}.${process.pid}.part`;
    fs.writeFileSync(partial, VLM_PAGE_SOURCE, 'utf8');
    fs.renameSync(partial, materialised);
  }
  return materialised;
}

/**
 * The interpreter, in order of how sure we are about it.
 *
 * `vlmtest` is the conda environment mlx-vlm and PyMuPDF were installed into on
 * the machine this mode was built and measured on. It is a name, not a
 * requirement: `--python` and `FOUNDRY_VLM_PYTHON` both override, and the error
 * below names every path that was tried so an operator with a different
 * environment knows exactly what to pass.
 */
const CONDA_ROOTS = [
  '/opt/homebrew/Caskroom/miniconda/base',
  path.join(os.homedir(), 'miniconda3'),
  path.join(os.homedir(), 'miniforge3'),
  path.join(os.homedir(), 'anaconda3'),
];

function resolvePython(explicit?: string): string {
  const named = explicit ?? process.env['FOUNDRY_VLM_PYTHON'];
  if (named) {
    if (!fs.existsSync(named)) {
      throw new VlmBridgeError(`--python ${named} does not exist`);
    }
    return named;
  }
  const candidates = CONDA_ROOTS.map((root) => path.join(root, 'envs', 'vlmtest', 'bin', 'python'));
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new VlmBridgeError(
    'no Python with MLX was found. This mode needs an interpreter with mlx-vlm and PyMuPDF'
    + ' installed; pass it with --python or FOUNDRY_VLM_PYTHON. Tried:\n'
    + candidates.map((c) => `  ${c}`).join('\n'),
  );
}

/** Read every page of the PDF with the model, in one interpreter. */
export async function readPagesWithVlm(opts: VlmRunOptions): Promise<VlmRunResult> {
  if (!fs.existsSync(opts.pdfPath)) {
    throw new VlmBridgeError(`no such PDF: ${opts.pdfPath}`);
  }
  const python = resolvePython(opts.python);
  const script = scriptPath();

  const config = JSON.stringify({
    mode: opts.renderOnly ? 'render' : 'read',
    pdf: path.resolve(opts.pdfPath),
    repo: opts.model.repo,
    // Verbatim, and it travels as a JSON string on stdin rather than as an
    // argv word: no shell, no quoting, no truncation in a process listing.
    prompt: opts.model.prompt,
    dpi: opts.dpi,
    maxTokens: opts.model.maxTokens,
    grayscale: opts.grayscale === true,
    skipPages: opts.skipPages ?? [],
    excludePages: opts.excludePages ?? [],
    ...(opts.maxPixels !== undefined ? { maxPixels: opts.maxPixels } : {}),
    ...(opts.rendersDir ? { rendersDir: path.resolve(opts.rendersDir) } : {}),
  });

  const proc = spawn(python, [script], { stdio: ['pipe', 'pipe', 'pipe'] });

  let document: VlmDocumentInfo | null = null;
  let loadSeconds = 0;
  let totals: { renderSeconds: number; inferenceSeconds: number; peakRssBytes: number | null } | null = null;
  const pages: VlmPage[] = [];
  const stderrTail: string[] = [];

  const finished = new Promise<void>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let failure: Error | null = null;

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      let nl = stdout.indexOf('\n');
      while (nl !== -1) {
        const line = stdout.slice(0, nl);
        stdout = stdout.slice(nl + 1);
        nl = stdout.indexOf('\n');
        if (line.trim().length === 0) continue;
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          switch (event['event']) {
            case 'document':
              document = event as unknown as VlmDocumentInfo;
              break;
            case 'loaded':
              loadSeconds = event['seconds'] as number;
              opts.onLoaded?.(loadSeconds);
              break;
            case 'page': {
              const page = event as unknown as VlmPage;
              pages.push(page);
              opts.onPage?.(page, document?.pages ?? 0);
              break;
            }
            case 'done':
              totals = {
                renderSeconds: event['renderSeconds'] as number,
                inferenceSeconds: event['inferenceSeconds'] as number,
                peakRssBytes: (event['peakRssBytes'] ?? null) as number | null,
              };
              break;
            default:
              throw new VlmBridgeError(`the helper sent an event this bridge does not know: ${line}`);
          }
        } catch (err) {
          // Recorded and rethrown at exit rather than here: killing the process
          // mid-stream would lose the stderr that usually explains it.
          failure ??= err instanceof Error ? err : new Error(String(err));
        }
      }
    });

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      let nl = stderr.indexOf('\n');
      while (nl !== -1) {
        const line = stderr.slice(0, nl);
        stderr = stderr.slice(nl + 1);
        nl = stderr.indexOf('\n');
        stderrTail.push(line);
        if (stderrTail.length > 40) stderrTail.shift();
        process.stderr.write(`${line}\n`);
      }
    });

    proc.on('error', (err) => reject(
      new VlmBridgeError(`could not start ${python}: ${err.message}`),
    ));
    proc.on('close', (code) => {
      if (failure) return reject(failure);
      if (code !== 0) {
        return reject(new VlmBridgeError(
          `${path.basename(script)} exited ${code}. Its last output:\n`
          + stderrTail.map((l) => `  ${l}`).join('\n'),
        ));
      }
      resolve();
    });
  });

  proc.stdin.write(config);
  proc.stdin.end();
  await finished;

  if (!document) throw new VlmBridgeError('the helper exited without describing the document');
  if (!totals) throw new VlmBridgeError('the helper exited without a done event — the run is incomplete');
  const doc: VlmDocumentInfo = document;
  const sums: { renderSeconds: number; inferenceSeconds: number; peakRssBytes: number | null } = totals;

  /*
   * The pages this run was ever going to be about, in order.
   *
   * "All of them" is the ordinary answer, and then this is `1..doc.pages` and
   * the two checks below are the ones that have always been here. With
   * `--skip-pages` it is that list with the gaps taken out — and the gaps are
   * what the checks have to be stated against, because a helper that silently
   * dropped page nine and a helper that was TOLD to drop page nine produce
   * exactly the same stream.
   */
  const excluded = new Set(opts.excludePages ?? []);
  const expected: number[] = [];
  for (let page = 1; page <= doc.pages; page += 1) {
    if (!excluded.has(page)) expected.push(page);
  }

  if (pages.length !== expected.length) {
    throw new VlmBridgeError(
      excluded.size === 0
        ? `the PDF has ${doc.pages} pages and the helper reported ${pages.length} of them`
        : `the PDF has ${doc.pages} pages with ${excluded.size} skipped, so ${expected.length}`
          + ` were expected and the helper reported ${pages.length}`,
    );
  }

  const record = opts.unreadablePages === 'record';
  const unreadable: VlmUnreadablePage[] = [];
  const usable: VlmPage[] = [];
  for (const [index, page] of pages.entries()) {
    if (page.number !== expected[index]) {
      throw new VlmBridgeError(
        `pages arrived out of order: expected page ${expected[index]}, got page ${page.number}`,
      );
    }
    // A skipped page was never offered to the model on this run, so nothing
    // about its answer is this run's to judge.
    if (page.skipped) { usable.push(page); continue; }

    const truncated = page.finishReason === 'length'
      ? `it hit the ${opts.model.maxTokens}-token cap, so the model was still writing when it was`
        + ' cut off. That page is truncated and the book would be missing the end of it with'
        + ' nothing to show for it.'
      : null;
    const empty = page.text.trim().length === 0
      ? `it came back empty from ${opts.model.id}. A blank page in a book is a claim about the`
        + ' source, and nothing here can make it.'
      : null;
    const reason = truncated ?? empty;
    if (reason === null) { usable.push(page); continue; }
    if (!record) throw new VlmBridgeError(`page ${page.number}: ${reason}`);
    unreadable.push({ number: page.number, reason });
  }

  return {
    document: doc,
    pages: usable,
    unreadable,
    loadSeconds,
    renderSeconds: sums.renderSeconds,
    inferenceSeconds: sums.inferenceSeconds,
    peakRssBytes: sums.peakRssBytes,
  };
}

// ── cropping a picture out of a page ────────────────────────────────────────

/** One picture to cut out of a page render, in render pixels. */
export interface VlmCropRequest {
  page: number;
  box: { x1: number; y1: number; x2: number; y2: number };
  /** The file name it gets, inside the container. */
  name: string;
}

export interface VlmCropResult {
  name: string;
  mediaType: string;
  data: Uint8Array;
}

/**
 * Cut the pictures out of the renders, in one more turn of the same seam.
 *
 * A second short subprocess rather than a PNG codec in TypeScript, and that is
 * the same decision `src/scan/pgm.ts` records: an image decoder is a dependency
 * in the most portable part of the program, and this mode ALREADY requires a
 * Python with PyMuPDF in it. The boxes are not known until the pages have been
 * parsed, which is why it cannot be folded into the read pass.
 */
export async function cropPageRenders(opts: {
  pdfPath: string;
  dpi: number;
  cropsDir: string;
  requests: readonly VlmCropRequest[];
  python?: string;
}): Promise<VlmCropResult[]> {
  if (opts.requests.length === 0) return [];
  const python = resolvePython(opts.python);
  const script = scriptPath();
  const cropsDir = path.resolve(opts.cropsDir);

  const config = JSON.stringify({
    mode: 'crop',
    pdf: path.resolve(opts.pdfPath),
    dpi: opts.dpi,
    cropsDir,
    crops: opts.requests.map((r) => ({
      page: r.page,
      name: r.name,
      box: [r.box.x1, r.box.y1, r.box.x2, r.box.y2],
    })),
  });

  const proc = spawn(python, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
  const written: { name: string; path: string }[] = [];
  const stderrTail: string[] = [];

  const finished = new Promise<void>((resolve, reject) => {
    let stdout = '';
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      let nl = stdout.indexOf('\n');
      while (nl !== -1) {
        const line = stdout.slice(0, nl);
        stdout = stdout.slice(nl + 1);
        nl = stdout.indexOf('\n');
        if (line.trim().length === 0) continue;
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event['event'] === 'crop') {
          written.push({ name: event['name'] as string, path: event['path'] as string });
        }
      }
    });
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.length === 0) continue;
        stderrTail.push(line);
        if (stderrTail.length > 40) stderrTail.shift();
      }
    });
    proc.on('error', (err) => reject(new VlmBridgeError(`could not start ${python}: ${err.message}`)));
    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new VlmBridgeError(
          `${path.basename(script)} exited ${code} while cropping. Its last output:\n`
          + stderrTail.map((l) => `  ${l}`).join('\n'),
        ));
      }
      resolve();
    });
  });

  proc.stdin.write(config);
  proc.stdin.end();
  await finished;

  if (written.length !== opts.requests.length) {
    throw new VlmBridgeError(
      `${opts.requests.length} pictures were asked for and ${written.length} were written`,
    );
  }
  return written.map((entry) => ({
    name: entry.name,
    mediaType: 'image/png',
    data: new Uint8Array(fs.readFileSync(entry.path)),
  }));
}
