import { afterAll, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/*
 * ASK'S STRUCTURAL TOOLS (Owen, 2026-11-02): join a sentence broken by a picture,
 * split a heading run into its paragraph, rename a chapter, restore a block
 * struck by mistake, link a note to its number, and point at places. Each is
 * proved twice: as the tool the model calls, and as the ops it lands as and the
 * ops that take it back — replayed, so the words that come out are the proof.
 */
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-ask-structure-'));
// The platform port (electron/platform.ts) in place of the electron mock this
// file had until 2026-11-04: nothing it imports reaches Electron any more.
import { useTestPlatform } from './platform-fixture';
useTestPlatform(()=>userData);
afterAll(() => fs.rmSync(userData, { recursive: true, force: true }));
const { askToolbox } = await import('../../src/node/ask-tools');
const { askRowStates, planLanding, planUndo, structureSaid, retypeSaid } = await import('../../src/shared/ask');
const { replayOps } = await import('../../src/shared/ops');
const { isAskMark } = await import('../../src/node/ask-document');
import type { AskMark, AskView } from '../../src/shared/ask';
import type { BookOp } from '../../src/shared/ops';
import type { BookRow } from '../../src/shared/book';

const VIEW: AskView = {
  title: 'Pictures',
  struck: 2,
  chapters: [{ id: 'a-1', title: '1' }, { id: 'a-9', title: 'Two' }],
  blocks: [
    { id: 'a-1', text: 'CHAPTER ONE The rain began on a Tuesday.', category: 'Text', chapter: 0 },
    { id: 'a-2', text: 'The river rose and the town', category: 'Text', chapter: 0 },
    { id: 'a-3', text: '[Picture]', category: 'Picture', chapter: 0 },
    { id: 'a-4', text: 'Figure 3. The flooded square.', category: 'Caption', chapter: 0 },
    { id: 'a-5', text: 'watched it from the bridge,', category: 'Text', chapter: 0 },
    { id: 'a-6', text: 'until the bridge went too.', category: 'Text', chapter: 0 },
    { id: 'a-7', text: 'See the note.²', category: 'Text', chapter: 0 },
    { id: 'a-8', text: '² A note nothing points at.', category: 'Footnote', chapter: 0 },
    { id: 'a-9', text: 'Two', category: 'Section-header', chapter: 1 },
    { id: 'a-10', text: 'Morning came.', category: 'Text', chapter: 1 },
  ],
  struckBlocks: [
    { id: 'a-11', text: 'A paragraph struck by mistake.', category: 'Text', chapter: 1 },
    { id: 'a-12', text: 'A real running head', category: 'Page-header', chapter: 1 },
  ],
  loose: { numbers: [{ block: 'a-7', at: 13, len: 1, printed: 2 }], notes: ['a-8'] },
};

function box() {
  const b = askToolbox(VIEW);
  const run = (name: string, args: Record<string, unknown> = {}): string => b.call(name, JSON.stringify(args)).content;
  return { b, run };
}

/** The book the view came from, as rows, with the person's two strikes as ops. */
const BOX = { x1: 0, y1: 0, x2: 0, y2: 0 };
const ROWS: BookRow[] = [...VIEW.blocks, ...VIEW.struckBlocks].map((one) => ({
  id: one.id, category: one.category, text: one.text, page: 0, pages: [0], box: BOX, pageWidth: 0, pageHeight: 0,
  parts: [{ src: one.id, page: 0, chars: [0, one.text.length] }],
}) as BookRow);
const STRUCK: BookOp[] = [{ op: 'strike', id: 'a-11' }, { op: 'strike', id: 'a-12' }];
const CHAPTERS = VIEW.chapters.map((c) => ({ id: c.id, title: c.title }));

function replay(ops: readonly BookOp[]) {
  return replayOps(ROWS, [...STRUCK, ...ops], { markers: [], notes: [] }, CHAPTERS);
}
function states(ops: readonly BookOp[]) {
  const out = replay(ops);
  expect(out.missing).toEqual([]);
  return { out, rows: askRowStates(out.rows, out.chapters) };
}
const textOf = (ops: readonly BookOp[], id: string) => replay(ops).rows.find((r) => r.id === id)?.text;

test('a sentence broken by a picture: strike the picture and caption, join the halves', () => {
  const { b, run } = box();
  run('mark', { ids: ['a-3', 'a-4'], reason: 'picture' });
  expect(run('join', { id: 'a-5', reason: 'broken by a picture', dry_run: true }))
    .toContain('a-5 → a-2: The river rose and the town ⏐ watched it from the bridge,');
  expect(b.call('join', JSON.stringify({ id: 'a-5', reason: 'broken by a picture' })).said)
    .toEqual({ verb: 'joined', detail: 'a-5 → a-2 "broken by a picture"' });
  expect(run('read', { only: 'joined' })).toContain('a-5 [JOINED into a-2: broken by a picture]');
  expect(b.counts()).toMatchObject({ struck: 2, joined: 1 });

  const items = b.items();
  const landing = planLanding(items, states([]).rows, false);
  expect(landing.skipped).toEqual([]);
  expect(textOf(landing.ops, 'a-2')).toBe('The river rose and the town watched it from the bridge,');
  expect(replay(landing.ops).rows.some((r) => r.id === 'a-5')).toBe(false);

  // Taken back: the join is cut again where it was made, under new names.
  const joined = items.filter((i) => i.kind === 'join');
  const undo = planUndo(joined, states(landing.ops).rows, false);
  expect(undo.skipped).toEqual([]);
  const after = replay([...landing.ops, ...undo.ops]);
  expect(after.missing).toEqual([]);
  expect(after.rows.find((r) => r.id === 'a-2/1')!.text).toBe('The river rose and the town');
  expect(after.rows.find((r) => r.id === 'a-2/2')!.text).toBe('watched it from the bridge,');
});

test('a chain of joins composes, lands into the survivor, and comes apart last first', () => {
  const { b, run } = box();
  run('join', { id: 'a-5', into: 'a-2', reason: 'broken' });
  run('join', { id: 'a-6', reason: 'broken' }); // into a-5, itself joined into a-2
  const items = b.items().filter((i) => i.kind === 'join');
  expect(items.map((i) => (i.kind === 'join' ? i.into : ''))).toEqual(['a-2', 'a-5']);
  const landing = planLanding(items, states([]).rows, false);
  expect(landing.ops).toEqual([{ op: 'merge', id: 'a-5', into: 'a-2' }, { op: 'merge', id: 'a-6', into: 'a-2' }]);
  expect(textOf(landing.ops, 'a-2')).toBe('The river rose and the town watched it from the bridge, until the bridge went too.');

  const undo = planUndo(items, states(landing.ops).rows, false);
  expect(undo.skipped).toEqual([]);
  const after = replay([...landing.ops, ...undo.ops]);
  expect(after.missing).toEqual([]);
  expect(after.rows.filter((r) => r.id.startsWith('a-2')).map((r) => r.text)).toEqual([
    'The river rose and the town', 'watched it from the bridge,', 'until the bridge went too.',
  ]);

  // Only the first of the chain, while the second still holds: refused by name.
  const partial = planUndo([items[0]!], states(landing.ops).rows, false);
  expect(partial.skipped[0]!.why).toContain('more was joined after it');
});

test('join refuses a chapter boundary, a footnote, a revised block and the first block', () => {
  const { run } = box();
  expect(run('join', { id: 'a-9', reason: 'x' })).toContain('never crosses a chapter');
  expect(run('join', { id: 'a-8', reason: 'x' })).toContain('is a footnote');
  expect(run('join', { id: 'a-1', reason: 'x' })).toContain('nothing before it');
  run('revise', { id: 'a-6', edits: [{ find: 'too', replace: 'as well' }], reason: 'w' });
  expect(run('join', { id: 'a-6', reason: 'x' })).toContain('is revised');
  expect(run('join', { id: 'a-5', into: 'a-6', reason: 'x' })).toContain('a block joins an EARLIER block');
  expect(run('mark', { ids: ['a-6'], reason: 'y' })).toContain('MARKED 1');
});

test('a landing skips a join whose blocks changed while the model worked', () => {
  const { b, run } = box();
  run('join', { id: 'a-6', reason: 'broken' });
  const plan = planLanding(b.items(), states([{ op: 'text', id: 'a-5', text: 'edited' }]).rows, false);
  expect(plan.ops).toEqual([]);
  expect(plan.skipped[0]!.why).toContain('the block it continues (a-5) was changed');
});

test('a heading run into its paragraph is split off and given its kind, and joined back on undo', () => {
  const { b, run } = box();
  expect(run('split', { id: 'a-1', at_quote: 'The rain', first_category: 'Section-header', reason: 'heading run in', dry_run: true }))
    .toContain('1: CHAPTER ONE');
  run('split', { id: 'a-1', at_quote: 'The rain', first_category: 'Section-header', reason: 'heading run in' });
  const item = b.items().find((i) => i.kind === 'split')!;
  expect(structureSaid(item as Extract<AskMark, { kind: 'split' }>)).toBe('split before "The rain began on a Tuesday." (Section-header | Text)');
  const landing = planLanding([item], states([]).rows, false);
  const out = states(landing.ops);
  expect(out.out.rows.find((r) => r.id === 'a-1/1')).toMatchObject({ text: 'CHAPTER ONE', category: 'Section-header' });
  expect(out.out.rows.find((r) => r.id === 'a-1/2')).toMatchObject({ text: 'The rain began on a Tuesday.', category: 'Text' });
  // The chapter that started at the block stays with its first half.
  expect(out.out.chapters[0]).toMatchObject({ id: 'a-1/1', title: '1' });

  const undo = planUndo([item], out.rows, false);
  const back = replay([...landing.ops, ...undo.ops]);
  expect(back.missing).toEqual([]);
  expect(back.rows.find((r) => r.id === 'a-1/1')).toMatchObject({ text: VIEW.blocks[0]!.text, category: 'Text' });
  expect(run('split', { id: 'a-8', at_quote: 'A note', reason: 'x' })).toContain('a note is never cut in two');
  expect(run('split', { id: 'a-10', at_quote: 'nowhere', reason: 'x' })).toContain('does not occur');
});

test('rename_chapter retitles a chapter that starts there, and only one that does', () => {
  const { b, run } = box();
  expect(run('rename_chapter', { chapter: 0, title: 'Chapter One', reason: 'number only' })).toContain('"1" → "Chapter One"');
  expect(run('rename_chapter', { id: 'a-2', title: 'Nope', reason: 'x' })).toContain('no chapter starts at a-2');
  const item = b.items().find((i) => i.kind === 'category')!;
  expect(retypeSaid(item as Extract<AskMark, { kind: 'category' }>)).toBe('chapter "1" renamed "Chapter One"');
  const landing = planLanding([item], states([]).rows, false);
  expect(landing.ops).toEqual([{ op: 'chapter', set: 'a-1', title: 'Chapter One' }]);
  const undo = planUndo([item], states(landing.ops).rows, false);
  expect(undo.ops).toEqual([{ op: 'chapter', set: 'a-1', title: '1' }]);
});

test('the person\'s strikes are readable, and restore proposes one back; undo strikes it again', () => {
  const { b, run } = box();
  expect(run('read', { only: 'struck' })).toContain('a-11 [STRUCK] A paragraph struck by mistake.');
  expect(run('restore', { ids: ['a-10'], reason: 'x' })).toContain('not blocks the person struck');
  run('restore', { ids: ['a-11'], reason: 'struck with the caption' });
  expect(run('read', { only: 'struck' })).toContain('a-11 [STRUCK] [RESTORE: struck with the caption]');
  const item = b.items().find((i) => i.kind === 'restore')!;
  const landing = planLanding([item], states([]).rows, false);
  expect(landing.ops).toEqual([{ op: 'restore', id: 'a-11' }]);
  expect(planUndo([item], states(landing.ops).rows, false).ops).toEqual([{ op: 'strike', id: 'a-11' }]);
  run('unmark', { ids: ['a-11'] });
  expect(b.counts().restored).toBe(0);
});

test('link_footnote binds a loose note to its loose number, and its undo is an unlink', () => {
  const { b, run } = box();
  expect(run('read', { only: 'unlinked' })).toContain('a-8 [Footnote] [UNLINKED NOTE]');
  expect(run('read', { only: 'unlinked' })).toContain('a-7 [LOOSE NUMBER "²" at 13]');
  expect(run('link_footnote', { note: 'a-7', block: 'a-7', number: '²', reason: 'x' })).toContain('not a footnote');
  run('link_footnote', { note: 'a-8', block: 'a-7', number: '²', reason: 'unlinked note' });
  expect(run('link_footnote', { note: 'a-8', block: 'a-7', number: '²', reason: 'again' })).toContain('already have a link proposed');
  const item = b.items().find((i) => i.kind === 'link')!;
  expect(item).toMatchObject({ block: 'a-7', at: 13, len: 1 });
  const landing = planLanding([item], states([]).rows, false);
  expect(landing.ops).toEqual([{ op: 'link', note: 'a-8', block: 'a-7', at: 13, len: 1 }]);
  const linked = replayOps(ROWS, [...STRUCK, ...landing.ops], { markers: [{ block: 'a-7', at: 13, len: 1, printed: 2 }], notes: ['a-8'] }, CHAPTERS);
  expect(linked.rows.find((r) => r.id === 'a-8')!.refs).toEqual([{ block: 'a-7', at: 13, len: 1 }]);
  expect(linked.loose).toEqual({ markers: [], notes: [] });
  expect(planUndo([item], states(landing.ops).rows, false).ops).toEqual([{ op: 'unlink', note: 'a-8', block: 'a-7', at: 13, len: 1 }]);
});

test('highlight points at a block or exact words in it, and changes nothing', () => {
  const { b, run } = box();
  expect(run('highlight', { id: 'a-6', quote: 'the bridge', note: 'the bridge goes' })).toContain('1 places so far');
  expect(run('highlight', { id: 'a-6', quote: 'not here', note: 'x' })).toContain('does not occur');
  run('highlight', { id: 'a-9', note: 'chapter two' });
  expect(b.highlights()).toEqual([
    { id: 'a-6', quote: 'the bridge', note: 'the bridge goes' },
    { id: 'a-9', quote: null, note: 'chapter two' },
  ]);
  expect(b.items()).toEqual([]);
  expect(b.call('highlight', JSON.stringify({ id: 'a-9', note: 'x' })).said).toEqual({ verb: 'pointed at', detail: 'a-9 "x"' });
});

/*
 * A CHAPTER HEADING THE READING LOST (Owen, 2026-11-10, A Culture of Conspiracy):
 * chapter 3's text was in the book and its title was in no block. The model had
 * no way to add one, and its workaround was refused, as the second test keeps.
 */
test('a heading no block carries: add a Title where the chapter begins, starting the chapter', () => {
  const { b, run } = box();
  expect(run('insert', { before: 'a-10', text: 'Chapter 3. The Flood', category: 'Title', starts_chapter: true, reason: 'heading lost', dry_run: true }))
    .toContain('WOULD ADD before a-10');
  expect(b.items()).toEqual([]);
  expect(run('insert', { before: 'a-10', text: ' Chapter 3. The Flood ', category: 'Title', starts_chapter: true, reason: 'heading lost' }))
    .toContain('[Title; starts chapter "Chapter 3. The Flood"] Chapter 3. The Flood');
  expect(b.counts().added).toBe(1);
  // The model sees its new block where it will stand, and the chapter in the outline.
  expect(run('read', { from: 'a-9', count: 3 })).toContain('(new) [ADDED before a-10 as Title; starts chapter "Chapter 3. The Flood": heading lost] Chapter 3. The Flood\na-10 ');
  expect(run('outline')).toContain('a chapter "Chapter 3. The Flood" starts at the block you added before a-10');
  expect(run('marks_summary')).toContain('"heading lost" (added): 1');

  const items = b.items();
  expect(items).toEqual([{
    id: 'u1', kind: 'insert', reason: 'heading lost', beside: 'a-10', before: 'Morning came.', where: 'before',
    category: 'Title', text: 'Chapter 3. The Flood', chapter: 'Chapter 3. The Flood',
  }]);
  expect(structureSaid(items[0] as Extract<AskMark, { kind: 'insert' }>)).toBe('added before a-10 as Title, starts a chapter, "Chapter 3. The Flood"');
  for (const item of JSON.parse(JSON.stringify(items)) as unknown[]) expect(isAskMark(item)).toBe(true);
  expect(isAskMark({ ...items[0], text: '' })).toBe(false);

  const landing = planLanding(items, states([]).rows, false);
  expect(landing.skipped).toEqual([]);
  expect(landing.ops).toEqual([
    { op: 'insert', id: 'u1', before: 'a-10', category: 'Title', text: 'Chapter 3. The Flood' },
    { op: 'chapter', set: 'u1', title: 'Chapter 3. The Flood' },
  ]);
  const after = states(landing.ops);
  const order = after.out.rows.map((r) => r.id);
  expect(order.slice(order.indexOf('a-9'), order.indexOf('a-10') + 1)).toEqual(['a-9', 'u1', 'a-10']);
  expect(after.out.rows.find((r) => r.id === 'u1')).toMatchObject({ category: 'Title', text: 'Chapter 3. The Flood' });
  expect(after.out.chapters.map((c) => c.id)).toEqual(['a-1', 'a-9', 'u1']);

  // Taken back, the added block is struck and its chapter goes.
  const undo = planUndo(landing.acted, after.rows, false);
  expect(undo.skipped).toEqual([]);
  expect(undo.ops).toEqual([{ op: 'chapter', remove: 'u1' }, { op: 'strike', id: 'u1' }]);
  const back = states([...landing.ops, ...undo.ops]);
  expect(back.out.rows.find((r) => r.id === 'u1')?.struck).toBe(true);
  expect(back.out.chapters.map((c) => c.id)).toEqual(['a-1', 'a-9']);
  // Words the person changed since are theirs.
  const edited = states([...landing.ops, { op: 'text', id: 'u1', text: 'Chapter 3' }]);
  expect(planUndo(landing.acted, edited.rows, false).skipped[0]!.why).toContain('have changed since the run');

  // A name the book took meanwhile is never minted twice: the mark kept is the one that landed.
  const again = planLanding(items, after.rows, false);
  expect(again.acted[0]!.id).toBe('u2');
  expect(states([...landing.ops, ...again.ops]).out.rows.filter((r) => r.id === 'u1' || r.id === 'u2').length).toBe(2);
  // The block it goes beside, gone.
  const rowsWithout = new Map(states([]).rows);
  rowsWithout.delete('a-10');
  expect(planLanding(items, rowsWithout, false).skipped[0]!.why).toContain('a-10');
});

test('an added block lands before the join or split that consumes its neighbour\'s name', () => {
  const { b, run } = box();
  run('split', { id: 'a-1', at_quote: 'The rain', first_category: 'Section-header', reason: 'heading run in' });
  run('insert', { after: 'a-1', text: 'An epigraph the reading missed.', category: 'Quote', reason: 'epigraph lost' });
  run('insert', { before: 'a-1', text: 'Part One', category: 'Section-header', reason: 'part heading lost' });
  const landing = planLanding(b.items(), states([]).rows, false);
  expect(landing.skipped).toEqual([]);
  expect(landing.ops.slice(0, 2).map((op) => op.op)).toEqual(['insert', 'insert']);
  const after = states(landing.ops);
  expect(after.out.rows.slice(0, 4).map((r) => r.id)).toEqual(['u1', 'a-1/1', 'a-1/2', 'u2']);
  expect(landing.acted.filter((i) => i.kind === 'insert').map((i) => i.id).sort()).toEqual(['u1', 'u2']);
});

test('what insert refuses, and how an added block is taken off', () => {
  const { b, run } = box();
  // The workaround the model tried on the real book: write the title onto the paragraph, then cut it off.
  run('revise', { id: 'a-10', edits: [{ find: 'Morning', replace: 'Chapter 3. The Flood Morning' }], reason: 'title' });
  expect(run('split', { id: 'a-10', at_quote: 'Morning', reason: 'title' })).toContain('already carries a mark, revision');
  run('unmark', { ids: ['a-10'] });

  expect(run('insert', { text: 'x', reason: 'r' })).toContain('exactly one of before or after');
  expect(run('insert', { before: 'a-1', after: 'a-2', text: 'x', reason: 'r' })).toContain('exactly one of before or after');
  expect(run('insert', { before: 'a-10', text: '   ', reason: 'r' })).toContain('the reading missed its words');
  expect(run('insert', { before: 'a-10', text: 'x', category: 'Footnote', reason: 'r' })).toContain('never as a footnote');
  expect(run('insert', { before: 'a-10', text: 'x', starts_chapter: true, reason: 'r' })).toContain('a chapter starts at a heading');
  expect(run('insert', { before: 'a-10', text: 'x', chapter_title: 'X', reason: 'r' })).toContain('chapter_title goes with starts_chapter:true');
  expect(run('insert', { before: 'a-11', text: 'x', reason: 'r' })).toContain('was struck by the person');
  run('mark', { ids: ['a-3', 'a-4'], reason: 'picture' });
  run('join', { id: 'a-5', reason: 'broken' });
  expect(run('insert', { after: 'a-5', text: 'x', reason: 'r' })).toContain('a-5 is joined into a-2');
  expect(b.counts().added).toBe(0);

  run('insert', { before: 'a-10', text: 'First', reason: 'one' });
  expect(run('insert', { before: 'a-10', text: 'Second', reason: 'one' })).toContain('It replaces the block you added there earlier.');
  run('insert', { after: 'a-9', text: 'Third', chapter_title: 'Named', starts_chapter: true, category: 'Section-header', reason: 'two' });
  expect(b.items().filter((i) => i.kind === 'insert').map((i) => [i.id, (i as Extract<AskMark, { kind: 'insert' }>).text])).toEqual([['u1', 'Third'], ['u2', 'Second']]);
  expect(run('unmark', { reason: 'two' })).toContain('Unmarked 1.');
  expect(run('unmark', { ids: ['a-10'] })).toContain('Unmarked 1.');
  expect(b.counts().added).toBe(0);
});

test('every new mark is one a saved run can be read back with', () => {
  const { b, run } = box();
  run('mark', { ids: ['a-3', 'a-4'], reason: 'picture' });
  run('join', { id: 'a-5', reason: 'broken' });
  run('split', { id: 'a-1', at_quote: 'The rain', reason: 'heading' });
  run('restore', { ids: ['a-11'], reason: 'mistake' });
  run('link_footnote', { note: 'a-8', block: 'a-7', number: '²', reason: 'link' });
  const items = b.items();
  expect(new Set(items.map((i) => i.kind))).toEqual(new Set(['strike', 'join', 'split', 'restore', 'link']));
  for (const item of JSON.parse(JSON.stringify(items)) as unknown[]) expect(isAskMark(item)).toBe(true);
  expect(isAskMark({ id: 'x', kind: 'join', reason: 'r', before: 'b' })).toBe(false);
});
