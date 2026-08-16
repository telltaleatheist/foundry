/**
 * vlm/pdf-text — the scanned book, set again as real type on fresh paper.
 *
 * A FOURTH EMITTER, AND THE ONLY ONE THAT DOES NOT BUILD A BOOK. `epub.ts`,
 * `dots-book.ts` and `text-out.ts` all answer "what does this book say", and
 * every rule they own — where the chapters divide, which paragraph runs over a
 * page turn, which superscript names which note — is a rule about the book that
 * the pages are evidence FOR. This file answers a different question: where on
 * the paper was each of those words printed, and it answers it by printing them
 * there again. So it forks in `convert.ts` the moment the pages are parsed and
 * takes none of that with it. No chapters, no page-turn joins, no dehyphenation,
 * no note markers, no reflow of its own.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT COMES OUT IS A NEW DOCUMENT, AND THAT IS THE WHOLE CHANGE.
 *
 * This emitter used to hand back the INPUT PDF with an invisible text layer laid
 * over its pages: the scan still looked like the scan, because it WAS the scan.
 * That mode had one incurable defect, and it was the defect the mode existed to
 * fix. A scan is a photograph of type — a quarter-megabyte of grey pixels a
 * page, which does not reflow, does not zoom, and stays crooked and dim wherever
 * the scanner caught it so. An invisible layer makes such a page FINDABLE
 * without making it READABLE, and "findable but not readable" is a smaller
 * promise than the one people bring this program a box of scans to keep.
 *
 * So the pixels go. Each page of the output is a blank page the size of the page
 * it stands for, and every block the model read is set on it as real, visible,
 * selectable type at the position — and, where the model kept them, on the LINES
 * — it was printed at. What comes out is a born-digital PDF: text at every zoom,
 * copies as characters, prints at the printer's resolution rather than the
 * scanner's, and a fraction of the weight.
 *
 * THE ORIGINAL IS NEVER TOUCHED. The input bytes are read for two things — the
 * geometry of each page, and the document's own title and author — and are
 * otherwise not written to, not copied and not modified. `convert.ts` refuses an
 * `--out` that names the `--pdf` before a page is rendered, so the scan on disk
 * survives this command by construction. That is what makes throwing the pixels
 * away an acceptable trade: the irrecoverable thing is still where it was.
 *
 * FACSIMILE, NOT TYPESETTING. A block lands in the rectangle the model measured
 * it in, on the page it was printed on, in the reading order the model answered
 * in. The folio is still at the foot of the page, the running head at its head,
 * a footnote still under the rule at the bottom of the page it is cited on, and
 * the book still breaks its pages where the printer broke them. A citation to
 * page 142 of this file is a citation to page 142 of the book.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE LINES ARE THE PRINTER'S OWN, WHEREVER THE MODEL KEPT THEM.
 *
 * `dots.ts` preserves a newline exactly where the page had one, and on a real
 * bank rather more than half of them survive: 277 lone line breaks against 39
 * blank-line separators, over the Kershaw article. Where they survive, a block's
 * segments ARE its printed lines — measured at 35 to 36 render pixels apiece
 * across every such block in that book, which is a printed line at 200 dpi and
 * could not be anything else. So they are set line for line: one printed line to
 * one output line, the printer's own end-of-line hyphens included, and the
 * hyphenation comes out right for free because nothing re-broke it.
 *
 * BUT THE MODEL REFLOWS ABOUT HALF THE BLOCKS, AND SAYS NOTHING ABOUT IT. In the
 * same bank, pages 8 to 12 came back line for line and pages 1 to 7 came back as
 * one 970-character run per paragraph. A block's newline count therefore cannot
 * be trusted on its face: it has to be CHECKED against what a printed line of
 * this book measures. `trustsItsLines` does exactly that — a block's segments
 * are believed only when the height they divide into lands inside the band a
 * printed line occupies on this page — and everything outside falls back to
 * wrapping, per block, and is counted in the report. A reflowed paragraph set as
 * though its one segment were one printed line would be a single 970-character
 * line squeezed into a five-line box, which is the failure this check exists to
 * make impossible.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE SIZE IS MEASURED OFF THE BOOK, AND IT USED TO BE MEASURED OFF THE FONT.
 *
 * The first version of this file solved each block's size from its box: the type
 * that exactly fills the rectangle the words were printed in. Every such number
 * is a CEILING — the largest size at which OUR font's widths still fit — and a
 * book set from ceilings comes out at the size DejaVu happens to need, which on
 * the Kershaw bank was 7.8 pt for a page printed at about 9. The type was
 * visibly smaller than the scan, and every paragraph stopped short of the bottom
 * of its own box, leaving a white gap the printed page does not have.
 *
 * The book states its own size twice, and neither statement is about our font:
 *
 *  - ITS LEADING. A block's box divided by the number of lines printed in it is
 *    the distance from one baseline to the next, in the book's own pixels. That
 *    is a measurement, not a fit, and it is the number that decides how big the
 *    type LOOKS. `leadOf` takes it.
 *  - ITS MEASURE. A printed line's characters across the column's width says how
 *    wide the book's face is. Divided by what OUR face needs for the same
 *    characters, it says how much narrower the book's type was than ours.
 *
 * So the size is `min(leading / LINE_FACTOR, fit / TZ_MIN)`: as large as the
 * book's leading implies, but never larger than horizontal compression can make
 * fit. And the leading is taken from the box rather than from the size, so a
 * block's lines always span exactly the rectangle they were printed in — which
 * is what closes the white gap, by construction rather than by tuning.
 *
 * AND SOME BOOKS STATE IT A THIRD TIME, IN POINTS, AND THAT STATEMENT WINS. A
 * born-digital PDF — and a scan whose publisher ran real OCR over it, which is
 * what JSTOR ships — carries a text layer with a size on every span. Both
 * numbers above are INFERENCES from a rectangle the model drew; the layer is
 * the page's own record, and where it exists (`TextPdfOptions.layer`) a block
 * is set at the char-weighted median of the spans under its box, a class at
 * the median over its blocks, and the width-fit cap does not touch either —
 * fitting is the squeeze's job, line by line. Measured against one such book,
 * the inferred sizes ran 4–17% small of the layer's and wobbled block to
 * block; the layer's ARE the printed sizes, wobbling only where the printer
 * did.
 *
 * HORIZONTAL COMPRESSION IS THE PRICE OF NOT OWNING THE BOOK'S FACE, and it is
 * paid openly. DejaVu Serif averages 0.536 em a character; the Kershaw page
 * averages about 0.45. Set at the size its leading implies, our type does not
 * fit the column — so each line is squeezed, first by tightening its word spaces
 * and then with `Tz`, down to `TZ_MIN`. Below that the squeeze would be visible
 * as distortion rather than as tight setting, and the block gives up its line
 * count instead: a line-for-line block falls back to wrapping, a wrapped block
 * shrinks, and either way it is reported.
 *
 * A CLASS IS ONE SIZE, MEASURED OVER THE WHOLE DOCUMENT. Body text is one size
 * everywhere, footnotes another, captions another (`sizeClassOf`). Display type
 * — Title, Section-header, and the furniture — is still measured per block,
 * because display type legitimately varies and averaging a chapter opener with a
 * section head flattens the distinction the printer was making. The statistic is
 * the MEDIAN, and it is the median precisely because these are measurements now:
 * a median of measurements is the typical value, where a median of ceilings
 * guaranteed half the book overflowed. A class with fewer than `CLASS_SAMPLES`
 * blocks gets no rule at all — `typography.ts`'s pattern, and its reasoning.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE EMPHASIS IS THE MODEL'S OWN WORD, AND IT IS NOW HONOURED.
 *
 * `dots.ts` hands over the model's markdown, and for a while this file threw the
 * markers away: one face was embedded, bold could not be drawn whatever was done
 * with the asterisks, and `**Führer**` printed as punctuation the page never
 * carried. That reasoning was right about the asterisks and wrong about the
 * remedy — the answer was to embed the faces. `*italic*` is the same class of
 * evidence as the categories and the boxes, and this book's notes are made of it
 * (`Monologe`, `Führerstaat`, `Vierteljahrshefte` — 98 spans in seventeen
 * pages). Thrown away, every book title in every note reads as plain text.
 *
 * FOUR FACES OF DejaVu SERIF, embedded only where used. Roman, italic, bold and
 * bold-italic: the same project, the same licence and the same coverage as the
 * sans face this file used to carry, and a serif is what the books it is pointed
 * at are set in. A face nothing in the book uses is never read off disk.
 *
 * WHAT IS STILL STRIPPED, AND WHY. A Table block's text is the model's own
 * XHTML, and the tags come off: the model reports ONE box round a whole table
 * and never the cells inside it, so there are no column positions to set the
 * cells at, and a table drawn with invented rules would lie about where a number
 * sat. The cell text, separated, is what is certainly true.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * A REFERENCE MARK IS RAISED ONLY WHEN THE PAGE PROVES IT IS ONE.
 *
 * The bank settles how markers arrive, and it is two different ways. In BODY
 * text they are already Unicode superscripts — `on 4 September!¹⁴` — which need
 * no detection and no gate: `¹⁴` is a superscript character, our faces carry the
 * glyphs, and drawing it draws a raised numeral. At the HEAD OF A FOOTNOTE they
 * are sometimes the same (`¹⁴ Institut für Zeitgeschichte`) and sometimes plain
 * digits (`20 *Ibid.*`, `25 See Jochmann`), and a plain digit run is exactly
 * what a year or a page citation looks like.
 *
 * So the gate is EVIDENCE FROM THE SAME PAGE: a footnote's leading digits are
 * raised only when some Text block on that page carries the matching marker as a
 * superscript. `20` at the head of a note on the page whose body says `²⁰` is a
 * reference mark; `1938` at the head of anything is not, because no body block
 * cites `¹⁹³⁸`. Nothing else is touched — a digit run inside a note stays as it
 * was set, because a note full of page numbers is what a note is.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * A PICTURE IS THE ONE THING THAT CANNOT BE SET AS TYPE, so it is the one thing
 * that stays a photograph. Each Picture region is cut out of the scan at the
 * pinned dpi, through the same `crop` seam that cuts pictures into `dots-book`'s
 * EPUBs, and embedded at the rectangle it was printed in. The FULL-PAGE rasters
 * are still thrown away; what survives is the ink that was never words.
 *
 * A PAGE WITH NO READING KEEPS ITS PHOTOGRAPH, AND IS NAMED FOR IT. A page the
 * model could not read, and a page struck out with `--skip-pages`, has no text
 * to set. Stopping the run is wrong — `--skip-pages` exists so a colour card
 * does not cost somebody their book. Emitting a BLANK page is worse: a silent
 * claim that the page was empty, indistinguishable from a leaf that really is,
 * and unnoticeable until somebody looks for what was on it. So the page keeps
 * its own image and every one of them is reported by number.
 *
 * A CHARACTER NO FACE CAN WRITE BECOMES U+FFFD, AND SAYS SO BY NAME. What stays
 * a refusal is SCALE — substitutions past one in a thousand characters are not a
 * glitch, they are a script these faces do not cover, and a book that is mostly
 * replacement characters is not a book (ARCHITECTURE §8).
 */
import * as fs from 'node:fs';

import fontkit from '@pdf-lib/fontkit';
import {
  PDFDocument,
  PDFName,
  TextRenderingMode,
  beginText,
  endText,
  rgb,
  setCharacterSqueeze,
  setFillingRgbColor,
  setFontAndSize,
  setTextMatrix,
  setTextRenderingMode,
  showText,
  type PDFFont,
  type PDFOperator,
  type PDFPage,
} from 'pdf-lib';

import { decodeEntities } from '../epub/xml.js';
import { versionString } from '../version.js';
import type { DotsBox, DotsCategory, Size } from './dots.js';

