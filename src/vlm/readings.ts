/**
 * vlm/readings — the answers, on disk, one JSON object per line.
 *
 * A book read by a vision model costs minutes of GPU per dozen pages, and the
 * one thing that must never happen is paying for a page twice. So `--readings`
 * names a file, every answer is appended and FSYNCED the moment it exists, and
 * a run that starts against an existing file reads only the pages that are not
 * in it. A kill costs the page that was in flight.
 *
 * It is a CACHE OF ANSWERS, not a cache of books. Nothing downstream is skipped
 * because of it: the pages are still rendered, still parsed, still assembled,
 * so a fix to the dialect or the assembler is re-run for free over answers that
 * cost an hour. That is the same distinction the pipeline draws between a
 * cached stage and an input read off disk.
 *
 * The file is keyed by page number and nothing else — it belongs to one PDF,
 * and pointing it at a second one is the caller naming the wrong file.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface VlmReading {
  page: number;
  text: string;
  tokens: number;
  finishReason: string | null;
  seconds: number;
}

export class VlmReadingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VlmReadingsError';
  }
}

export class VlmReadings {
  private readonly byPage = new Map<number, VlmReading>();

  private constructor(private readonly filePath: string) {}

  /**
   * Open a readings file, reading whatever is already in it.
   *
   * A malformed LAST line is an interrupted append and is dropped; a malformed
   * line anywhere else is a file this program did not write, and it fails
   * naming the line. The difference matters: the first is the normal
   * consequence of a kill, and the second is a wrong `--readings` path about to
   * silently supply somebody else's pages.
   */
  static open(filePath: string): VlmReadings {
    const readings = new VlmReadings(path.resolve(filePath));
    if (!fs.existsSync(readings.filePath)) return readings;
    const lines = fs.readFileSync(readings.filePath, 'utf8').split('\n');
    for (const [index, line] of lines.entries()) {
      if (line.trim().length === 0) continue;
      const last = lines.slice(index + 1).every((rest) => rest.trim().length === 0);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        if (last) break;
        throw new VlmReadingsError(
          `${readings.filePath}, line ${index + 1} is not JSON `
          + `(${err instanceof Error ? err.message : String(err)}). This file is not a readings file.`,
        );
      }
      const record = parsed as Partial<VlmReading>;
      if (typeof record.page !== 'number' || typeof record.text !== 'string') {
        throw new VlmReadingsError(
          `${readings.filePath}, line ${index + 1} carries no page and text. This file is not a readings file.`,
        );
      }
      readings.byPage.set(record.page, {
        page: record.page,
        text: record.text,
        tokens: record.tokens ?? 0,
        finishReason: record.finishReason ?? null,
        seconds: record.seconds ?? 0,
      });
    }
    return readings;
  }

  get size(): number {
    return this.byPage.size;
  }

  has(page: number): boolean {
    return this.byPage.has(page);
  }

  get(page: number): VlmReading | undefined {
    return this.byPage.get(page);
  }

  pages(): number[] {
    return [...this.byPage.keys()].sort((a, b) => a - b);
  }

  /** Append and fsync. The whole point is that a kill costs one page. */
  append(reading: VlmReading): void {
    this.byPage.set(reading.page, reading);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const handle = fs.openSync(this.filePath, 'a');
    try {
      fs.writeSync(handle, `${JSON.stringify(reading)}\n`);
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
  }
}
