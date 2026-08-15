/**
 * The overlay file — the app's half of a contract with the engine.
 *
 * THIS IS THE PART OF THE BLOCK EDITOR WORTH TESTING AND IT IS ALSO THE PART
 * NOTHING ELSE CAN REACH. Everything around it needs a window: the outlines need
 * a page rendered by pdf.js, the gestures need a pointer, the writes need
 * Electron's IPC and a project on disk. What is HERE is a pure function of
 * strings and plain objects — parse it, amend it, print it, and decide whether a
 * file found beside a book is still about that book — which is exactly why it
 * was extracted into `app/shared` rather than left inside the service.
 *
 * The two things these tests are really protecting:
 *
 *   THE WRITER STAYS CANONICAL. One amendment per block, fields merged, empties
 *   dropped, page order. Not tidiness: the file is rewritten whole on every
 *   gesture in a folder people sync, the engine quotes the amendment count back
 *   to the user on every run, and an append-forever writer would report a
 *   curation of twelve decisions as four hundred.
 *
 *   THE READER REFUSES THE WHOLE FILE. Never half of it. A `strike` misspelled
 *   as `struck` that is quietly skipped is a block somebody struck that comes
 *   back in every export with nothing on screen to say so; a file refused is
 *   archived aside, named out loud, and still on the disk.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  OverlayError,
  amendOverlay,
  amendmentsOf,
  chaptersOfText,
  chaptersText,
  decisionFor,
  decisionsOf,
  emptyOverlay,
  overlayFate,
  overlayText,
  parseOverlay,
  parseTargetKey,
  frozenCuration,
  setChapters,
  targetKey,
  type OverlayFile,
} from '../../app/shared/overlay.ts';

const GENERATION = '0f9c5a2e-4d3b-4a1e-9f77-2b1c8e6d4a55';

function overlayOf(body: Record<string, unknown>): string {
  return JSON.stringify({ overlay: 1, generation: GENERATION, amendments: [], ...body });
}

function refusal(text: string): string {
  try {
    parseOverlay(text, 'the file');
  } catch (err) {
    assert.ok(err instanceof OverlayError, `expected an OverlayError, got ${String(err)}`);
    return (err as Error).message;
  }
  assert.fail('that file should have been refused');
}

// ─────────────────────────────────────────────────────────────────────────────
// Naming a block
// ─────────────────────────────────────────────────────────────────────────────

test('a target key round-trips, with and without a part', () => {
  assert.equal(targetKey({ page: 7, order: 14 }), '7:14');
  assert.equal(targetKey({ page: 12, order: 3, part: 1 }), '12:3:1');
  assert.deepEqual(parseTargetKey('7:14'), { page: 7, order: 14 });
  assert.deepEqual(parseTargetKey('12:3:1'), { page: 12, order: 3, part: 1 });
});

test('a key that does not name a block is refused rather than guessed at', () => {
  // Each of these would otherwise be a ledger row replayed against SOME block,
  // which is the one outcome worse than an undo that refuses.
  for (const bad of ['', '7', '7:14:1:2', 'p7:14', '7:1.5', '0:3', '7:-1']) {
    assert.throws(() => parseTargetKey(bad), OverlayError, `"${bad}" should be refused`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Reading one
// ─────────────────────────────────────────────────────────────────────────────

test('a well-formed overlay reads back exactly as written', () => {
  const file = parseOverlay(overlayOf({
    amendments: [
      { at: { page: 7, order: 14 }, strike: true },
      { at: { page: 12, order: 3, part: 1 }, category: 'Footnote' },
      { at: { page: 40, order: 2 }, text: 'IV' },
    ],
    chapters: [{ at: { page: 30, order: 1 }, title: 'Chapter 4 — The Windmill' }],
  }), 'the file');

  assert.equal(file.overlay, 1);
  assert.equal(file.generation, GENERATION);
  assert.equal(file.amendments.length, 3);
  assert.deepEqual(file.amendments[1], { at: { page: 12, order: 3, part: 1 }, category: 'Footnote' });
  assert.deepEqual(file.chapters, [{ at: { page: 30, order: 1 }, title: 'Chapter 4 — The Windmill' }]);
});

test('a file with no generation is refused: nothing would say which reading it is about', () => {
  const said = refusal(JSON.stringify({ overlay: 1, amendments: [] }));
  assert.match(said, /generation/);
});

test('a schema this app does not write is refused by number', () => {
  assert.match(refusal(JSON.stringify({ overlay: 2, generation: GENERATION, amendments: [] })), /overlay/);
});

test('a misspelled field takes the whole file down rather than being skipped', () => {
  // The case this discipline exists for: `struck` silently ignored is a block
  // somebody struck that comes back in every export.
  const said = refusal(overlayOf({ amendments: [{ at: { page: 7, order: 14 }, struck: true }] }));
  assert.match(said, /struck/);
});

test('the fields the engine dropped are refused, not carried', () => {
  // `chapter` and `title` were amendment fields in an earlier draft of the
  // contract; the spine is a list now. Writing one would be refused by the
  // engine three hours into a conversion, so it is refused here in a sentence.
  assert.match(
    refusal(overlayOf({ amendments: [{ at: { page: 30, order: 1 }, chapter: true }] })),
    /chapter/,
  );
});

test('a category nothing renders is refused, and the refusal lists the ones that do', () => {
  const said = refusal(overlayOf({ amendments: [{ at: { page: 1, order: 0 }, category: 'footnote' }] }));
  assert.match(said, /Footnote/);
  assert.match(said, /Section-header/);
});

test('Quote is a category a person may state even though no model emits one', () => {
  const file = parseOverlay(
    overlayOf({ amendments: [{ at: { page: 1, order: 0 }, category: 'Quote' }] }),
    'the file',
  );
  assert.equal(file.amendments[0]?.category, 'Quote');
});

test('an amendment that decides nothing is refused', () => {
  assert.match(refusal(overlayOf({ amendments: [{ at: { page: 1, order: 0 } }] })), /says nothing/);
});

test('an empty text override is refused: striking a block is what strike is for', () => {
  assert.match(refusal(overlayOf({ amendments: [{ at: { page: 1, order: 0 }, text: '' }] })), /strike/);
});

test('a block named with anything but whole numbers is refused', () => {
  for (const at of [{ page: 0, order: 1 }, { page: 1.5, order: 1 }, { page: '1', order: 1 }, { order: 1 }]) {
    assert.throws(
      () => parseOverlay(overlayOf({ amendments: [{ at, strike: true }] }), 'the file'),
      OverlayError,
      `${JSON.stringify(at)} should be refused`,
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// The spine
// ─────────────────────────────────────────────────────────────────────────────

test('an absent chapter list and an empty one mean different things', () => {
  const absent = parseOverlay(overlayOf({}), 'the file');
  const empty = parseOverlay(overlayOf({ chapters: [] }), 'the file');
  // Absent hands the book to the engine's own detection. Empty is a person
  // saying this book does not divide, and reading the two the same way would put
  // detection back in charge of a decision somebody made explicitly.
  assert.equal(absent.chapters, undefined);
  assert.deepEqual(empty.chapters, []);
});

test('a spine that runs backwards is refused rather than sorted out of', () => {
  const said = refusal(overlayOf({
    chapters: [
      { at: { page: 30, order: 1 }, title: 'Four' },
      { at: { page: 12, order: 1 }, title: 'Three' },
    ],
  }));
  assert.match(said, /reading order/);
});

test('two chapters cannot begin at one block', () => {
  const said = refusal(overlayOf({
    chapters: [
      { at: { page: 30, order: 1 }, title: 'Four' },
      { at: { page: 30, order: 1 }, title: 'Also four' },
    ],
  }));
  assert.match(said, /reading order|cannot begin/);
});

test('a chapter with no name is refused: a contents entry nobody can click', () => {
  assert.match(refusal(overlayOf({ chapters: [{ at: { page: 1, order: 0 }, title: '  ' }] })), /title/);
});

test('setChapters sorts what it is given and refuses a duplicate location', () => {
  const file = setChapters(emptyOverlay(GENERATION), [
    { at: { page: 30, order: 1 }, title: 'Four' },
    { at: { page: 12, order: 1 }, title: 'Three' },
  ]);
  assert.deepEqual(file.chapters?.map((one) => one.title), ['Three', 'Four']);
  assert.throws(() => setChapters(file, [
    { at: { page: 12, order: 1 }, title: 'Three' },
    { at: { page: 12, order: 1 }, title: 'Three again' },
  ]), OverlayError);
});

test('setChapters with null takes the field off entirely', () => {
  const listed = setChapters(emptyOverlay(GENERATION), []);
  assert.deepEqual(listed.chapters, []);
  assert.equal(setChapters(listed, null).chapters, undefined);
  assert.ok(!('chapters' in setChapters(listed, null)));
});

test('a chapter list round-trips through a ledger row, and "" is the absent list', () => {
  const chapters = [{ at: { page: 30, order: 1, part: 0 }, title: 'Four' }];
  assert.deepEqual(chaptersOfText(chaptersText(chapters), 'a row'), chapters);
  assert.equal(chaptersText(null), '');
  assert.equal(chaptersOfText('', 'a row'), null);
});

// ─────────────────────────────────────────────────────────────────────────────
// Editing one
// ─────────────────────────────────────────────────────────────────────────────

test('one amendment per target, with the fields merged', () => {
  let file = emptyOverlay(GENERATION);
  file = amendOverlay(file, { page: 7, order: 14 }, 'strike', 'true');
  file = amendOverlay(file, { page: 7, order: 14 }, 'category', 'Footnote');
  file = amendOverlay(file, { page: 7, order: 14 }, 'text', 'a note');

  assert.equal(file.amendments.length, 1);
  assert.deepEqual(file.amendments[0], {
    at: { page: 7, order: 14 },
    strike: true,
    category: 'Footnote',
    text: 'a note',
  });
});

test('an empty value REMOVES a field rather than writing a false', () => {
  let file = amendOverlay(emptyOverlay(GENERATION), { page: 7, order: 14 }, 'strike', 'true');
  file = amendOverlay(file, { page: 7, order: 14 }, 'category', 'Title');
  file = amendOverlay(file, { page: 7, order: 14 }, 'strike', '');

  // `strike: false` and no strike at all render identically, and the file is
  // read by a person as often as by a program. The absent one is the truth.
  assert.deepEqual(file.amendments[0], { at: { page: 7, order: 14 }, category: 'Title' });
});

test('an amendment that ends up deciding nothing is dropped', () => {
  let file = amendOverlay(emptyOverlay(GENERATION), { page: 7, order: 14 }, 'strike', 'true');
  file = amendOverlay(file, { page: 7, order: 14 }, 'strike', '');
  assert.deepEqual(file.amendments, []);
  // And it survives a round trip, which an empty `{ at }` would not: the reader
  // refuses one of those by name.
  assert.deepEqual(parseOverlay(overlayText(file), 'the file').amendments, []);
});

test('amendments come out in page order however they were made', () => {
  let file = emptyOverlay(GENERATION);
  for (const at of [{ page: 40, order: 2 }, { page: 7, order: 14 }, { page: 7, order: 2 }]) {
    file = amendOverlay(file, at, 'strike', 'true');
  }
  file = amendOverlay(file, { page: 7, order: 2, part: 1 }, 'category', 'Text');

  assert.deepEqual(file.amendments.map((one) => targetKey(one.at)), ['7:2', '7:2:1', '7:14', '40:2']);
});

test('a category this app does not know is refused at the setter, not written', () => {
  assert.throws(
    () => amendOverlay(emptyOverlay(GENERATION), { page: 1, order: 0 }, 'category', 'Heading'),
    OverlayError,
  );
});

test('what is written is what reads back — the round trip that guards the engine', () => {
  let file: OverlayFile = emptyOverlay(GENERATION);
  file = amendOverlay(file, { page: 7, order: 14 }, 'strike', 'true');
  file = amendOverlay(file, { page: 12, order: 3, part: 1 }, 'category', 'Footnote');
  file = amendOverlay(file, { page: 40, order: 2 }, 'text', 'IV');
  file = setChapters(file, [{ at: { page: 30, order: 1 }, title: 'Four' }]);

  const back = parseOverlay(overlayText(file), 'the file');
  assert.deepEqual(back, file);
});

test('an overlay with no chapter list does not print one', () => {
  const printed = overlayText(emptyOverlay(GENERATION));
  assert.ok(!printed.includes('chapters'));
  // Null would be refused by the reader and reads as the opposite of what it
  // looks like, so the field is omitted rather than emitted empty.
  assert.equal(parseOverlay(printed, 'the file').chapters, undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// Reading what it says about a block
// ─────────────────────────────────────────────────────────────────────────────

test('the decisions fold in file order, field by field, like the engine', () => {
  const file = parseOverlay(overlayOf({
    amendments: [
      { at: { page: 7, order: 14 }, strike: true, category: 'Text' },
      { at: { page: 7, order: 14 }, category: 'Footnote' },
    ],
  }), 'the file');
  // The later amendment beats the earlier one for the field it carries and
  // leaves the others exactly as they were.
  assert.deepEqual(decisionsOf(file).get('7:14'), { strike: true, category: 'Footnote' });
});

test('a part-specific amendment sits on top of the element-wide one', () => {
  const file = parseOverlay(overlayOf({
    amendments: [
      { at: { page: 7, order: 14 }, strike: true, category: 'Text' },
      { at: { page: 7, order: 14, part: 1 }, category: 'Footnote' },
    ],
  }), 'the file');
  const decisions = decisionsOf(file);
  assert.deepEqual(decisionFor(decisions, 7, 14, 0), { strike: true, category: 'Text' });
  assert.deepEqual(decisionFor(decisions, 7, 14, 1), { strike: true, category: 'Footnote' });
  assert.deepEqual(decisionFor(decisions, 7, 15, 0), {});
});

test('amendmentsOf drops what decides nothing and keeps what does', () => {
  const amendments = amendmentsOf(new Map([
    ['7:14', {}],
    ['7:15', { strike: false }],
    ['7:16', { category: 'Title' as const }],
  ]));
  // `strike: false` is a real statement of "keep it" and is kept; an empty
  // decision is a line nobody meant to write.
  assert.deepEqual(amendments.map((one) => targetKey(one.at)), ['7:15', '7:16']);
});

// ─────────────────────────────────────────────────────────────────────────────
// THE HAZARD
// ─────────────────────────────────────────────────────────────────────────────

test('an overlay about this reading is used', () => {
  assert.deepEqual(overlayFate(GENERATION, GENERATION), { use: true });
});

test('an overlay about an earlier reading is not, and the reason names both', () => {
  const fate = overlayFate('an-older-one', GENERATION);
  assert.equal(fate.use, false);
  // The sentence reaches the notice strip. It has to say which reading the file
  // was made against and which one is on screen, or "your corrections have been
  // archived" is a thing that happened for no stated reason.
  assert.ok(!fate.use && fate.why.includes('an-older-one'));
  assert.ok(!fate.use && fate.why.includes(GENERATION));
});

test('an overlay that names no reading at all is refused by name', () => {
  const fate = overlayFate('', GENERATION);
  assert.equal(fate.use, false);
  assert.ok(!fate.use && fate.why.includes('unrecorded'));
});

// ─────────────────────────────────────────────────────────────────────────────
// THE OTHER CURATION: a frozen save, shown but never written
// ─────────────────────────────────────────────────────────────────────────────
//
// Two curations are on screen at once the moment somebody presses Save: the LIVE
// overlay, which is where a correction goes, and a committed SNAPSHOT, which is
// what a rendering at the position is made with. Standing on the save, the block
// editor draws the snapshot — the whole reason to click an old save is to see the
// book as it was then — while every write still lands in the live file.
//
// The danger in handing a second curation to the renderer is that it becomes a
// write. `FrozenCuration` is the answer: it carries a field `OverlayFile` declares
// as `never`, so the compiler refuses it everywhere a curation is written, and the
// `@ts-expect-error` lines below are that refusal asserted rather than assumed.
// They are checked by `tsc --noEmit` from the repo root, which compiles `test/`.

test('a frozen curation says the same thing as the file it was copied from', () => {
  const file = parseOverlay(overlayOf({
    amendments: [{ at: { page: 7, order: 14 }, strike: true }],
    chapters: [{ at: { page: 1, order: 0 }, title: 'One' }],
  }), 'curations/one.json');
  const shown = frozenCuration(file);

  assert.equal(shown.frozen, true);
  assert.equal(shown.generation, GENERATION);
  // The decisions a page is outlined from are the same decisions either way —
  // which is what makes drawing the snapshot a change of WHICH curation rather
  // than a second way of reading one.
  assert.deepEqual([...decisionsOf(shown)], [...decisionsOf(file)]);
  assert.deepEqual(shown.chapters, file.chapters);
});

test('a spine nobody stated stays absent rather than becoming an empty one', () => {
  // ABSENT and EMPTY are different claims about a book — "the engine decides"
  // against "this book does not divide" — and a copy that flattened them would
  // make every save of an uncurated spine assert the second one.
  const shown = frozenCuration(emptyOverlay(GENERATION));
  assert.equal('chapters' in shown, false);
  assert.deepEqual(shown.amendments, []);
});

test('nothing can write what it was handed to display', () => {
  const shown = frozenCuration(parseOverlay(overlayOf({
    amendments: [{ at: { page: 7, order: 14 }, strike: true }],
  }), 'curations/one.json'));

  /*
   * THE ASSERTION IS THE SUPPRESSION ITSELF. `@ts-expect-error` fails the build
   * when the line it guards COMPILES, so each of these three is a test that the
   * refusal is still there — the day somebody widens one of these signatures to
   * `CurationContent` for convenience, this file stops building and says which
   * door was left open. The calls are made for real underneath, because they are
   * pure functions over a copy and nothing on disk hears about them; what would
   * be a bug is only ever a call to `overlay.save` with the result.
   */
  // @ts-expect-error a frozen curation is not a file this app may amend
  const amended = amendOverlay(shown, { page: 7, order: 15 }, 'strike', 'true');
  assert.equal(amended.amendments.length, 2);
  // @ts-expect-error nor one whose spine may be rewritten
  const respined = setChapters(shown, []);
  assert.deepEqual(respined.chapters, []);
  // @ts-expect-error nor one that may be printed back out as a curation file
  assert.match(overlayText(shown), /"overlay": 1/);
});