/**
 * DejaVu Serif, four faces, embedded in the binary as bytes.
 *
 * A UNICODE FONT IS NOT OPTIONAL HERE. pdf-lib's built-in fourteen are WinAnsi
 * and throw on anything outside Latin-1, and the very first page of a real book
 * carries an em dash, a curly quote or a name with an accent in it.
 *
 * SERIF RATHER THAN SANS, WHICH IS A CHANGE. This file used to carry DejaVu Sans
 * alone. The books it is pointed at are set in serif faces, so a sans reprint
 * looked wrong beside its own scan — and it also SET wrong: DejaVu Sans is wider
 * than DejaVu Serif, so the same column held fewer characters and every line
 * needed more squeezing to fit.
 *
 * FOUR FACES BECAUSE THE MODEL REPORTS EMPHASIS and there is no other way to
 * draw it. Italic is not decoration in these books: it is how every book title
 * in every footnote is set. The four together are 1.4 MB of a hundred-megabyte
 * executable, only the faces a book actually uses are ever read off disk, and
 * the SUBSET that reaches the output is only the glyphs that book used.
 *
 * DejaVu specifically because its licence permits redistribution in a binary
 * without conditions anybody has to read (Bitstream Vera; the text ships beside
 * it), and because its coverage is Latin, Greek and Cyrillic — the alphabet set
 * of the books this program is for.
 *
 * `with { type: 'file' }` is the same seam `bridge.ts` uses for `vlm_page.py`:
 * Bun embeds the bytes at compile time and hands back a path that reads back out
 * of the binary's own filesystem.
 */
import FONT_ROMAN from './assets/DejaVuSerif.ttf' with { type: 'file' };
import FONT_ITALIC from './assets/DejaVuSerif-Italic.ttf' with { type: 'file' };
import FONT_BOLD from './assets/DejaVuSerif-Bold.ttf' with { type: 'file' };
import FONT_BOLD_ITALIC from './assets/DejaVuSerif-BoldItalic.ttf' with { type: 'file' };

/** Nothing about the text PDF could be done. Always says which page. */
export class VlmPdfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VlmPdfError';
  }
}

/** Which of the four faces a run of text is set in. */
type FaceKey = 'roman' | 'italic' | 'bold' | 'boldItalic';

const FACE_FILES: Readonly<Record<FaceKey, string>> = {
  roman: FONT_ROMAN,
  italic: FONT_ITALIC,
  bold: FONT_BOLD,
  boldItalic: FONT_BOLD_ITALIC,
};

/**
 * The resource names the faces are registered under, on every page.
 *
 * Fixed rather than randomised so that converting the same book twice produces
 * the same bytes. Nothing can collide with them: every page this file writes is
 * a page this file created.
 */
const FACE_KEYS: Readonly<Record<FaceKey, string>> = {
  roman: 'FoundryRoman',
  italic: 'FoundryItalic',
  bold: 'FoundryBold',
  boldItalic: 'FoundryBoldItalic',
};

/**
 * How far below a line's baseline its descenders reach, in ems.
 *
 * Used to sit a baseline off the bottom of its line's slot, so the ink of a line
 * sits inside the rectangle the words were printed in rather than hanging under
 * it. DejaVu Serif's declared descent is 0.236 em.
 */
const DESCENDER = 0.21;

/** Below this, a box is degenerate rather than small, and text cannot sit in it. */
const MIN_FONT_SIZE = 0.5;

/**
 * The size below which type is present but not readable, in points.
 *
 * Four points is about the smallest a printed footnote is ever set at, so
 * anything under it is evidence about the READING rather than about the book: a
 * box drawn round the wrong region, or a model that answered with a paragraph
 * where the page had a line.
 */
const LEGIBLE_SIZE = 4;

/**
 * A line's height as a multiple of its type size, used ONE way only.
 *
 * It converts a MEASURED leading into the size that leading implies — the
 * ceiling on how big this file will set a class. It is no longer used to lay
 * lines out: the leading a block is actually set on comes from its own box
 * divided by its own line count, which is a measurement rather than a
 * convention, and which is what makes a block fill the rectangle it was printed
 * in. 1.2 is the printer's default and near enough every book's.
 */
const LINE_FACTOR = 1.2;

/**
 * How far a line may be squeezed horizontally before the squeeze is the defect.
 *
 * THE NUMBER THAT DECIDES HOW BIG THE BOOK LOOKS, and the one tolerance in this
 * file worth arguing about. Our face is wider than the faces books are set in —
 * DejaVu Serif averages 0.536 em a character against about 0.45 for the Kershaw
 * page — so type set at the size the book's leading implies does NOT fit the
 * book's column. Something has to give: either the type is set smaller until it
 * fits (which is what this file used to do, and is exactly the "smaller than the
 * scan" complaint), or the line is compressed.
 *
 * 0.82 buys back most of the difference. Eighteen per cent of horizontal
 * compression reads as tight setting rather than as distortion — it is inside
 * the range real condensed faces occupy — and it lets the type be set at very
 * nearly the size the page was printed at. Past it the letterforms start to look
 * squashed rather than narrow, so a line that still does not fit gives up its
 * line count instead and is reported.
 */
const TZ_MIN = 0.82;

/**
 * How far a word space may be tightened before `Tz` is reached for.
 *
 * Squeezing the spaces is free — it is what a compositor does first, it changes
 * no letterform, and a line set with slightly tight spacing is simply a line set
 * tight. So it is spent before any horizontal scaling: a quarter out of every
 * space, and only then is the letterform touched.
 */
const SPACE_SQUEEZE = 0.25;

/**
 * How much of a line may be white space added by justification.
 *
 * A justified line stretches its word gaps by a few per cent. A line needing a
 * third of its width in added space is not being justified, it is a SHORT line
 * being pulled across the measure into something no printer ever set — the last
 * line of a paragraph, or a line the printer ended early. Left ragged, it looks
 * like what it is.
 */
const JUSTIFY_SLACK_LIMIT = 0.25;

/**
 * The band a printed line's height occupies, as a fraction of the page's.
 *
 * The gate that decides whether a block's newlines are the printer's lines or
 * the model's paragraph breaks. On a 2112-pixel page this is 17 to 74 pixels: a
 * printed line at 200 dpi measures 30 to 45, a reflowed paragraph's box divided
 * by its one segment measures 100 to 430, and nothing real sits between. Stated
 * as a fraction of the page so it holds at any dpi and any paper size.
 */
const LINE_BAND = { low: 0.008, high: 0.035 };

/**
 * How far the two line counts may disagree and the newlines still be believed.
 *
 * THE BAND ALONE IS NOT ENOUGH, and a footnote proved it. A block of five NOTES
 * in a 121-point box divides into 24 points a segment, which is inside the band
 * a printed line occupies — so the band said "these are lines" about segments
 * that were each a whole note of four hundred characters. Set line for line,
 * every note became one line and the block came out at 2.75 pt.
 *
 * So the newlines have to survive a SECOND, INDEPENDENT estimate of how many
 * lines the block was printed on: the one solved from its area and the book's
 * own character width, which knows nothing about newlines. When a block's
 * segments really are its lines the two agree exactly — six segments and six
 * lines, fourteen and fourteen, across every line-for-line block in that bank.
 * When the segments are notes they disagree by a factor: five against ten.
 *
 * A fifth is the widest gap that still reads as rounding between two estimates
 * of the same count, and the narrowest that does not start rejecting real
 * line-for-line blocks over one line of slack in a box.
 */
const LINE_COUNT_TOLERANCE = 0.2;

/**
 * How wide a character is, in ems, when the book will not say.
 *
 * Used only to estimate how many lines a REFLOWED block was printed on, and only
 * when the document carries no line-for-line blocks to calibrate against.
 * 0.45 em is about what a Times-like book face averages in running text. When
 * the document does carry line-for-line blocks the number is measured off them
 * instead (`calibrateCharWidth`) and this default is never reached.
 */
const AVG_CHAR_EM = 0.45;

/**
 * Which block's width-fit the class's size is capped by.
 *
 * NOT THE MEDIAN, AND THE ASYMMETRY IS THE POINT. The leading samples are
 * two-sided — a class's typical leading is what is wanted, so the median is
 * right. The width-fit samples are one-sided: each is the largest size at which
 * that block's WIDEST line still fits, so a class set at the median fit leaves
 * half its blocks with a line too wide to set. Those lines then either overrun
 * the column or drag the block out of its line count, and on the first run of
 * this design that is exactly what happened — 76 of 136 blocks fell back and the
 * book came out at 5 pt.
 *
 * A fifth from the bottom leaves four blocks in five fitting outright, and the
 * remainder inside `LINE_OVERRUN`. Lower would start pricing the whole book off
 * its worst boxes again, which is the failure the old low-quantile design had.
 */
const FIT_QUANTILE = 0.2;

/**
 * How much of the class size a line-for-line block may spend to keep its lines.
 *
 * `FIT_QUANTILE` prices the class so four blocks in five fit outright, which
 * means one in five holds a line wider than the class size can set — and a block
 * over that line used to lose its printed lines entirely, re-broken at our own
 * widths in the middle of a page whose neighbours kept theirs. The structure is
 * worth more to a facsimile than the last half-point of uniformity, so such a
 * block now shrinks alone until its widest line fits, down to this floor.
 *
 * The floor is what keeps the one real danger out: a block whose "line" is two
 * printed lines the model glued together arrives asking for HALF the class size,
 * far under any floor a wide line would ever touch. Genuine wide lines cost a
 * few percent; a merged line costs half. Nothing sits near four-fifths from
 * either side, which is why the line is drawn there.
 */
const TRUSTED_SIZE_FLOOR = 0.8;

/**
 * How far a line may overrun its measure after the squeeze is spent.
 *
 * The last resort before a block gives up its printed line count, and it is
 * offered because the two costs are so unequal. Three per cent of a column is a
 * couple of characters reaching into a margin that is many times wider — nobody
 * reading the page would notice. Losing the line count means re-breaking the
 * printer's own lines and setting the block smaller, which changes the texture
 * of the page and shows up immediately beside the scan.
 */
const LINE_OVERRUN = 0.03;

/** How many blocks a class needs before its size is measured over the class. */
const CLASS_SAMPLES = 8;

/**
 * The least leading a truth-sized block may be set on, as a multiple of its
 * size — the point where spending leading stops and shrinking starts again.
 *
 * `LINE_FACTOR`'s 1.2 is the printer's convention; 1.05 is five per cent of
 * air left between one line's descenders and the next line's ascenders.
 * Between the two, a wrap that came out a line long keeps the printed SIZE —
 * the thing the eye actually reads — and pays in tightness, which is how the
 * page itself absorbs a long paragraph. Below it the glyphs would start to
 * touch, and no printed page does that.
 */
const LEADING_FLOOR = 1.05;

/** A paragraph's first-line indent, in ems. The printer's default. */
const INDENT_EM = 1;

/** How far a block's centre may sit from the body column's, as a page fraction. */
const CENTRE_TOLERANCE = 0.02;

/** How wide a block may be, against the body column, and still be centred. */
const CENTRE_MAX_WIDTH = 0.8;

/** A raised reference mark: its size, and how far its baseline lifts, in ems. */
const SUPER_SCALE = 0.62;
const SUPER_RISE = 0.34;

/** A footnote's leading reference mark, plain or already raised. */
const FOOTNOTE_MARKER = /^((?:[⁰¹²³⁴-⁹]+|\d{1,3})[.)]?)\s+/u;

/** The superscript digits, and their plain equivalents, for the marker gate. */
const SUPERSCRIPT_DIGITS = '⁰¹²³⁴⁵⁶⁷⁸⁹';

