/**
 * BLOCK CATEGORIES BY SNAP — the pure half: what snap is shown, what it is asked,
 * and what its answers become.
 *
 * ── What this is (Owen, 2026-09-22) ─────────────────────────────────────────
 *
 * *"the new tile will be used to categorize blocks as section header, chapter
 * header, list, body text, etc. we'll hand snap a list of possible categories …
 * and we'll ask it which one it should be … chapter headers get chapter markers."*
 *
 * snap (C:\Users\tellt\Projects\snap, its README) answers a closed question with
 * ONE forward pass: it reads the model's next-token probabilities over lettered
 * options and never generates. So every block gets a category and a probability,
 * and a block the model was unsure of is left as it was rather than guessed at.
 *
 * AN EXPERIMENT, run outside Crucible on purpose: Crucible's chat door cannot
 * return the letter probabilities snap reads, and Owen ruled "not through
 * crucible yet — good call". If it earns its place it becomes a Crucible job.
 *
 * ── The second design, after the first run (2026-09-22) ─────────────────────
 *
 * The first version sent the WHOLE BOOK as one state with bare lines
 * ("[e-54] 1. Introduction") and short options. On *Evolution: Still a Theory in
 * Crisis* it changed 399 blocks, mostly wrongly, and put chapter markers on the
 * contents page. Every failure was one kind: it could not tell WHERE in the book
 * a line sits — "1. Introduction" in the contents list, the chapter's own
 * heading and the first endnote ("1. See Chapters Five and Six…") are the same
 * shape once flattened to a line. Owen: *"a small window with a descriptive
 * prompt so it knows what its choosing from and what to look for, and the
 * markup would be fine, too … we have to assume the markup will be wrong. thats
 * why we're doing this."* So now:
 *
 *  - SMALL GROUPS: a few dozen blocks judged together, each seen with the blocks
 *    around it (`buildGroups`). It is also the speed: the whole-book window made
 *    every question attend over ~117,000 tokens (~0.4 s a block, measured).
 *  - A GUIDE (`SNAP_GUIDE`): what each kind is and what gives it away, what the
 *    contents, notes and index sections look like, and that the markup is a
 *    weak hint.
 *  - EVERY LINE CARRIES ITS SECTION (from the book's own navigation) and the
 *    publisher's markup (`BookRow.markup`), and a picture says it is one — a
 *    caption's best evidence is the picture beside it.
 *
 * ── What the answers become ─────────────────────────────────────────────────
 *
 * OPS, the same `{op:'category'}` and `{op:'chapter', set}` a person's Apply
 * writes (shared/ops.ts), so the result is an ordinary edit step: drawn by the
 * existing chips, comparable against the step before, removable in one delete.
 */

import type { CategoryOp, ChapterSetOp } from './ops';

/**
 * The categories snap chooses between, as each QUESTION shows them: the engine's
 * spelling and a few words.
 *
 * SHORT ON PURPOSE, MEASURED: snap renders every option as "A. name: text"
 * inside EACH question, the one part read afresh for every block. With a
 * sentence per option each question was 197 tokens; the definitions live once,
 * in the guide.
 */
export const SNAP_CATEGORY_OPTIONS: Readonly<Record<string, string>> = {
  Title: 'chapter or part heading',
  'Section-header': 'section heading',
  Text: 'body paragraph',
  'List-item': 'list, contents or index entry',
  Quote: 'block quotation or epigraph',
  Caption: 'caption of a picture or table',
  Footnote: 'footnote or endnote',
};

/**
 * THE GUIDE — what the model is choosing between, and what gives each one away.
 * Read once per group, cached with it; the questions stay short.
 */
