/**
 * translate/tablecells — A GRID'S WORDS, WITHOUT EVER SHOWING A MODEL A TAG.
 *
 * ── THE ARGUMENT THIS FILE EXISTS TO SETTLE ─────────────────────────────────
 *
 * A `Table` row's text is the vision model's own HTML — the whole grid as one
 * string, `<table><tr><td>Vorwort</td><td>VII</td></tr>…` — and until this file
 * existed that was the end of the matter: `bookrows.ts` and `run.ts` both left
 * tables in the source language and said so, on an argument that was correct as
 * far as it went. *Translating the grid as one string means handing a model
 * `<tr>`, `<td>` and every attribute in them and asking it not to touch any of
 * it, and a table whose columns quietly swapped is worse than a table nobody
 * translated, because it looks fine.*
 *
 * That argument is kept, WHOLE, and this file is what makes it irrelevant. The
 * model is never shown the grid. It is shown CELLS — plain strings, no tags, no
 * attributes, one per `<td>` — through the same table wire format `run.ts`
 * already sends a cast EPUB's cells in, and the grid is put back together HERE,
 * mechanically, by splicing each answer into the source range its cell's words
 * came out of. The columns cannot swap because nothing reorders anything: the
 * tags, the attributes, the row order and the cell order are the SOURCE STRING,
 * untouched by construction, and the only bytes that move are the ones between
 * a `<td>` and its `</td>`.
 *
 * WHY THIS IS NOT A SECOND HTML PARSER. It is `src/epub/xml.ts` — the one this
 * project has, the one `checkTableHtml` already validates a grid with, and the
 * one whose whole design is that every node knows its span in the source so an
 * edit is a splice rather than a re-serialization. `blocks.ts`'s `tableRows`
 * walks a cast document's grid with the same parser and the same strictness;
 * this is that walk over a string the vision model wrote instead of a file the
 * emitter wrote, and it refuses the same shapes for the same reasons.
 *
 * ── WHAT IS REFUSED, AND WHY IT IS REFUSED WHOLE ────────────────────────────
 *
 * A grid this file cannot read is not half-read. Two tables in one fragment, a
 * `<tr>` holding something that is not a cell, a cell holding an ELEMENT rather
 * than words — each of those is a shape whose row order or whose prose this
 * stage would be guessing at, and the guess is the failure the paragraph above
 * refuses. So `readTableGrid` says what is wrong in one sentence and the caller
 * leaves the whole table exactly as the book wrote it, named on the completion
 * line. That is strictly what happened to EVERY table before this file existed.
 *
 * ── AND WHAT IS CARRIED RATHER THAN ASKED ───────────────────────────────────
 *
 * A printed table of contents is two columns: the chapter's name, and the leaf
 * it starts on. `VII`, `48`, `103`. There is nothing in a folio to translate,
 * and asking anyway is the `HV111$007458S` failure in miniature — a model given
 * a string with no language in it and told to render it in another one has been
 * handed an invitation to invent. So a cell with no letters in it, and a cell
 * that is a Roman numeral, are CARRIED: they keep their source bytes, they are
 * never sent, and they are counted so the run can say how many.
 *
 * THE ROMAN RULE IS KNOWN TO OVER-MATCH AND IS KEPT ANYWAY. `MIX`, `DIM` and
 * `CIVIL` are canonical numerals and are also words, and the measurement is not
 * hypothetical: the abbreviations table of the Dannenmann scan carries `DC` —
 * *Deutsche Christen* — straight through as though it were 600. That is the
 * SAFE direction and the only one worth taking: carrying a cell is exactly what
 * this stage did to every cell of every table until now, so the worst case of
 * the rule is the status quo, while the worst case of asking is a page number
 * answered with a sentence. (`DC` is also an abbreviation, which no translation
 * would have changed, and the cell beside it holding what it stands for IS
 * translated — so in the case that actually occurs the rule costs nothing.)
 */
import { decodeEntities, elements, parseXml, type XmlElement } from '../epub/xml.js';
import { ROMAN_NUMERAL } from '../vlm/dots.js';

/** One `<td>` or `<th>`: the words in it, and where those words live. */
export interface TableCell {
  /** The cell's own words, entities decoded and edge whitespace off. */
  text: string;
  /**
   * The source range of exactly `text`'s characters — the cell's contents with
   * any padding whitespace left OUTSIDE it, so a splice replaces the words and
   * nothing else. Equal offsets for a cell that holds nothing.
   */
  start: number;
  end: number;
}

