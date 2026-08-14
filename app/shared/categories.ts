/**
 * The categories a block can carry, and the colour each one is drawn in.
 *
 * ── Why this is ONE table in shared/ ─────────────────────────────────────────
 *
 * The colour has to appear in TWO places or it is a code nobody can decode: as
 * an outline on the block inside the sandboxed frame (electron/click-reporter.ts
 * builds its stylesheet from this), and as a swatch beside the category's name
 * in the inspector the user relabels from (the Angular side imports the same
 * array). Two hand-kept lists of eleven colours would be one edit away from an
 * inspector that says a paragraph is green while the page outlines it in amber,
 * and the whole point of colouring them is that the two agree.
 *
 * `app/shared` is the one directory BOTH TypeScript programs compile — the
 * renderer through tsconfig.json's `@shared/*`, the main process through
 * tsconfig.electron.json's `shared/**` include — which is why the wire shapes
 * live here and why this does too.
 *
 * ── The eleven ───────────────────────────────────────────────────────────────
 *
 * Ten are the dots model's own categories, lower-cased, as `src/vlm/dots-book.ts`
 * writes them; the eleventh — `chapter` — is foundry's, marking a heading the
 * book divides at (dots has no such category, and `proposeChapters` is what
 * decides). This list must stay in step with that emitter: a category arriving
 * from a book that is not here is drawn in the fallback grey and named as
 * unknown rather than silently taking somebody else's colour.
 *
 * ── The colours ──────────────────────────────────────────────────────────────
 *
 * Owen named three — green body text, blue chapter header, red title — and the
 * rest are chosen around them. Eleven hues cannot all be told apart at a glance,
 * so they are grouped by WHAT THE BLOCK IS and the families carry the meaning:
 * the prose is green, the headings are the red→blue→violet run (title, chapter,
 * section-header, in the order a book nests them), the apparatus a reader skips
 * past is warm (footnote, caption), set-off prose is pink/lime, and the objects
 * that are not sentences at all are cool (table, picture, formula). Two pairs
 * sit close — fuchsia/pink and cyan/teal — and the swatch in the inspector is
 * what settles those, which is why the inspector is not optional.
 *
 * They are applied as an OUTLINE AND A TINT, never as text colour: this is a
 * book, and recolouring its words makes it unreadable.
 */

export interface BlockCategory {
  /** The `data-bf-cat` value, verbatim. */
  id: string;
  /** What the inspector's row says. */
  label: string;
  /** The outline and tint, as `#rrggbb`. */
  colour: string;
  /** One line under the label, so a row explains itself. */
  note: string;
}

export const BLOCK_CATEGORIES: readonly BlockCategory[] = [
  {
    id: 'text',
    label: 'Body text',
    colour: '#4ade80',
    note: 'The prose of the book.',
  },
  {
    id: 'title',
    label: 'Title',
    colour: '#f87171',
    note: "The book's own name, and the parts a title page carries.",
  },
  {
    id: 'chapter',
    label: 'Chapter opening',
    colour: '#60a5fa',
    note: 'A heading the book divides at — the EPUB split points.',
  },
  {
    id: 'section-header',
    label: 'Section header',
    colour: '#a78bfa',
    note: 'A heading inside a chapter.',
  },
  {
    id: 'quote',
    label: 'Quotation',
    colour: '#f472b6',
    note: 'Prose set off from the paragraph around it.',
  },
  {
    id: 'list-item',
    label: 'List item',
    colour: '#a3e635',
    note: 'A list, and the items in it.',
  },
  {
    id: 'footnote',
    label: 'Footnote',
    colour: '#fbbf24',
    note: 'A note the page printed under a rule.',
  },
  {
    id: 'caption',
    label: 'Caption',
    colour: '#e879f9',
    note: 'The words under a plate or a table.',
  },
  {
    id: 'table',
    label: 'Table',
    colour: '#22d3ee',
    note: "A grid, with the model's own rows inside it.",
  },
  {
    id: 'picture',
    label: 'Picture',
    colour: '#2dd4bf',
    note: 'A plate cropped out of the scan.',
  },
  {
    id: 'formula',
    label: 'Formula',
    colour: '#94a3b8',
    note: 'Mathematics, left exactly as it was read.',
  },
];

/**
 * Every legal `data-bf-cat`, for the one place it has to be checked before it is
 * written into somebody's book (`setBlockCategories` in electron/epub-reader.ts).
 * A relabel to a category the emitter never writes would put a book in a shape
 * `src/translate/blocks.ts` refuses by name on the next run.
 */
export const CATEGORY_IDS: ReadonlySet<string> = new Set(BLOCK_CATEGORIES.map((one) => one.id));

/** What a category this table has never heard of is drawn in. Grey, and named as unknown. */
export const UNKNOWN_CATEGORY_COLOUR = '#8c8c8c';

export function categoryLabel(id: string): string {
  return BLOCK_CATEGORIES.find((one) => one.id === id)?.label ?? id;
}

/** `#4ade80` → `74,222,128`, so a colour can be tinted with an alpha. */
export function categoryRgb(colour: string): string {
  const hex = colour.replace('#', '');
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  return `${r},${g},${b}`;
}
