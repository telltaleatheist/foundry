/**
 * tag/input — the two files a tag run reads, and the one normal form.
 *
 * A document (plain text, converted by whoever calls this) and a vocabulary
 * (one tag per line, hers). Nothing here talks to a model; it is the whole of
 * what this command knows about files.
 *
 * ── THE DOCUMENT IS NORMALISED, WHICH ANALYZE IS FORBIDDEN TO DO ────────────
 *
 * `analyze/sentences.ts` measures and never rewrites, because every finding it
 * produces is a pair of character offsets into a block a reader will be
 * travelled to — a `start` off by one space lights the highlight in the wrong
 * place. THIS command reports no locations at all (docs/TAGGING.md: the map of
 * where a tag matches is analyze's job and deliberately not this one), so a
 * hard-wrapped paragraph can be joined back into a paragraph before it is cut
 * into sentences. That is the difference, and it is the only reason the same
 * segmenter is allowed to be fed different bytes here: a sentence that a
 * converter broke across three lines must not be scored as three fragments.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { stripBom } from '../bom.js';
import { bookSentence, type BookSentence } from '../analyze/rank.js';
import { splitSentences } from '../analyze/sentences.js';

/** The run cannot continue, and the message says why. */
export class TagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TagError';
  }
}

/**
 * A tag, reduced to the form two spellings of one idea share.
 *
 * Used ONLY as a key — for dropping a repeat inside her list, and for keeping a
 * suggestion that is already hers (or already another suggestion) out of the
 * answer. It is never shown and never written: `applies` carries her spelling
 * verbatim, because a vocabulary is a person's own words and a tool that quietly
 * recased them would be answering a question she did not ask.
 *
 * The final `s` is dropped because "ban" and "bans" are one tag and a model
 * asked for new tags will offer the plural of one she already has; the
 * three-character floor keeps "gas" and the `ss`/`us`/`is` exceptions keep
 * "witness", "census" and "thesis" whole. IT IS NOT A STEMMER AND DOES NOT TRY
 * TO BE: a singular ending in `s` after a vowel ("bias") folds to a key that is
 * not a word, which costs nothing, because the key is never shown and every
 * spelling of that tag lands on the same one. What it can cost is a suggestion
 * dropped as a duplicate of a tag it is not — the cheap direction, and the only
 * one worth erring in.
 */
export function normalTag(tag: string): string {
  const flat = tag
    .normalize('NFKC')
    .toLowerCase()
    // Curly quotes and dashes are the same characters to a reader; a tag typed
    // in a word processor and the same tag typed in a terminal must be one tag.
    .replace(/[‘’ʼ]/g, '\'')
    .replace(/[“”]/g, '"')
    // U+2010..U+2015: hyphen through horizontal bar, all of them a dash here.
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    // Leading and trailing punctuation: a model that answers "free speech," and
    // a list that holds "free speech" are not two tags.
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[^\p{L}\p{N})\]]+$/u, '');
  const words = flat.split(' ');
  const last = words[words.length - 1] ?? '';
  if (last.length > 3 && last.endsWith('s') && !/(ss|us|is)$/.test(last)) {
    words[words.length - 1] = last.slice(0, -1);
  }
  return words.join(' ');
}

/**
 * Her vocabulary: one tag per line, blank lines skipped, her spelling kept.
 *
 * AN EMPTY FILE IS ALLOWED, and it is a real case rather than an oversight: a
 * lawyer who has not written her list yet, or who wants to know what a document
 * would be called by somebody with no list at all, gets a run that only
 * suggests. What is refused is a file that is not there — that is a typo in a
 * path, and answering it with "no tags applied" would be a lie about a document
 * this program never compared against anything.
 *
 * A repeated tag is dropped rather than scored twice: the worker refuses two
 * identical hypotheses in one request (they could not be told apart in the
 * answer), and a run that paid twice for one question would put the same word in
 * `applies` twice.
 */
export function readVocabulary(tagsPath: string, log: (line: string) => void): string[] {
  const resolved = path.resolve(tagsPath);
  if (!fs.existsSync(resolved)) {
    throw new TagError(
      `no such tags file: ${resolved}. It is one tag per line; an EMPTY file is a legal run (the `
      + 'document is only suggested for), but an absent one is a path that is wrong.',
    );
  }
  const lines = stripBom(fs.readFileSync(resolved, 'utf8')).split(/\r?\n/);

  const tags: string[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const line of lines) {
    const tag = line.trim();
    if (tag.length === 0) continue;
    const key = normalTag(tag);
    // A line of nothing but punctuation normalises to an empty key. It is not a
    // tag, and a hypothesis built from it would be a question about nothing.
    if (key.length === 0) {
      dropped += 1;
      continue;
    }
    if (seen.has(key)) {
      dropped += 1;
      continue;
    }
    seen.add(key);
    tags.push(tag);
  }

  log(
    `tag: ${tags.length} tag(s) in ${resolved}`
    + (dropped > 0 ? `; ${dropped} line(s) were repeats or held no word and were dropped` : '')
    + (tags.length === 0 ? ' — nothing to score against, so this run only suggests' : ''),
  );
  return tags;
}

/** The document, cut into the units the ranker reads. */
export interface TagDocument {
  /** The resolved path, for the messages. */
  docPath: string;
  /** Paragraphs the text was joined into. */
  paragraphs: number;
  /** Every sentence, in reading order. `row` is `p<n>` — a log address, no more. */
  sentences: BookSentence[];
}

/**
 * Read the document and cut it into sentences.
 *
 * PARAGRAPHS ARE BLANK-LINE SEPARATED and everything inside one is collapsed to
 * single spaces. That is the shape a converter produces from a PDF, a DOCX or an
 * email, and it is the one rule that survives all three: a single newline is a
 * line break somebody's word wrap chose and carries no meaning; a blank line is
 * the author's own paragraph. Sentences are then cut INSIDE a paragraph, never
 * across one, so a heading with no full stop is one sentence rather than the
 * opening clause of the paragraph under it.
 *
 * `row` is `p<n>` and it is not an identity anybody may key on. This command
 * emits no locations, so nothing outside these files ever sees it.
 */
export function readDocument(docPath: string, log: (line: string) => void): TagDocument {
  const resolved = path.resolve(docPath);
  if (!fs.existsSync(resolved)) {
    throw new TagError(
      `no such document: ${resolved}. This command reads PLAIN TEXT and converts nothing — the `
      + 'software that calls it does the converting (docs/TAGGING.md).',
    );
  }
  const text = stripBom(fs.readFileSync(resolved, 'utf8'));

  const sentences: BookSentence[] = [];
  let paragraphs = 0;
  for (const raw of text.split(/\r?\n[ \t]*(?:\r?\n[ \t]*)+/)) {
    const paragraph = raw.replace(/\s+/g, ' ').trim();
    if (paragraph.length === 0) continue;
    paragraphs += 1;
    const row = `p${paragraphs}`;
    for (const sentence of splitSentences(paragraph)) {
      sentences.push(bookSentence(row, sentence.start, sentence.end, sentence.text));
    }
  }

  log(`tag: ${resolved} — ${paragraphs} paragraph(s), ${sentences.length} sentence(s)`);
  if (sentences.length === 0) {
    throw new TagError(
      `${resolved} has no words in it. A document with nothing to read is not a document with no `
      + 'tags; it is a conversion that produced an empty file, and saying "no tags apply" about it '
      + 'would be a false answer rather than an empty one.',
    );
  }
  return { docPath: resolved, paragraphs, sentences };
}