/** A grid this stage can take apart and put back together. */
export interface TableGrid {
  /** The fragment exactly as the vision model wrote it. Never re-serialized. */
  source: string;
  /** Every cell, in reading order — row by row, left to right. */
  cells: TableCell[];
  /** Cells per row, in row order, summing to `cells.length`. */
  rowSizes: number[];
}

/** Which of a grid's cells are worth asking about, and in what shape. */
export interface TableAsk {
  /** Indexes into `TableGrid.cells`, in reading order. */
  ask: number[];
  /**
   * Cells per row of the PAYLOAD, summing to `ask.length` — the grid's own row
   * sizes with the carried cells taken out, and a row that lost all of its
   * cells dropped entirely.
   *
   * A dropped row is not a hole: the answer is read back positionally against
   * THIS shape (`parseChunkAnswer`), and the cells that were never sent are
   * spliced from the source. A row of nothing but folios simply has no line in
   * the request, which is also the only thing `chunkAmbiguity` would accept —
   * an all-empty row "has no line to come back on".
   */
  rowSizes: number[];
  /** Cells kept as the book wrote them: blanks, numbers, folios. */
  carried: number;
}

/** The five characters a splice must not put back into the grid raw. */
function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * One cell's words, or null where this is not a cell of words.
 *
 * A `<td>` holding an ELEMENT — a `<p>`, a `<br/>`, an `<img/>` — is refused
 * rather than flattened. `blocks.ts` refuses the same shape one format over on
 * the same ground: passing markup through as though it were prose is how the
 * words inside it get silently left untranslated, and inventing a text-level
 * dialect for markup the vision model does not otherwise write would be a
 * second flowing-text grammar bought for one rare cell.
 *
 * A COMMENT IS NOT AN ELEMENT AND IS ALSO NOT WORDS, so it refuses too: its
 * bytes sit inside the range a splice would overwrite, and silently deleting
 * something out of somebody's book is not a thing this stage does.
 */
function cellWords(cell: XmlElement, source: string): TableCell | null {
  for (const child of cell.children) {
    if (child.kind !== 'text') return null;
  }
  const raw = source.slice(cell.innerStart, cell.innerEnd);
  const lead = raw.length - raw.trimStart().length;
  const trail = raw.length - raw.trimEnd().length;
  const start = cell.innerStart + lead;
  const end = Math.max(start, cell.innerEnd - trail);
  return { text: decodeEntities(source.slice(start, end)), start, end };
}

/**
 * A Table row's HTML, read as a grid — or one sentence saying why it is not one.
 *
 * `tableRows`' strictness (`blocks.ts`), stated over a fragment rather than a
 * document: `<thead>`/`<tbody>`/`<tfoot>` are transparent because the rows are
 * found by walking for `<tr>` wherever they sit, and a wrapper holding more than
 * one `<table>` is refused because a flat cell list across two grids is a list
 * whose row boundaries this stage would be inventing.
 */
