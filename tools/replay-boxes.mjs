#!/usr/bin/env node
/**
 * replay-boxes — prove the moved boxes encoder emits the SAME prompt, byte for
 * byte, as the BookForge original it was moved from (MIGRATION §1).
 *
 *   node tools/replay-boxes.mjs
 *   node tools/replay-boxes.mjs --books michelle-remembers,rise-and-fall \
 *        --versions 1,2,3,4,5,6 --corpus /Volumes/Callisto/training/rubric \
 *        --reference /Volumes/Callisto/Projects/BookForgeApp
 *
 * Adapted from BookForgeApp `tools/rubric-replay.js`, which replays a labelled
 * book through the MODEL and scores it. This replays the same books through the
 * ENCODER and scores nothing: the only acceptable result is zero differences.
 * A prompt encoder is a trained-against artifact — a port that is 99% right
 * produces a model that is slightly worse in a way nobody can attribute, and the
 * natural conclusion ("the model needs more data") is expensive and wrong.
 * See docs/ARCHITECTURE.md §1 and §4.
 *
 * WHAT IS COMPARED, per book and per prompt version:
 *   - the number of encoded pages, and their page numbers
 *   - `blockIds`, in order
 *   - the `system` turn
 *   - the `user` turn
 *   - `toRawPrompt()` — the final string that goes on the wire
 *   - `parseAnswer()` over an answer synthesised from the book's gold labels,
 *     which exercises the per-version legal-class set
 * Every one of these is an exact string/identity comparison. There is no
 * tolerance and no normalisation.
 *
 * INPUT is the real labelled corpus, not a fixture: `<corpus>/<book>/labels.json`
 * (the labelling session, already in TextBlock shape) or, for a book not yet
 * labelled, `<corpus>/<book>/blocks.json` converted exactly as BookForgeApp
 * `tools/rubric-detect-corpus.js` `sessionFromBlocks()` converts it.
 *
 * REQUIREMENTS: `typescript` must be resolvable (`npm i --no-save typescript`,
 * or run under bun). Both encoders are compiled with the same transpiler in the
 * same mode, so the comparison cannot be an artefact of how one side was built.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };

if (argv.includes('--help') || argv.includes('-h')) {
  console.error('usage: node tools/replay-boxes.mjs [--books a,b,c] [--versions 1,2,3,4,5,6]\n' +
    '                                  [--corpus <dir>] [--reference <BookForgeApp dir>]\n' +
    '                                  [--show N]');
  process.exit(0);
}

const CORPUS = path.resolve(opt('corpus', '/Volumes/Callisto/training/rubric'));
const REFERENCE = path.resolve(opt('reference', '/Volumes/Callisto/Projects/BookForgeApp'));
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SHOW = Number(opt('show', '3'));

/** Five real labelled books; the smallest is 360 pages. */
const DEFAULT_BOOKS = [
  'michelle-remembers',
  'rise-and-fall',
  'himmler-a-life',
  'siege-of-budapest',
  'deathstalker-rebellion',
];
const books = opt('books', DEFAULT_BOOKS.join(',')).split(',').map(s => s.trim()).filter(Boolean);
const versions = opt('versions', '1,2,3,4,5,6').split(',').map(s => Number(s.trim())).filter(Boolean);

const REF_ENCODER = path.join(REFERENCE, 'src/app/features/pdf-picker/services/rubric-encoder.ts');
const NEW_ENCODER = path.join(REPO, 'src/boxes/encoder.ts');
for (const f of [REF_ENCODER, NEW_ENCODER]) {
  if (!fs.existsSync(f)) { console.error(`replay-boxes: no such file: ${f}`); process.exit(1); }
}

