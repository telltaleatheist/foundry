/**
 * The read phase, and the promise that makes it worth being a step of its own.
 *
 * `foundry vlm-read` puts a book in a bank and `foundry vlm-convert
 * --reuse-readings` turns that bank into an EPUB, a text file or a facsimile
 * PDF. The whole arrangement rests on ONE claim: rendering a second format costs
 * no GPU. If a replay quietly loaded a model or posted a page to a server, the
 * split would be a worse version of the thing it replaced — the same money, paid
 * twice, with an extra command to type.
 *
 * An absence of work cannot be observed from outside without a GPU and a server
 * to not use, so the bridge is handed in and WATCHED: what the phase asked the
 * subprocess for, and whether it asked the endpoint for anything at all. Both
 * questions are settled before the format fork — `convert.ts` chooses between
 * EPUB, text and PDF strictly downstream of this function — so what holds here
 * holds for every format by construction.
 *
 * The progress lines are pinned too, with the app's own regexes. Something is
 * watching stderr to move a progress bar, and a line that stopped matching would
 * be a bar that stopped moving on a run that was working perfectly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { VlmPage, VlmRunOptions, VlmRunResult } from '../../src/vlm/bridge.js';
import type { VlmEndpointOptions } from '../../src/vlm/endpoint.js';
import { requireVlmModel } from '../../src/vlm/models.js';
import { readPagesIntoBank, vlmRead, type VlmBridge } from '../../src/vlm/read.js';
import {
  readCompletionMarker,
  VlmReadings,
  VlmReadingsError,
  writeCompletionMarker,
} from '../../src/vlm/readings.js';

const DOTS = requireVlmModel('dots-ocr');

/** What dots would answer for a page, in the shape the parser wants. */
function answerFor(page: number): string {
  return JSON.stringify([
    { bbox: [200, 400, 1100, 900], category: 'Text', text: `page ${page} of the book` },
  ]);
}

interface Watched {
  bridge: VlmBridge;
  /** Every call to the rasteriser/reader subprocess, with what it was asked for. */
  rendered: VlmRunOptions[];
  /** Every call to the server. An empty list is the point of half these tests. */
  posted: VlmEndpointOptions[];
}

/**
 * A bridge that answers instead of spawning, and remembers what it was asked.
 *
 * It imitates `vlm_page.py` where the imitation matters: in render mode every
 * page comes back `skipped` and no model is ever loaded, and a page whose answer
 * is already banked comes back skipped too. Those two are the whole difference
 * between a run that costs GPU-minutes and one that costs none.
 */
function watch(pageCount: number): Watched {
  const rendered: VlmRunOptions[] = [];
  const posted: VlmEndpointOptions[] = [];
  const bridge: VlmBridge = {
    readPages: async (opts): Promise<VlmRunResult> => {
      rendered.push(opts);
      const excluded = new Set(opts.excludePages ?? []);
      const banked = new Set(opts.skipPages ?? []);
      const numbers = Array.from({ length: pageCount }, (_, i) => i + 1)
        .filter((n) => !excluded.has(n));
      const readsSomething = opts.renderOnly !== true && numbers.some((n) => !banked.has(n));
      if (readsSomething) opts.onLoaded?.(1.5);

      const pages: VlmPage[] = [];
      for (const number of numbers) {
        const skipped = opts.renderOnly === true || banked.has(number);
        const text = skipped ? '' : answerFor(number);
        const page: VlmPage = {
          number,
          width: 1300,
          height: 2112,
          renderSeconds: 0.1,
          seconds: skipped ? 0 : 2,
          chars: text.length,
          tokens: skipped ? 0 : 40,
          finishReason: skipped ? null : 'stop',
          text,
          skipped,
        };
        pages.push(page);
        opts.onPage?.(page, numbers.length);
      }
      return {
        document: { pages: pageCount, title: 'A Book', author: 'A Person', widthPt: 468, heightPt: 760 },
        pages,
        unreadable: [],
        loadSeconds: readsSomething ? 1.5 : 0,
        renderSeconds: 0.1 * numbers.length,
        inferenceSeconds: pages.filter((p) => !p.skipped).length * 2,
        peakRssBytes: null,
      };
    },
    fromEndpoint: async (opts): Promise<void> => {
      posted.push(opts);
      for (const page of opts.pages) {
        opts.onPage({
          number: page.number,
          text: answerFor(page.number),
          tokens: 40,
          finishReason: 'stop',
          seconds: 1,
          response: { id: `chatcmpl-${page.number}`, usage: { completion_tokens: 40 } },
        });
      }
    },
  };
  return { bridge, rendered, posted };
}

