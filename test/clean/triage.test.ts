/**
 * THE TRIAGED CLEANUP — `clean-triage` flags, `clean-text --triage` cleans only
 * what was flagged and records the rest as examined and clean.
 *
 * Owen, 2026-09-23: *"we create a list of blocks that need to be cleaned with
 * snap and then we bring snap down and load the full normal cleaning logic"*,
 * and *"mark those that dont need to be cleaned as 'clean' so everything is
 * uniform and it's verified that it was at least examined."*
 *
 * No server and no GPU: the decide door is a fake transport that answers the
 * wire PHASE22-DECIDE §2.2 specifies, and the cleaner is a stub runner that
 * remembers every block it was shown.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { receiptPath, runCleanText, triageKey, cleanKey } from '../../src/clean/run.js';
import {
  decideUrl, needsCleaning, readTriageFile, runCleanTriage, TRIAGE_FLAG_P, TRIAGE_GUIDE,
  TRIAGE_MIN_LABEL_MASS, type TriageFile,
} from '../../src/clean/triage.js';
import type { NumberNormalizerRunner } from '../../src/clean/tts-number-normalizer.js';
import type { HttpResponse, Transport } from '../../src/translate/transport.js';

/** b1-2 prints a year and b1-4 an acronym; b1-1 and b1-3 are plain prose. */
const TEXTS = [
  'The committee met on the first floor and adjourned before noon.',
  'The report was finally published in 1953, long after anyone cared.',
  'Nobody present had read it -- and nobody said so out loud.',
  'The FBI kept a copy anyway, filed under a name nobody remembers.',
];
const NEEDS = new Set(['b1-2', 'b1-4']);

function bookFile(dir: string, texts: readonly string[] = TEXTS): string {
  const header = {
    book: 3,
    engine: 'foundry-test',
    language: 'en',
    source: { pages: 1, unreadable: [], bankSha: 'sha256:test' },
    chapters: [],
    typography: null,
    seams: [],
    loose: { markers: [], notes: [] },
  };
  const rows = texts.map((text, at) => ({
    id: `b1-${at + 1}`,
    category: 'Text',
    text,
    page: 1,
    pages: [1],
    box: [0, 0, 100, 10],
    parts: [{ src: `p1-${at + 1}`, page: 1, chars: [0, text.length] }],
  }));
  const at = path.join(dir, 'book.jsonl');
  fs.writeFileSync(at, [JSON.stringify(header), ...rows.map((row) => JSON.stringify(row))].join('\n') + '\n');
  return at;
}

interface DecideRequest { model: string; state: string; questions: Record<string, { type: string; instructions: string }> }

/**
 * A decide door. `answer` gives P(yes) per question name; `before` may return
 * a refusal to send first (once per call index).
 */
function fakeDoor(
  answer: (name: string) => number,
  before: (call: number) => HttpResponse | null = () => null,
): Transport & { requests: DecideRequest[]; urls: string[] } {
  const requests: DecideRequest[] = [];
  const urls: string[] = [];
  let calls = 0;
  return {
    requests,
    urls,
    async get(): Promise<HttpResponse> { throw new Error('the triage never GETs'); },
    async post(url: string, body: string): Promise<HttpResponse> {
      calls += 1;
      urls.push(url);
      const refusal = before(calls);
      if (refusal !== null) return refusal;
      const request = JSON.parse(body) as DecideRequest;
      requests.push(request);
      const answers = Object.fromEntries(Object.keys(request.questions).map((name) => [
        name, { type: 'yesno', p: answer(name), label_mass: 0.99 },
      ]));
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          model: { id: 'qwen3.5-0.8b', revision: 'r1', fingerprint: 'f1' },
          engine: 'vllm',
          answers,
          timing_ms: { total: 1, per_question: {}, prime: null },
          tokens: { per_question: {}, images: 0 },
        }),
      };
    },
  };
}