// ── compile both encoders identically ───────────────────────────────────────
let ts;
try { ts = require('typescript'); } catch {
  console.error('replay-boxes: cannot resolve `typescript`. Run: npm i --no-save typescript');
  process.exit(1);
}

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-boxes-'));
function compile(tsFile, name) {
  const src = fs.readFileSync(tsFile, 'utf8');
  const js = ts.transpileModule(src, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, isolatedModules: true },
    fileName: tsFile,
  }).outputText;
  const out = path.join(outDir, `${name}.mjs`);
  fs.writeFileSync(out, js);
  return pathToFileURL(out).href;
}
const ref = await import(compile(REF_ENCODER, 'reference-encoder'));
const now = await import(compile(NEW_ENCODER, 'foundry-encoder'));

// ── corpus loading, exactly as BookForge does it ────────────────────────────
/**
 * `blocks.json` field names -> TextBlock field names. Copied from
 * BookForgeApp tools/rubric-detect-corpus.js `sessionFromBlocks()`; a block
 * with no id is refused there and is refused here, because an undefined id
 * collapses every label onto one key and the run then reports success.
 */
function sessionFromBlocks(raw, book) {
  return {
    pageDimensions: raw.pageDimensions,
    blocks: (raw.blocks || []).map((b, i) => {
      if (!b.id) { console.error(`replay-boxes: ${book} block ${i} has no id`); process.exit(1); }
      return {
        id: b.id,
        page: b.page,
        x: b.x, y: b.y, width: b.w, height: b.h,
        text: b.text ?? '',
        font_size: b.fsize ?? 0,
        font_name: b.fontName ?? 'OCR',
        char_count: (b.text ?? '').length,
        region: 'body',
        category_id: b.category ?? 'body',
        line_count: b.lineCount,
        is_ocr: true,
        ocr_confidence: b.conf,
        ...(b.bold !== undefined ? { is_bold: b.bold } : {}),
        ...(b.italic !== undefined ? { is_italic: b.italic } : {}),
      };
    }),
    labels: {},
  };
}

function readBook(book) {
  const dir = path.join(CORPUS, book);
  const labelsFile = path.join(dir, 'labels.json');
  const blocksFile = path.join(dir, 'blocks.json');
  const from = fs.existsSync(labelsFile) ? labelsFile : blocksFile;
  if (!fs.existsSync(from)) { console.error(`replay-boxes: no labels.json or blocks.json in ${dir}`); process.exit(1); }
  const parsed = JSON.parse(fs.readFileSync(from, 'utf8'));
  const session = from === labelsFile ? parsed : sessionFromBlocks(parsed, book);
  if (!Array.isArray(session.blocks) || !session.blocks.length) {
    console.error(`replay-boxes: ${from} has no blocks`); process.exit(1);
  }
  if (!Array.isArray(session.pageDimensions) || !session.pageDimensions.length) {
    console.error(`replay-boxes: ${from} has no pageDimensions`); process.exit(1);
  }
  return {
    source: path.basename(from),
    blocks: session.blocks,
    labels: session.labels || {},
    pageDimensions: session.pageDimensions.map(d => ({ width: d.width || 0, height: d.height || 0 })),
  };
}

// ── the diff ────────────────────────────────────────────────────────────────
const diffs = [];
let comparedPages = 0, comparedPrompts = 0, comparedBlocks = 0, comparedAnswers = 0;

function note(book, version, page, what, a, b) {
  diffs.push({ book, version, page, what, a, b });
}

