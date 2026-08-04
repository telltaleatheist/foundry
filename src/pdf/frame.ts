/**
 * frame — one geometry frame for the whole pipeline, and the conversion to the
 * PDF's own.
 *
 * Foundry measures everything in the SCAN's frame: pixels at the pinned
 * rendering resolution (200 dpi), origin top-left, y down, half-open boxes in
 * PIL crop order. Every model in the repo was trained on numbers in that frame
 * and every deterministic rule — calibration, the paragraph splitter, the
 * display-run merge — has its thresholds expressed in units derived from it
 * (ARCHITECTURE §5). A book measured in points would hand all of them a
 * different distribution for no reason at all, so a document-mode stage
 * converts at the edge and thinks in pixels everywhere else.
 *
 * PDF user space is the other frame: points (1/72 inch), origin bottom-left,
 * y UP. The conversion is a scale and a flip, and it is per page, because a PDF
 * page's size is per page.
 *
 * ## The scale comes from the page, not from the dpi
 *
 * `widthPt / widthPx` rather than `72 / dpi`. They agree to within the
 * renderer's rounding when the render really was made at that dpi, and where
 * they do not agree the page is the authority — the boxes have to land on the
 * ink, and the ink is where the page put it. The dpi is still checked (see
 * `assertRenderMatches`) because a render at the wrong resolution is a
 * different Tesseract segmentation and a silently worse book, and a scale
 * factor that quietly absorbs it would hide exactly that.
 *
 * ## Deskew
 *
 * A scan's line boxes are measured on the STRAIGHTENED raster: the band
 * segmenter rotates a tilted page before it profiles it, and records the angle
 * it used. The conversions here do not undo that rotation, so on a page with a
 * nonzero deskew the frame is the straightened page and not the visible one.
 * `get-text` records the angle per page (`/FoundryDeskew`) so the difference is
 * stated in the document rather than lost — see docs/DOCUMENT_MODES.md, "The
 * text layer is straightened".
 */
import type { Box } from '../scan/bands.js';

/** Points per inch. Not a setting; it is what a point IS. */
export const POINTS_PER_INCH = 72;

export interface PageFrame {
  /** 0-based page index, the same index every artifact keys by. */
  page: number;
  widthPx: number;
  heightPx: number;
  widthPt: number;
  heightPt: number;
  /** Straightening the scan applied before the px boxes were measured. */
  deskewDeg: number;
}

/** [x0,y0,x1,y1] in PDF user space: points, origin bottom-left, y up. */
export type PtRect = [number, number, number, number];

export function pxToPtX(frame: PageFrame, x: number): number {
  return x * (frame.widthPt / frame.widthPx);
}

export function pxToPtY(frame: PageFrame, y: number): number {
  return frame.heightPt - y * (frame.heightPt / frame.heightPx);
}

export function ptToPxX(frame: PageFrame, x: number): number {
  return x * (frame.widthPx / frame.widthPt);
}

export function ptToPxY(frame: PageFrame, y: number): number {
  return (frame.heightPt - y) * (frame.heightPx / frame.heightPt);
}

/**
 * A scan box in the PDF's frame. The y flip swaps which edge is which, so the
 * result is re-ordered into the `[x0,y0,x1,y1]` a `/Rect` wants (lower-left
 * first) rather than left as an inverted box.
 */
export function pxBoxToPtRect(frame: PageFrame, box: Box): PtRect {
  const [x0, y0, x1, y1] = box;
  return [pxToPtX(frame, x0), pxToPtY(frame, y1), pxToPtX(frame, x1), pxToPtY(frame, y0)];
}

/** The inverse: a `/Rect` back into the scan's frame. */
export function ptRectToPxBox(frame: PageFrame, rect: PtRect): Box {
  const [x0, y0, x1, y1] = rect;
  return [ptToPxX(frame, x0), ptToPxY(frame, y1), ptToPxX(frame, x1), ptToPxY(frame, y0)];
}

/**
 * The pixel size a page of this many points has at a given dpi.
 *
 * Used when there IS no render to take a size from — a document that arrived
 * with its own text layer is never rasterized, so `scan --pdf` states the pixel
 * frame it is projecting that text into, at the pinned resolution, so that
 * everything downstream sees the numbers it would have seen from a scan.
 */
export function frameFromPage(
  page: number, widthPt: number, heightPt: number, dpi: number,
): PageFrame {
  const scale = dpi / POINTS_PER_INCH;
  return {
    page,
    widthPx: Math.round(widthPt * scale),
    heightPx: Math.round(heightPt * scale),
    widthPt,
    heightPt,
    deskewDeg: 0,
  };
}

/**
 * Refuse a render that is not this page.
 *
 * A page count that matches while the pages do not is the failure this catches:
 * renders from a different edition, or from the same book with the cover
 * stripped, produce a text layer laid over the wrong ink and a book that is
 * subtly, unattributably wrong. Aspect ratio is the check because it survives
 * the renderer's rounding while an exact pixel size does not, and the tolerance
 * is stated rather than tuned: 1% is far tighter than any two page shapes in a
 * book and far looser than rounding.
 */
export const ASPECT_TOLERANCE = 0.01;

export function assertRenderMatches(frame: PageFrame, dpi: number): void {
  const pageAspect = frame.widthPt / frame.heightPt;
  const renderAspect = frame.widthPx / frame.heightPx;
  if (Math.abs(pageAspect - renderAspect) / pageAspect > ASPECT_TOLERANCE) {
    throw new Error(
      `page ${frame.page + 1} of the PDF is ${frame.widthPt.toFixed(1)}×${frame.heightPt.toFixed(1)} pt `
      + `(aspect ${pageAspect.toFixed(4)}) and its render is ${frame.widthPx}×${frame.heightPx} px `
      + `(aspect ${renderAspect.toFixed(4)}). These are not the same page: a text layer written from `
      + `one onto the other lands nowhere near the ink. Re-render the pages from THIS PDF.`,
    );
  }
  const impliedDpi = (frame.widthPx / frame.widthPt) * POINTS_PER_INCH;
  if (Math.abs(impliedDpi - dpi) / dpi > ASPECT_TOLERANCE) {
    throw new Error(
      `page ${frame.page + 1} was rendered at ${impliedDpi.toFixed(1)} dpi, and the pipeline is pinned `
      + `to ${dpi} dpi (ARCHITECTURE §5). A different resolution is a different Tesseract `
      + `segmentation, which every model downstream was trained against. Re-render at ${dpi} dpi.`,
    );
  }
}