export function readTableGrid(fragment: string): { grid: TableGrid } | { complaint: string } {
  let root: XmlElement;
  try {
    // The same wrapper `checkTableHtml` parses it in, so a fragment that got
    // into a book file at all gets past this line — and one that did not is
    // named here rather than throwing a page error at compile time.
    root = parseXml(`<foundry-table-fragment>${fragment}</foundry-table-fragment>`, 'xhtml');
  } catch (err) {
    return {
      complaint: 'a table\'s text is the vision model\'s own HTML and this one is not well-formed '
        + `(${err instanceof Error ? err.message : String(err)}), so its cells cannot be told apart`,
    };
  }
  // Every offset above is one character past the fragment's own, because of the
  // wrapper. Read the cells out of the WRAPPED string and shift once, here.
  const wrapped = `<foundry-table-fragment>${fragment}</foundry-table-fragment>`;
  const shift = '<foundry-table-fragment>'.length;

  let tables = 0;
  const cells: TableCell[] = [];
  const rowSizes: number[] = [];
  for (const el of elements(root)) {
    if (el.tag === 'table') tables += 1;
    if (el.tag !== 'tr') continue;
    const row: TableCell[] = [];
    for (const child of el.children) {
      if (child.kind === 'text' && wrapped.slice(child.start, child.end).trim().length === 0) continue;
      if (child.kind !== 'element' || (child.tag !== 'td' && child.tag !== 'th')) {
        return {
          complaint: 'a row of this table holds something that is not a cell, so which words belong '
            + 'in which column is not a thing this stage can read off it',
        };
      }
      const words = cellWords(child, wrapped);
      if (words === null) {
        return {
          complaint: 'a cell of this table holds markup rather than words, and flattening it is how '
            + 'the prose inside it gets left untranslated without anybody being told',
        };
      }
      row.push({ text: words.text, start: words.start - shift, end: words.end - shift });
    }
    if (row.length === 0) continue;
    cells.push(...row);
    rowSizes.push(row.length);
  }
  if (tables > 1) {
    return {
      complaint: 'this block holds more than one table, and one flat list of cells across two grids '
        + 'has row boundaries nobody wrote down',
    };
  }
  if (cells.length === 0) {
    return { complaint: 'this table has no cells in it at all' };
  }
  return { grid: { source: fragment, cells, rowSizes } };
}

/**
 * Is there anything in this cell for a model to do? See the header's last
 * section for the whole argument, including the one it knowingly loses.
 */
export function cellIsCarried(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  if (!/\p{L}/u.test(trimmed)) return true;
  return ROMAN_NUMERAL.test(trimmed);
}

/** Which cells of this grid are asked about, and the payload's shape. */
export function askableCells(grid: TableGrid): TableAsk {
  const ask: number[] = [];
  const rowSizes: number[] = [];
  let carried = 0;
  let at = 0;
  for (const size of grid.rowSizes) {
    let asked = 0;
    for (let i = at; i < at + size; i++) {
      if (cellIsCarried(grid.cells[i]!.text)) { carried += 1; continue; }
      ask.push(i);
      asked += 1;
    }
    at += size;
    if (asked > 0) rowSizes.push(asked);
  }
  return { ask, rowSizes, carried };
}

/**
 * The grid with translated words in it — the source string, spliced.
 *
 * RIGHT TO LEFT, DISJOINT, AND PROVED AFTERWARDS. The splice order is
 * `spliceAll`'s (`blocks.ts`) for its reason — an edit before an earlier one
 * moves it — and the cells are disjoint by construction, since each range is
 * one element's contents. What is not taken on trust is the RESULT: the grid is
 * read again and its shape compared against the one that went in, so a
 * translated table that is no longer the same table never reaches a record. The
 * cost is one parse of a fragment; the alternative is somebody's rows silently
 * rearranged, which is precisely what this whole file is arranged against.
 *
 * A CELL WITH NO WORDS FOR IT KEEPS ITS SOURCE BYTES, and that is what makes a
 * partial table honest rather than broken: a cell nobody asked about (a folio),
 * a cell the model refused, and a cell of a run that was killed all look the
 * same in the output — untouched — and the run says how many of each there
 * were. No link beats a wrong one.
 */
export function spliceTableGrid(
  grid: TableGrid,
  words: ReadonlyMap<number, string>,
): { text: string } | { complaint: string } {
  const edits = [...words]
    .map(([index, text]) => ({ cell: grid.cells[index]!, text }))
    .filter((edit) => edit.cell !== undefined)
    .sort((a, b) => a.cell.start - b.cell.start);
  let out = grid.source;
  for (let i = edits.length - 1; i >= 0; i--) {
    const edit = edits[i]!;
    out = out.slice(0, edit.cell.start) + escapeXml(edit.text) + out.slice(edit.cell.end);
  }
  const back = readTableGrid(out);
  if ('complaint' in back) {
    return { complaint: `the translated grid is no longer a grid this stage can read — ${back.complaint}` };
  }
  if (back.grid.rowSizes.join(',') !== grid.rowSizes.join(',')) {
    return {
      complaint: `the translated grid has rows of ${back.grid.rowSizes.join('/')} cells where the `
        + `source has ${grid.rowSizes.join('/')} — the words that came back have changed the shape `
        + 'of somebody\'s table, which is the one thing translating a table cell by cell exists to '
        + 'make impossible',
    };
  }
  return { text: out };
}
