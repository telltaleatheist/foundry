/**
 * clean/removal — what a cleanup TAKES OUT, beside what it reads (Owen, 2026-09-29).
 *
 * *"add a checkbox to ai cleanup that's automatically checked, and will remove (see:
 * table [x]) or (fig. 1-1) or similar things. the ai should make a decision about
 * whether it should be removed. does it substantively add to the prose and would it
 * be read in a real audiobook? real audiobooks would never read "see fig. 1-1". or
 * "[image]""* — and: *"give me the ability to ask it to remove other specific patterns
 * i saw in the book. just add to the prompt. it will add what i request to the decide
 * prompt and to the actual cleanup prompt."*
 *
 * TWO INPUTS, ONE DECISION-MAKER. `references` is the box: printed pointers a
 * narrator skips (a figure, a table, a page, an image placeholder). `also` is the
 * person's own words about what else this book prints that nobody would read aloud.
 * Neither is a pattern this code matches — both are said to the MODEL, in the triage
 * question and in the cleaner's prompt, and the model decides span by span. What the
 * code owns is only that a removal it proposes is accepted as a removal
 * (`NumberEditPolicy.removal`) and that the question each block is asked names what
 * was asked for, so a different request is a different question (`removalKeyField`).
 *
 * OFF, BOTH, IS EXACTLY THE CLEANUP THAT EXISTED BEFORE: the same prompt bytes, the
 * same cache keys, the same triage criteria. Nothing here changes a run that asks
 * for no removal.
 */

/** What this run removes. */
export interface RemovalRequest {
  /** The box: printed references a narrator would not read aloud. */
  references: boolean;
  /** The person's own description of anything else to remove. Empty for none. */
  also: string;
}

/** No removal beyond what the cleanup always did. */
export const NO_REMOVAL: RemovalRequest = { references: false, also: '' };

/** The person's words, as the prompts and the key see them: trimmed, line endings folded. */
function alsoText(request: RemovalRequest): string {
  return request.also.replace(/\r\n?/g, '\n').trim();
}

/** Does this run remove anything the plain cleanup would not? */
export function removesAnything(request: RemovalRequest): boolean {
  return request.references || alsoText(request).length > 0;
}

/**
 * The rule for the box, in words and without worked examples (Owen, 2026-09-25:
 * *"i want general rules. specific examples sometimes lead to smaller models using
 * the examples and nothing else"*).
 */
const REFERENCES_RULE = [
  'A printed reference that no narrator of a real audiobook would read aloud is removed. That is a',
  'pointer to something the listener cannot see: a figure, table, chart, map, plate, illustration,',
  'photograph, page or note of the book, however it is abbreviated or bracketed; and a placeholder',
  'standing where an image, a chart or a table was. Ask of each one: does it add anything to the',
  'prose, and would a narrator say it? If it adds nothing and would be skipped, remove it. Words',
  'that say something about the subject stay, even when they mention a figure or a table.',
].join(' ');

/** The rule the person's own words become. */
function alsoRule(also: string): string {
  return [
    'The reader of this book also asked for the following to be removed, because a narrator would',
    'not read it. Remove only what their description fits:',
    also,
  ].join('\n');
}

/**
 * The section added to the cleaner's prompt, or '' when nothing more is removed.
 *
 * It says HOW a removal is written as well as what to remove, because a removal is
 * the one edit whose "replace" is empty and the prompt's answer format otherwise
 * implies a reading.
 */
export function removalPromptSection(request: RemovalRequest): string {
  if (!removesAnything(request)) return '';
  const also = alsoText(request);
  const lines = ['WHAT YOU REMOVE', ''];
  if (request.references) lines.push(`- ${REFERENCES_RULE}`);
  if (also.length > 0) lines.push(`- ${alsoRule(also)}`);
  lines.push(
    '- A removal is an edit whose "replace" is empty: "find" is the whole thing removed, with its',
    'brackets and the space before it, so the sentence reads on without a gap. When it is the whole',
    'TARGET, the find is the whole TARGET. Nothing else in the sentence changes because of it.',
  );
  return lines.join('\n');
}

/** The cleaner's prompt with the removal section, when there is one, at its end. */
export function withRemoval(prompt: string, request: RemovalRequest): string {
  const section = removalPromptSection(request);
  return section.length === 0 ? prompt : `${prompt}\n\n${section}`;
}

/**
 * The criteria lines added to the triage question: a sentence that prints something
 * to remove NEEDS CLEANING, or the cleaner is never asked about it. '' for none.
 */
export function removalTriageCriteria(request: RemovalRequest): string {
  if (!removesAnything(request)) return '';
  const also = alsoText(request);
  const lines: string[] = [];
  if (request.references) {
    lines.push('- a printed reference a narrator would not read aloud: a pointer to a figure, table, '
      + 'chart, map, plate, page or note, or a placeholder where an image or a table was;');
  }
  if (also.length > 0) {
    lines.push(`- anything that fits what the reader asked to be removed: ${also.replace(/\s+/g, ' ')}`);
  }
  return lines.join('\n');
}

/**
 * What the removal adds to a block's cache key — '' when nothing is removed, so a
 * run that asks for no removal keeps every key it had.
 *
 * A different request is a different question: a block answered with the box off
 * must be asked again with it on, and a block answered for one description of what
 * to remove is not answered for another.
 */
export function removalKeyField(request: RemovalRequest): string {
  if (!removesAnything(request)) return '';
  return `removal/v1:${request.references ? 'references' : ''}:${alsoText(request)}`;
}

/** The request, for a receipt or a triage file: what was asked, verbatim. */
export function removalRecord(request: RemovalRequest): RemovalRequest {
  return { references: request.references, also: alsoText(request) };
}

/** Are two requests the same question? */
export function sameRemoval(a: RemovalRequest, b: RemovalRequest): boolean {
  return removalKeyField(a) === removalKeyField(b);
}
