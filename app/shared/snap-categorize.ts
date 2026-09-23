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
  'MARKS ON A LINE: "first in section" means the block is the first one of its section. "matches',
  'contents entry …" means its words repeat a chapter name from the table of contents. A chapter name',
  'appears in three places, and each is a different kind: in the table of contents page it is a',
  'List-item; where the chapter itself begins (usually "first in section") it is a Title; in the',
  'notes or endnotes section, over that chapter\'s notes, it is a Section-header.',
  '',
  'HOW TO JUDGE: read the block\'s words first, then where it sits (its section, its marks and the',
  'blocks around it), then the table of contents. The markup in parentheses is a WEAK hint for',
  'headings and captions: publishers mark captions and headings as plain paragraphs all the time,',
  'and style names like "calibre_3" mean nothing by themselves. But markup that says blockquote is',
  'real evidence of a Quote: a publisher rarely sets a quotation apart by mistake. A line in the',
  'contents page is a List-item. A numbered line in an endnotes section is a Footnote unless it is',
  'the heading over a chapter\'s notes.',
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

/**
 * A chapter name reduced to its words: case folded, a leading "Chapter 5", "5." or
 * "V" and every dash and punctuation mark gone. "Chapter 5—Evo-Devo" and
 * "5. Evo-Devo" are the same name, which is the whole test.
 */
export function nameKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/^\s*(chapter|part|book)?\s*([0-9]+|[ivxlcdm]+)\b\s*[.:—–-]?\s*/i, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * THE MARKS ON EACH LINE — facts about where a block sits that its words alone
 * cannot say, measured once per book (second run, 2026-09-22: the model put the
 * contents page's lines and the endnotes' chapter headings down as chapter
 * titles, because "Chapter 5—Evo-Devo" reads the same in all three places).
 *
 * `first in section`: the first row of a section of the navigation.
 * `matches contents entry "…"`: the row's words are a chapter name from the
 * navigation (`nameKey`). EVIDENCE, not a verdict — the guide tells the model
 * what a match means in each place, and the model decides.
 */
export function lineMarks(rows: readonly SnapRow[], chapters: readonly SnapChapter[]): Map<string, string[]> {
  const starts = new Set(chapters.map((chapter) => chapter.id));
  const names = new Map<string, string>();
  for (const chapter of chapters) {
    const key = nameKey(chapter.title);
    if (key.length >= 3) names.set(key, chapter.title);
  }
  const out = new Map<string, string[]>();
  for (const row of rows) {
    const marks: string[] = [];
    if (starts.has(row.id)) marks.push('first in section');
    const named = names.get(nameKey(row.text));
    if (named !== undefined) marks.push(`matches contents entry "${named}"`);
    if (marks.length > 0) out.set(row.id, marks);
  }
  return out;
}

/** One block as snap sees it: id, (section · marks · markup), then its text — a picture says so. */
export function blockLine(row: SnapRow, section: string, marks: readonly string[] = []): string {
  const parts = [section, ...marks];
  if (row.markup !== undefined && row.markup.length > 0) parts.push(row.markup);
  const where = parts.join(' · ');
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
  marks: ReadonlyMap<string, readonly string[]> = new Map(),
): string {
  const body = rows.slice(group.from, group.to)
    .map((row) => blockLine(row, sections.get(row.id) ?? 'the book', marks.get(row.id) ?? []))
    .join('\n');
  return `${header}\n\nBLOCKS (a stretch of the book, in reading order):\n${body}`;
}

/**
 * THE SECOND QUESTION, asked only of blocks answered `Title` — snap's `yesno`.
 *
 * A Title is the one answer with consequences beyond its own block (it marks
 * where a chapter begins), and on the second run every wrong chapter call was a
 * confident one (0.63-0.97). A sharper question about just that decision costs
 * one more short prefill against the cached group, for the few blocks that need
 * it. An unconfirmed Title leaves the block as it was (`decide`).
 */
export function titleConfirmQuestion(row: SnapRow): { type: 'yesno'; instructions: string } {
  return {
    type: 'yesno',
    instructions: `Block [${row.id}] is where a chapter or part of the book's main text begins — its own `
      + 'heading, not a line of the table of contents, not a heading over notes in an endnotes section, '
      + 'and not a heading inside a chapter.',
  };
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
  /** p(yes) the Title confirmation (`titleConfirmQuestion`) must reach for a block to become a Title. */
  minTitleConfirm: number;
}

