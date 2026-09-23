/**
 * THE CATEGORIZE TILE'S PURE HALF — what snap is shown, and what its answers
 * become (shared/snap-categorize.ts). No model and no server: the answers are
 * written here the way snap's `/v1/decide` returns them.
 */
import { describe, expect, test } from 'bun:test';

import { formatOpsFile, parseOpsFile } from '../shared/ops';
import {
  blockLine, bookHeader, buildGroups, decide, DEFAULT_SNAP_POLICY, groupState, isAsked, LINE_CHARS,
  lineMarks, nameKey, runTitle, sectionsOf, SNAP_GUIDE, titleConfirmQuestion,
  type SnapChoiceAnswer, type SnapRow,
} from '../shared/snap-categorize';

const answer = (choice: string, confidence = 0.95, labelMass = 0.99): SnapChoiceAnswer => ({
  choice, confidence, label_mass: labelMass, probabilities: { [choice]: confidence },
});

const rows: SnapRow[] = [
  { id: 'e-1', category: 'Picture', text: 'Cover' },
  { id: 'e-2', category: 'Text', text: '1' },
  { id: 'e-3', category: 'Text', text: 'KILLING AMERICA' },
  { id: 'e-4', category: 'Text', text: 'It began on a Tuesday.' },
  { id: 'e-5', category: 'Text', text: 'The Long Road' },
  { id: 'e-6', category: 'Text', text: 'Nobody expected the rain.' },
];

describe('decide — what an answer does to a block', () => {
  test('a confident different answer changes the category; the same answer changes nothing', () => {
    const d = decide(rows, new Map([
      ['e-4', answer('Text')],
      ['e-5', answer('Section-header')],
    ]), []);
    expect(d.categoryOps).toEqual([{ op: 'category', id: 'e-5', category: 'Section-header' }]);
    expect(d.report.map((r) => [r.id, r.outcome])).toEqual([['e-4', 'same'], ['e-5', 'changed']]);
  });

  test('an unsure answer, or one whose letters held little of the probability, leaves the block alone', () => {
    const d = decide(rows, new Map([
      ['e-4', answer('Quote', 0.4)],
      ['e-6', answer('Footnote', 0.9, 0.5)],
    ]), []);
    expect(d.categoryOps).toEqual([]);
    expect(d.report.map((r) => r.outcome)).toEqual(['low-confidence', 'low-label-mass']);
  });

  test('the report carries each block\'s section and opening words, so it reads without the book', () => {
    const d = decide(rows, new Map([['e-4', answer('Text')]]), [{ id: 'e-2', title: 'Chapter 1' }]);
    expect(d.report[0]).toMatchObject({ section: 'Chapter 1', text: 'It began on a Tuesday.' });
  });

  test('a Title needs its confirmation: unconfirmed, or confirmed below the bar, the block stays', () => {
    const answers = new Map([['e-2', answer('Title')], ['e-3', answer('Title')], ['e-5', answer('Title')]]);
    const d = decide(rows, answers, [], DEFAULT_SNAP_POLICY, new Map([['e-2', 0.95], ['e-3', 0.4]]));
    expect(d.categoryOps).toEqual([{ op: 'category', id: 'e-2', category: 'Title' }]);
    expect(d.report.map((r) => [r.id, r.outcome, r.titleConfirm])).toEqual([
      ['e-2', 'changed', 0.95], ['e-3', 'title-unconfirmed', 0.4], ['e-5', 'title-unconfirmed', undefined],
    ]);
  });

  test('WITHOUT a navigation, a run of confirmed chapter-heading rows gets ONE marker, titled from the run', () => {
    const d = decide(rows, new Map([
      ['e-2', answer('Title')],
      ['e-3', answer('Title')],
    ]), [], DEFAULT_SNAP_POLICY, new Map([['e-2', 0.9], ['e-3', 0.9]]));
    expect(d.chapterOps).toEqual([{ op: 'chapter', set: 'e-2', title: '1: KILLING AMERICA' }]);
  });

  test('WITH a navigation, the model adds no chapter markers at all — the publisher said where they are', () => {
    const d = decide(rows, new Map([
      ['e-2', answer('Title')], ['e-3', answer('Title')], ['e-5', answer('Title')],
    ]), [{ id: 'e-1', title: 'Cover' }], DEFAULT_SNAP_POLICY, new Map([['e-2', 0.99], ['e-3', 0.99], ['e-5', 0.99]]));
    expect(d.chapterOps).toEqual([]);
    expect(d.categoryOps.map((op) => op.id)).toEqual(['e-2', 'e-3', 'e-5']);
  });

  test('the ops it produces are ones the ops file itself accepts (the Apply door re-parses them)', () => {
    const d = decide(rows, new Map([
      ['e-2', answer('Title')], ['e-3', answer('Title')], ['e-5', answer('Section-header')],
    ]), [], DEFAULT_SNAP_POLICY, new Map([['e-2', 0.9], ['e-3', 0.9]]));
    const ops = [...d.categoryOps, ...d.chapterOps];
    expect(d.chapterOps.length).toBe(1);
    expect(parseOpsFile(formatOpsFile(ops))).toEqual(ops);
  });
});