/** A directory with a bank in it, holding answers for `banked`. */
function bankOf(banked: readonly number[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-read-test-'));
  const readingsPath = path.join(dir, 'readings.jsonl');
  const readings = VlmReadings.open(readingsPath);
  for (const page of banked) {
    readings.append({
      page,
      text: answerFor(page),
      tokens: 40,
      finishReason: 'stop',
      seconds: 2,
      render: { width: 1300, height: 2112 },
      maxPixels: 11_289_600,
      model: 'dots-ocr',
    });
  }
  return readingsPath;
}

function markComplete(readingsPath: string, pages: number, outPath: string | null): void {
  writeCompletionMarker(readingsPath, {
    completedAt: '2026-08-01T12:00:00.000Z',
    outPath,
    pages,
  });
}

function phaseOptions(readingsPath: string, watched: Watched) {
  return {
    label: 'vlm-convert' as const,
    pdfPath: path.join(path.dirname(readingsPath), 'book.pdf'),
    model: DOTS,
    rendersDir: path.join(path.dirname(readingsPath), 'renders'),
    keepRenders: false,
    maxPixels: 11_289_600,
    skipPages: [] as readonly number[],
    readingsPath,
    bridge: watched.bridge,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The replay costs nothing
// ─────────────────────────────────────────────────────────────────────────────

test('a replay renders the pages and reads none of them: no model, no server', async () => {
  const readingsPath = bankOf([1, 2, 3]);
  markComplete(readingsPath, 3, path.join(path.dirname(readingsPath), 'book.epub'));
  const before = fs.readFileSync(readingsPath);
  const watched = watch(3);
  const lines: string[] = [];

  const phase = await readPagesIntoBank({
    ...phaseOptions(readingsPath, watched),
    endpoint: 'http://localhost:8000/v1',
    reuseReadings: true,
    log: (line) => lines.push(line),
  });

  // RENDER MODE. The helper loads no weights in it, which is the minutes this
  // whole split exists to stop paying twice.
  assert.equal(watched.rendered.length, 1);
  assert.equal(watched.rendered[0].renderOnly, true);
  // And not one request, rather than an empty queue politely posted.
  assert.deepEqual(watched.posted, []);
  assert.ok(
    lines.some((l) => l.includes('every page is answered out of the bank')),
    'the run did not say that it read nothing',
  );

  // Every answer is there, out of the bank.
  assert.deepEqual([...phase.answers.keys()].sort((a, b) => a - b), [1, 2, 3]);
  assert.equal(phase.answers.get(2), answerFor(2));
  assert.equal(phase.inferredPages, 0);
  assert.equal(phase.bankAction, 'reuse');

  // THE BANK IS NOT DISTURBED: not a byte rewritten, nothing archived.
  assert.deepEqual(fs.readFileSync(readingsPath), before);
  assert.deepEqual(
    fs.readdirSync(path.dirname(readingsPath)).filter((e) => e.startsWith('archived-')),
    [],
  );
});

test('a replay against the MLX route is the same promise: render only', async () => {
  const readingsPath = bankOf([1, 2]);
  markComplete(readingsPath, 2, path.join(path.dirname(readingsPath), 'book.epub'));
  const watched = watch(2);

  const phase = await readPagesIntoBank({
    ...phaseOptions(readingsPath, watched),
    reuseReadings: true,
    log: () => {},
  });

  assert.equal(watched.rendered[0].renderOnly, true);
  assert.equal(phase.run.loadSeconds, 0);
  assert.equal(phase.inferredPages, 0);
  // The pages were still rasterised — a rendering measures the ink of a page
  // turn, cuts figures out of the scan and takes the cover from it.
  assert.equal(phase.run.pages.length, 2);
  assert.equal(phase.sizes.get(1)?.width, 1300);
});

test('an INTERRUPTED bank still reads the pages that are missing', async () => {
  // The other half of the rule: no marker means a debt, and a debt gets paid.
  const readingsPath = bankOf([1, 2]);
  const watched = watch(3);

  const phase = await readPagesIntoBank({
    ...phaseOptions(readingsPath, watched),
    log: () => {},
  });

  assert.notEqual(watched.rendered[0].renderOnly, true);
  assert.deepEqual(watched.rendered[0].skipPages, [1, 2]);
  assert.equal(phase.inferredPages, 1);
  assert.equal(phase.answers.get(3), answerFor(3));
  assert.equal(VlmReadings.open(readingsPath).size, 3);
});

test('an interrupted bank against a server asks it only for what is missing', async () => {
  const readingsPath = bankOf([1, 3]);
  const watched = watch(3);

  await readPagesIntoBank({
    ...phaseOptions(readingsPath, watched),
    endpoint: 'http://localhost:8000/v1',
    log: () => {},
  });

  assert.equal(watched.posted.length, 1);
  assert.deepEqual(watched.posted[0].pages.map((p) => p.number), [2]);
  // And what came back is banked whole: the server's own body, the geometry the
  // render pass measured, the budget and the model.
  const banked = VlmReadings.open(readingsPath).get(2)!;
  assert.deepEqual(banked.response, { id: 'chatcmpl-2', usage: { completion_tokens: 40 } });
  assert.deepEqual(banked.render, { width: 1300, height: 2112 });
  assert.equal(banked.maxPixels, 11_289_600);
  assert.equal(banked.model, 'dots-ocr');
});

// ─────────────────────────────────────────────────────────────────────────────
// The progress lines
//
// Copied from `parseProgressLine` in app/electron/engine.ts, which is what
// actually reads them. They are the contract; the prose around them is free.
// ─────────────────────────────────────────────────────────────────────────────

const LOCAL_PROGRESS = /\bpage\s+(\d+)\/(\d+)\b/;
const ENDPOINT_PROGRESS = /\bpage\s+\d+\s+\((\d+)\/(\d+)\)/;

test('vlm-read says the same progress as vlm-convert, under its own name', async () => {
  const readingsPath = bankOf([]);
  const watched = watch(3);
  const lines: string[] = [];

  await readPagesIntoBank({
    ...phaseOptions(readingsPath, watched),
    label: 'vlm-read',
    log: (line) => lines.push(line),
  });

  const progress = lines.filter((l) => LOCAL_PROGRESS.test(l));
  assert.equal(progress.length, 3);
  for (const line of progress) assert.ok(line.startsWith('vlm-read: '), line);
  const [, page, total] = LOCAL_PROGRESS.exec(progress[1])!;
  assert.deepEqual([page, total], ['2', '3']);
});

test('the endpoint progress line keeps its (done/total) shape under vlm-read', async () => {
  const readingsPath = bankOf([]);
  const watched = watch(3);
  const lines: string[] = [];

  await readPagesIntoBank({
    ...phaseOptions(readingsPath, watched),
    label: 'vlm-read',
    endpoint: 'http://localhost:8000/v1',
    log: (line) => lines.push(line),
  });

  const progress = lines.filter((l) => ENDPOINT_PROGRESS.test(l));
  assert.equal(progress.length, 3);
  for (const line of progress) assert.ok(line.startsWith('vlm-read: '), line);
  const [, done, total] = ENDPOINT_PROGRESS.exec(progress[2])!;
  assert.deepEqual([done, total], ['3', '3']);
});

// ─────────────────────────────────────────────────────────────────────────────
// The command
// ─────────────────────────────────────────────────────────────────────────────

/** A `book.pdf` beside the bank, so the existence check has something to find. */
function withPdf(readingsPath: string): string {
  const pdfPath = path.join(path.dirname(readingsPath), 'book.pdf');
  fs.writeFileSync(pdfPath, '%PDF-1.7\n');
  return pdfPath;
}

test('vlm-read banks the book and writes a marker that produced NO document', async () => {
  const readingsPath = bankOf([]);
  const watched = watch(4);
  const lines: string[] = [];

  const report = await vlmRead({
    pdfPath: withPdf(readingsPath),
    readingsPath,
    modelId: 'dots-ocr',
    language: 'de',
    bridge: watched.bridge,
    log: (line) => lines.push(line),
  });

  assert.equal(report.pages.length, 4);
  assert.equal(report.banked, 4);
  assert.equal(report.inferredPages, 4);
  assert.equal(VlmReadings.open(readingsPath).size, 4);

  // outPath IS NULL, and that is the honest answer: this run wrote no document.
  const marker = readCompletionMarker(readingsPath)!;
  assert.equal(marker.outPath, null);
  assert.equal(marker.pages, 4);
  // The language is recorded rather than used — the step that renders the book
  // is a separate invocation, and this is where it can find what it was told.
  assert.equal(marker.language, 'de');
  assert.deepEqual(report.completion, marker);

  // And the run says what it made and what makes it worth having.
  assert.ok(lines.some((l) => l.includes('The product of this run is the reading'))
    || lines.some((l) => l.includes('the product of this run is the reading')), lines.join('\n'));
  assert.ok(lines.some((l) => l.includes('--reuse-readings')));
});

test('vlm-read resumes its own bank and pays only for the pages missing from it', async () => {
  const readingsPath = bankOf([1, 2]);
  const watched = watch(3);

  const report = await vlmRead({
    pdfPath: withPdf(readingsPath),
    readingsPath,
    modelId: 'dots-ocr',
    bridge: watched.bridge,
    log: () => {},
  });

  assert.equal(report.inferredPages, 1);
  assert.equal(report.banked, 3);
  assert.equal(readCompletionMarker(readingsPath)?.outPath, null);
  // No language was given, so the marker claims none rather than inventing one.
  assert.equal(readCompletionMarker(readingsPath)?.language, undefined);
});

test('vlm-read names a PDF that is not there rather than banking nothing quietly', async () => {
  const readingsPath = bankOf([]);
  await assert.rejects(
    () => vlmRead({
      pdfPath: path.join(path.dirname(readingsPath), 'absent.pdf'),
      readingsPath,
      modelId: 'dots-ocr',
      bridge: watch(1).bridge,
      log: () => {},
    }),
    (err: Error) => /no such PDF/.test(err.message),
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// The marker, old and new
// ─────────────────────────────────────────────────────────────────────────────

test('a marker written by a conversion still names its book, and still reads', () => {
  const readingsPath = bankOf([1]);
  const outPath = path.join(path.dirname(readingsPath), 'book.epub');
  // The exact bytes a foundry that had never heard of vlm-read wrote.
  fs.writeFileSync(
    `${readingsPath.replace(/\.jsonl$/, '')}.completed.json`,
    JSON.stringify({
      completedAt: '2026-01-01T00:00:00.000Z',
      outPath,
      pages: 300,
      foundryVersion: '0.9.0',
    }),
  );
  const marker = readCompletionMarker(readingsPath)!;
  assert.equal(marker.outPath, outPath);
  assert.equal(marker.pages, 300);
  assert.equal(marker.language, undefined);
});

test('a marker that does not say what it produced, one way or the other, is refused', () => {
  const readingsPath = bankOf([1]);
  fs.writeFileSync(
    `${readingsPath.replace(/\.jsonl$/, '')}.completed.json`,
    JSON.stringify({ completedAt: '2026-01-01T00:00:00.000Z', pages: 3, foundryVersion: '0.9.1' }),
  );
  // Null is a reading. ABSENT is a file this program did not write, and reading
  // it as "no document" would be guessing about somebody else's file.
  assert.throws(() => readCompletionMarker(readingsPath), VlmReadingsError);
});

test('a replay of a bank with a hole in it reports the hole rather than paying for it', async () => {
  /*
   * `reuse` is `readings.ts` saying "a finished run's answers are replayed, and
   * NO PAGE IS READ" — the sentence it prints says exactly that. A bank that was
   * marked complete with a page missing (the model could not read it) used to
   * make the MLX route quietly load the model and pay for that page anyway,
   * which is the sentence being false. The hole is now carried forward, where
   * every renderer already knows how to name it.
   */
  const readingsPath = bankOf([1, 3]);
  markComplete(readingsPath, 3, path.join(path.dirname(readingsPath), 'book.epub'));
  const watched = watch(3);

  const phase = await readPagesIntoBank({
    ...phaseOptions(readingsPath, watched),
    reuseReadings: true,
    log: () => {},
  });

  assert.equal(watched.rendered[0].renderOnly, true);
  assert.equal(phase.inferredPages, 0);
  assert.deepEqual([...phase.answers.keys()].sort((a, b) => a - b), [1, 3]);
  // Page 2 has no answer, and the renderers say so by number — a facsimile keeps
  // the scan of it, a book leaves it out and the run names it either way.
  assert.equal(phase.answers.has(2), false);
  assert.equal(VlmReadings.open(readingsPath).size, 2);
});