const totals = [];
for (const book of books) {
  const { source, blocks, labels, pageDimensions } = readBook(book);
  const totalPages = pageDimensions.length;
  let bookPages = 0;

  for (const version of versions) {
    const options = { version, totalPages };
    const a = ref.encodeBook(blocks, pageDimensions, options);
    const b = now.encodeBook(blocks, pageDimensions, options);

    if (a.length !== b.length) {
      note(book, version, -1, 'page count', String(a.length), String(b.length));
      continue;
    }
    bookPages = a.length;

    for (let i = 0; i < a.length; i++) {
      const pa = a[i], pb = b[i];
      comparedPages++;
      if (pa.page !== pb.page) note(book, version, i, 'page number', String(pa.page), String(pb.page));
      if (pa.blockIds.length !== pb.blockIds.length
          || pa.blockIds.some((id, k) => id !== pb.blockIds[k])) {
        note(book, version, pa.page, 'blockIds', pa.blockIds.join(','), pb.blockIds.join(','));
      }
      comparedBlocks += pa.blockIds.length;
      if (pa.system !== pb.system) note(book, version, pa.page, 'system', pa.system, pb.system);
      if (pa.user !== pb.user) note(book, version, pa.page, 'user', pa.user, pb.user);

      const ra = ref.toRawPrompt(pa), rb = now.toRawPrompt(pb);
      comparedPrompts++;
      if (ra !== rb) note(book, version, pa.page, 'toRawPrompt', ra, rb);

      // parseAnswer, driven by the book's own gold labels: every block on the
      // page answered with its hand label. Classes retired in this version must
      // be dropped identically by both parsers.
      const answer = pa.blockIds
        .map((id, k) => `${k + 1} ${labels[id] ?? 'body'}`)
        .join('\n');
      const ma = ref.parseAnswer(answer, pa.blockIds, version);
      const mb = now.parseAnswer(answer, pb.blockIds, version);
      comparedAnswers++;
      if (ma.size !== mb.size || [...ma].some(([k, v]) => mb.get(k) !== v)) {
        note(book, version, pa.page, 'parseAnswer',
          JSON.stringify([...ma]), JSON.stringify([...mb]));
      }
    }
  }

  // Constants and the id parser, once per run's worth of context.
  totals.push({ book, source, blocks: blocks.length, pages: bookPages, totalPages });
  console.log(`[replay] ${book.padEnd(24)} ${String(blocks.length).padStart(6)} blocks  ` +
    `${String(bookPages).padStart(5)} encoded pages / ${totalPages} pdf pages  (${source})`);
}

// ── the exports that are not per-page ───────────────────────────────────────
let constDiffs = 0;
function same(what, a, b) {
  if (a !== b) { constDiffs++; console.log(`  DIFF ${what}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`); }
}
same('STOP token', ref.RUBRIC_STOP, now.BOXES_STOP);
for (const v of [0, 1, 2, 3, 4, 5, 6, 7]) {
  same(`categories(v${v})`,
    ref.rubricCategories(v).join(' '), now.boxesCategories(v).join(' '));
}
for (const name of [
  'rubric-v1-0.6b', 'rubric-v2-0.6b', 'rubric-v3-4b', 'rubric-v4-4b', 'rubric-v5-4b',
  'rubric-v6-4b', 'blockcat-v3-4b', 'foundry-boxes-v1-4b', 'no-version-here', 'V5',
  'rubric-v3-v5-mixed', 'model.v2.gguf',
]) {
  same(`versionFor(${name})`, String(ref.rubricVersionFor(name)), String(now.boxesVersionFor(name)));
}

// ── report ──────────────────────────────────────────────────────────────────
console.log(`\n[replay] books ${totals.length}  versions ${versions.join(',')}`);
console.log(`[replay] compared ${comparedPages} page encodings, ${comparedPrompts} raw prompts, ` +
  `${comparedBlocks} block lines, ${comparedAnswers} parsed answers`);
console.log(`[replay] non-page exports compared: STOP, categories(v0..v7), versionFor x12`);

if (diffs.length || constDiffs) {
  console.log(`\n[replay] FAILED — ${diffs.length} page differences, ${constDiffs} export differences`);
  for (const d of diffs.slice(0, SHOW)) {
    console.log(`\n  ${d.book} v${d.version} page ${d.page} — ${d.what}`);
    console.log(`    reference: ${JSON.stringify(String(d.a).slice(0, 400))}`);
    console.log(`    foundry:   ${JSON.stringify(String(d.b).slice(0, 400))}`);
  }
  process.exit(1);
}
console.log('\n[replay] IDENTICAL — zero differences');
fs.rmSync(outDir, { recursive: true, force: true });