export const DEFAULT_SNAP_POLICY: SnapPolicy = { minConfidence: 0.6, minLabelMass: 0.9, minTitleConfirm: 0.7 };

/** One row of the report written beside the step: what was asked, answered and done. */
export interface SnapReportRow {
  id: string;
  was: string;
  answer: string;
  confidence: number;
  labelMass: number;
  probabilities: Record<string, number>;
  /** `changed`, `same`, or why a different answer was not applied. */
  outcome: 'changed' | 'same' | 'low-confidence' | 'low-label-mass' | 'title-unconfirmed';
  /** p(yes) of the Title confirmation, for a block answered Title; absent otherwise. */
  titleConfirm?: number;
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
 * A BLOCK BECOMES A TITLE ONLY WHEN THE CONFIRMATION AGREES: `titleConfirms`
 * holds p(yes) of `titleConfirmQuestion` for every block answered Title, and
 * below `policy.minTitleConfirm` the block is left as it was
 * (`title-unconfirmed`). A block that already was a Title is not re-judged.
 *
 * CHAPTER MARKERS COME FROM THE MODEL ONLY WHEN THE BOOK HAS NO NAVIGATION. On
 * the second run (a book whose navigation already listed all fourteen chapters)
 * every marker the model added was wrong — the contents page, a numbered
 * sub-section, the endnotes' headings. Where the publisher said where the
 * chapters are, that stands; the model's Title calls still relabel the blocks.
 * Where there is no navigation, a run of consecutive `Title` rows (after the
 * changes) is one heading — a number line and a title line are one chapter
 * opening — and gets one marker at its first row, titled with the run's text.
 * Chapters are only ever ADDED.
 */
export function decide(
  rows: readonly SnapRow[],
  answers: ReadonlyMap<string, SnapChoiceAnswer>,
  chapters: readonly SnapChapter[],
  policy: SnapPolicy = DEFAULT_SNAP_POLICY,
  titleConfirms: ReadonlyMap<string, number> = new Map(),
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
    const confirm = titleConfirms.get(row.id);
    if (answer.choice === row.category) {
      outcome = 'same';
    } else if (answer.label_mass < policy.minLabelMass) {
      outcome = 'low-label-mass';
    } else if (answer.confidence < policy.minConfidence) {
      outcome = 'low-confidence';
    } else if (answer.choice === 'Title' && (confirm === undefined || confirm < policy.minTitleConfirm)) {
      outcome = 'title-unconfirmed';
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
      ...(confirm === undefined ? {} : { titleConfirm: confirm }),
      section: sections.get(row.id) ?? 'the book',
      text: row.text.replace(/\s+/g, ' ').trim().slice(0, 120),
    });
  }

  const chapterOps: ChapterSetOp[] = [];
  if (chapters.length > 0) return { categoryOps, chapterOps, report };
  for (let i = 0; i < rows.length; i += 1) {
    if (finalCategory.get(rows[i]!.id) !== 'Title') continue;
    if (i > 0 && finalCategory.get(rows[i - 1]!.id) === 'Title') continue;
    let end = i;
    while (end + 1 < rows.length && finalCategory.get(rows[end + 1]!.id) === 'Title') end += 1;
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

/**
 * WHERE THE MODEL RUNS. `local` is snap's own llama-server on this machine's card
 * (scripts/serve.ps1); `crucible` places the run like any `analysis` act — a
 * registered Crucible, its selected model, loaded and LEASED for the run — and
 * points snap's openai-chat engine at that server's chat door, which passes
 * `logprobs` through to vLLM.
 */
export type SnapEngine = 'local' | 'crucible';

export interface SnapCategorizeSettings {
  engine: SnapEngine;
  /** The snap checkout: `scripts/serve.ps1`, `.venv/Scripts/snap.exe`, `models/`. */
  snapHome: string;
  /**
   * The engine's context, in tokens, when this press starts a LOCAL one. A group
   * needs only a few thousand. Unread for `crucible`: that window is the server's
   * `max_model_len`, read off its listing.
   */
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
  /** Which model answered, and where — "qwen3.5-9b on 3090 Ti", "Qwen3.5 9B on this machine". */
  answeredBy: string;
  /** False when there was nothing to change, so no step was made. */
  applied: boolean;
}
