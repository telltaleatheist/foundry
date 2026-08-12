/**
 * The plain-text emitter.
 *
 * The whole of this format is a promise about what SURVIVES the conversion from
 * markup to text, so the tests pin the finished text byte for byte rather than
 * matching patterns in it. Three of them earn their place:
 *
 *  - a chapter's title is written once, never twice, and the rule that decides
 *    that is a comparison of RENDERED forms rather than of strings;
 *  - `--strip-note-markers` reaches this format without this format knowing it
 *    exists, which is only true while the markers are stripped upstream;
 *  - an element with no rule STOPS the run. A text file that quietly lost a
 *    table reads as a book that never had one, and nothing downstream can tell.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BookLexicon, type DotsBlock } from '../../src/vlm/dots.js';
import { buildChapterBody, buildDotsBook, type DotsPageImages } from '../../src/vlm/dots-book.js';
import { XHTML_HEAD, XHTML_TAIL, type VlmEpubMetadata } from '../../src/vlm/epub.js';
import {
  chapterText,
  formatConflict,
  packageVlmText,
  VlmTextError,
} from '../../src/vlm/text-out.js';

const META: VlmEpubMetadata = {
  title: 'Nuremberg',
  author: 'Ann Tusa',
  language: 'en',
  identifier: 'urn:sha256:cafe',
};

/**
 * No ink anywhere — the page-turn join is dots.test.ts's subject, not this
 * file's — and a crop that answers every request, so the EPUB half of the
 * comparison below gets the pictures it checks for.
 */
const IMAGES: DotsPageImages = {
  inkExtent: () => null,
  crop: async (requests) => requests.map((request) => ({
    name: request.name,
    mediaType: 'image/png',
    data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  })),
};

function block(overrides: Partial<DotsBlock> = {}): DotsBlock {
  return {
    page: 1,
    category: 'Text',
    box: { x1: 200, y1: 300, x2: 1100, y2: 700 },
    text: 'body',
    pageWidth: 1300,
    pageHeight: 2112,
    ...overrides,
  };
}

function chapterOptions(stripNoteMarkers = false) {
  return {
    column: { x1: 200, x2: 1100 },
    lexicon: new BookLexicon([]),
    images: IMAGES,
    stripNoteMarkers,
    firstNote: 1,
    firstPicture: 0,
    openers: new Set<number>(),
  };
}

/** A chapter of one page's blocks, rendered the way `buildDotsBook` renders one. */
function textOf(blocks: readonly DotsBlock[], label: string, stripNoteMarkers = false): string {
  const body = buildChapterBody(blocks, chapterOptions(stripNoteMarkers));
  return chapterText(label, `${XHTML_HEAD(label, 'en')}${body.xhtml}\n${XHTML_TAIL}`);
}

/**
 * One page of every block kind this dialect emits.
 *
 * `Jackson & Shawcross` is here for the ampersand: it is `&amp;` by the time it
 * is in the XHTML, and an entity that reached the text file would be the most
 * visible way this emitter could fail.
 */
const PAGE: readonly DotsBlock[] = [
  block({ page: 3, category: 'Title', text: 'THE TRIAL BEGINS' }),
  block({ page: 3, category: 'Text', text: 'Jackson & Shawcross rose at once.¹' }),
  block({ page: 3, category: 'Section-header', text: 'The Indictment' }),
  block({ page: 3, category: 'Quote', text: 'We must never forget.' }),
  block({ page: 4, category: 'List-item', text: '1. Conspiracy' }),
  block({ page: 4, category: 'List-item', text: '2. War crimes' }),
  block({ page: 4, category: 'Picture', text: '' }),
  block({ page: 4, category: 'Caption', text: 'The dock, 1946.' }),
  block({
    page: 4,
    category: 'Table',
    text: '<table><tr><th>Count</th><th>Verdict</th></tr><tr><td>One</td><td>Guilty</td></tr></table>',
  }),
  block({ page: 3, category: 'Footnote', text: '¹ Jackson\'s opening, 21 November.' }),
];

test('a chapter becomes readable text, and no markup or entity survives it', () => {
  assert.equal(textOf(PAGE, 'THE TRIAL BEGINS'), [
    'THE TRIAL BEGINS',
    '================',
    '',
    'Jackson & Shawcross rose at once.[1]',
    '',
    'The Indictment',
    '--------------',
    '',
    '    We must never forget.',
    '',
    '1. Conspiracy',
    '2. War crimes',
    '',
    '[figure from page 4]',
    '',
    'The dock, 1946.',
    '',
    'Count | Verdict',
    'One | Guilty',
    '',
    '----',
    '',
    '[1] Jackson\'s opening, 21 November.',
  ].join('\n'));
});