/** What ends a sentence, and what opens one — the indent rule's evidence. */
const ENDS_SENTENCE = /[.!?][)\]"'”’»]*$/u;
const OPENS_SENTENCE = /^[("'“‘«[]?[A-Z0-9\p{Lu}]/u;

/**
 * What an unwritable character becomes: U+FFFD, the replacement character.
 *
 * Saying "something was here" is its entire job in Unicode, and every DejaVu
 * face carries its glyph — checked once at embed time, because a substitute the
 * font also cannot write would be this mechanism eating itself.
 */
const REPLACEMENT = '�';
const REPLACEMENT_CODE = 0xfffd;

/**
 * Where substitution stops being a repair and becomes a refusal.
 *
 * One character in a thousand is a model glitch — a hallucinated CJK glyph in an
 * English book, once — and the book should not be held hostage to it. Past that
 * ratio the faces do not cover the book's SCRIPT, and substituting on would
 * produce a book that is mostly holes while reporting success (§8). The floor
 * keeps a tiny run honest: a handful of characters is noise, not evidence.
 */
const SUBSTITUTION_RATIO = 1 / 1000;
const SUBSTITUTION_FLOOR = 10;

/**
 * How far the render may disagree with the page it is supposed to be of.
 *
 * Renders are made at a pinned 200 dpi off the page's own display box, so the
 * points-per-pixel this file recomputes should land on 72/200 to within whatever
 * the rasteriser rounded. Two per cent is orders of magnitude more than that
 * rounding and far less than any real mismatch — a render of the wrong page, a
 * dpi that moved — each of which puts every line somewhere it does not belong.
 */
const SCALE_TOLERANCE = 0.02;

// ── geometry ────────────────────────────────────────────────────────────────

/** A rectangle in PDF user space: points, y up. */
export interface PdfRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Everything about one source page that decides where a box lands.
 *
 * `crop` is the page's CropBox — what a viewer shows and what the rasteriser
 * rendered — in the page's UNROTATED user space. `rotation` is the page's own
 * /Rotate. `render` is the pixel size of the image the model was looking at.
 */
export interface PageFrame {
  crop: PdfRect;
  /** 0, 90, 180 or 270. Anything else is refused before a frame is built. */
  rotation: number;
  render: Size;
}

/** A source page's shape, before anything is known about how it was rendered. */
type PageGeometry = Pick<PageFrame, 'crop' | 'rotation'>;

/**
 * The page AS DISPLAYED, in points: a quarter turn swaps the sides.
 *
 * This is the frame the render is of, and — since this file makes new paper
 * rather than writing on the old — it is also the size of the page that comes
 * out. PyMuPDF applies /Rotate when it rasterises, so a 90°-rotated portrait
 * page arrives as a landscape image and every box is in that landscape frame.
 *
 * THE OUTPUT PAGE IS THE DISPLAY FRAME, WHICH IS WHY THIS FILE TRANSFORMS
 * NOTHING. The overlay had to push a matrix in front of every line to carry the
 * CropBox's offset and the page's /Rotate back into the original page's
 * coordinates, because it drew onto that page. A new page created at this size,
 * at the origin, with no /Rotate of its own IS display space.
 */
export function displaySize(frame: PageGeometry): Size {
  const quarterTurn = frame.rotation === 90 || frame.rotation === 270;
  return quarterTurn
    ? { width: frame.crop.height, height: frame.crop.width }
    : { width: frame.crop.width, height: frame.crop.height };
}

/** Points per render pixel, one per axis. Both should be 72/dpi. */
export function pointsPerPixel(frame: PageFrame): { x: number; y: number } {
  const display = displaySize(frame);
  return { x: display.width / frame.render.width, y: display.height / frame.render.height };
}

/**
 * A block's box, from the render's pixels into the output page's points.
 *
 * The two frames disagree about y: an image counts rows DOWN from the top and
 * PDF user space counts up from the bottom, so the box's top edge in pixels is
 * its `y + height` here and its bottom edge is `y`. Getting this backwards puts
 * every line of a book on the mirror image of the page it belongs to.
 */
export function boxToDisplay(box: DotsBox, frame: PageFrame): PdfRect {
  const scale = pointsPerPixel(frame);
  const display = displaySize(frame);
  const left = box.x1 * scale.x;
  const right = box.x2 * scale.x;
  const top = display.height - box.y1 * scale.y;
  const bottom = display.height - box.y2 * scale.y;
  return { x: left, y: bottom, width: right - left, height: top - bottom };
}

// ── the pages, as this format sees them ─────────────────────────────────────

/** One recognised block: where it was, what kind of thing it was, what it said. */
export interface PdfTextBlock {
  /** In the RENDER's pixel frame, top-down — what `parseDotsPage` hands out. */
  box: DotsBox;
  /**
   * The model's own category. Two distinctions are made from it — a `Picture` is
   * cut out of the scan, and a class decides the size — but the whole category
   * is carried, because a report saying "3 Picture blocks" is checkable against
   * the page and "3 images" is not.
   */
  category: DotsCategory;
  /** The model's own text, verbatim: markdown emphasis and newlines included. */
  text: string;
}

export interface PdfTextPage {
  /** 1-based, the PDF's own numbering. */
  page: number;
  /** The render the boxes are measured in, in pixels. */
  render: Size;
  blocks: readonly PdfTextBlock[];
}

/** One region of one page's scan to cut out, in render pixels. `DotsCrop`. */
export interface PdfCropRequest {
  page: number;
  box: DotsBox;
  /** The file name it comes back under, with no directory in it. */
  name: string;
}

/** What came back. `DotsCropped`, so `convert.ts`'s existing seam fits it. */
export interface PdfCropped {
  name: string;
  mediaType: string;
  data: Uint8Array;
}

/**
 * One piece of type the source PDF itself reports — `VlmLayerSpan`, shaped
 * here so this file keeps taking seams rather than importing the bridge.
 *
 * `x`/`y` are the span's centre on the displayed page in POINTS, top-left
 * origin — the frame the renders are made in, so a span lands inside a block's
 * box under nothing more than the dpi scale. `size` is the font size in
 * points, and points are frame-independent: whatever the render's resolution,
 * the size the layer states is the size to set. `chars` is how much text the
 * span carries, kept so a median over a block can be WEIGHTED by it — a
 * two-character superscript must not outvote the paragraph it annotates.
 */
export interface PdfLayerSpan {
  x: number;
  y: number;
  size: number;
  chars: number;
}

export interface TextPdfOptions {
  /** The original PDF. Read for page geometry and metadata; never written. */
  pdfBytes: Uint8Array;
  /** The dpi the renders were made at — `VLM_DPI`, and the frame check's expectation. */
  dpi: number;
  /** The pages that were read, in any order. A page not here keeps its photograph. */
  pages: readonly PdfTextPage[];
  /**
   * Cut these regions out of the scan, as PNG, at `dpi`.
   *
   * The seam rather than the implementation, for the same reason `dots-book.ts`
   * takes one: cutting a picture out means a Python with PyMuPDF in it. Every
   * request this file will make is made in ONE call, so the subprocess is
   * spawned once for the whole book however many pictures are in it.
   */
  crop: (requests: readonly PdfCropRequest[]) => Promise<readonly PdfCropped[]>;
  /**
   * The source's own text layer, keyed by page — the book's THIRD statement
   * of its size, and the only one made in points by whoever set the page.
   *
   * A born-digital PDF, and a scan a publisher ran real OCR over (JSTOR ships
   * exactly this), records a size for every run of type it carries. Where a
   * block of the reading has such spans under its box, that size wins over
   * everything solved from the box: the leading and the width-fit are both
   * INFERENCES from a rectangle the model drew, and each carries the model's
   * generosity and our face's width inside it, where the layer carries
   * neither. Measured against one such book, the inferred sizes ran 4–17%
   * small and wobbled per block; the layer's are the printed sizes.
   *
   * Absent — a pure scan, or a caller that did not ask — nothing changes:
   * the measured sizes stand, as they always did. Absence of evidence, not a
   * fallback (`typography.ts`'s pattern).
   */
  layer?: ReadonlyMap<number, readonly PdfLayerSpan[]>;
}

export interface TextPdfResult {
  bytes: Uint8Array;
  /**
   * How long the document took, under the name `packageVlmEpub` gives the same
   * phase. This one is a typesetting rather than a zip or a render, and the
   * run's phase line says which of the three it was (`convert.ts`).
   */
  zipSeconds: number;
  /** Pages that came out as real type. */
  textPages: number;
  /** Lines of type set, over the whole book. */
  lines: number;
  /** Picture regions cut out of the scan and placed where they were printed. */
  pictures: number;
  /**
   * Pages that had no reading and kept their photograph instead, ascending.
   *
   * By NUMBER rather than counted, because the number is the value of the
   * report: "pages 4, 5 and 87" is an instruction and "3 pages" is a statistic.
   */
  facsimilePages: number[];
  /** The size each class was set at, in points. A class not measured is absent. */
  classSizes: Record<string, number>;
  /**
   * Blocks whose size came straight from the source's own text layer, out of
   * the blocks set at all. Zero-of-N for a pure scan, and the report says so:
   * how much of the book's sizing is the publisher's own statement is the
   * first thing to know about why a facsimile looks right or wrong.
   */
  layerSized: { blocks: number; of: number };
  /**
   * How the book's lines were decided — the single most useful number about a
   * facsimile, because it says how much of it is the printer's own setting.
   */
  lineForLine: {
    /** Blocks whose printed lines the model kept, and which were set line for line. */
    blocks: number;
    /** Blocks whose newlines could not be believed, and which were wrapped. */
    wrapped: number;
    /** Lines set from the printer's own breaks. */
    lines: number;
  };
  /** Emphasis spans set in a real italic or bold face. */
  emphasis: number;
  /** Footnote reference marks raised, having been proved to be marks. */
  superscripts: number;
  /**
   * Lines the squeeze could not fit, or null when every line took its measure.
   *
   * Reported rather than refused: one over-drawn box is not worth a book. Each
   * of these is a block that gave up its printed line count or its class size.
   */
  cramped: {
    /** Blocks set smaller than their class, or that fell back from line-for-line. */
    count: number;
    /** Of those, the ones that ended below `LEGIBLE_SIZE`. */
    illegible: number;
    /** The smallest size any of them came out at, in points. */
    smallest: number;
    /** Which pages they are on, ascending. */
    pages: number[];
  } | null;
  /**
   * Characters no face could write, each replaced with U+FFFD — or null when
   * every character went down as itself.
   */
  substituted: {
    count: number;
    characters: { char: string; code: number; count: number; pages: number[] }[];
  } | null;
}

/** The running tally the pages write substitutions into as they are set. */
interface SubstitutionTally {
  chars: number;
  perChar: Map<string, { code: number; count: number; pages: Set<number> }>;
}

/** The running tally of blocks that could not be set as their class asks. */
interface CrampedTally {
  count: number;
  illegible: number;
  smallest: number;
  pages: Set<number>;
}

/**
 * The classes whose size is decided once for the whole book.
 *
 * Each is a thing a printer sizes DELIBERATELY and uniformly: body text is the
 * measure everything else is relative to, notes smaller, captions smaller again,
 * a block quotation a shade down. NOT here: display type, because a chapter
 * opener is meant to be bigger than a section head; and `Table`, `Formula` and
 * `Picture`, because a box round one of those is not a box round a line of type.
 *
 * The same split, and the same reasoning, as `typography.ts`'s `CALIBRATED`.
 */
type SizeClass = 'body' | 'quote' | 'footnote' | 'caption';

function sizeClassOf(category: DotsCategory): SizeClass | null {
  switch (category) {
    case 'Text':
    case 'List-item':
      return 'body';
    case 'Quote':
      return 'quote';
    case 'Footnote':
      return 'footnote';
    case 'Caption':
      return 'caption';
    default:
      return null;
  }
}

/** Which classes are set justified. Display type and tables never are. */
const JUSTIFIED: ReadonlySet<SizeClass> = new Set<SizeClass>(['body', 'quote', 'footnote']);

// ── the words, and the faces they are set in ────────────────────────────────

/**
 * A run of characters in one face, at one height.
 *
 * The unit everything below measures and draws. A word is a list of these rather
 * than a string, because a face can change inside a word — `*Ibid.*,` is an
 * italic `Ibid.` and a roman comma, and the model writes exactly that.
 */
interface Piece {
  text: string;
  face: FaceKey;
  /** A raised reference mark: set at `SUPER_SCALE` and lifted `SUPER_RISE`. */
  raised: boolean;
}

/** One word: its pieces, and the space that followed it in the source. */
interface Word {
  pieces: Piece[];
  /** Kept inside the last piece when the line continues, so a copy has spaces. */
  spaced: boolean;
}

/** One output line: its words, and whether it ends the block. */
interface Line {
  words: Word[];
  last: boolean;
}

/**
 * The faces this document actually uses, embedded and named.
 *
 * Only the ones a book reaches for are read off disk and embedded — a book with
 * no bold in it pays nothing for the bold face. `roman` is always present: it is
 * what everything falls back to, and a page with no emphasis on it is still set
 * in something.
 */
interface FaceSet {
  fonts: Map<FaceKey, PDFFont>;
  covered: Set<number>;
}

function fontFor(faces: FaceSet, face: FaceKey): PDFFont {
  return faces.fonts.get(face) ?? faces.fonts.get('roman')!;
}

function faceKeyFor(faces: FaceSet, face: FaceKey): string {
  return faces.fonts.has(face) ? FACE_KEYS[face] : FACE_KEYS.roman;
}

/** What a piece measures at a given size, in points. */
function pieceWidth(piece: Piece, size: number, faces: FaceSet): number {
  const font = fontFor(faces, piece.face);
  return font.widthOfTextAtSize(piece.text, piece.raised ? size * SUPER_SCALE : size);
}

function wordWidth(word: Word, size: number, faces: FaceSet): number {
  return word.pieces.reduce((sum, piece) => sum + pieceWidth(piece, size, faces), 0);
}

/** A line's words at their natural widths, with no gaps between them. */
function inkWidth(words: readonly Word[], size: number, faces: FaceSet): number {
  return words.reduce((sum, word) => sum + wordWidth(word, size, faces), 0);
}

function spaceWidth(size: number, faces: FaceSet): number {
  return fontFor(faces, 'roman').widthOfTextAtSize(' ', size);
}

// ── the document ────────────────────────────────────────────────────────────

/**
 * The book, set as type on new paper, one page per page of the scan.
 *
 * PAGE-FOR-PAGE WITH THE INPUT, WITHOUT EXCEPTION. Every page of the source
 * document becomes a page of the output at the size it was displayed at, whether
 * it was read, skipped or unreadable — because the promise this format makes is
 * that page 142 is page 142, and a document that quietly dropped the leaves
 * nobody could read would break that promise in the one way nothing downstream
 * could detect. A reading for a page the document does not have is a different
 * matter and stops the run: it means the readings and the PDF are not about the
 * same document, and every box in the book is then suspect.
 */
export async function buildTextPdf(opts: TextPdfOptions): Promise<TextPdfResult> {
  const started = Date.now();

  let source: PDFDocument;
  try {
    /*
     * `updateMetadata: false`, deliberately.
     *
     * Nothing is written back to this document — it is opened to be measured —
     * and pdf-lib otherwise stamps its own Producer and a fresh ModDate over the
     * document's the moment it is loaded. The scan is the evidence this whole
     * mode is derived from, and a library quietly signing it on the way past is
     * not a cosmetic difference.
     */
    source = await PDFDocument.load(opts.pdfBytes, { updateMetadata: false });
  } catch (err) {
    throw new VlmPdfError(
      'the PDF could not be opened to measure its pages '
      + `(${err instanceof Error ? err.message : String(err)}). The pages were read from it, so `
      + 'what stopped this is the file\'s structure rather than its content — an encrypted '
      + 'document is the usual answer.',
    );
  }

  const pageCount = source.getPageCount();
  const readings = new Map<number, PdfTextPage>();
  for (const reading of opts.pages) {
    if (reading.page < 1 || reading.page > pageCount) {
      throw new VlmPdfError(
        `there is a reading for page ${reading.page} and the PDF has ${pageCount} page(s), so the `
        + 'readings and this document are not about the same file. Nothing is skipped over that: '
        + 'if one page number is wrong, every box in the book is in doubt.',
      );
    }
    readings.set(reading.page, reading);
  }

  /*
   * EVERY PAGE'S SHAPE, MEASURED AND CHECKED BEFORE ANYTHING IS DRAWN.
   *
   * One pass over the whole document rather than page by page as the pages are
   * built, because both things that can be wrong here are refusals: an angle
   * this file cannot honour, and a render that is not of the page it claims. A
   * refusal after two hundred pages have been typeset costs the run everything —
   * and worse, it arrives after the crops below have spawned a subprocess to cut
   * up a scan this run was never going to finish.
   */
  const geometry: PageGeometry[] = [];
  for (let index = 0; index < pageCount; index += 1) {
    const shape = geometryOf(source.getPage(index), index + 1);
    geometry.push(shape);
    const reading = readings.get(index + 1);
    if (reading !== undefined) checkScale({ ...shape, render: reading.render }, index + 1, opts.dpi);
  }

  /*
   * WHAT HAS TO BE CUT OUT OF THE SCAN, ASKED FOR ONCE.
   *
   * Both kinds of image are gathered before a page is built and fetched in a
   * single call: cutting a region out means a Python subprocess (`bridge.ts`),
   * and a book with ninety plates should pay for one of those rather than ninety.
   */
  const requests: PdfCropRequest[] = [];
  const facsimilePages: number[] = [];
  for (let number = 1; number <= pageCount; number += 1) {
    const reading = readings.get(number);
    if (reading === undefined) {
      facsimilePages.push(number);
      /*
       * The whole page, in the render's own pixels. Derived from the display
       * size and the dpi rather than read off a render, because this is exactly
       * the page nobody rendered for a reading — a `--skip-pages` leaf was never
       * offered to the model at all — and the crop seam re-renders from the PDF.
       * The Python side clips the box to the page, so a rounding of half a pixel
       * cannot ask for paper that is not there.
       */
      const display = displaySize(geometry[number - 1]);
      requests.push({
        page: number,
        box: {
          x1: 0,
          y1: 0,
          x2: (display.width * opts.dpi) / 72,
          y2: (display.height * opts.dpi) / 72,
        },
        name: `page-${String(number).padStart(4, '0')}-whole.png`,
      });
      continue;
    }
    for (const [index, block] of reading.blocks.entries()) {
      if (block.category !== 'Picture') continue;
      requests.push({
        page: number,
        box: block.box,
        name: `page-${String(number).padStart(4, '0')}-${String(index).padStart(3, '0')}.png`,
      });
    }
  }

  const cropped = await opts.crop(requests);
  const images = new Map(cropped.map((image) => [image.name, image]));

  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const faces = await embedFaces(doc, opts.pages);
  if (!faces.covered.has(REPLACEMENT_CODE)) {
    // Unreachable with DejaVu, which carries U+FFFD in every face. Here so a
    // future font swap cannot leave the substitute itself unwritable.
    throw new VlmPdfError('the book\'s font has no glyph for U+FFFD, its own substitute.');
  }
  carryMetadata(source, doc);

  let lines = 0;
  let textPages = 0;
  let pictures = 0;
  const tally: SubstitutionTally = { chars: 0, perChar: new Map() };
  const cramped: CrampedTally = {
    count: 0,
    illegible: 0,
    smallest: Number.POSITIVE_INFINITY,
    pages: new Set(),
  };

  /*
   * MEASURE THE WHOLE BOOK, THEN SET IT. A class's size is a fact about every
   * block in the document, so nothing can be drawn until everything has been
   * measured. This is also where the substitution tally is filled, once, off the
   * same text the drawing pass will use.
   */
  const planned = planBlocks(opts.pages, geometry, faces, tally, opts.dpi, opts.layer);
  const sizes = classSizes(planned);

  for (let number = 1; number <= pageCount; number += 1) {
    const display = displaySize(geometry[number - 1]);
    const page = doc.addPage([display.width, display.height]);
    const reading = readings.get(number);

    if (reading === undefined) {
      /*
       * The photograph, filling the page it is a photograph of. No white behind
       * it: a full-page render is opaque over every point of the paper, and a
       * rectangle underneath would be a hundred bytes a page saying something
       * already true.
       */
      const whole = images.get(`page-${String(number).padStart(4, '0')}-whole.png`);
      if (whole === undefined) {
        throw new VlmPdfError(
          `page ${number} has no reading, so the only thing that can stand for it is a picture of `
          + 'it — and nothing came back from cutting the page out of the scan. The alternative is a '
          + 'blank page, which is a claim that the leaf was empty, and this run cannot make it.',
        );
      }
      page.drawImage(await doc.embedPng(whole.data), {
        x: 0,
        y: 0,
        width: display.width,
        height: display.height,
      });
      continue;
    }

    /*
     * THE PAPER, PAINTED RATHER THAN ASSUMED. A PDF page with nothing on it has
     * no colour — it is white because viewers paint white, which is a convention
     * every one of them shares and none of them promises. Black type on an
     * unstated background is the one way this document could arrive unreadable
     * at a reader that decided otherwise, and one rectangle a page closes it.
     */
    page.drawRectangle({
      x: 0,
      y: 0,
      width: display.width,
      height: display.height,
      color: rgb(1, 1, 1),
    });

    const frame: PageFrame = { ...geometry[number - 1], render: reading.render };

    /*
     * The pictures first, then the type over them — in that order and not the
     * model's, because a caption the printer set INSIDE a plate's bounds would
     * otherwise be painted over by the plate. Ordinary pages do not overlap at
     * all and the order costs them nothing.
     */
    for (const [index, block] of reading.blocks.entries()) {
      if (block.category !== 'Picture') continue;
      const image = images.get(
        `page-${String(number).padStart(4, '0')}-${String(index).padStart(3, '0')}.png`,
      );
      if (image === undefined) {
        throw new VlmPdfError(
          `page ${number} has a Picture block that could not be cut out of the scan. A picture is `
          + 'the one thing on a page that cannot be set as type, so there is nothing to put in its '
          + 'place, and a book quietly missing its plates is not the book that was asked for.',
        );
      }
      const rect = boxToDisplay(block.box, frame);
      if (rect.width <= 0 || rect.height <= 0) continue;
      page.drawImage(await doc.embedPng(image.data), {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      });
      pictures += 1;
    }

    const drawn = drawPage(planned.filter((block) => block.page === number), sizes, faces, cramped);
    if (drawn.lines > 0) {
      for (const [face, font] of faces.fonts) {
        page.node.setFontDictionary(PDFName.of(FACE_KEYS[face]), font.ref);
      }
      page.pushOperators(...drawn.operators);
      textPages += 1;
      lines += drawn.lines;
    }
  }

  const substituted = closeTally(tally);
  const lineForLine = {
    blocks: planned.filter((block) => block.trusted).length,
    wrapped: planned.filter((block) => !block.trusted).length,
    lines: planned.filter((block) => block.trusted).reduce((sum, block) => sum + block.lines, 0),
  };

  const bytes = await doc.save();
  return {
    bytes,
    zipSeconds: (Date.now() - started) / 1000,
    textPages,
    lines,
    pictures,
    facsimilePages,
    classSizes: Object.fromEntries(sizes),
    layerSized: {
      blocks: planned.filter((block) => block.truthPt !== null).length,
      of: planned.length,
    },
    lineForLine,
    emphasis: planned.reduce((sum, block) => sum + block.emphasis, 0),
    superscripts: planned.reduce((sum, block) => sum + block.superscripts, 0),
    cramped: cramped.count === 0
      ? null
      : {
        count: cramped.count,
        illegible: cramped.illegible,
        smallest: cramped.smallest,
        pages: [...cramped.pages].sort((a, b) => a - b),
      },
    substituted,
  };
}

/**
 * The faces this book needs, embedded — and no others.
 *
 * The document is scanned for emphasis markers BEFORE anything is embedded,
 * because the answer decides which files are read off disk. Roman is
 * unconditional; the other three are read only if some block asks for them. A
 * book of plain prose therefore carries one 380 KB face and not four.
 *
 * `subset: true` on all of them: what reaches the output is the glyphs this book
 * used, not the three and a half thousand each face knows.
 */
async function embedFaces(doc: PDFDocument, pages: readonly PdfTextPage[]): Promise<FaceSet> {
  const wanted = new Set<FaceKey>(['roman']);
  for (const page of pages) {
    for (const block of page.blocks) {
      if (block.category === 'Picture') continue;
      if (/\*\*[^*\n]|__[^_\n]/.test(block.text)) wanted.add('bold');
      if (/\*[^*\n]|_[^_\n]/.test(block.text)) wanted.add('italic');
    }
  }
  // Bold-italic only where both are in play at all; `emphasise` falls back to
  // whichever single face IS embedded when the pair never occurs together.
  if (wanted.has('bold') && wanted.has('italic')) wanted.add('boldItalic');

  const fonts = new Map<FaceKey, PDFFont>();
  const covered = new Set<number>();
  for (const face of ['roman', 'italic', 'bold', 'boldItalic'] as const) {
    if (!wanted.has(face)) continue;
    const font = await doc.embedFont(fs.readFileSync(FACE_FILES[face]), { subset: true });
    fonts.set(face, font);
    for (const code of font.getCharacterSet()) covered.add(code);
  }
  return { fonts, covered };
}

/**
 * The document's own title and author, carried onto the document made from it.
 *
 * COPIED WHERE THEY EXIST AND NEVER INVENTED, which is the rule `convert.ts`
 * follows for the EPUB's `dc:title`. A scan usually carries nothing, and an
 * empty title written into the new file would be a claim that the book has none,
 * where absence is the honest answer. Nothing is derived from the filename here:
 * `convert.ts` knows the path and this file does not.
 *
 * The Producer IS foundry, uniquely in this program, and says so. Every other
 * emitter hands back a document somebody else made; this one made the document.
 */
function carryMetadata(source: PDFDocument, doc: PDFDocument): void {
  const title = source.getTitle();
  if (title !== undefined && title.trim().length > 0) doc.setTitle(title);
  const author = source.getAuthor();
  if (author !== undefined && author.trim().length > 0) doc.setAuthor(author);
  doc.setProducer(`foundry ${versionString()}`);
  doc.setCreator(`foundry ${versionString()}`);
}

/**
 * The tally, judged and folded into the report — or the run stopped.
 *
 * The judgement happens HERE, over the whole book, rather than at the first bad
 * character, because one character cannot tell a glitch from a script: only the
 * ratio can. Nothing has been written yet, so a refusal here costs time only.
 */
function closeTally(tally: SubstitutionTally): TextPdfResult['substituted'] {
  if (tally.perChar.size === 0) return null;
  const characters = [...tally.perChar.entries()]
    .map(([char, entry]) => ({
      char,
      code: entry.code,
      count: entry.count,
      pages: [...entry.pages].sort((a, b) => a - b),
    }))
    .sort((a, b) => b.count - a.count);
  const count = characters.reduce((sum, entry) => sum + entry.count, 0);

  const allowed = Math.max(SUBSTITUTION_FLOOR, tally.chars * SUBSTITUTION_RATIO);
  if (count > allowed) {
    const named = characters.slice(0, 8)
      .map((entry) => `${JSON.stringify(entry.char)} (U+${hex(entry.code)}, ×${entry.count})`)
      .join(', ');
    throw new VlmPdfError(
      `${count} of the ${tally.chars} characters in this book have no glyph in the book's faces — `
      + `${named}${characters.length > 8 ? ', and more' : ''}. One stray character is a model `
      + 'glitch and is replaced with U+FFFD by name, but at this scale the faces do not cover the '
      + 'book\'s script, and every page would come out mostly replacement characters while the run '
      + 'reported success. The faces are DejaVu Serif (src/vlm/assets); a book in a script they do '
      + 'not cover needs faces that do.',
    );
  }
  return { count, characters };
}

function hex(code: number): string {
  return code.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * One source page's shape, and a refusal where it cannot be honoured.
 *
 * /Rotate is READ rather than assumed. A quarter turn decides which way round
 * the new page is made; anything else — the arbitrary angles a malformed file
 * can carry — is refused by name, because the alternative is a page of type set
 * at an angle to the paper it belongs on.
 */
function geometryOf(page: PDFPage, number: number): PageGeometry {
  const crop = page.getCropBox();
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;
  if (rotation % 90 !== 0) {
    throw new VlmPdfError(
      `page ${number} is rotated by ${page.getRotation().angle}°, which is not a quarter turn. `
      + 'The book is set by transforming the render\'s frame into the page\'s, and that transform '
      + 'is only exact for 0, 90, 180 and 270 — an approximation here would put every line on the '
      + 'page slightly askew.',
    );
  }
  if (crop.width <= 0 || crop.height <= 0) {
    throw new VlmPdfError(
      `page ${number} has a ${crop.width}×${crop.height} pt crop box, so there is no page for the `
      + 'text to be set on.',
    );
  }
  return { crop, rotation };
}

/**
 * Is this render a render of THIS page?
 *
 * The one observable that says so. Renders are pinned at 200 dpi off the page's
 * display box (ARCHITECTURE §5), so the points per pixel this recomputes has
 * exactly one right answer, and a wrong one is not a small error — it is the
 * whole page scaled off the paper. Checked per axis, because a mismatch only one
 * axis sees is a rotation this file got wrong.
 */
function checkScale(frame: PageFrame, number: number, dpi: number): void {
  if (frame.render.width <= 0 || frame.render.height <= 0) {
    throw new VlmPdfError(
      `page ${number} was rendered ${frame.render.width}×${frame.render.height}, and the model's `
      + 'boxes are measured in that render.',
    );
  }
  const expected = 72 / dpi;
  const scale = pointsPerPixel(frame);
  for (const [axis, measured] of [['width', scale.x], ['height', scale.y]] as const) {
    if (Math.abs(measured / expected - 1) <= SCALE_TOLERANCE) continue;
    const display = displaySize(frame);
    throw new VlmPdfError(
      `page ${number}'s render is ${frame.render.width}×${frame.render.height} px for a `
      + `${display.width.toFixed(1)}×${display.height.toFixed(1)} pt page, which is `
      + `${(72 / measured).toFixed(1)} dpi across its ${axis} and not the ${dpi} every render is `
      + 'made at. The boxes are measured in that render, so text placed from it would be wrong by '
      + 'that ratio on every line of the page.',
    );
  }
}

// ── reading a block into words ──────────────────────────────────────────────

/**
 * A Table's markup flattened to text, BEFORE the block is split into lines.
 *
 * THE ORDER MATTERS AND IT USED TO BE WRONG. This ran per line, inside the
 * emphasis parser, so the newline it puts in place of a row break arrived after
 * the block had already been divided on newlines — and got drawn as a glyph. A
 * table came out with a stray mark where its row ended. Flattening first means
 * the row break is a line break like any other by the time anything reads it.
 *
 * The tags come off because the model reports ONE box round the whole table and
 * never the cells inside it: there are no column positions to set cells at, and
 * a table drawn with invented rules would lie about where a number sat. The cell
 * text, separated, is what is certainly true. Stripping with a pattern rather
 * than a parser is sound precisely because `checkTableHtml` already refused the
 * page if the fragment was not well-formed — a stray `<` cannot reach here.
 */
function flattenTable(text: string, category: DotsCategory): string {
  if (category !== 'Table') return text;
  return decodeEntities(text.replace(/<\/tr\s*>/gi, '\n').replace(/<[^>]*>/g, ' '));
}

/**
 * A block's text turned into pieces, with the model's emphasis honoured.
 *
 * `**bold**`, `*italic*`, `__bold__`, `_italic_` — the markers are the model's
 * report of how the page was set, and they come off the text and onto the FACE
 * rather than being printed. Anchored on non-space so that a lone asterisk the
 * page really printed, or a mid-word underscore in a file name, is left where it
 * is: `*` with a space after it is a bullet, not an emphasis.
 *
 * A TABLE IS FLATTENED FIRST. Its text is the model's own validated XHTML, and
 * the tags come off because the model reports one box round the whole table and
 * never the cells inside it — so there are no column positions to set cells at,
 * and a table drawn with invented rules would lie about where a number sat. A
 * row break becomes a line break, which is the one piece of a table's shape this
 * format can honour. Stripping with a pattern rather than a parser is sound
 * precisely because `checkTableHtml` already refused the page if the fragment
 * was not well-formed: a stray `<` cannot reach here.
 */
function readPieces(text: string): { pieces: Piece[]; spans: number } {
  const source = text;
  const pieces: Piece[] = [];
  let spans = 0;
  let face: FaceKey = 'roman';
  let index = 0;
  let plain = '';

  const flush = (): void => {
    if (plain.length > 0) pieces.push({ text: plain, face, raised: false });
    plain = '';
  };

  while (index < source.length) {
    const rest = source.slice(index);
    const strong = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest);
    const light = /^([*_])(?=\S)([^*_\n]*?\S)\1/.exec(rest);
    const match = strong ?? light;
    if (match !== null) {
      flush();
      const bold = match[1].length === 2;
      const inner: FaceKey = face === 'roman'
        ? (bold ? 'bold' : 'italic')
        : 'boldItalic';
      const outer: FaceKey = face;
      face = inner;
      spans += 1;
      // Nested emphasis is one level deep in practice; recursing keeps a
      // `**bold with *italic* inside**` from printing its inner markers.
      const nested = readPieces(match[2]);
      for (const piece of nested.pieces) {
        pieces.push({ ...piece, face: piece.face === 'roman' ? inner : 'boldItalic' });
      }
      spans += nested.spans;
      face = outer;
      index += match[0].length;
      continue;
    }
    plain += source[index];
    index += 1;
  }
  flush();
  return { pieces: pieces.filter((piece) => piece.text.length > 0), spans };
}

/**
 * A footnote's leading digits, raised — but only where the page proves they are
 * a reference mark.
 *
 * THE GATE IS THE SAME PAGE'S BODY TEXT. A note opening `20` on a page whose
 * prose carries `²⁰` is a note numbered twenty; `1938` at the head of anything
 * is a year, because no body block on any page cites `¹⁹³⁸`. Marks that arrive
 * already raised — which is how this dialect reports most of them — need no gate
 * and no change: `¹⁴` is a superscript character and drawing it draws one.
 *
 * Nothing inside a note is touched. A note full of page numbers is what a note
 * is, and raising the second number in `158–60` would be this rule inventing a
 * reference the page never made.
 */
function raiseMarker(pieces: Piece[], marks: ReadonlySet<string>): { pieces: Piece[]; raised: number } {
  const first = pieces[0];
  if (first === undefined) return { pieces, raised: 0 };
  const match = FOOTNOTE_MARKER.exec(first.text);
  if (match === null) return { pieces, raised: 0 };
  const mark = match[1].replace(/[.)]$/, '');
  // Already a superscript character: the glyph is the raised one, nothing to do.
  if ([...mark].every((ch) => SUPERSCRIPT_DIGITS.includes(ch))) return { pieces, raised: 0 };
  if (!marks.has(mark)) return { pieces, raised: 0 };
  return {
    pieces: [
      { text: mark, face: first.face, raised: true },
      { text: first.text.slice(match[1].length), face: first.face, raised: false },
      ...pieces.slice(1),
    ].filter((piece) => piece.text.length > 0),
    raised: 1,
  };
}

/** Every reference mark this page's prose cites, as plain digits. */
function marksOnPage(page: PdfTextPage): Set<string> {
  const marks = new Set<string>();
  for (const block of page.blocks) {
    if (block.category === 'Picture' || block.category === 'Footnote') continue;
    for (const run of block.text.matchAll(new RegExp(`[${SUPERSCRIPT_DIGITS}]+`, 'gu'))) {
      marks.add([...run[0]].map((ch) => String(SUPERSCRIPT_DIGITS.indexOf(ch))).join(''));
    }
  }
  return marks;
}

/**
 * Pieces split into words, remembering which ones a space followed.
 *
 * The space is NOT in the text here: it would be measured into every width, and
 * a word's width has to be the ink alone for the gap to be a thing the line can
 * open and close. It is put back at drawing time, on the word it followed, so
 * that extracted text still reads as a sentence — see `drawPage`.
 */
function toWords(pieces: readonly Piece[]): Word[] {
  const words: Word[] = [];
  let current: Piece[] = [];
  const push = (spaced: boolean): void => {
    if (current.length > 0) words.push({ pieces: current, spaced });
    current = [];
  };
  for (const piece of pieces) {
    const parts = piece.text.split(' ');
    for (const [index, part] of parts.entries()) {
      if (part.length > 0) current.push({ ...piece, text: part });
      if (index < parts.length - 1) push(true);
    }
  }
  push(false);
  return words;
}

// ── measuring the book before setting it ────────────────────────────────────

/**
 * One block, measured and decided, before a single line of it is drawn.
 *
 * THE PASS EXISTS BECAUSE A CLASS SIZE IS A FACT ABOUT THE WHOLE DOCUMENT: it
 * cannot be known until every block has been measured, and the measuring needs
 * the faces, the page's geometry and the substituted text.
 */
interface PlannedBlock {
  page: number;
  category: DotsCategory;
  cls: SizeClass | null;
  rect: PdfRect;
  /** The printed lines when the model kept them; one entry otherwise. */
  segments: Word[][];
  /** Are those segments the printer's own lines? `trustsItsLines` decides. */
  trusted: boolean;
  /** How many lines this block was printed on. */
  lines: number;
  /** The measured distance from baseline to baseline, in points. */
  leadPt: number;
  /** The largest size at which this block's widest line fits the measure. */
  fitPt: number;
  /**
   * What the source's own text layer says this block's type measured, or null
   * where the source carries no spans under this box. The char-weighted median
   * over the spans whose centres fall inside the block — weighted so the
   * paragraph outvotes its own superscripts, and a median so one span the
   * box's edge clipped from a neighbour cannot move the answer.
   */
  truthPt: number | null;
  indent: boolean;
  centre: boolean;
  /**
   * A footnote's reference mark, kept so its lines can hang under it.
   *
   * The mark stays flush at the box's left edge and every line after the first
   * is indented past it, which is how a note is set and what makes a column of
   * them scannable. Empty where the note opens with nothing that looks like a
   * mark, because a hanging indent under no mark is an indent under nothing.
   */
  marker: string;
  emphasis: number;
  superscripts: number;
}

function planBlocks(
  pages: readonly PdfTextPage[],
  geometry: readonly PageGeometry[],
  faces: FaceSet,
  tally: SubstitutionTally,
  dpi: number,
  layer?: ReadonlyMap<number, readonly PdfLayerSpan[]>,
): PlannedBlock[] {
  const planned: PlannedBlock[] = [];
  const columns: { centre: number; width: number }[] = [];

  /*
   * PASS ONE: the words, the lines, and whether the lines are the printer's.
   *
   * Everything here is decided from the block alone. The two numbers that need
   * the whole document — the class's size, and how many lines a REFLOWED block
   * was printed on — are settled in pass two, once the book has been measured.
   */
  for (const reading of [...pages].sort((a, b) => a.page - b.page)) {
    const frame: PageFrame = { ...geometry[reading.page - 1], render: reading.render };
    const display = displaySize(frame);
    const marks = marksOnPage(reading);
    let previous: string | null = null;

    for (const block of reading.blocks) {
      if (block.category === 'Picture') continue;
      const rect = boxToDisplay(block.box, frame);
      if (rect.width <= 0 || rect.height <= 0) continue;

      /*
       * The lines the page broke on, and nothing invented. The one thing changed
       * on the way down is HORIZONTAL WHITESPACE THAT HAS NO GLYPH: a tab, a
       * vertical tab and a form feed are formatting bytes rather than marks on
       * paper, no text font has an outline for one, and this format's unit of
       * formatting is the line — so they become the space they stood for.
       * Refusing them would stop a book over a character never printed on it.
       * Every OTHER control character is left to fail: a NUL in a page's text is
       * not formatting, it is a sign the answer is damaged.
       */
      const raw = flattenTable(block.text, block.category)
        .split(/\r\n|\r|\n/)
        .map((line) => line.replace(/[\t\v\f]/g, ' ').trim())
        .filter((line) => line.length > 0)
        /*
         * A LIST MARKER IS MARKDOWN, NOT INK. The model that writes `*emphasis*`
         * writes `* ` for the bullet it saw, and drawing the marker verbatim
         * prints an asterisk on a page whose printer set a bullet — which is how
         * "● Stalin arose from within" came back "* Stalin arose from within".
         * The marker cannot be an emphasis span (those open against a non-space)
         * and a printed paragraph does not begin "* ", so the head of a block —
         * or of every item in a List-item block — is the one place the asterisk
         * is known to be notation, and it is set as the bullet it stood for.
         */
        .map((line, index) => (
          (index === 0 || block.category === 'List-item') && line.startsWith('* ')
            ? `• ${line.slice(2)}`
            : line
        ));
      if (raw.length === 0) continue;

      let emphasis = 0;
      let superscripts = 0;
      let marker = '';
      const segments: Word[][] = [];
      for (const [index, line] of raw.entries()) {
        const read = readPieces(line);
        emphasis += read.spans;
        let pieces = read.pieces;
        if (index === 0 && block.category === 'Footnote') {
          marker = FOOTNOTE_MARKER.exec(line)?.[1] ?? '';
          const raised = raiseMarker(pieces, marks);
          pieces = raised.pieces;
          superscripts += raised.raised;
        }
        const written = pieces.map((piece) => ({
          ...piece,
          text: substituteUnwritable(piece.text, reading.page, piece.face, faces, tally),
        }));
        const words = toWords(written);
        if (words.length > 0) segments.push(words);
      }
      if (segments.length === 0) continue;

      const trusted = trustsItsLines(segments.length, rect.height, display.height, dpi);
      const indent = block.category === 'Text'
        && previous !== null
        && ENDS_SENTENCE.test(previous)
        && OPENS_SENTENCE.test(raw[0]);

      const cls = sizeClassOf(block.category);
      if (cls === 'body') {
        columns.push({
          centre: (rect.x + rect.width / 2) / display.width,
          width: rect.width / display.width,
        });
      }

      planned.push({
        page: reading.page,
        category: block.category,
        cls,
        rect,
        segments,
        trusted,
        // Both settled in pass two for an untrusted block.
        lines: trusted ? segments.length : 0,
        leadPt: trusted ? rect.height / segments.length : 0,
        fitPt: 0,
        truthPt: layerTruth(layer?.get(reading.page), block.box, dpi),
        indent,
        centre: false,
        marker,
        emphasis,
        superscripts,
      });
      previous = raw[raw.length - 1];
    }
  }

  /*
   * PASS TWO: what only the whole document knows.
   *
   * How wide the BOOK's own characters are, taken from the blocks whose printed
   * lines survived — their line count and their characters are both known, so
   * the ratio is a measurement. A document with no such blocks falls back to
   * `AVG_CHAR_EM`, which is what a book face averages, because the alternative
   * is measuring the book's face with our own and getting our own answer back.
   */
  const charEm = calibrateCharWidth(planned, faces) ?? AVG_CHAR_EM;

  /*
   * THE SECOND OPINION, and the newlines are believed only if it agrees.
   *
   * `trustsItsLines` has already thrown out everything whose segments cannot be
   * a line by their HEIGHT. What survives that can still be wrong the other way
   * — a footnote's notes divide their box into segments of exactly line-like
   * height while each is a whole paragraph — so every block is asked again, this
   * time by an estimate that never looks at a newline: how many lines the book's
   * own character width says that much text takes in that much space.
   */
  for (const block of planned) {
    if (!block.trusted) continue;
    const implied = impliedLines(block, charEm);
    const ratio = implied / block.segments.length;
    if (Math.abs(ratio - 1) > LINE_COUNT_TOLERANCE) {
      block.trusted = false;
      block.lines = 0;
      block.leadPt = 0;
    }
  }

  const bodyLead = medianOf(planned.filter((b) => b.trusted && b.cls === 'body').map((b) => b.leadPt));

  for (const block of planned) {
    if (!block.trusted) {
      /*
       * A reflowed block: how many lines WAS it printed on? Not a question our
       * font can answer — it answers with its own widths, which is how this file
       * used to get a book two points too small. Solved instead from the book's
       * own character width: n lines of s points hold `width / (charEm · s)`
       * characters each, and n lines fill the box, so `s = √(H·W / (C·charEm·λ))`.
       */
      /*
       * The layer's size settles the line count too, where it exists. The
       * body's median leading is the right guess for a body-sized paragraph
       * and a wrong one for everything set smaller inside the body class —
       * an extract, a source line, the small type of a title page — which
       * got a line budget a fifth short and then shrank to meet it. A block
       * whose printed size is KNOWN was printed on lines of that size, and
       * `LINE_FACTOR` is the same convention the class sizes already assume.
       */
      const lead = block.truthPt !== null
        ? block.truthPt * LINE_FACTOR
        : bodyLead !== null && block.cls === 'body'
          ? bodyLead
          : Math.max(MIN_FONT_SIZE, block.rect.height / impliedLines(block, charEm));
      block.lines = Math.max(1, Math.round(block.rect.height / lead));
      block.leadPt = block.rect.height / block.lines;
    }
    block.fitPt = fitSize(block, faces);
  }

  /*
   * THE BOOK'S OWN MIDDLE, and everything judged against it rather than the
   * paper's. A book set in an asymmetric measure has a text column whose centre
   * is not the page's, and a running head centred in that column would fail a
   * test against the sheet. Measured off the body blocks, as a fraction of the
   * page, taking the median so one runaway box cannot move it.
   */
  const centre = medianOf(columns.map((column) => column.centre));
  const measure = medianOf(columns.map((column) => column.width));
  for (const block of planned) {
    const display = displaySize(geometry[block.page - 1]);
    const own = (block.rect.x + block.rect.width / 2) / display.width;
    const width = block.rect.width / display.width;
    block.centre = block.category === 'Title' || block.category === 'Section-header'
      || (
        centre !== null && measure !== null
        && Math.abs(own - centre) <= CENTRE_TOLERANCE
        && width <= measure * CENTRE_MAX_WIDTH
      );
  }
  return planned;
}

/**
 * Are this block's newlines the printer's line breaks, or the model's paragraph?
 *
 * THE ONE CHECK THAT MAKES LINE-FOR-LINE SETTING SAFE. `dots.ts` keeps a newline
 * where the page had one, but the model reflows about half its blocks and says
 * nothing about which — on the Kershaw bank, five pages came back line for line
 * and seven came back as one run per paragraph. Believing a reflowed block's one
 * segment would set a 970-character paragraph as a single line in a five-line
 * box.
 *
 * So the segments are believed only when the height they divide into is a
 * PRINTED LINE: inside `LINE_BAND` of the page's own height. A real line at
 * 200 dpi measures 30 to 45 pixels of a 2112-pixel page; a reflowed paragraph's
 * box over its one segment measures 100 to 430. Nothing real sits between, which
 * is why one band separates them on every page of that book.
 */
function trustsItsLines(segments: number, heightPt: number, pageHeightPt: number, dpi: number): boolean {
  void dpi;
  const perLine = heightPt / segments / pageHeightPt;
  return perLine >= LINE_BAND.low && perLine <= LINE_BAND.high;
}

/**
 * How many lines this block was printed on, solved WITHOUT looking at newlines.
 *
 * The second opinion `LINE_COUNT_TOLERANCE` weighs the newlines against, and the
 * only line count available for a block the model reflowed. n lines of size `s`
 * hold `W / (charEm · s)` characters each and fill a box of height `H`, so
 * `s = √(H·W / (C·charEm·λ))` and `n = H / (λ·s)`.
 *
 * `charEm` IS THE BOOK'S OWN, measured off the blocks whose lines survived. That
 * is the whole reason this estimate is worth anything: solved with OUR font's
 * widths it would answer with our font's line count, which is how this file
 * previously set a nine-point book at seven and three-quarters.
 */
function impliedLines(block: PlannedBlock, charEm: number): number {
  const chars = block.segments.reduce(
    (sum, words) => sum + words.reduce(
      (count, word) => count + word.pieces.reduce((n, p) => n + p.text.length, 0)
        + (word.spaced ? 1 : 0), 0),
    0,
  );
  if (chars <= 0) return 1;
  const size = Math.sqrt(
    (block.rect.height * block.rect.width) / (chars * charEm * LINE_FACTOR),
  );
  if (!Number.isFinite(size) || size <= 0) return 1;
  return Math.max(1, block.rect.height / (LINE_FACTOR * size));
}

/**
 * What the source's own layer says the type inside this box measured.
 *
 * A span belongs to the block whose box holds its CENTRE, with two points of
 * slack for the disagreement between a hand of OCR and a model's rectangle
 * about where ink exactly ends. The median is weighted by each span's
 * character count so that the size most of the block's TEXT is set at wins —
 * a footnote's raised mark, an italic word the layer split out, a fragment of
 * a neighbouring block caught at the edge, all are outvoted by the words.
 *
 * The comparison happens in render pixels because the boxes already live
 * there; the SIZE never converts at all, because a point is a point at any
 * dpi — which is the whole reason the layer's statement transfers to fresh
 * paper unchanged.
 */
function layerTruth(
  spans: readonly PdfLayerSpan[] | undefined,
  box: DotsBox,
  dpi: number,
): number | null {
  if (spans === undefined || spans.length === 0) return null;
  const scale = dpi / 72;
  const slack = 2 * scale;
  const hits = spans.filter((span) => {
    const x = span.x * scale;
    const y = span.y * scale;
    return x >= box.x1 - slack && x <= box.x2 + slack
      && y >= box.y1 - slack && y <= box.y2 + slack;
  });
  if (hits.length === 0) return null;
  const sorted = [...hits].sort((a, b) => a.size - b.size);
  const total = sorted.reduce((sum, span) => sum + span.chars, 0);
  let seen = 0;
  for (const span of sorted) {
    seen += span.chars;
    if (seen * 2 >= total) return span.size;
  }
  return sorted[sorted.length - 1].size;
}

/**
 * How wide the BOOK's characters are, in ems, measured off its own set lines.
 *
 * Only line-for-line blocks can answer: they are the only ones where the number
 * of characters on a printed line and the height of that line are both known. A
 * line of `C` characters across `W` points, set at `lead/λ` points, means each
 * character averaged `W / (C · size)` ems. The median over every such line is the
 * book's face, in the only unit that transfers to ours.
 */
function calibrateCharWidth(planned: readonly PlannedBlock[], faces: FaceSet): number | null {
  void faces;
  const ratios: number[] = [];
  for (const block of planned) {
    if (!block.trusted || block.cls === null) continue;
    const size = block.leadPt / LINE_FACTOR;
    if (size <= 0) continue;
    for (const words of block.segments) {
      const chars = words.reduce(
        (n, word) => n + word.pieces.reduce((c, p) => c + p.text.length, 0) + (word.spaced ? 1 : 0), 0);
      if (chars < 20) continue;
      ratios.push(block.rect.width / (chars * size));
    }
  }
  return medianOf(ratios);
}

/**
 * The largest size at which this block's widest line still fits the measure.
 *
 * The second thing the book says about its own size, and the one our font has an
 * opinion about: it is where the book's setting meets our face's widths. Paired
 * with the leading in `classSizes`, it is what keeps the type as large as the
 * page looks without asking the squeeze for more than it can give.
 */
function fitSize(block: PlannedBlock, faces: FaceSet): number {
  let widest = 0;
  if (block.trusted) {
    for (const words of block.segments) {
      widest = Math.max(widest, lineWidthAt1(words, faces));
    }
  } else {
    // A reflowed block has no printed line to measure, so the measure is its own
    // text spread over the line count pass two settled on.
    const total = block.segments.reduce((sum, words) => sum + lineWidthAt1(words, faces), 0);
    widest = total / Math.max(1, block.lines);
  }
  if (widest <= 0) return MIN_FONT_SIZE;
  return Math.max(MIN_FONT_SIZE, block.rect.width / widest);
}

/** A line's ink plus its word spaces, at one point. */
function lineWidthAt1(words: readonly Word[], faces: FaceSet): number {
  const ink = inkWidth(words, 1, faces);
  const gaps = Math.max(0, words.length - 1);
  return ink + gaps * spaceWidth(1, faces);
}

/**
 * Each class's size: as large as its leading implies, capped by what the squeeze
 * can make fit.
 *
 * THE MEDIAN, AND IT COULD NOT BE BEFORE. When a block's size was solved from
 * what our font could fit, every sample was a CEILING and the median guaranteed
 * half the book overflowed — which is why that version reached for a low
 * quantile. These samples are MEASUREMENTS of the book: the leading its printer
 * set, and the width its face occupied. The median of measurements is the
 * typical value, which is the number wanted.
 *
 * A class with fewer than `CLASS_SAMPLES` blocks gets no entry at all, and the
 * caller falls back to setting each of its blocks on its own measurements —
 * `typography.ts`'s rule, and its reasoning: a whole book's body size taken from
 * three paragraphs is a decision that looks measured and is not.
 */
function classSizes(planned: readonly PlannedBlock[]): Map<SizeClass, number> {
  const leads = new Map<SizeClass, number[]>();
  const fits = new Map<SizeClass, number[]>();
  const byClass = new Map<SizeClass, PlannedBlock[]>();
  for (const block of planned) {
    if (block.cls === null) continue;
    (leads.get(block.cls) ?? leads.set(block.cls, []).get(block.cls)!).push(block.leadPt);
    (fits.get(block.cls) ?? fits.set(block.cls, []).get(block.cls)!).push(block.fitPt);
    (byClass.get(block.cls) ?? byClass.set(block.cls, []).get(block.cls)!).push(block);
  }

  const sizes = new Map<SizeClass, number>();
  for (const [cls, lead] of leads) {
    if (lead.length < CLASS_SAMPLES) continue;
    /*
     * THE LAYER'S STATEMENT BEATS BOTH INFERENCES, class-wide as well as per
     * block. Where enough of a class's blocks sit over the source's own text
     * layer, the class is set at the median of what the layer says those
     * blocks measured — and the width-fit cap does not apply to it. The cap
     * exists because a size solved from leading might not FIT our wider face,
     * and capping it traded size for fit across the whole class; but the fit
     * machinery already pays for width line by line (the spaces, then `Tz`,
     * then `LINE_OVERRUN`), so applying the cap to a size that is KNOWN right
     * would shrink the entire book below its printed size to spare a few
     * lines a squeeze they can afford. Measured against a book whose layer
     * was checked by hand, the cap is exactly where the missing tenth of the
     * body size had gone.
     */
    const truths = (byClass.get(cls) ?? [])
      .map((block) => block.truthPt)
      .filter((pt): pt is number => pt !== null);
    if (truths.length >= CLASS_SAMPLES) {
      sizes.set(cls, Math.max(MIN_FONT_SIZE, medianOf(truths)!));
      continue;
    }
    const byLead = medianOf(lead);
    const byFit = quantileOf(fits.get(cls) ?? [], FIT_QUANTILE);
    if (byLead === null || byFit === null) continue;
    sizes.set(cls, Math.max(MIN_FONT_SIZE, Math.min(byLead / LINE_FACTOR, byFit / TZ_MIN)));
  }
  return sizes;
}

function medianOf(values: readonly number[]): number | null {
  return quantileOf(values, 0.5);
}

function quantileOf(values: readonly number[], at: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (at === 0.5) {
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
  }
  const index = Math.min(sorted.length - 1, Math.floor(at * sorted.length));
  return sorted[index];
}

// ── setting the type ────────────────────────────────────────────────────────

/**
 * One page's blocks as drawing operators, or nothing at all.
 *
 * `0 Tr` — FILL — is written rather than left to the default. The default IS 0,
 * so the operator changes no byte of what a viewer draws; what it changes is
 * what this file says about itself. Its predecessor set `3 Tr` here, invisible,
 * and the whole difference between the two formats is that one number. Stated
 * explicitly, a run that lost the distinction fails a test instead of shipping a
 * book of blank pages. The colour is stated in the same breath and for the same
 * reason, and the two read together as "visible, in black".
 */
function drawPage(
  blocks: readonly PlannedBlock[],
  sizes: ReadonlyMap<SizeClass, number>,
  faces: FaceSet,
  cramped: CrampedTally,
): { operators: PDFOperator[]; lines: number } {
  const body: PDFOperator[] = [];
  let lines = 0;
  const state = { face: '', size: -1, squeeze: 1 };

  for (const block of blocks) {
    const laid = layOut(block, sizes, faces);
    if (laid.lines.length === 0) continue;
    if (laid.tight) {
      cramped.count += 1;
      if (laid.size < LEGIBLE_SIZE) cramped.illegible += 1;
      cramped.smallest = Math.min(cramped.smallest, laid.size);
      cramped.pages.add(block.page);
    }

    const justify = block.cls !== null && JUSTIFIED.has(block.cls) && !block.centre;
    for (const [index, line] of laid.lines.entries()) {
      /*
       * TOP-ANCHORED, AT THE BLOCK'S OWN MEASURED LEADING. The lines descend
       * from the top of the box one leading apart, and the leading is the box's
       * height over the number of lines printed in it — so the block spans
       * exactly the rectangle it was printed in. That is the white gap fixed by
       * construction: there is no slack left over to leave at the bottom,
       * because the leading was derived from the box rather than from the size.
       */
      const baseline = block.rect.y + block.rect.height - (index + 1) * laid.leading
        + DESCENDER * laid.size;
      const offset = index === 0 ? laid.indent : laid.hang;
      const target = block.rect.width - offset;
      const fit = fitLine(line, laid.size, target, faces, justify);

      let x = block.rect.x + offset;
      if (block.centre && laid.lines.length === 1) {
        x = block.rect.x + Math.max(0, (block.rect.width - fit.width) / 2);
      }

      if (Math.abs(state.squeeze - fit.squeeze) > 1e-9) {
        body.push(setCharacterSqueeze(fit.squeeze * 100));
        state.squeeze = fit.squeeze;
      }
      for (const word of line.words) {
        for (const [at, piece] of word.pieces.entries()) {
          const size = piece.raised ? laid.size * SUPER_SCALE : laid.size;
          const key = faceKeyFor(faces, piece.face);
          if (key !== state.face || Math.abs(size - state.size) > 1e-9) {
            body.push(setFontAndSize(key, size));
            state.face = key;
            state.size = size;
          }
          const rise = piece.raised ? laid.size * SUPER_RISE : 0;
          /*
           * THE SPACE IS DRAWN WITH THE WORD IT FOLLOWS, AND MEASURED APART FROM
           * IT — which is what makes a copy out of this document read as a
           * sentence. Every word is positioned by its own `Tm`, because that is
           * how justification, the squeeze and the hanging indent are applied at
           * all, and a reader extracting text from separately positioned runs is
           * left to guess where the spaces were. Written into the string there
           * is nothing to guess. It costs nothing to draw — the glyph is blank —
           * and it cannot disturb the setting, because the next word is placed
           * at the x this line's arithmetic computed rather than wherever the
           * space happened to end.
           */
          const trailing = word.spaced && at === word.pieces.length - 1;
          body.push(
            setTextMatrix(1, 0, 0, 1, x, baseline + rise),
            showText(fontFor(faces, piece.face).encodeText(trailing ? `${piece.text} ` : piece.text)),
          );
          x += pieceWidth(piece, laid.size, faces) * fit.squeeze;
        }
        if (word.spaced) x += fit.gap * fit.squeeze;
      }
      lines += 1;
    }
  }

  if (lines === 0) return { operators: [], lines: 0 };
  return {
    operators: [
      beginText(),
      setTextRenderingMode(TextRenderingMode.Fill),
      setFillingRgbColor(0, 0, 0),
      ...body,
      endText(),
      // Left as it was found: the squeeze is text state, and a page that ended
      // mid-compression would hand the next content stream a scale it never set.
      setCharacterSqueeze(100),
    ],
    lines,
  };
}

/**
 * A block's lines, its size and its leading — the last decision before drawing.
 *
 * A LINE-FOR-LINE BLOCK KEEPS ITS LINES, and its only question is whether they
 * fit. A wrapped block is broken at our own widths, at the class's size, into
 * the line count the book's own measurements implied. Either way the leading is
 * the box over the lines, so the block fills its rectangle.
 *
 * THE FALLBACK IS PER BLOCK AND IT IS REPORTED. When a printed line cannot be
 * squeezed into its measure even at `TZ_MIN`, the line count is not honest for
 * this block — the box is wrong, or the model merged two lines into one — and
 * the block is re-set by wrapping instead. Nothing is ever clipped: the last
 * resort is smaller type, which is visible, and never fewer words, which is not.
 */
function layOut(
  block: PlannedBlock,
  sizes: ReadonlyMap<SizeClass, number>,
  faces: FaceSet,
): { lines: Line[]; size: number; leading: number; indent: number; hang: number; tight: boolean } {
  /*
   * The block's own truth first, the class second, the box-solved size last.
   *
   * PER BLOCK BEFORE PER CLASS, and only for the truth — which reverses the
   * uniformity the class sizes exist for, deliberately. A class is one size
   * because sizes SOLVED from boxes wobble with the model's generosity, and
   * a median across the book is how the wobble cancels; the layer's sizes
   * are not solved, they are the printed page's own, so their variation is
   * the printer's (a title page's mixed sizes, a source line set small) and
   * flattening it to the class median would erase exactly the thing a
   * facsimile is for. Where the layer is silent the old order stands
   * unchanged. Everything downstream — the squeeze, the overrun, the floor,
   * the rewrap — treats the truth like any other wanted size, so a box the
   * model drew too narrow still pays in tightness, visibly, rather than in
   * words.
   */
  const wanted = block.truthPt
    ?? (block.cls !== null ? sizes.get(block.cls) : undefined)
    ?? Math.max(MIN_FONT_SIZE, Math.min(block.leadPt / LINE_FACTOR, block.fitPt / TZ_MIN));

  const hangAt = (size: number): number => block.marker.length === 0
    ? 0
    : fontFor(faces, 'roman').widthOfTextAtSize(`${block.marker} `, size);

  const roomy = block.rect.width * (1 + LINE_OVERRUN);
  if (block.trusted) {
    const lines: Line[] = block.segments.map((words, index) => ({
      words,
      last: index === block.segments.length - 1,
    }));
    /*
     * Every printed line has to reach its measure once the squeeze is spent —
     * give or take `LINE_OVERRUN`, which is cheaper than losing the line count.
     *
     * A LINE THAT STILL DOES NOT FIT COSTS THIS BLOCK SIZE, NOT ITS LINES. The
     * first cut of this branch gave the whole block to the wrapping path the
     * moment one line came up wide, and `FIT_QUANTILE` made that common: the
     * class size is set so a fifth of the book's blocks hold at least one line
     * wider than it, and every one of them was being re-broken at our widths,
     * its boundary spaces lost and its leading stretched over the shortfall —
     * one paragraph in five set sparse in the middle of a page whose neighbours
     * kept their printed breaks. The page's own geometry is the better half of
     * the facsimile, so the block keeps the printer's lines and gives up size
     * until its widest line fits, and the loss is counted as cramped where a
     * person can read about it. Only a block whose lines would cost more than
     * `TRUSTED_SIZE_FLOOR` of the class size can be lying about its line count
     * — the model gluing two printed lines into one arrives here asking for
     * half size — and only that block is re-broken by wrapping.
     */
    const widest = lines.reduce(
      (max, line) => Math.max(max, lineWidthAt1(line.words, faces)), 0,
    );
    const fitted = widest <= 0 ? wanted : Math.min(wanted, roomy / (widest * TZ_MIN));
    if (fitted >= wanted * TRUSTED_SIZE_FLOOR) {
      /*
       * A KNOWN size is held; a solved one gives way. `fitted` shaves a block
       * whose widest line outruns the measure in our face, and when the size
       * was solved from the box that shave is the honest answer — the size
       * was a guess and the line is evidence against it. When the size is
       * the LAYER's, the line is not evidence of anything except DejaVu
       * being wider than the book's face, and shaving a few per cent off
       * block after block is precisely the wobble a page of one-size type
       * turns into: every paragraph its own size, none of them the page's.
       * So the block keeps the printed size and its widest line pays where
       * a line can — spaces first, then `Tz`, then a reach into the margin
       * (`fitLine` compresses to `TZ_MIN` and past that lets the line run
       * long rather than clipping a word). `TRUSTED_SIZE_FLOOR` still
       * guards above: a block asking for HALF its size is a merged line,
       * not a wide one, and it re-wraps as before.
       */
      const size = block.truthPt !== null ? wanted : fitted;
      return {
        lines,
        size,
        leading: block.rect.height / lines.length,
        indent: block.indent ? INDENT_EM * size : 0,
        // A line the printer set is already positioned by its own text; hanging
        // it under the mark would indent a line the page did not indent.
        hang: 0,
        tight: fitted < wanted,
      };
    }
  }

  /*
   * The wrapped path: our own widths, and the line count the book's own
   * measurements implied.
   *
   * THE SQUEEZE IS SPENT BEFORE THE SIZE IS. Wrapping at the column's true width
   * puts our wider face on more lines than the printer used, and shrinking until
   * they fit is what made the type too small in the first place. So the wrap is
   * tried a second time against the width the column will EFFECTIVELY have once
   * each line is compressed — `width / TZ_MIN` — and only if the book's line
   * count is still out of reach does the block give up size instead. Nothing is
   * ever clipped: the last resort is smaller type, which is visible, and never
   * fewer words, which is not.
   */
  const flat = joinSegments(block.segments);
  const allowed = Math.max(1, block.lines);
  /*
   * A truth-sized block wraps into the measure a line is ACTUALLY permitted
   * to occupy — the squeeze plus the same `LINE_OVERRUN` the trusted path
   * grants a printed line. The distinction matters at the margin, and the
   * margin is where whole paragraphs were being lost: a bulleted paragraph
   * whose text needs 2.04 lines' width in a two-line box wraps to three lines
   * at the strict measure, and the shrink loop then prices three-into-two at
   * two-thirds of the printed size — 6.8 pt in a 10.2 pt book, for four per
   * cent of overflow the overrun absorbs without anyone seeing it. A block
   * with no truth keeps the strict measure and the old arithmetic untouched:
   * its `wanted` is a guess solved from its own box, over-generous exactly
   * when the box is (a 35 pt "size" from a box drawn far too tall), and the
   * aggressive count-ratio shrink is what walks a guess like that back down.
   */
  const wrapWidth = block.truthPt === null
    ? block.rect.width / TZ_MIN
    : (block.rect.width * (1 + LINE_OVERRUN)) / TZ_MIN;
  let size = wanted;
  let indent = block.indent ? INDENT_EM * size : 0;
  let hang = hangAt(size);
  let lines = wrapWords(flat, block.rect.width, size, faces, indent, hang);
  if (lines.length > allowed) {
    const squeezed = wrapWords(flat, wrapWidth, size, faces, indent, hang);
    // For a truth-sized block the squeezed wrap is adopted whenever it is the
    // better of the two — the loop below starts from its count, and starting
    // from the unsqueezed count overshoots. Without truth, the historical
    // rule stands: adopted only when it settles the matter outright.
    if (block.truthPt !== null ? squeezed.length < lines.length : squeezed.length <= allowed) {
      lines = squeezed;
    }
  }
  /*
   * A block whose size is the LAYER's spends its leading before its size.
   * Our face squeezed to `TZ_MIN` sits within a few per cent of the widths
   * these books are set in, so a wrap that misses the printed line count
   * misses it by a line — and the page's own remedy for one line too many is
   * never to print the paragraph smaller, it is to set the lines closer. The
   * leading floor is where that stops: below five per cent of air between
   * lines, descenders and ascenders start to meet, and past THAT point the
   * box genuinely cannot hold the text at the printed size — a box the model
   * drew too small, or two blocks' text in one box — and shrinking is the
   * honest answer again, exactly as it is for a block with no truth at all.
   */
  const ceiling = block.truthPt === null
    ? allowed
    : Math.max(allowed, Math.floor(block.rect.height / (block.truthPt * LEADING_FLOOR)));
  let tight = block.trusted;
  for (let attempt = 0; attempt < 4 && lines.length > ceiling && size > MIN_FONT_SIZE; attempt += 1) {
    size = Math.max(MIN_FONT_SIZE, size * (ceiling / lines.length));
    indent = block.indent ? INDENT_EM * size : 0;
    hang = hangAt(size);
    lines = wrapWords(flat, wrapWidth, size, faces, indent, hang);
    tight = true;
  }
  if (block.truthPt !== null && lines.length > allowed) tight = true;
  return {
    lines,
    size,
    /*
     * NEVER STRETCHED PAST THE PRINTED LEAD. The wrap can come in UNDER the
     * book's line count — our face condensed onto fewer lines than the printer
     * used — and dividing the box by the smaller number opened the lines up
     * until the paragraph read as a different setting from its neighbours: the
     * sparse block in the middle of an otherwise faithful page. The box over
     * the PRINTED count is the leading the page was set on; a wrap that beat it
     * simply ends short of the box's floor, which is a gap the reader has seen
     * at the bottom of every paragraph that ever ended early.
     */
    leading: block.rect.height / Math.max(allowed, lines.length),
    indent,
    hang,
    tight,
  };
}

/**
 * The segments as one run of words, with the breaks between them made spaces.
 *
 * THE BREAK ITSELF IS A SPACE, and this is where the wrapping path gets it. A
 * word that ends a printed line carries `spaced: false` — nothing followed it on
 * its line — and flattening the segments bare put that word hard against the
 * first word of the next line: every re-wrapped paragraph rendered its old line
 * breaks as fused pairs, "superficial" against "similarities", at exactly the
 * points the page once broke. The one break that is NOT a space is the one the
 * printer hyphenated: a segment ending in a hyphenated word-half joins its other
 * half bare, hyphen kept, because "compar- ing" is a word no search finds and no
 * reader forgives.
 */
function joinSegments(segments: readonly Word[][]): Word[] {
  return segments.map((words, index) => {
    if (index === segments.length - 1 || words.length === 0) return words;
    const last = words[words.length - 1];
    const half = last.pieces[last.pieces.length - 1]?.text ?? '';
    if (/\p{L}-$/u.test(half)) return words;
    return [...words.slice(0, -1), { ...last, spaced: true }];
  }).flat();
}

/**
 * Greedy wrapping at word boundaries, and a word too long for the column goes on
 * a line of its own rather than nowhere.
 *
 * Never breaks inside a word: a word split across two runs is a word a search
 * does not match and a hyphen the printer never set. The printer's OWN
 * end-of-line hyphens survive untouched, because they are characters in the text
 * and this never looks at them — which is the whole of why a line-for-line block
 * reproduces the page's hyphenation for free.
 */
function wrapWords(
  words: readonly Word[],
  width: number,
  size: number,
  faces: FaceSet,
  firstIndent: number,
  hangIndent = 0,
): Line[] {
  const out: Line[] = [];
  let current: Word[] = [];
  const gap = spaceWidth(size, faces);
  let used = 0;
  for (const word of words) {
    const w = wordWidth(word, size, faces);
    // The indents narrow the MEASURE rather than moving the text: wrapping to
    // the full width and then shifting the line would push its last word past
    // the right edge of the box it was measured into.
    const available = width - (out.length === 0 ? firstIndent : hangIndent);
    if (current.length > 0 && used + gap + w > available) {
      out.push({ words: current, last: false });
      current = [word];
      used = w;
    } else {
      used += (current.length > 0 ? gap : 0) + w;
      current.push(word);
    }
  }
  if (current.length > 0) out.push({ words: current, last: false });
  if (out.length > 0) out[out.length - 1].last = true;
  return out;
}

/**
 * How one line meets its measure: the word gap it is set on, and the squeeze.
 *
 * THE ORDER IS THE COMPOSITOR'S. A line too wide gives up its word spacing
 * first, down to `SPACE_SQUEEZE`, because tightening spaces changes no letter
 * and a line set tight is simply a line set tight. Only when the spaces are
 * spent does the letterform itself get scaled, and only as far as `TZ_MIN`.
 *
 * A line too NARROW is justified — its gaps opened until it fills the measure —
 * unless it ends the paragraph, or unless it would need more than
 * `JUSTIFY_SLACK_LIMIT` of its width in air, which is a short line being pulled
 * apart rather than a line being justified.
 */
function fitLine(
  line: Line,
  size: number,
  target: number,
  faces: FaceSet,
  justify: boolean,
): { gap: number; squeeze: number; width: number } {
  const ink = inkWidth(line.words, size, faces);
  const gaps = line.words.filter((word) => word.spaced).length;
  const natural = spaceWidth(size, faces);
  const width = ink + gaps * natural;

  if (gaps === 0) {
    const squeeze = width > target ? Math.max(TZ_MIN, target / width) : 1;
    return { gap: 0, squeeze, width: width * squeeze };
  }

  if (width <= target) {
    const slack = target - width;
    if (!justify || line.last || slack > target * JUSTIFY_SLACK_LIMIT) {
      return { gap: natural, squeeze: 1, width };
    }
    return { gap: natural + slack / gaps, squeeze: 1, width: target };
  }

  // Too wide: spend the spaces, then the letterforms.
  const tightest = ink + gaps * natural * (1 - SPACE_SQUEEZE);
  if (tightest <= target) {
    return { gap: (target - ink) / gaps, squeeze: 1, width: target };
  }
  const squeeze = Math.max(TZ_MIN, target / tightest);
  return {
    gap: natural * (1 - SPACE_SQUEEZE),
    squeeze,
    width: tightest * squeeze,
  };
}

/**
 * Every character, checked against what the faces can write — and the ones they
 * cannot, replaced with U+FFFD and put on the tally.
 *
 * pdf-lib does not do this and cannot be made to: a character the font has no
 * glyph for is encoded as .notdef and silently becomes a blank, so the word it
 * was in stops being findable and the file still opens, still looks right and
 * still reports success. Substituted here — with the page, the character and its
 * code point recorded — because this is the only place all three are known, and
 * whether the book's WORTH of them is a glitch or a script is `closeTally`'s
 * question, asked once, at the end.
 */
function substituteUnwritable(
  text: string,
  page: number,
  face: FaceKey,
  faces: FaceSet,
  tally: SubstitutionTally,
): string {
  const font = fontFor(faces, face);
  const covered = new Set(font.getCharacterSet());
  let out = '';
  for (const character of text) {
    tally.chars += 1;
    const code = character.codePointAt(0)!;
    if (covered.has(code)) {
      out += character;
      continue;
    }
    const entry = tally.perChar.get(character) ?? { code, count: 0, pages: new Set<number>() };
    entry.count += 1;
    entry.pages.add(page);
    tally.perChar.set(character, entry);
    out += REPLACEMENT;
  }
  return out;
}
