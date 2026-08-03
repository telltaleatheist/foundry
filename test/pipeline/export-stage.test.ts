/**
 * The stage that turns a run directory into a book.
 *
 * The interesting behaviour is the text ladder — footnotes over ocr over scan —
 * and the fact that it is a PIPELINE ORDER rather than a fallback chain. The
 * difference is testable: a stage that ran must have covered the whole book, and
 * a half-populated artifact throws instead of quietly mixing corrected and
 * uncorrected text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runExportStage, deriveMetadata, ExportStageError } from '../../src/pipeline/export-stage.js';
import { readBlocks, readRun, readScanLines, writeArtifact, artifactPath } from '../../src/pipeline/artifacts.js';
import { buildRun, runDirFor } from '../../fixtures/export/generate.js';
import { applyFootnoteDeletions } from '../../src/footnotes/applier.js';
import { unzipMap } from '../export/unzip.js';

const METADATA = { title: 'A Synthetic Book', language: 'en', identifier: 'urn:uuid:test' };

function scratchRun(convention: 'indent' | 'block' | 'none' = 'indent'): { runDir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'foundry-stage-'));
  const runDir = join(root, `${convention}-book`);
  buildRun(convention, runDir);
  return { runDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const prose = (zip: Uint8Array): string =>
  [...unzipMap(zip)].filter(([p]) => p.startsWith('EPUB/text/')).map(([, e]) => e.text()).join('\n');

test('the stage writes the EPUB and exclusions.json to their documented paths', () => {
  const { runDir, cleanup } = scratchRun();
  try {
    const r = runExportStage({ runDir, metadata: METADATA, log: () => {} });
    assert.equal(r.epubPath, join(runDir, 'export/book.epub'));
    assert.ok(existsSync(r.epubPath));
    assert.ok(existsSync(artifactPath(runDir, 'exportExclusions')));
    // Atomic: no temp file left behind.
    assert.equal(existsSync(`${r.epubPath}.tmp`), false);
  } finally { cleanup(); }
});

test('without an ocr artifact the scan text is used', () => {
  const { runDir, cleanup } = scratchRun();
  try {
    const r = runExportStage({ runDir, metadata: METADATA, log: () => {} });
    assert.match(prose(r.zip), /This book exists to exercise the exporter/);
  } finally { cleanup(); }
});

test('ocr/lines.json supersedes the scan text', () => {
  const { runDir, cleanup } = scratchRun();
  try {
    const lines = readScanLines(runDir).lines;
    writeArtifact(runDir, 'ocrLines', {
      lines: lines.map(l => ({
        id: l.id,
        text: l.text.replace('exercise the exporter', 'EXERCISE THE EXPORTER'),
        edits: [], rejected: [],
      })),
    });
    const r = runExportStage({ runDir, metadata: METADATA, log: () => {} });
    assert.match(prose(r.zip), /EXERCISE THE EXPORTER/);
    assert.equal(prose(r.zip).includes('exercise the exporter'), false);
  } finally { cleanup(); }
});

test('a PARTIAL ocr artifact throws rather than mixing corrected and uncorrected text', () => {
  // The quiet degradation this rule exists to prevent: half the book silently
  // uncorrected, and no way to tell from the output which half.
  const { runDir, cleanup } = scratchRun();
  try {
    const lines = readScanLines(runDir).lines;
    writeArtifact(runDir, 'ocrLines', {
      lines: lines.slice(0, 5).map(l => ({ id: l.id, text: l.text, edits: [], rejected: [] })),
    });
    assert.throws(() => runExportStage({ runDir, metadata: METADATA, log: () => {} }), (e: unknown) => {
      assert.ok(e instanceof ExportStageError);
      assert.match(e.message, /ocr\/lines\.json is present but does not cover \d+ line\(s\)/);
      assert.match(e.message, /re-run the ocr stage over the whole book/);
      return true;
    });
  } finally { cleanup(); }
});

test('footnotes/deletions.json replaces a block\'s text wholesale', () => {
  const { runDir, cleanup } = scratchRun();
  try {
    // The artifact must DERIVE from the block's current lines — the export
    // replays the recorded deletions and refuses a rewrite it cannot
    // reproduce. So build it the way the footnotes stage does: apply a real
    // deletion to the real text.
    const target = readBlocks(runDir).blocks.find(b => b.category === 'footnote')!;
    const lines = readScanLines(runDir).lines;
    const byId = new Map(lines.map(l => [l.id, l.text]));
    const base = target.lineIds.map(id => byId.get(id)!).join('\n');
    const applied = [{ before: '1. A', after: 'A' }];
    const stripped = applyFootnoteDeletions(base, applied);
    assert.equal(stripped.rejected, 0);
    writeArtifact(runDir, 'footnoteDeletions', {
      blocks: [{ blockId: target.id, applied, rejected: 0, text: stripped.text }],
    });
    const r = runExportStage({ runDir, metadata: METADATA, log: () => {} });
    assert.match(prose(r.zip), /A footnote at the foot/);
    assert.equal(prose(r.zip).includes('1. A footnote at the foot'), false);
  } finally { cleanup(); }
});

test('a footnotes-rewritten block still gets line joining and hyphen healing', () => {
  // The Kershaw bug (Aug 3 2026): the rewrite is computed over the block's
  // newline-joined lines, and the stage used to ship that glued string as ONE
  // unit. Every marker-bearing block then bypassed joinLines — its `\n`s went
  // into the XHTML verbatim and its wrap hyphens were never examined, so a
  // footnoted book (i.e. every book this stage exists for) shipped
  // `totali-\ntarianism` everywhere. Pin: after a footnotes rewrite, the book
  // contains no raw line breaks and no unexamined wrap hyphen.
  const { runDir, cleanup } = scratchRun();
  try {
    const lines = readScanLines(runDir).lines;
    const byId = new Map(lines.map(l => [l.id, l.text]));
    // A body block whose joined base wraps a hyphen across lines — the shape
    // the fix exists for.
    const target = readBlocks(runDir).blocks.find(b =>
      b.category === 'body'
      && /-$/.test(byId.get(b.lineIds[0]!) ?? ''))!;
    assert.ok(target, 'fixture must carry a body block with a wrap hyphen');
    const base = target.lineIds.map(id => byId.get(id)!).join('\n');
    // A word this block holds and the rest of the book does not, so its absence
    // from the export proves the deletion landed rather than colliding with
    // another occurrence.
    const everything = lines.map(l => l.text).join('\n');
    const word = [...base.matchAll(/[A-Za-z]{4,}/g)]
      .map(m => m[0])
      .find(w => everything.split(w).length === 2)!;
    assert.ok(word, 'fixture block must contain a word unique to the book');
    const applied = [{ before: word, after: word.slice(0, -1) }];
    const stripped = applyFootnoteDeletions(base, applied);
    assert.equal(stripped.rejected, 0);
    writeArtifact(runDir, 'footnoteDeletions', {
      blocks: [{ blockId: target.id, applied, rejected: 0, text: stripped.text }],
    });

    const text = prose(runExportStage({ runDir, metadata: METADATA, log: () => {} }).zip);
    // The glued rewrite must not ship: no wrap hyphen may survive against a
    // raw line break anywhere in the book.
    assert.equal(/[A-Za-zÀ-ÿ]-\n/.test(text), false,
      'a footnotes rewrite shipped its newline-joined base without line joining');
    assert.equal(text.includes(stripped.text), false);
    // And the deletion itself still landed.
    assert.equal(text.includes(word), false);
  } finally { cleanup(); }
});

test('a footnotes rewrite that does not derive from the current lines is refused', () => {
  // The bug the 2-page end-to-end run caught, pinned: dagger derived its
  // deletions from the RAW scan text, ocr corrected the lines afterwards, and
  // the export silently shipped raw text minus markers for every block dagger
  // touched — OCR corrections discarded. Now the export replays the recorded
  // deletions against the shipping text and refuses a rewrite that does not
  // reproduce.
  const { runDir, cleanup } = scratchRun();
  try {
    const target = readBlocks(runDir).blocks.find(b => b.category === 'footnote')!;
    writeArtifact(runDir, 'footnoteDeletions', {
      blocks: [{ blockId: target.id, applied: [{ before: '1. A', after: 'A' }], rejected: 0, text: 'A stale rewrite from another text base.' }],
    });
    assert.throws(() => runExportStage({ runDir, metadata: METADATA, log: () => {} }), (e: unknown) => {
      assert.ok(e instanceof ExportStageError);
      assert.match(e.message, /does not derive from the current text/);
      assert.match(e.message, /Re-run the footnotes stage/);
      return true;
    });
  } finally { cleanup(); }
});

test('the hyphen vocabulary is the whole book, not the exported subset', () => {
  // "question" is attested only in a block the user excluded. The heal must
  // still happen: a word is attested by the BOOK, and letting an exclusion
  // change how a hyphen resolves elsewhere would make the text depend on the
  // filter.
  const { runDir, cleanup } = scratchRun();
  try {
    const attesting = readBlocks(runDir).blocks
      .find(b => b.category === 'body')!;
    const r = runExportStage({
      runDir, metadata: METADATA, log: () => {}, exclude: { blockIds: [attesting.id] },
    });
    assert.equal(prose(r.zip).includes('This book exists to exercise'), false, 'the block was not excluded');
    assert.match(prose(r.zip), /like question, which/);
    assert.equal(r.healedHyphens, 1);
  } finally { cleanup(); }
});

test('a run directory with no blocks.json says which stage to run', () => {
  const root = mkdtempSync(join(tmpdir(), 'foundry-empty-run-'));
  try {
    assert.throws(
      () => runExportStage({ runDir: root, metadata: METADATA, log: () => {} }),
      /blocks\/blocks\.json: not found .* run the stage that produces it/s,
    );
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('the degradation banner goes to the log, framed so it cannot be missed', () => {
  const { runDir, cleanup } = scratchRun('none');
  const said: string[] = [];
  try {
    runExportStage({ runDir, metadata: METADATA, log: m => said.push(m) });
    const banner = said.join('\n');
    assert.match(banner, /─{72}/, 'the degraded verdict is not framed');
    assert.match(banner, /DEGRADED PARAGRAPH ASSEMBLY/);
    assert.match(banner, /Calibration measured/);
  } finally { cleanup(); }
});

test('a calibrated book logs its verdict without the alarm', () => {
  const { runDir, cleanup } = scratchRun('indent');
  const said: string[] = [];
  try {
    runExportStage({ runDir, metadata: METADATA, log: m => said.push(m) });
    const banner = said.join('\n');
    assert.match(banner, /Paragraphs assembled under the indent convention/);
    assert.equal(banner.includes('DEGRADED'), false);
    assert.equal(banner.includes('─'.repeat(72)), false);
  } finally { cleanup(); }
});

test('the committed fixtures export without being mutated', () => {
  // A guard on the tests themselves: exporting reads the committed run dirs in
  // other suites, and a stray write there would break the drift check silently.
  for (const convention of ['indent', 'block', 'none'] as const) {
    const before = JSON.stringify(readBlocks(runDirFor(convention)));
    const { runDir, cleanup } = scratchRun(convention);
    try {
      runExportStage({ runDir, metadata: METADATA, log: () => {} });
    } finally { cleanup(); }
    assert.equal(JSON.stringify(readBlocks(runDirFor(convention))), before);
  }
});

// ── the CLI's surface ───────────────────────────────────────────────────────

test('--output writes a copy WITHOUT replacing the canonical artifact', () => {
  // The run directory is the contract: a book exported to the desktop must
  // still leave the run complete enough to re-export from.
  const { runDir, cleanup } = scratchRun();
  const dest = join(runDir, '..', 'somewhere-else.epub');
  try {
    const r = runExportStage({ runDir, metadata: METADATA, outputPath: dest, log: () => {} });
    assert.equal(r.epubPath, join(runDir, 'export/book.epub'));
    assert.ok(existsSync(r.epubPath), 'the canonical artifact was not written');
    assert.ok(existsSync(dest), 'the --output copy was not written');
    assert.deepEqual(readFileSync(dest), readFileSync(r.epubPath));
  } finally { cleanup(); }
});

test('--output pointing at the canonical path writes it once, not twice', () => {
  const { runDir, cleanup } = scratchRun();
  try {
    const canonical = join(runDir, 'export/book.epub');
    const r = runExportStage({ runDir, metadata: METADATA, outputPath: canonical, log: () => {} });
    assert.equal(r.outputPath, r.epubPath);
    assert.ok(existsSync(canonical));
  } finally { cleanup(); }
});

test('metadata is DERIVED from the run directory when the caller has none', () => {
  const { runDir, cleanup } = scratchRun();
  try {
    const r = runExportStage({ runDir, log: () => {} });
    const opf = unzipMap(r.zip).get('EPUB/package.opf')!.text();
    // Title from the book's own title block.
    assert.match(opf, /<dc:title>A Synthetic Book<\/dc:title>/);
    // Language from the tessdata the book was recognized with, not a default.
    assert.match(opf, /<dc:language>en<\/dc:language>/);
    // Identifier from the input hash: stable across re-exports, different per source.
    assert.match(opf, /<dc:identifier id="pub-id">urn:sha256:0{64}<\/dc:identifier>/);
  } finally { cleanup(); }
});

test('a derived title falls to the chapter, then the filename', () => {
  const { runDir, cleanup } = scratchRun();
  try {
    const blocks = readBlocks(runDir);
    // Drop the title block: the first chapter is the next best answer.
    const noTitle = blocks.blocks.filter(b => b.category !== 'title');
    writeArtifact(runDir, 'blocks', { calibration: blocks.calibration, blocks: noTitle });
    const meta = deriveMetadata(runDir, noTitle, new Map(noTitle.map(b => [b.id, ['Chapter One']])));
    assert.equal(meta.title, 'Chapter One');

    // With neither, the input filename — which run.json records as indent.pdf.
    const bodyOnly = noTitle.filter(b => b.category !== 'chapter');
    assert.equal(deriveMetadata(runDir, bodyOnly, new Map()).title, 'indent');
  } finally { cleanup(); }
});

test('a non-English tessdata pin produces a non-English dc:language', () => {
  const { runDir, cleanup } = scratchRun();
  try {
    const run = readRun(runDir);
    writeArtifact(runDir, 'run', { ...run, tesseract: { ...run.tesseract, tessdata: ['deu'] } });
    const r = runExportStage({ runDir, log: () => {} });
    assert.match(unzipMap(r.zip).get('EPUB/package.opf')!.text(), /<dc:language>de<\/dc:language>/);
  } finally { cleanup(); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Overrides — the user's own text and category decisions
//
// This is how a heading retyped in BookForge's pdf-picker reaches the book.
// Block formation splits a display heading into one block per line and the scan
// misreads its edges, so the person looking at the page is the only participant
// who can say what the chapter is actually called. `--overrides` is that
// sentence, and it sits above every stage in the text ladder.
// ─────────────────────────────────────────────────────────────────────────────

const nav = (zip: Uint8Array): string[] =>
  [...unzipMap(zip).get('EPUB/nav.xhtml')!.text().matchAll(/<a href="[^"]+">([^<]+)<\/a>/g)]
    .map(m => m[1]);

test('a text override renames a chapter — the heading AND its nav label follow', () => {
  const { runDir, cleanup } = scratchRun();
  try {
    const r = runExportStage({
      runDir,
      metadata: METADATA,
      overrides: { blocks: [{ id: 'b0009', text: 'The Lost Empire' }] },
      log: () => {},
    });
    assert.deepEqual(r.overrides, { text: 1, category: 0 });

    // The TOC entry is the user's line, not the scan's.
    assert.ok(nav(r.zip).includes('The Lost Empire'), `nav is ${JSON.stringify(nav(r.zip))}`);
    assert.equal(nav(r.zip).includes('Chapter One'), false);

    // And so is the h1 in the section it opens.
    const text = prose(r.zip);
    assert.match(text, /<h1>The Lost Empire<\/h1>/);
    assert.equal(text.includes('Chapter One'), false);
    // Chapter Two was not touched.
    assert.match(text, /<h1>Chapter Two<\/h1>/);
  } finally { cleanup(); }
});

test('a text override lands before the metadata is derived from the book', () => {
  const { runDir, cleanup } = scratchRun();
  try {
    const r = runExportStage({
      runDir,
      overrides: { blocks: [{ id: 'b0002', text: 'A Retyped Title' }] },
      log: () => {},
    });
    assert.match(unzipMap(r.zip).get('EPUB/package.opf')!.text(),
      /<dc:title>A Retyped Title<\/dc:title>/);
  } finally { cleanup(); }
});

test('a text override replaces the whole block as ONE line, lines and all', () => {
  const { runDir, cleanup } = scratchRun();
  try {
    // b0016 is the three-item list; one line per <li> normally.
    const r = runExportStage({
      runDir,
      metadata: METADATA,
      overrides: { blocks: [{ id: 'b0016', text: 'One replacement line', category: 'body' }] },
      log: () => {},
    });
    assert.deepEqual(r.overrides, { text: 1, category: 1 });
    const text = prose(r.zip);
    assert.match(text, /<p>One replacement line<\/p>/);
    assert.equal(text.includes('The first item'), false);
    assert.equal(text.includes('<li>'), false);
  } finally { cleanup(); }
});

test('a category override moves how the block renders', () => {
  const { runDir, cleanup } = scratchRun();
  try {
    const before = prose(runExportStage({ runDir, metadata: METADATA, log: () => {} }).zip);
    assert.match(before, /<p class="caption">Figure 1\./);

    const r = runExportStage({
      runDir,
      metadata: METADATA,
      overrides: { blocks: [{ id: 'b0015', category: 'heading' }] },
      log: () => {},
    });
    assert.deepEqual(r.overrides, { text: 0, category: 1 });
    const text = prose(r.zip);
    assert.match(text, /<h2>Figure 1\. A caption belonging to a plate\.<\/h2>/);
    assert.equal(text.includes('<p class="caption">Figure 1.'), false);
  } finally { cleanup(); }
});

test('a category override to chapter opens a section and a TOC entry', () => {
  const { runDir, cleanup } = scratchRun();
  try {
    // b0021 is body prose in the middle of page 3 — nothing adjacent to merge
    // with, so promoting it is a new spine item and a new TOC entry.
    const r = runExportStage({
      runDir,
      metadata: METADATA,
      overrides: { blocks: [{ id: 'b0021', category: 'chapter', text: 'A Promoted Heading' }] },
      log: () => {},
    });
    assert.ok(nav(r.zip).includes('A Promoted Heading'), `nav is ${JSON.stringify(nav(r.zip))}`);
    assert.match(prose(r.zip), /<h1>A Promoted Heading<\/h1>/);
  } finally { cleanup(); }
});

test('a block promoted next to a real chapter joins it — the merge net still holds', () => {
  // The exporter's same-page opener rule (heading-merge.test.ts) is the safety
  // net under BookForge's own merge, and an override does not slip past it:
  // b0010 sits immediately under "Chapter One" on the same page, so promoting
  // it EXTENDS that section rather than splitting the chapter in two.
  const { runDir, cleanup } = scratchRun();
  try {
    const r = runExportStage({
      runDir,
      metadata: METADATA,
      overrides: { blocks: [{ id: 'b0010', category: 'chapter', text: 'A Promoted Heading' }] },
      log: () => {},
    });
    assert.ok(nav(r.zip).includes('Chapter One A Promoted Heading'),
      `nav is ${JSON.stringify(nav(r.zip))}`);
  } finally { cleanup(); }
});

test('an override naming a block that is not in the run refuses, and says which id', () => {
  const { runDir, cleanup } = scratchRun();
  try {
    assert.throws(
      () => runExportStage({
        runDir,
        metadata: METADATA,
        overrides: { blocks: [{ id: 'b0009', text: 'fine' }, { id: 'b9999', text: 'nowhere' }] },
        log: () => {},
      }),
      (e: unknown) => {
        assert.ok(e instanceof ExportStageError);
        assert.match((e as Error).message, /b9999/);
        assert.match((e as Error).message, /different run of the blocks stage/);
        // The one that WOULD have applied is not silently applied anyway.
        assert.equal((e as Error).message.includes('b0009'), false);
        return true;
      },
    );
  } finally { cleanup(); }
});

test('an override asking for a category that does not exist refuses with the legal list', () => {
  const { runDir, cleanup } = scratchRun();
  try {
    assert.throws(
      () => runExportStage({
        runDir,
        metadata: METADATA,
        overrides: { blocks: [{ id: 'b0015', category: 'captoins' }] },
        log: () => {},
      }),
      (e: unknown) => {
        assert.ok(e instanceof ExportStageError);
        assert.match((e as Error).message, /captoins/);
        assert.match((e as Error).message, /Legal categories are: body, title, chapter/);
        return true;
      },
    );
  } finally { cleanup(); }
});

test('an override that asks for nothing, or for empty text, is a mistake and says so', () => {
  const { runDir, cleanup } = scratchRun();
  try {
    assert.throws(
      () => runExportStage({
        runDir, metadata: METADATA, overrides: { blocks: [{ id: 'b0009' }] }, log: () => {},
      }),
      /neither text nor category/,
    );
    assert.throws(
      () => runExportStage({
        runDir, metadata: METADATA, overrides: { blocks: [{ id: 'b0009', text: '   ' }] }, log: () => {},
      }),
      /replaces its text with nothing.*--exclude-ids/s,
    );
  } finally { cleanup(); }
});

test('overrides and exclusions compose — an edited block can still be dropped by category', () => {
  const { runDir, cleanup } = scratchRun();
  try {
    const r = runExportStage({
      runDir,
      metadata: METADATA,
      overrides: { blocks: [{ id: 'b0015', text: 'A caption nobody will read' }] },
      exclude: { categories: ['captions'] },
      log: () => {},
    });
    assert.equal(prose(r.zip).includes('A caption nobody will read'), false);
  } finally { cleanup(); }
});

test('no overrides changes nothing — the same run exports the same bytes', () => {
  const { runDir, cleanup } = scratchRun();
  try {
    const plain = runExportStage({ runDir, metadata: METADATA, log: () => {} });
    const empty = runExportStage({
      runDir, metadata: METADATA, overrides: { blocks: [] }, log: () => {},
    });
    assert.deepEqual(empty.overrides, { text: 0, category: 0 });
    assert.deepEqual([...empty.zip], [...plain.zip]);
  } finally { cleanup(); }
});
