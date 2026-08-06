/**
 * vlm/convert — the whole of `foundry vlm-convert`, in order.
 *
 * PDF in, EPUB out, four phases: one Python process reads every page with the
 * model (`bridge.ts`), each page's answer is parsed in its own dialect
 * (`dialect.ts`), the blocks are assembled into a book (`epub.ts`), and the
 * bytes are written. Nothing here touches a run directory, and no stage of the
 * pipeline in PIPELINE.md is reachable from this file — that separation is the
 * point of the mode, not an omission (see `models.ts`).
 *
 * EVERY PHASE IS TIMED AND EVERY TIME IS REPORTED. This mode's cost is minutes
 * of GPU per book, and the only honest way to decide whether it is usable on a
 * 300-page book is to know where the minutes went: a model load is paid once, a
 * render is milliseconds, and inference is everything else. The numbers go to
 * stderr as the run proceeds, which is foundry's convention and also the only
 * way a person watching a forty-minute run can tell it is still working.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { readPagesWithVlm, type VlmPage } from './bridge.js';
import { parsePage } from './dialect.js';
import { buildVlmEpub, type VlmChapter, type VlmPageBlocks } from './epub.js';
import { requireVlmModel, type VlmModelDef } from './models.js';

/**
 * The resolution every page is rendered at, and not a setting.
 *
 * The default model was measured on 200 dpi pages — 1300×2112 for a 468×760 pt
 * page — and a model's behaviour moves with its input resolution. The same pin,
 * for the same reason, as the rest of foundry (ARCHITECTURE §5).
 */
export const VLM_DPI = 200;

export interface VlmConvertOptions {
  pdfPath: string;
  outPath: string;
  modelId: string;
  /** Explicit interpreter. See `bridge.ts` for what is tried without one. */
  python?: string;
  /** Keep the page renders here — they are deleted after each page otherwise. */
  rendersDir?: string;
  /**
   * `dc:language`, which EPUB requires and no model reports.
   *
   * DECLARED, NOT DETECTED. The scan pipeline derives it from the tessdata a
   * book was recognized with, which is a decision somebody made about that
   * book; nothing equivalent exists here, so it is an option with a default and
   * the help says so.
   */
  language: string;
  log: (message: string) => void;
}

export interface VlmConvertReport {
  model: VlmModelDef;
  outPath: string;
  bytes: number;
  title: string;
  author: string;
  chapters: VlmChapter[];
  pages: VlmPage[];
  /** Furniture the dialect removed: folios, running feet, watermarks. */
  droppedFurniture: number;
  blocks: number;
  timings: {
    loadSeconds: number;
    renderSeconds: number;
    inferenceSeconds: number;
    parseSeconds: number;
    xhtmlSeconds: number;
    zipSeconds: number;
    writeSeconds: number;
    totalSeconds: number;
  };
  peakRssBytes: number;
}

export async function vlmConvert(opts: VlmConvertOptions): Promise<VlmConvertReport> {
  const started = Date.now();
  const model = requireVlmModel(opts.modelId);
  const pdfPath = path.resolve(opts.pdfPath);
  const outPath = path.resolve(opts.outPath);

  opts.log(`vlm-convert: ${model.id} (${model.repo}), pages rendered at ${VLM_DPI} dpi`);

  const run = await readPagesWithVlm({
    pdfPath,
    model,
    dpi: VLM_DPI,
    ...(opts.python ? { python: opts.python } : {}),
    ...(opts.rendersDir ? { rendersDir: opts.rendersDir } : {}),
    onLoaded: (seconds) => opts.log(`vlm-convert: model resident in ${seconds.toFixed(1)}s`),
    onPage: (page, total) => opts.log(
      `vlm-convert: page ${page.number}/${total} — ${page.width}x${page.height}, `
      + `${page.chars} chars, ${page.tokens} tokens, `
      + `${page.renderSeconds.toFixed(2)}s render, ${page.seconds.toFixed(1)}s inference`,
    ),
  });
  opts.log(
    `vlm-convert: ${run.pages.length} pages read — ${run.loadSeconds.toFixed(1)}s load, `
    + `${run.renderSeconds.toFixed(1)}s render, ${run.inferenceSeconds.toFixed(1)}s inference`,
  );

  const parseStarted = Date.now();
  const pages: VlmPageBlocks[] = [];
  let droppedFurniture = 0;
  for (const page of run.pages) {
    const parsed = parsePage(page.text, model.dialect, page.number);
    droppedFurniture += parsed.dropped;
    pages.push({ number: page.number, blocks: parsed.blocks });
  }
  const parseSeconds = (Date.now() - parseStarted) / 1000;
  const blocks = pages.reduce((sum, p) => sum + p.blocks.length, 0);
  opts.log(
    `vlm-convert: ${blocks} blocks parsed in ${parseSeconds.toFixed(2)}s, `
    + `${droppedFurniture} page-furniture tag(s) dropped`,
  );

  /*
   * The title, in the order of who actually knows it.
   *
   * The PDF's own metadata first — a born-digital book usually carries the
   * publisher's title — then the filename stem, which is a FACT about the file
   * rather than a guess about the book. The model is never asked: it can read
   * the words on a title page but it cannot know which of them is the title,
   * and a heading promoted to `dc:title` would be a guess wearing a metadata
   * field's clothes.
   */
  const stem = path.basename(pdfPath).replace(/\.[^.]+$/, '').trim();
  const title = run.document.title.length > 0 ? run.document.title : stem;
  const identifier = `urn:sha256:${crypto.createHash('sha256').update(fs.readFileSync(pdfPath)).digest('hex')}`;

  const built = buildVlmEpub({
    title,
    ...(run.document.author.length > 0 ? { author: run.document.author } : {}),
    language: opts.language,
    identifier,
  }, pages);

  const writeStarted = Date.now();
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, built.bytes);
  const writeSeconds = (Date.now() - writeStarted) / 1000;

  opts.log(
    `vlm-convert: ${built.chapters.length} chapters, ${built.bytes.length} bytes — `
    + `${built.xhtmlSeconds.toFixed(2)}s XHTML, ${built.zipSeconds.toFixed(2)}s zip, `
    + `${writeSeconds.toFixed(2)}s write`,
  );
  opts.log(`vlm-convert: wrote ${outPath}`);

  return {
    model,
    outPath,
    bytes: built.bytes.length,
    title,
    author: run.document.author,
    chapters: built.chapters,
    pages: run.pages,
    droppedFurniture,
    blocks,
    timings: {
      loadSeconds: run.loadSeconds,
      renderSeconds: run.renderSeconds,
      inferenceSeconds: run.inferenceSeconds,
      parseSeconds,
      xhtmlSeconds: built.xhtmlSeconds,
      zipSeconds: built.zipSeconds,
      writeSeconds,
      totalSeconds: (Date.now() - started) / 1000,
    },
    peakRssBytes: run.peakRssBytes,
  };
}