test('nothing that looks like markup is left anywhere in a chapter', () => {
  const text = textOf(PAGE, 'THE TRIAL BEGINS');
  assert.doesNotMatch(text, /<[a-z/!]/i);
  assert.doesNotMatch(text, /&(amp|lt|gt|quot|apos|#\d+);/);
});

test('--strip-note-markers leaves no [n] in the prose or on the note', () => {
  const text = textOf(PAGE, 'THE TRIAL BEGINS', true);
  assert.doesNotMatch(text, /\[\d+\]/);
  // The note itself is still in the book — the MARKER is what was asked for,
  // and a narration build that silently lost its footnotes would be a different
  // book rather than the same one read aloud.
  assert.match(text, /Jackson's opening, 21 November\./);
  assert.match(text, /Jackson & Shawcross rose at once\.\n/);
});

test('the chapter title is written once when the chapter opens with it', () => {
  const text = textOf(PAGE, 'THE TRIAL BEGINS');
  assert.equal(text.match(/THE TRIAL BEGINS/g)?.length, 1);
});

test('a label the chapter does not carry is written above it', () => {
  // A copyright page has no heading on it — that is half of what identifies one
  // — and a text file has no nav document to put the name in instead.
  const text = textOf([block({ page: 2, text: 'All rights reserved.' })], 'Copyright');
  assert.equal(text, 'Copyright\n=========\n\nAll rights reserved.');
});

test('a heading the printer set over two lines keeps its break and is ruled to its widest', () => {
  const xhtml = `${XHTML_HEAD('x', 'en')}`
    + '<h1 data-bf-page="1" data-bf-cat="title">PART ONE<br/>\nTHE ROAD BACK</h1>\n'
    + '<p data-bf-page="1" data-bf-cat="text">It began<br/>\nin 1918.</p>\n'
    + XHTML_TAIL;
  assert.equal(
    chapterText('PART ONE\nTHE ROAD BACK', xhtml),
    'PART ONE\nTHE ROAD BACK\n=============\n\nIt began\nin 1918.',
  );
});

test('an element with no plain-text rule stops the run and names its tag', () => {
  assert.throws(
    () => chapterText('x', `${XHTML_HEAD('x', 'en')}<marquee>gone</marquee>\n${XHTML_TAIL}`),
    (err: unknown) => err instanceof VlmTextError && /<marquee>/.test(err.message),
  );
});

test('the book states its title and author, because a text file has nowhere else', () => {
  const body = buildChapterBody(PAGE, chapterOptions());
  const packaged = packageVlmText(META, [{
    id: 'c0001',
    href: 'text/c0001.xhtml',
    label: 'THE TRIAL BEGINS',
    xhtml: `${XHTML_HEAD('THE TRIAL BEGINS', 'en')}${body.xhtml}\n${XHTML_TAIL}`,
  }]);
  const text = new TextDecoder().decode(packaged.bytes);
  assert.ok(text.startsWith('Nuremberg\n=========\nAnn Tusa\n\n\nTHE TRIAL BEGINS\n'));
  // A text file that does not end in a newline is one half the tools that will
  // touch this book complain about.
  assert.ok(text.endsWith('21 November.\n'));
});

test('a book with no documents is refused rather than written empty', () => {
  assert.throws(() => packageVlmText(META, []), VlmTextError);
});

test('the dots route writes the same book either way, and only the bytes differ', async () => {
  const pages = [{
    page: 3,
    furniture: [],
    rawExtent: { x: 1100, y: 700 },
    blocks: [...PAGE],
  }];
  const options = {
    metadata: META,
    images: IMAGES,
    stripNoteMarkers: false,
  };
  // The page blocks are MUTATED by the assembler's dehyphenation and reflow
  // passes, so each build gets its own copy — otherwise the second run is
  // reading the first one's leftovers rather than the book.
  const asEpub = await buildDotsBook({ ...options, pages: [{ ...pages[0], blocks: [...PAGE] }] });
  const asText = await buildDotsBook({
    ...options,
    pages: [{ ...pages[0], blocks: [...PAGE] }],
    format: 'txt',
  });

  // Same book: same chapters, same notes, same pictures found. Only the
  // container is different, and the EPUB is the one that is a zip.
  assert.deepEqual(asText.chapters.map((c) => c.label), asEpub.chapters.map((c) => c.label));
  assert.equal(asText.footnotes, asEpub.footnotes);
  // Counted even though a text book cannot carry one, and counted WITHOUT
  // cropping it: the report is about the book, not about the file.
  assert.equal(asText.pictures, 1);
  assert.equal(asEpub.pictures, 1);
  assert.equal(asEpub.bytes[0], 0x50);
  assert.equal(asEpub.bytes[1], 0x4b);
  assert.match(new TextDecoder().decode(asText.bytes), /^Nuremberg\n=========\nAnn Tusa\n/);
});

// ── --out and --format ──────────────────────────────────────────────────────

test('an --out that names the other format is refused, both ways round', () => {
  assert.match(formatConflict('book.epub', 'txt')!, /--format txt writes \.txt/);
  assert.match(formatConflict('book.txt', 'epub')!, /--format epub writes \.epub/);
});

test('an --out that agrees, has no extension, or names neither format is left alone', () => {
  assert.equal(formatConflict('book.epub', 'epub'), null);
  assert.equal(formatConflict('book.txt', 'txt'), null);
  assert.equal(formatConflict('book.TXT', 'txt'), null);
  assert.equal(formatConflict('/books/nuremberg', 'txt'), null);
  // `.md` makes no claim about which of foundry's formats the file holds, and
  // what somebody calls their own file is not this program's business.
  assert.equal(formatConflict('notes.md', 'txt'), null);
  // A dot in a DIRECTORY is not an extension on the file.
  assert.equal(formatConflict('/my.books/nuremberg', 'epub'), null);
});
