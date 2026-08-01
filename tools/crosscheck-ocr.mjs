#!/usr/bin/env node
/**
 * crosscheck-ocr — prove the moved edit contract behaves identically to the
 * BookForge original it was ported from (MIGRATION §2).
 *
 *   node tools/crosscheck-ocr.mjs
 *   node tools/crosscheck-ocr.mjs --sft <a.jsonl,b.jsonl> \
 *        --reference /Volumes/Callisto/Projects/BookForgeApp --show 3
 *
 * `src/ocr/edits.ts` is `tools/galley/edits.mjs` with types added and nothing
 * else changed. This runs every GOLD row of the corpus through BOTH — the
 * original `.mjs` and the ported `.ts` — and compares, exactly:
 *
 *   parseEdits   : the edit list, field for field, and the `bad` line count
 *   formatEdits  : the wire string
 *   applyEdits   : the applied TEXT, `ok`, `applied`, and every rejection
 *                  ({before, why}) in order — the rejection rule is the safety
 *                  property, so "same output, different rejections" is a
 *                  failure here, not a detail
 *   deriveEdits  : re-derived from (ocr, gold-applied-text), edit for edit,
 *                  including the null/dropped decision and `changed`
 *
 * There is no tolerance. A single differing rejection reason fails the run.
 *
 * The gold data is the corpus the model was actually built from:
 * `/Volumes/Callisto/training/rubric/galley/sft/{train,eval}.jsonl` — the
 * block-level, arrow-format split, which is what `edits.mjs` derives and
 * applies. (`sft-line/` is the newer line-level split whose assistant turn is
 * a whole corrected line, not an edit list; it does not exercise this contract.)
 *
 * NOT PORTED: BookForge's `tools/galley/contract-crosscheck.mjs` also runs the
 * gold edits through `electron/ai-cleanup-prepass.ts` `applyEditList`, a
 * DIFFERENT contract with word-boundary lookarounds that rejects 81.4% of true
 * corrections. That applier is BookForge's AI-cleanup path and is not moving to
 * Foundry. Its invariant checks — anchor present, anchor unique, and the
 * word-boundary measurement that explained the 81.4% — are in
 * `test/ocr/contract-crosscheck.test.ts`.
 *
 * REQUIREMENTS: `typescript` must be resolvable (`npm i --no-save typescript`,
 * or run under bun).
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
  console.error('usage: node tools/crosscheck-ocr.mjs [--sft <a.jsonl,b.jsonl>]\n' +
    '                                    [--reference <BookForgeApp dir>] [--show N]');
  process.exit(0);
}

const REFERENCE = path.resolve(opt('reference', '/Volumes/Callisto/Projects/BookForgeApp'));
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SHOW = Number(opt('show', '3'));
const GALLEY_SFT = '/Volumes/Callisto/training/rubric/galley/sft';
const files = opt('sft', `${GALLEY_SFT}/eval.jsonl,${GALLEY_SFT}/train.jsonl`)
  .split(',').map(s => s.trim()).filter(Boolean);

const REF_EDITS = path.join(REFERENCE, 'tools/galley/edits.mjs');
const NEW_EDITS = path.join(REPO, 'src/ocr/edits.ts');
for (const f of [REF_EDITS, NEW_EDITS, ...files]) {
  if (!fs.existsSync(f)) { console.error(`crosscheck-ocr: no such file: ${f}`); process.exit(1); }
}

// ── load both implementations ───────────────────────────────────────────────
let ts;
try { ts = require('typescript'); } catch {
  console.error('crosscheck-ocr: cannot resolve `typescript`. Run: npm i --no-save typescript');
  process.exit(1);
}
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crosscheck-ocr-'));
const compiled = path.join(outDir, 'foundry-edits.mjs');
fs.writeFileSync(compiled, ts.transpileModule(fs.readFileSync(NEW_EDITS, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, isolatedModules: true },
  fileName: NEW_EDITS,
}).outputText);

const ref = await import(pathToFileURL(REF_EDITS).href);
const now = await import(pathToFileURL(compiled).href);

// ── the diff ────────────────────────────────────────────────────────────────
const J = (v) => JSON.stringify(v);
const diffs = [];
function note(file, row, what, a, b) { diffs.push({ file, row, what, a, b }); }

let rows = 0, identityRows = 0, editRows = 0, goldEdits = 0, badLines = 0;
let applierOk = 0, rejections = 0, derivedNull = 0, derivedEdits = 0;
let limitDiffs = 0;

// The limits ARE the contract; a changed number here is invisible in output
// until it is not.
for (const k of Object.keys(ref.LIMITS)) {
  if (ref.LIMITS[k] !== now.LIMITS[k]) {
    limitDiffs++;
    console.log(`  DIFF LIMITS.${k}: ${ref.LIMITS[k]} vs ${now.LIMITS[k]}`);
  }
}
if (Object.keys(ref.LIMITS).length !== Object.keys(now.LIMITS).length) {
  limitDiffs++;
  console.log(`  DIFF LIMITS keys: ${J(Object.keys(ref.LIMITS))} vs ${J(Object.keys(now.LIMITS))}`);
}
if (String(ref.ARROW) !== String(now.ARROW)) {
  limitDiffs++;
  console.log(`  DIFF ARROW: ${String(ref.ARROW)} vs ${String(now.ARROW)}`);
}

for (const file of files) {
  const base = path.basename(path.dirname(file)) + '/' + path.basename(file);
  let n = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const msgs = JSON.parse(line).messages;
    const ocr = msgs.find((m) => m.role === 'user').content;
    const target = msgs.find((m) => m.role === 'assistant').content;
    rows++; n++;

    // parse
    const pa = ref.parseEdits(target);
    const pb = now.parseEdits(target);
    if (J(pa) !== J(pb)) note(base, n, 'parseEdits', J(pa), J(pb));
    goldEdits += pa.edits.length;
    badLines += pa.bad;
    if (/^none$/i.test(target.trim())) identityRows++; else editRows++;

    // format (round trip through the wire form)
    const fa = ref.formatEdits(pa.edits);
    const fb = now.formatEdits(pb.edits);
    if (fa !== fb) note(base, n, 'formatEdits', fa, fb);

    // apply — the safety property, compared field for field
    const aa = ref.applyEdits(ocr, pa.edits);
    const ab = now.applyEdits(ocr, pb.edits);
    if (aa.text !== ab.text) note(base, n, 'applyEdits.text', aa.text, ab.text);
    if (aa.ok !== ab.ok) note(base, n, 'applyEdits.ok', String(aa.ok), String(ab.ok));
    if (aa.applied !== ab.applied) note(base, n, 'applyEdits.applied', String(aa.applied), String(ab.applied));
    if (J(aa.rejected) !== J(ab.rejected)) note(base, n, 'applyEdits.rejected', J(aa.rejected), J(ab.rejected));
    if (aa.ok) applierOk++;
    rejections += aa.rejected.length;

    // derive — run the contract backwards over the same real pair
    const da = ref.deriveEdits(ocr, aa.text);
    const db = now.deriveEdits(ocr, ab.text);
    if (J(da) !== J(db)) note(base, n, 'deriveEdits', J(da), J(db));
    if (da === null) derivedNull++; else derivedEdits += da.edits.length;
  }
  console.log(`[crosscheck] ${base.padEnd(22)} ${String(n).padStart(6)} rows`);
}

// ── report ──────────────────────────────────────────────────────────────────
console.log(`\n[crosscheck] rows ${rows}  identity ${identityRows}  with-edits ${editRows}`);
console.log(`[crosscheck] gold edits ${goldEdits}  unparseable gold lines ${badLines}`);
console.log(`[crosscheck] applier accepted every edit on ${applierOk}/${rows} rows, ` +
  `${rejections} rejections total`);
console.log(`[crosscheck] re-derivation: ${derivedEdits} edits over ${rows - derivedNull} rows, ` +
  `${derivedNull} pairs the contract refuses`);

if (diffs.length || limitDiffs) {
  console.log(`\n[crosscheck] FAILED — ${diffs.length} row differences, ${limitDiffs} constant differences`);
  for (const d of diffs.slice(0, SHOW)) {
    console.log(`\n  ${d.file} row ${d.row} — ${d.what}`);
    console.log(`    reference: ${J(String(d.a).slice(0, 300))}`);
    console.log(`    foundry:   ${J(String(d.b).slice(0, 300))}`);
  }
  process.exit(1);
}
console.log('\n[crosscheck] IDENTICAL — zero differences');
fs.rmSync(outDir, { recursive: true, force: true });
