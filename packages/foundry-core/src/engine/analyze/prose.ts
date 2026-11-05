/**
 * analyze/prose — the book, as the one list of sentences both halves of an
 * analysis read.
 *
 * `analyze-rank` scores these sentences and `analyze` verifies passages of
 * them, in two processes on two models, and the rank file the first writes is
 * indexed by sentence. So the list has to come out of one function, read the
 * same way both times, or the second process would be verifying the first
 * one's answers against a different book.
 */
import * as fs from 'node:fs';

import { stripBom } from '../bom.js';
import { parseBookFile } from '../vlm/book-file.js';
import { bookSentence, type BookSentence } from './rank.js';
import { splitSentences } from './sentences.js';

/** The run cannot continue, and the message says why. */
export class AnalyzeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalyzeError';
  }
}

/**
 * The rows whose words are read.
 *
 * The translate set minus the furniture: a running head is not prose and a page
 * number is not an assertion, and both recur on every page — scoring them would
 * spend the ranker proving that the book's title is not hate speech, several
 * hundred times. `Formula`, `Picture` and `Table` are out for their own reason:
 * a formula and a picture have no sentences, and a table's cells are not one.
 *
 * SHELVED ROWS ARE OUT TOO, by `shelf === undefined` rather than by category —
 * a block the reflow judged to be a running head is out of the flow, and
 * analysing something the reader is not shown would flag a passage nobody can
 * be travelled to.
 */
const PROSE: ReadonlySet<string> = new Set([
  'Caption', 'Footnote', 'List-item', 'Quote', 'Section-header', 'Text', 'Title',
]);

export interface ProseBook {
  sentences: BookSentence[];
  bankSha: string;
  generation: string | undefined;
}

/** Read the book, take its prose, and cut it into one flat list of sentences. */
export function readProse(bookPath: string, act: string, log: (line: string) => void): ProseBook {
  if (!fs.existsSync(bookPath)) throw new AnalyzeError(`no such book file: ${bookPath}`);
  const book = parseBookFile(stripBom(fs.readFileSync(bookPath, 'utf8')));

  const sentences: BookSentence[] = [];
  let rows = 0;
  for (const row of book.rows) {
    if (row.shelf !== undefined) continue;
    if (!PROSE.has(row.category)) continue;
    rows += 1;
    for (const sentence of splitSentences(row.text)) {
      sentences.push(bookSentence(row.id, sentence.start, sentence.end, sentence.text));
    }
  }
  log(
    `${act}: ${book.rows.length} row(s) in the book, ${rows} of them prose in the flow, cut into `
    + `${sentences.length} sentence(s)`,
  );
  if (sentences.length === 0) {
    throw new AnalyzeError(
      `${bookPath} has no prose to analyse. Its rows are all shelved, or all figures, formulae and `
      + 'tables — there is nothing here for a model to read.',
    );
  }
  return { sentences, bankSha: book.source.bankSha, generation: book.source.generation };
}