export const SNAP_GUIDE = [
  'You are sorting the blocks of a book into kinds, one block at a time. Each block below is one',
  'line: its id in brackets, then in parentheses the section of the book it sits in and how the',
  'publisher\'s files marked it up, then its text (long blocks are cut short with "…").',
  '',
  'THE KINDS:',
  '- Title: the heading that OPENS a chapter or a part of the book, in the chapter itself. It is',
  '  usually the first block of its section and matches a table of contents entry. It may be split',
  '  over two lines: a number ("3" or "Chapter 3") and then the words.',
  '- Section-header: a heading inside a chapter, over a stretch of its text. In a notes section, the',
  '  heading over one chapter\'s notes ("Chapter 3" or "3. The Hierarchy of Nature") is a',
  '  Section-header, not a Title.',
  '- Text: an ordinary paragraph of the book\'s prose.',
  '- List-item: one item of a list, including every line of a table of contents and every entry of',
  '  an index ("Darwin, Charles 12, 45-47"). A contents line is never a Title, even though it names one.',
  '- Quote: a passage quoted from someone else and set apart from the paragraphs (a block',
  '  quotation), or an epigraph under a chapter heading.',
  '- Caption: the short line that labels a picture, a map, a figure or a table. It very often begins',
  '  "Figure 3-2.", "Fig. 1-1", "Map 2" or "Table 4", and sits right after or right before a',
  '  (picture) block.',
  '- Footnote: the text of a footnote or an endnote. In a notes or endnotes section these are the',
  '  numbered notes ("12. Ibid., 9-10.", "1. See Chapters Five and Six of..."), each one a Footnote.',
  '',
  'HOW TO JUDGE: read the block\'s words first, then where it sits (its section and the blocks around',
  'it), then the table of contents. The markup in parentheses is a WEAK hint and is often wrong:',
  'publishers mark captions and quotations as plain paragraphs all the time, so never choose a kind',
  'because of the markup alone. A line in the contents section is a List-item. A numbered line in',
  'an endnotes section is a Footnote unless it is the heading over a chapter\'s notes.',
].join('\n');

/** The longest text a block line shows; a block's kind is in its opening words. */
export const LINE_CHARS = 280;

/** How many blocks a group asks about, and how many it shows on either side of them. */
export const GROUP_ASK = 24;
export const GROUP_RADIUS = 12;

/**
 * Categories snap is NOT asked about, and why: a picture, a formula and a table
 * are what the markup says they are — their shape is structural, not a reading
 * of the words — and page furniture does not occur in a book that has no pages.
 * They are still SHOWN, as context: a caption's best evidence is its picture.
 */
export const SNAP_SKIPPED_CATEGORIES: ReadonlySet<string> = new Set([
  'Picture', 'Formula', 'Table', 'Page-header', 'Page-footer',
]);

/** The one row shape this module needs — a subset of `BookRow`, so a test can build one by hand. */
export interface SnapRow {
  id: string;
  category: string;
  text: string;
  /** The publisher's element (`BookRow.markup`) — shown as a weak hint; absent on older imports. */
  markup?: string;
}

/** The one chapter shape this module needs — a subset of `BookChapter`. */
export interface SnapChapter {
  id: string;
  title: string;
}

/**
 * Which section of the book each row sits in: the title of the last navigation
 * entry at or before it. Rows before the first entry are the front of the book.
 */
export function sectionsOf(rows: readonly SnapRow[], chapters: readonly SnapChapter[]): Map<string, string> {
  const opens = new Map(chapters.map((chapter) => [chapter.id, chapter.title] as const));
  const out = new Map<string, string>();
  let current = chapters.length > 0 ? 'front of the book, before the first contents entry' : 'the book';
  for (const row of rows) {
    const title = opens.get(row.id);
    if (title !== undefined) current = title;
    out.set(row.id, current);
  }
  return out;
}

/** One block as snap sees it: id, (section · markup), then its text — a picture says so. */
export function blockLine(row: SnapRow, section: string): string {
  const where = row.markup !== undefined && row.markup.length > 0 ? `${section} · ${row.markup}` : section;
  const flat = row.text.replace(/\s+/g, ' ').trim();
  const text = row.category === 'Picture'
    ? `(picture) ${flat}`
    : flat.length > LINE_CHARS ? `${flat.slice(0, LINE_CHARS)}…` : flat;
  return `[${row.id}] (${where}) ${text}`;
}