/** A cleaner that proposes nothing and remembers what it was shown. */
function stubCleaner(): NumberNormalizerRunner & { seen: string[] } {
  const seen: string[] = [];
  return {
    seen,
    model: 'the-cleaner',
    async generate(input: string): Promise<string> {
      seen.push(input);
      return '{"edits": []}';
    },
    async release(): Promise<void> { /* nothing was loaded. */ },
  };
}

/**
 * Which of the book's paragraphs a cleaner was shown as its TARGET — matched by
 * the paragraph's closing words, because the number rules run before the model
 * and have already spelled a year out by the time it is shown.
 */
function targetsShown(seen: readonly string[], texts: readonly string[] = TEXTS): number[] {
  return texts.flatMap((text, at) => {
    const ending = text.slice(-24);
    return seen.some((input) => {
      const target = input.slice(input.indexOf('TARGET'), input.indexOf('NEXT ('));
      return target.includes(ending);
    }) ? [at + 1] : [];
  });
}

const noSleep = async (): Promise<void> => {};

async function triage(dir: string, door: Transport): Promise<{ out: string; file: TriageFile }> {
  const out = path.join(dir, 'triage.json');
  const done = await runCleanTriage({
    bookPath: path.join(dir, 'book.jsonl'),
    outPath: out,
    endpoint: 'http://crucible:7100',
    model: 'qwen3.5-0.8b',
    transport: door,
    sleep: noSleep,
    log: () => {},
  });
  return { out, file: done.file };
}

describe('clean-triage', () => {
  test('asks the decide door one yes/no per block over one state, and writes every verdict', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-'));
    bookFile(dir);
    const door = fakeDoor((name) => (NEEDS.has(name) ? 0.97 : 0.02));
    const { out, file } = await triage(dir, door);

    expect(door.urls[0]).toBe('http://crucible:7100/v1/decide');
    expect(door.requests).toHaveLength(1);
    const request = door.requests[0]!;
    expect(request.model).toBe('qwen3.5-0.8b');
    expect(Object.keys(request.questions)).toEqual(['b1-1', 'b1-2', 'b1-3', 'b1-4']);
    expect(request.questions['b1-2']).toEqual({ type: 'yesno', instructions: 'Block [b1-2] needs cleaning.' });
    expect(request.state.startsWith(TRIAGE_GUIDE)).toBe(true);
    // The state shows the STAGE-1 text: the book's "--" is already an em dash.
    expect(request.state).toContain('[b1-3] (text) Nobody present had read it—and nobody said so out loud.');

    expect(Object.entries(file.blocks).map(([parts, v]) => [parts, v.needsCleaning]))
      .toEqual([['b1-1', false], ['b1-2', true], ['b1-3', false], ['b1-4', true]]);
    expect(file.model.id).toBe('qwen3.5-0.8b');
    expect(readTriageFile(out).blocks['b1-2']!.p).toBe(0.97);
  });

  test('a busy door is waited out, not failed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-'));
    bookFile(dir);
    const door = fakeDoor(() => 0.5, (call) => (call === 1
      ? { status: 503, headers: { 'retry-after': '1' }, body: JSON.stringify({ error: { code: 'chat_queue_full', message: 'full' } }) }
      : null));
    const { file } = await triage(dir, door);
    expect(door.urls).toHaveLength(2);
    expect(Object.keys(file.blocks)).toHaveLength(4);
  });

  test('a model that is not resident is refused by name', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-'));
    bookFile(dir);
    const door = fakeDoor(() => 0.5, () => (
      { status: 409, headers: {}, body: JSON.stringify({ error: { code: 'model_not_resident', message: 'load it first' } }) }));
    await expect(triage(dir, door)).rejects.toThrow(/model_not_resident/);
  });

  test('every doubt resolves toward cleaning', () => {
    expect(needsCleaning(TRIAGE_FLAG_P - 0.01, 0.99)).toBe(false);
    expect(needsCleaning(TRIAGE_FLAG_P, 0.99)).toBe(true);
    expect(needsCleaning(0.01, TRIAGE_MIN_LABEL_MASS - 0.01)).toBe(true);
    expect(decideUrl('http://h:7100/v1/')).toBe('http://h:7100/v1/decide');
  });
});

