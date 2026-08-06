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
 *    a stream that skipped page nine is wrong in a way no reader can see
 *
 * The interpreter is not searched for on PATH. `python3` on this machine is a
 * Homebrew build with neither mlx-vlm nor PyMuPDF in it, and MLX lives in one
 * specific environment; picking up the wrong interpreter would produce an
 * ImportError from a subprocess for a package the operator installed an hour
 * ago somewhere else. So the candidates are named, tried in order, and a
 * failure prints every one of them.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { VlmModelDef } from './models.js';

export class VlmBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VlmBridgeError';
  }
}

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
  /** The model's answer, verbatim, in its own dialect. */
  text: string;
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
  /** Process start through model resident. The fixed cost, paid once. */
  loadSeconds: number;
  renderSeconds: number;
  inferenceSeconds: number;
  /** macOS reports this in bytes; the helper normalises Linux's kilobytes. */
  peakRssBytes: number;
}

export interface VlmRunOptions {
  pdfPath: string;
  model: VlmModelDef;
  dpi: number;
  /** Explicit interpreter, from `--python`. Tried first and never skipped. */
  python?: string;
  /** Keep the page renders here instead of deleting them. */
  rendersDir?: string;
  /** Called as each page lands, for progress. */
  onPage?: (page: VlmPage, total: number) => void;
  onLoaded?: (seconds: number) => void;
}

/**
 * Where `vlm_page.py` is, next to this module.
 *
 * NOT EMBEDDED IN THE COMPILED BINARY, deliberately and visibly: a file bundled
 * by `bun build --compile` lives inside the executable and an external
 * interpreter cannot open it. This mode already requires a Python environment
 * with MLX in it, so it already requires something on the machine that is not
 * the binary; pretending otherwise would move the failure from here — where it
 * names the file — to a python that cannot find its script.
 */
function scriptPath(): string {
  const override = process.env['FOUNDRY_VLM_SCRIPT'];
  if (override) {
    if (!fs.existsSync(override)) {
      throw new VlmBridgeError(`FOUNDRY_VLM_SCRIPT points at ${override}, which does not exist`);
    }
    return override;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const script = path.join(here, 'vlm_page.py');
  if (!fs.existsSync(script)) {
    throw new VlmBridgeError(
      `the VLM helper is not at ${script}. It ships beside this module in the source tree and`
      + ' is not embedded in a compiled binary — point at it with FOUNDRY_VLM_SCRIPT.',
    );
  }
  return script;
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
    pdf: path.resolve(opts.pdfPath),
    repo: opts.model.repo,
    // Verbatim, and it travels as a JSON string on stdin rather than as an
    // argv word: no shell, no quoting, no truncation in a process listing.
    prompt: opts.model.prompt,
    dpi: opts.dpi,
    maxTokens: opts.model.maxTokens,
    ...(opts.rendersDir ? { rendersDir: path.resolve(opts.rendersDir) } : {}),
  });

  const proc = spawn(python, [script], { stdio: ['pipe', 'pipe', 'pipe'] });

  let document: VlmDocumentInfo | null = null;
  let loadSeconds = 0;
  let totals: { renderSeconds: number; inferenceSeconds: number; peakRssBytes: number } | null = null;
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
                peakRssBytes: event['peakRssBytes'] as number,
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
  const sums: { renderSeconds: number; inferenceSeconds: number; peakRssBytes: number } = totals;

  if (pages.length !== doc.pages) {
    throw new VlmBridgeError(
      `the PDF has ${doc.pages} pages and the model answered for ${pages.length} of them`,
    );
  }
  for (const [index, page] of pages.entries()) {
    if (page.number !== index + 1) {
      throw new VlmBridgeError(
        `pages arrived out of order: expected page ${index + 1}, got page ${page.number}`,
      );
    }
    if (page.finishReason === 'length') {
      throw new VlmBridgeError(
        `page ${page.number} hit the ${opts.model.maxTokens}-token cap, so the model was still`
        + ' writing when it was cut off. That page is truncated and the book would be missing'
        + ' the end of it with nothing to show for it.',
      );
    }
    if (page.text.trim().length === 0) {
      throw new VlmBridgeError(
        `page ${page.number} came back empty from ${opts.model.id}. A blank page in a book is a`
        + ' claim about the source, and nothing here can make it.',
      );
    }
  }

  return {
    document: doc,
    pages,
    loadSeconds,
    renderSeconds: sums.renderSeconds,
    inferenceSeconds: sums.inferenceSeconds,
    peakRssBytes: sums.peakRssBytes,
  };
}