/** What every group's state opens with: the guide, the book, and its contents. */
export function bookHeader(title: string, chapters: readonly SnapChapter[]): string {
  const lines = [SNAP_GUIDE, '', `BOOK: ${title}`];
  if (chapters.length > 0) {
    lines.push('TABLE OF CONTENTS (from the book\'s own navigation; it can be incomplete):');
    for (const chapter of chapters) lines.push(`- ${chapter.title}`);
  } else {
    lines.push('TABLE OF CONTENTS: none; this book has no navigation to go by.');
  }
  return lines.join('\n');
}

/** A group: `rows.slice(from, to)` shown, `rows.slice(askFrom, askTo)` asked about. */
export interface SnapGroup {
  from: number;
  to: number;
  askFrom: number;
  askTo: number;
}

/** Consecutive groups of `ask` rows, each shown with `radius` rows on either side. */
export function buildGroups(rowCount: number, ask: number = GROUP_ASK, radius: number = GROUP_RADIUS): SnapGroup[] {
  if (ask < 1 || radius < 0) {
    throw new Error(`a group asks about at least one block (asked for ${ask}, radius ${radius})`);
  }
  const groups: SnapGroup[] = [];
  for (let at = 0; at < rowCount; at += ask) {
    const askTo = Math.min(rowCount, at + ask);
    groups.push({ from: Math.max(0, at - radius), to: Math.min(rowCount, askTo + radius), askFrom: at, askTo });
  }
  return groups;
}

/** The state snap is handed for one group: the header, then the shown blocks in reading order. */
export function groupState(
  header: string,
  rows: readonly SnapRow[],
  sections: ReadonlyMap<string, string>,
  group: SnapGroup,
): string {
  const body = rows.slice(group.from, group.to)
    .map((row) => blockLine(row, sections.get(row.id) ?? 'the book'))
    .join('\n');
  return `${header}\n\nBLOCKS (a stretch of the book, in reading order):\n${body}`;
}

/** The question asked about one block — snap's `choice` question shape. */
export function blockQuestion(row: SnapRow): {
  type: 'choice'; instructions: string; options: Readonly<Record<string, string>>;
} {
  return {
    type: 'choice',
    instructions: `What kind of block is [${row.id}]?`,
    options: SNAP_CATEGORY_OPTIONS,
  };
}

/** Does snap get asked about this row at all? */
export function isAsked(row: SnapRow): boolean {
  return !SNAP_SKIPPED_CATEGORIES.has(row.category) && row.text.trim().length > 0;
}

/** snap's answer to one `choice` question — the fields this module reads. */
export interface SnapChoiceAnswer {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
  label_mass: number;
}

/** When an answer is trusted enough to change a block. */
export interface SnapPolicy {
  /** The chosen category's share of the letter probability. */
  minConfidence: number;
  /** The letters' share of ALL probability — below it the model wanted to say something else. */
  minLabelMass: number;
}

export const DEFAULT_SNAP_POLICY: SnapPolicy = { minConfidence: 0.6, minLabelMass: 0.9 };

/** One row of the report written beside the step: what was asked, answered and done. */
export interface SnapReportRow {
  id: string;
  was: string;
  answer: string;
  confidence: number;
  labelMass: number;
  probabilities: Record<string, number>;
  /** `changed`, `same`, or why a different answer was not applied. */
  outcome: 'changed' | 'same' | 'low-confidence' | 'low-label-mass';
  /** The block's section and opening words, so the report can be read without the book open. */
  section: string;
  text: string;
}

export interface SnapDecision {
  categoryOps: CategoryOp[];
  chapterOps: ChapterSetOp[];
  report: SnapReportRow[];
}

/**
 * WHAT THE ANSWERS COME TO: category changes, and chapter markers on the headings.
 *
 * A category changes only when snap chose a different one confidently
 * (`SnapPolicy`); everything else stays exactly as it was and the report says why.
 *
 * CHAPTERS ARE ADDED, NEVER TAKEN AWAY. A run of consecutive `Title` rows (after
 * the changes) is one heading — a number line and a title line are one chapter
 * opening — and it gets a chapter marker at its first row, titled with the run's
 * text, unless a chapter already starts at that row or within the three rows
 * before it (an EPUB's navigation often lands on the ornament or the number just
 * above the words). The publisher's own divisions are left alone: a nav entry the
 * model reads differently is still the publisher's statement, and removing one
 * is a person's call.
 */