describe('what snap is shown', () => {
  test('pictures, tables, formulas and empty blocks are not asked about', () => {
    expect(rows.filter(isAsked).map((r) => r.id)).toEqual(['e-2', 'e-3', 'e-4', 'e-5', 'e-6']);
    expect(isAsked({ id: 'x', category: 'Text', text: '   ' })).toBe(false);
  });

  test('every block sits in the section of the last contents entry at or before it', () => {
    const s = sectionsOf(rows, [{ id: 'e-2', title: 'Chapter 1' }, { id: 'e-5', title: 'Endnotes' }]);
    expect([...s.values()]).toEqual([
      'front of the book, before the first contents entry',
      'Chapter 1', 'Chapter 1', 'Chapter 1', 'Endnotes', 'Endnotes',
    ]);
  });

  test('a line shows the section, the markup as a hint, a picture as a picture, and cuts long text', () => {
    expect(blockLine({ id: 'e-9', category: 'Text', text: 'Figure 1-1. Richard Owen.', markup: 'ch.html p.calibre_3' }, 'Chapter 1'))
      .toBe('[e-9] (Chapter 1 · ch.html p.calibre_3) Figure 1-1. Richard Owen.');
    expect(blockLine({ id: 'e-8', category: 'Picture', text: 'portrait' }, 'Chapter 1'))
      .toBe('[e-8] (Chapter 1) (picture) portrait');
    const long = blockLine({ id: 'e-7', category: 'Text', text: 'x'.repeat(LINE_CHARS + 50) }, 'S');
    expect(long.endsWith('…')).toBe(true);
    expect(long.length).toBeLessThan(LINE_CHARS + 20);
  });

  test('the header is the guide, the book and its contents — or says there are none', () => {
    const h = bookHeader('B', [{ id: 'e-2', title: '1. Introduction' }]);
    expect(h.startsWith(SNAP_GUIDE)).toBe(true);
    expect(h).toContain('- 1. Introduction');
    expect(bookHeader('B', [])).toContain('none');
  });

  test('the guide names the three failures of the first run: contents lines, first endnotes, captions', () => {
    expect(SNAP_GUIDE).toContain('A contents line is never a Title');
    expect(SNAP_GUIDE).toContain('1. See Chapters Five and Six');
    expect(SNAP_GUIDE).toContain('Figure 3-2.');
    expect(SNAP_GUIDE).toContain('WEAK hint');
  });

  test('groups ask every row exactly once, and show each asked row with its neighbours', () => {
    const groups = buildGroups(60, 24, 12);
    expect(groups.map((g) => [g.askFrom, g.askTo])).toEqual([[0, 24], [24, 48], [48, 60]]);
    expect(groups.map((g) => [g.from, g.to])).toEqual([[0, 36], [12, 60], [36, 60]]);
  });

  test('a group\'s state is the header and only its own stretch of the book', () => {
    const state = groupState('H', rows, sectionsOf(rows, []), { from: 1, to: 4, askFrom: 2, askTo: 3 });
    expect(state).toContain('[e-2]');
    expect(state).toContain('[e-4]');
    expect(state).not.toContain('[e-1]');
    expect(state).not.toContain('[e-5]');
  });
});

describe('the marks on a line', () => {
  test('a chapter name is the same with or without its number, "Chapter N" or dashes', () => {
    expect(nameKey('Chapter 5—Evo-Devo')).toBe(nameKey('5. Evo-Devo'));
    expect(nameKey('7. Bridging Gaps: Cells and Proteins')).toBe('bridging gaps cells and proteins');
  });

  test('the contents page, the chapter opening and the endnotes heading are all marked as matching', () => {
    const book: SnapRow[] = [
      { id: 'c-1', category: 'Text', text: 'Chapter 5—Evo-Devo' },
      { id: 'b-1', category: 'Text', text: '5. Evo-Devo' },
      { id: 'b-2', category: 'Text', text: 'Some prose about limbs.' },
      { id: 'n-1', category: 'Text', text: 'Chapter 5—Evo-Devo' },
    ];
    const marks = lineMarks(book, [{ id: 'b-1', title: '5. Evo-Devo' }]);
    expect(marks.get('c-1')).toEqual(['matches contents entry "5. Evo-Devo"']);
    expect(marks.get('b-1')).toEqual(['first in section', 'matches contents entry "5. Evo-Devo"']);
    expect(marks.has('b-2')).toBe(false);
    expect(marks.get('n-1')).toEqual(['matches contents entry "5. Evo-Devo"']);
  });

  test('the marks are printed on the line, between the section and the markup', () => {
    expect(blockLine({ id: 'b-1', category: 'Text', text: '5. Evo-Devo', markup: 'x.html p.c2' }, '5. Evo-Devo', ['first in section']))
      .toBe('[b-1] (5. Evo-Devo · first in section · x.html p.c2) 5. Evo-Devo');
  });

  test('the guide explains the three places a chapter name appears, and that blockquote markup counts', () => {
    expect(SNAP_GUIDE).toContain('first in section');
    expect(SNAP_GUIDE).toContain('blockquote is');
    expect(titleConfirmQuestion({ id: 'x', category: 'Text', text: 't' }).type).toBe('yesno');
  });
});

describe('runTitle', () => {
  test('a number line joins the title with a colon, the navigation\'s own shape', () => {
    expect(runTitle(['1', 'KILLING AMERICA'])).toBe('1: KILLING AMERICA');
    expect(runTitle(['Chapter XII', 'The End'])).toBe('Chapter XII: The End');
    expect(runTitle(['Preface'])).toBe('Preface');
    expect(runTitle(['The Long', 'Road'])).toBe('The Long Road');
  });
});
