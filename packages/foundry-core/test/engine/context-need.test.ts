/**
 * The context a run needs, measured before any model is loaded
 * (src/engine/context-need.ts, src/node/context-need.ts).
 *
 * Owen, 2026-11-11: a Simplify failed because Crucible started the 27B at a
 * context it could not hold, and he asked for the need to be stated before the
 * load, measured from each book. What is kept here: the two halves of the line
 * agree; each measured stage plans its book and asks NO server (every transport
 * here throws); nothing is written; and a longer paragraph raises the figure.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as engineSide from '../../src/engine/context-need.js';
import * as queueSide from '../../src/node/context-need.js';
import { measureCleanText } from '../../src/engine/clean/run.js';
import { measureCleanTriage } from '../../src/engine/clean/triage.js';
import { measureTranslation } from '../../src/engine/translate/run.js';
import type { Transport } from '../../src/engine/translate/transport.js';

const SHORT = [
  'The committee met on the first floor and adjourned before noon.',
  'Nobody present had read the report, and nobody said so out loud.',
  'A second meeting was called for the following week, in the same room.',
];
const LONG = `${'The minutes were never circulated, which surprised exactly no one. '.repeat(60)}`.trim();

function bookFile(dir: string, texts: readonly string[]): string {
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

/** A server nobody may call: a measure that reached for one fails the test by name. */
const NO_SERVER: Transport = {
  get: async (url) => { throw new Error(`a measure asked a server: GET ${url}`); },
  post: async (url) => { throw new Error(`a measure asked a server: POST ${url}`); },
};

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-context-need-'));
}

const quiet = (): void => {};

describe('the line both halves read', () => {
  test('the prefix is spelled the same in the engine and the queue', () => {
    expect(engineSide.CONTEXT_NEED_PREFIX).toBe(queueSide.CONTEXT_NEED_PREFIX);
  });

  test('a printed need reads back, and so does a run that would ask nothing', () => {
    const lines: string[] = [];
    const write = process.stdout.write;
    process.stdout.write = ((chunk: string) => { lines.push(chunk); return true; }) as typeof process.stdout.write;
    try {
      engineSide.printContextNeed(5166);
      engineSide.printContextNeed(null);
    } finally {
      process.stdout.write = write;
    }
    expect(queueSide.readContextNeed(`progress\n${lines[0]}`)).toEqual({ contextTokens: 5166 });
    expect(queueSide.readContextNeed(lines[1]!)).toEqual({ contextTokens: null });
    expect(queueSide.readContextNeed('a run that broke printed nothing\n')).toBeNull();
    expect(() => queueSide.readContextNeed(`${queueSide.CONTEXT_NEED_PREFIX}{"contextTokens":0}`)).toThrow();
    expect(() => engineSide.printContextNeed(0)).toThrow();
  });
});

describe('each measured stage plans its book and asks no server', () => {
  test('a cleanup: a figure, nothing written, and a longer paragraph needs more', async () => {
    const short = scratch();
    const long = scratch();
    const measure = (dir: string, texts: readonly string[]) => measureCleanText({
      bookPath: bookFile(dir, texts),
      recordsPath: path.join(dir, 'clean.records.jsonl'),
      stampPath: path.join(dir, 'clean.stamp.json'),
      endpoint: 'http://measuring.invalid/openai',
      transport: NO_SERVER,
      log: quiet,
    });
    const small = await measure(short, SHORT);
    const large = await measure(long, [...SHORT, LONG]);
    expect(small).not.toBeNull();
    expect(large!).toBeGreaterThan(small!);
    // The edit list's answer room is in every request's need.
    expect(small!).toBeGreaterThan(2048);
    expect(fs.readdirSync(short).sort()).toEqual(['book.jsonl']);
    expect(fs.readdirSync(long).sort()).toEqual(['book.jsonl']);
  });

  test('a simplify: a figure, nothing written, and a longer paragraph needs more', async () => {
    const short = scratch();
    const long = scratch();
    const measure = (dir: string, texts: readonly string[]) => measureTranslation({
      bookPath: bookFile(dir, texts),
      recordsPath: path.join(dir, 'simplify.records.jsonl'),
      to: 'en',
      rewrite: 'dejargon',
      endpoint: 'http://measuring.invalid/openai',
      transport: NO_SERVER,
      log: quiet,
    });
    const small = await measure(short, SHORT);
    const large = await measure(long, [...SHORT, LONG]);
    expect(large).toBeGreaterThan(small);
    expect(large).toBeGreaterThan(Math.ceil(LONG.length / 2.5));
    expect(fs.readdirSync(short).sort()).toEqual(['book.jsonl']);
    expect(fs.readdirSync(long).sort()).toEqual(['book.jsonl']);
  });

  test('a triage: a figure from the book with no door and no model named, nothing written', async () => {
    const dir = scratch();
    const need = await measureCleanTriage({
      bookPath: bookFile(dir, [...SHORT, LONG]),
      outPath: path.join(dir, 'clean.triage.json'),
      endpoint: '',
      model: '',
      transport: NO_SERVER,
      log: quiet,
    });
    expect(need).not.toBeNull();
    expect(need!).toBeGreaterThan(Math.ceil(LONG.length / 2.5));
    expect(fs.readdirSync(dir).sort()).toEqual(['book.jsonl']);
  });
});