export function decide(
  rows: readonly SnapRow[],
  answers: ReadonlyMap<string, SnapChoiceAnswer>,
  chapters: readonly SnapChapter[],
  policy: SnapPolicy = DEFAULT_SNAP_POLICY,
): SnapDecision {
  const sections = sectionsOf(rows, chapters);
  const categoryOps: CategoryOp[] = [];
  const report: SnapReportRow[] = [];
  const finalCategory = new Map<string, string>();
  for (const row of rows) {
    finalCategory.set(row.id, row.category);
    const answer = answers.get(row.id);
    if (answer === undefined) continue;
    let outcome: SnapReportRow['outcome'];
    if (answer.choice === row.category) {
      outcome = 'same';
    } else if (answer.label_mass < policy.minLabelMass) {
      outcome = 'low-label-mass';
    } else if (answer.confidence < policy.minConfidence) {
      outcome = 'low-confidence';
    } else {
      outcome = 'changed';
      categoryOps.push({ op: 'category', id: row.id, category: answer.choice });
      finalCategory.set(row.id, answer.choice);
    }
    report.push({
      id: row.id,
      was: row.category,
      answer: answer.choice,
      confidence: answer.confidence,
      labelMass: answer.label_mass,
      probabilities: answer.probabilities,
      outcome,
      section: sections.get(row.id) ?? 'the book',
      text: row.text.replace(/\s+/g, ' ').trim().slice(0, 120),
    });
  }

  const starts = new Set(chapters.map((chapter) => chapter.id));
  const chapterOps: ChapterSetOp[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (finalCategory.get(rows[i]!.id) !== 'Title') continue;
    if (i > 0 && finalCategory.get(rows[i - 1]!.id) === 'Title') continue;
    let end = i;
    while (end + 1 < rows.length && finalCategory.get(rows[end + 1]!.id) === 'Title') end += 1;
    let covered = false;
    for (let back = i; back >= Math.max(0, i - 3); back -= 1) {
      if (starts.has(rows[back]!.id)) { covered = true; break; }
    }
    if (covered) continue;
    const title = runTitle(rows.slice(i, end + 1).map((row) => row.text));
    if (title.length === 0) continue;
    chapterOps.push({ op: 'chapter', set: rows[i]!.id, title });
  }
  return { categoryOps, chapterOps, report };
}

/**
 * A heading run's title: its lines joined, a bare number or "Chapter N" line
 * joined to the words after it with a colon — the shape an EPUB's own navigation
 * uses ("1: The Legacies of Revolution").
 */
export function runTitle(lines: readonly string[]): string {
  const parts = lines.map((line) => line.replace(/\s+/g, ' ').trim()).filter((line) => line.length > 0);
  if (parts.length === 0) return '';
  const numberLine = /^(chapter|part|book)?\s*([0-9]+|[ivxlcdm]+)\.?$/i;
  if (parts.length > 1 && numberLine.test(parts[0]!)) {
    return `${parts[0]}: ${parts.slice(1).join(' ')}`;
  }
  return parts.join(' ');
}

// ── The tile's wire: what the renderer sends, hears and gets back ─────────────

export interface SnapCategorizeSettings {
  /** The snap checkout: `scripts/serve.ps1`, `.venv/Scripts/snap.exe`, `models/`. */
  snapHome: string;
  /** The engine's context, in tokens, when this press starts it. A group needs only a few thousand. */
  contextTokens: number;
  minConfidence?: number;
  minLabelMass?: number;
}

export interface SnapProgress {
  projectDir: string;
  phase: 'starting' | 'asking' | 'applying' | 'stopping' | 'done' | 'failed' | 'cancelled';
  message: string;
  done?: number;
  total?: number;
}

export interface SnapCategorizeResult {
  asked: number;
  changed: number;
  chapters: number;
  lowConfidence: number;
  /** How many groups the book was asked in. */
  windows: number;
  /** The report of every answer, beside the book. */
  reportPath: string;
  /** Whether this press started the model — and so brought it down again. */
  startedModel: boolean;
  /** False when there was nothing to change, so no step was made. */
  applied: boolean;
}