describe('clean-text --triage', () => {
  test('asks the cleaner only the flagged blocks, and records the rest as examined and clean', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-'));
    const bookPath = bookFile(dir);
    const { out } = await triage(dir, fakeDoor((name) => (NEEDS.has(name) ? 0.97 : 0.02)));
    const recordsPath = path.join(dir, 'records.jsonl');
    const cleaner = stubCleaner();

    await runCleanText({
      bookPath, recordsPath, stampPath: path.join(dir, 'stamp.json'),
      endpoint: 'http://fake/v1', runner: cleaner, concurrency: 1, triagePath: out, log: () => {},
    });

    expect(targetsShown(cleaner.seen)).toEqual([2, 4]);
    // EVERY position has a row — the kept ones at their stage-1 text, under the triage's key.
    const rows = fs.readFileSync(recordsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { key: string; parts: string; text: string });
    expect(rows.map((r) => r.parts).sort()).toEqual(['b1-1', 'b1-2', 'b1-3', 'b1-4']);
    const kept = rows.find((r) => r.parts === 'b1-3')!;
    expect(kept.text).toBe('Nobody present had read it—and nobody said so out loud.');
    expect(kept.key).toBe(triageKey({ text: TEXTS[2]!, triageModel: 'qwen3.5-0.8b' }));
    expect(rows.find((r) => r.parts === 'b1-2')!.key).toBe(cleanKey({ text: TEXTS[1]!, model: 'the-cleaner' }));

    const receipt = JSON.parse(fs.readFileSync(receiptPath(recordsPath), 'utf8')) as {
      triage: { clean: string[]; flagged: number }; units: unknown[];
    };
    expect(receipt.triage.clean).toEqual(['b1-1', 'b1-3']);
    expect(receipt.triage.flagged).toBe(2);
    expect(receipt.units).toHaveLength(2);
  });

  test('a re-run with the same triage asks nothing; a run WITHOUT one asks the kept blocks', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-'));
    const bookPath = bookFile(dir);
    const { out } = await triage(dir, fakeDoor((name) => (NEEDS.has(name) ? 0.97 : 0.02)));
    const recordsPath = path.join(dir, 'records.jsonl');
    const run = (cleaner: NumberNormalizerRunner, triagePath?: string) => runCleanText({
      bookPath, recordsPath, stampPath: path.join(dir, 'stamp.json'), endpoint: 'http://fake/v1',
      runner: cleaner, concurrency: 1, ...(triagePath === undefined ? {} : { triagePath }), log: () => {},
    });
    await run(stubCleaner(), out);

    const again = stubCleaner();
    await run(again, out);
    expect(again.seen).toHaveLength(0);

    const full = stubCleaner();
    await run(full);
    expect(targetsShown(full.seen)).toEqual([1, 3]);
  });

  test('a verdict about different words is not one — the block is cleaned', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-'));
    bookFile(dir);
    const { out } = await triage(dir, fakeDoor(() => 0.01));
    // The book is edited after the triage: b1-1 now prints a year.
    const edited = [...TEXTS];
    edited[0] = 'The committee met in 1951 and adjourned before noon.';
    const bookPath = bookFile(dir, edited);
    const cleaner = stubCleaner();
    await runCleanText({
      bookPath, recordsPath: path.join(dir, 'records.jsonl'), stampPath: path.join(dir, 'stamp.json'),
      endpoint: 'http://fake/v1', runner: cleaner, concurrency: 1, triagePath: out, log: () => {},
    });
    expect(targetsShown(cleaner.seen, edited)).toEqual([1]);
  });

  test('a file that is not a triage is refused by name', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-'));
    const bad = path.join(dir, 'x.json');
    fs.writeFileSync(bad, JSON.stringify({ format: 'something-else' }));
    expect(() => readTriageFile(bad)).toThrow(/not a clean-triage file/);
  });
});
