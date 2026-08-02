/**
 * Build the three synthetic books the export tests run against.
 *
 * The three share ONE content script and differ only in how it is laid out:
 * indent style (first line inset, no extra space), block style (flush left,
 * blank-line gaps), and no convention at all. That is the point — the same text
 * must come out of the exporter the same way regardless of how the source
 * happened to mark its paragraphs, and the third book must still export.
 *
 * The geometry is real, not asserted: pages are 200 dpi, the layout engine
 * below places lines at a genuine pitch, and the block facts are then derived
 * by the production `calibrate()` and `computeBlockGeometry()` — not written by
 * hand. A fixture whose facts were hand-typed would prove only that the tests
 * agree with themselves.
 *
 * The generated run directories are COMMITTED, and a test regenerates them and
 * diffs. That way the fixtures are readable in the repo (they are what an
 * integration consumer would see) and they cannot drift from the generator.
 *
 * Run: bun run fixtures/export/generate.ts
 */
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { calibrate, type CalibrationLine } from '../../src/paragraphs/calibration.js';
import { computeBlockGeometry } from '../../src/paragraphs/geometry.js';
import { writeArtifact, type Block, type ScanLine } from '../../src/pipeline/artifacts.js';
import type { BoxesCategory } from '../../src/boxes/encoder.js';

// ── the page ────────────────────────────────────────────────────────────────

const PAGE_W = 1200;
const PAGE_H = 1800;
const DPI = 200;
const BODY_H = 28;
const PITCH = 40;
const LEFT = 200;
const RIGHT = 1000;
const CONTENT_TOP = 220;
const CONTENT_BOTTOM = 1560;
const HEADER_Y = 90;
const FOOTER_Y = 1680;
/** 1.5 body heights — an ordinary first-line indent. */
const INDENT_PX = 42;
/** Half a line of extra space: the blank-line gap, giving a 1.5x advance. */
const BLOCK_GAP_PX = 20;

export type Convention = 'indent' | 'block' | 'none';

/**
 * A deterministic sub-pixel wobble. Real deskewed scans never repeat a
 * coordinate exactly, and a fixture built on exact arithmetic would let a
 * calibrator pass by being brittle in the same way the fixture is.
 */
const wobble = (i: number): number => ((i * 2654435761) % 3) - 1;

// ── the content script ──────────────────────────────────────────────────────

interface Element {
  category: BoxesCategory;
  lines: string[];
  /**
   * Does this element open a paragraph? False marks the tail of one that was
   * split by a page break — the case the grouping stage must merge back.
   */
  opens?: boolean;
  /** Force this element to start a page (chapters do, in real books). */
  newPage?: boolean;
  /** Extra space above, in pitches, over and above the convention's. */
  dropPitches?: number;
  /** Centred rather than flush left. */
  centred?: boolean;
  /** Set at the foot of the page, below the text block. */
  atFoot?: boolean;
}

/**
 * One script, three layouts. The wrap hyphens are the interesting part:
 *
 *   ques- / tion   the book says "question" elsewhere  ⇒ HEALED
 *   far- / right   the book says "far-right" elsewhere ⇒ HYPHEN KEPT
 *   zeb- / ruck    the book says neither               ⇒ HYPHEN KEPT
 *
 * All three are decided from this book's own vocabulary and nothing else.
 */
const SCRIPT: Element[] = [
  { category: 'title', lines: ['A Synthetic Book'], centred: true, dropPitches: 2 },
  {
    category: 'body',
    lines: [
      'This book exists to exercise the exporter end to end, and it is set',
      'out the way a printed book is set out, with paragraphs that run for',
      'several lines before they turn. It raises a question of paragraphs',
      'and it answers that question in the only way the pipeline is willing',
      'to answer it, which is from the evidence on the page.',
    ],
  },
  {
    category: 'body',
    lines: [
      'The far-right press and the far-right movement are named here more',
      'than once, so that the compound is attested somewhere in the book',
      'that is not the line where it happens to be broken. That is the',
      'whole of the evidence the joiner is allowed to use, and it is the',
      'reason a compound survives the export with its hyphen intact.',
    ],
  },
  {
    category: 'body',
    lines: [
      'A paragraph can run to the very foot of a page and carry on at the',
      'top of the next one, and when it does the sentence is not finished',
      'and the reader should never hear a full stop where the page merely',
      'ran out of room. Sometimes the turn falls inside a word, like ques-',
    ],
  },
  {
    category: 'body', opens: false, newPage: true,
    lines: [
      'tion, which the book itself can prove should be rejoined, because it',
      'has used that word elsewhere as a word.',
    ],
  },

  { category: 'chapter', lines: ['Chapter One'], newPage: true, centred: true, dropPitches: 3 },
  { category: 'heading', lines: ['A Heading That Sits In Place'], dropPitches: 3 },
  { category: 'subheading', lines: ['A Subheading Beneath It'], dropPitches: 2 },
  {
    category: 'body',
    lines: [
      'The first paragraph of the chapter runs on for a good few lines so',
      'that it reads as prose rather than as a label, and so that the body',
      'of the book is what sets the measure and the leading against which',
      'everything else on the page is judged. Nothing here is a constant.',
      'Every threshold is derived from these lines.',
    ],
  },
  {
    category: 'body',
    lines: [
      'A second paragraph follows the first, opening the way this book',
      'opens its paragraphs and no other way, because a book commits to a',
      'convention and holds to it. Whichever convention that is, it is the',
      'one the calibration pass has to find, and the one the grouping pass',
      'then reads. The two are not allowed to disagree.',
    ],
  },
  {
    category: 'quote',
    lines: [
      'A quoted passage sits here, set apart from the body text around it,',
      'and it is its own category, so a paragraph never flows across the',
      'boundary between it and the prose on either side.',
    ],
  },
  { category: 'caption', lines: ['Figure 1. A caption belonging to a plate.'] },
  { category: 'list', lines: ['The first item', 'The second item', 'The third item'] },
  { category: 'footnote', lines: ['1. A footnote at the foot of its own page.'], atFoot: true },

  { category: 'chapter', lines: ['Chapter Two'], newPage: true, centred: true, dropPitches: 3 },
  {
    category: 'body',
    lines: [
      'The second chapter opens on a word that the compositor split as far-',
      'right, which must keep the hyphen it was written with, because this',
      'book uses that compound elsewhere and never uses the welded form.',
      'Getting that backwards is not a typo in the output; it is a word the',
      'author never wrote, and the reader cannot tell what it replaced.',
    ],
  },
  {
    category: 'body',
    lines: [
      'Another paragraph mentions a zeb-',
      'ruck, which nothing in this book attests either way, so the hyphen',
      'stays there too. An unproven pair keeps what was printed, because',
      'that is the direction a reader can still recover from.',
    ],
  },
  { category: 'image', lines: ['TEXT READ OFF A PHOTOGRAPH'] },
  { category: 'discard', lines: ['a leak from the facing page'] },
  { category: 'footnote', lines: ['2. A second footnote, on the second chapter.'], atFoot: true },
];

// ── layout ──────────────────────────────────────────────────────────────────

interface Laid {
  lines: ScanLine[];
  blocks: Array<{ id: string; page: number; category: BoxesCategory; lineIds: string[]; bbox: [number, number, number, number] }>;
  pages: number;
}

/** Width of a line, from its text. Monospace-ish, and only the shape matters. */
const widthOf = (text: string): number => Math.min(RIGHT - LEFT, Math.round(text.length * 11.5));

/**
 * Does this line run to the right margin?
 *
 * Every line of a paragraph except the last one does — that is what wrapping
 * means, and it is what gives a book a measurable right margin at all. A line
 * ending in a hyphen is by definition wrapped, so it runs full even when it is
 * the last line of its block: the paragraph continues on the next page.
 */
const runsFull = (category: BoxesCategory, index: number, count: number, text: string): boolean =>
  (category === 'body' || category === 'quote') && (index < count - 1 || text.endsWith('-'));

function layout(convention: Convention): Laid {
  const lines: ScanLine[] = [];
  let page = -1;
  let y = 0;
  let lineSeq = 0;
  let blockSeq = 0;
  let wob = 0;

  const pageBlocks: Array<Laid['blocks']> = [];

  const addLine = (p: number, x0: number, top: number, w: number, text: string): ScanLine => {
    const l: ScanLine = {
      id: `l${String(++lineSeq).padStart(4, '0')}`,
      page: p,
      bbox: [x0 + wobble(wob), top, x0 + w + wobble(wob + 7), top + BODY_H + wobble(wob + 3)],
      text,
      conf: 92,
      psm: 7,
    };
    wob++;
    lines.push(l);
    return l;
  };

  const addBlock = (p: number, category: BoxesCategory, ls: ScanLine[]): void => {
    const id = `b${String(++blockSeq).padStart(4, '0')}`;
    const bbox: [number, number, number, number] = [
      Math.min(...ls.map(l => l.bbox[0])),
      Math.min(...ls.map(l => l.bbox[1])),
      Math.max(...ls.map(l => l.bbox[2])),
      Math.max(...ls.map(l => l.bbox[3])),
    ];
    pageBlocks[p].push({ id, page: p, category, lineIds: ls.map(l => l.id), bbox });
  };

  const newPage = (): void => {
    page++;
    pageBlocks.push([]);
    y = CONTENT_TOP;
    // The running head: centred, so the indent signal's centred-line filter
    // drops it, and set well above the text block so its advance is a
    // structural jump rather than a paragraph gap.
    addBlock(page, 'header', [addLine(page, 460, HEADER_Y, 280, 'A SYNTHETIC BOOK')]);
  };

  newPage();

  for (const el of SCRIPT) {
    const opens = el.opens ?? true;
    if (el.newPage) newPage();

    if (el.atFoot) {
      y = Math.max(y + PITCH, CONTENT_BOTTOM - el.lines.length * PITCH);
    } else {
      if (el.dropPitches) y += PITCH * el.dropPitches;
      else if (opens && convention === 'block' && y > CONTENT_TOP) y += BLOCK_GAP_PX;
      if (y + el.lines.length * PITCH > CONTENT_BOTTOM) newPage();
    }

    const ls: ScanLine[] = [];
    el.lines.forEach((text, i) => {
      const w = runsFull(el.category, i, el.lines.length, text)
        ? RIGHT - LEFT
        : widthOf(text);
      let x0 = LEFT;
      if (el.centred) x0 = LEFT + Math.round((RIGHT - LEFT - w) / 2);
      else if (i === 0 && opens && convention === 'indent' && el.category === 'body') x0 = LEFT + INDENT_PX;
      ls.push(addLine(page, x0, y, w, text));
      y += PITCH;
    });
    addBlock(page, el.category, ls);
  }

  // The folio, last on every page in reading order.
  for (let p = 0; p <= page; p++) {
    const l = addLine(p, 580, FOOTER_Y, 40, String(p + 12));
    // Re-key it onto its own page's list, and keep line order by page.
    pageBlocks[p].push({
      id: `f${String(p).padStart(4, '0')}`,
      page: p,
      category: 'footer',
      lineIds: [l.id],
      bbox: [l.bbox[0], l.bbox[1], l.bbox[2], l.bbox[3]],
    });
  }

  return {
    lines: lines.slice().sort((a, b) => (a.page - b.page) || (a.bbox[1] - b.bbox[1])),
    blocks: pageBlocks.flat(),
    pages: page + 1,
  };
}

// ── assembly ────────────────────────────────────────────────────────────────

export function buildRun(convention: Convention, runDir: string): void {
  const laid = layout(convention);

  const calLines: CalibrationLine[] = laid.lines.map(l => ({ page: l.page, bbox: l.bbox }));
  const calibration = calibrate(calLines);

  const geometry = computeBlockGeometry(laid.blocks, laid.lines, calibration);
  const blocks: Block[] = laid.blocks.map(b => ({
    id: b.id,
    page: b.page,
    bbox: b.bbox,
    lineIds: b.lineIds,
    category: b.category,
    geometry: geometry.get(b.id)!,
  }));

  rmSync(runDir, { recursive: true, force: true });

  writeArtifact(runDir, 'run', {
    runId: `synthetic-${convention}`,
    createdAt: '1980-01-01T00:00:00Z',
    foundryVersion: 'fixture',
    input: { path: `${convention}.pdf`, sha256: '0'.repeat(64), pages: laid.pages },
    tesseract: { version: '5.3.4', binarySha256: '0'.repeat(64), tessdata: ['eng'], dpi: DPI },
    models: { base: 'foundry:4b', boxes: 'foundry-boxes-v6-4b' },
    stages: {
      scan: { status: 'done' },
      boxes: { status: 'done' },
      ocr: { status: 'pending' },
      footnotes: { status: 'pending' },
      export: { status: 'pending' },
    },
  });

  writeArtifact(runDir, 'scanPages', {
    pages: Array.from({ length: laid.pages }, (_, page) => ({
      page, widthPx: PAGE_W, heightPx: PAGE_H, deskewDeg: 0, dpi: DPI,
    })),
  });

  writeArtifact(runDir, 'scanLines', { lines: laid.lines });
  writeArtifact(runDir, 'boxesBlocks', { calibration, blocks });
}

export const FIXTURE_ROOT = dirname(fileURLToPath(import.meta.url));
export const CONVENTIONS: readonly Convention[] = ['indent', 'block', 'none'];
export const runDirFor = (convention: Convention, root = FIXTURE_ROOT): string =>
  join(root, `${convention}-book`);

if (import.meta.main) {
  for (const convention of CONVENTIONS) {
    const dir = runDirFor(convention);
    buildRun(convention, dir);
    console.log(`wrote ${dir}`);
  }
}
