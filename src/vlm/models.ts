/**
 * vlm/models — the document VLMs `foundry vlm-convert` knows how to drive.
 *
 * A SECOND, SELF-CONTAINED ROUTE TO A BOOK, and deliberately not connected to
 * the first. The pipeline in PIPELINE.md reads a page with Tesseract, labels
 * the blocks, repairs the words and reflows them; this mode hands the whole
 * page picture to a vision model trained on documents and takes back marked-up
 * text. Nothing here reads or writes a run directory, and no stage of the other
 * pipeline can reach it — the two answer the same question by different means
 * and must be comparable, which they stop being the moment they share a step.
 *
 * THE PROMPT IS THE MODEL'S INTERFACE AND IS SENT VERBATIM. Every entry below
 * carries the string its own model card documents, byte for byte, and none of
 * them may be adjusted to a house style. This is the same rule as
 * ARCHITECTURE §4 and `src/ocr/prompt.ts`, learned again the same way: asking
 * Qwen2.5-VL for an ad-hoc JSON layout produced FABRICATED bounding boxes and
 * straightened quotes, while asking it for `QwenVL HTML` — the format it was
 * trained to emit — produced real geometry and the book's own typography. A
 * prompt that is nearly right does not error. It quietly answers worse, and the
 * natural conclusion is that the model is bad.
 *
 * Adding a model is an entry here plus a dialect parser in `dialect.ts`, and
 * nothing else. The weights are mlx-community conversions pulled by mlx-vlm
 * into the HuggingFace cache; foundry does not host, mirror or checksum them —
 * that is `src/models/catalog.ts`'s job for the weights this project TRAINED,
 * and these are somebody else's.
 */

/**
 * The shape of what a model gives back, which is the only thing about it the
 * TypeScript side needs to understand.
 *
 *  - `nanonets-markdown`  markdown, plus the furniture tags the Nanonets prompt
 *                         asks for: `<page_number>`, `<footer>`, `<img>`,
 *                         `<watermark>`, and HTML tables.
 *  - `qwen-html`          `<h2 data-bbox="…">`, `<p data-bbox="…">` — Qwen2.5-VL's
 *                         own document format, geometry included.
 *  - `markdown`           plain markdown, no document tags (olmOCR).
 */
export type VlmDialect = 'nanonets-markdown' | 'qwen-html' | 'markdown';

export interface VlmModelDef {
  /** Selected with `--vlm-model`. */
  id: string;
  /** HuggingFace repo, passed to mlx-vlm's `load()` unchanged. */
  repo: string;
  /**
   * The model card's own prompt, VERBATIM. Never edited, never templated,
   * never merged with another model's. See this file's header.
   */
  prompt: string;
  dialect: VlmDialect;
  /**
   * Generation cap for one page.
   *
   * A page that hits the cap is a TRUNCATED page, and the bridge fails the run
   * naming it rather than writing half a page into a book (`bridge.ts`). So the
   * number is set well above a dense page's real length — a 4,000-character
   * page of prose is roughly 1,200 tokens — and its only job is to stop a model
   * that has started repeating itself.
   */
  maxTokens: number;
  /** What is known about this model's behaviour on books. Measured, or nothing. */
  notes: string;
}

/**
 * The Nanonets prompt, from the model card for Nanonets-OCR2-3B.
 *
 * Reproduced here as one concatenated string with single spaces at the joins,
 * which is exactly how the model card writes it — it is one paragraph, not a
 * list of lines. `tools/`-style crosschecking is not possible for it the way
 * `crosscheck-ocr-prompt.mjs` compares against the dataset builder: the
 * authority is a published model card rather than a file on this machine.
 */
const NANONETS_PROMPT =
  'Extract the text from the above document as if you were reading it naturally. '
  + 'Return the tables in html format. Return the equations in LaTeX representation. '
  + 'If there is an image in the document and image caption is not present, add a small '
  + 'description of the image inside the <img></img> tag; otherwise, add the image caption '
  + 'inside <img></img>. Watermarks should be wrapped in brackets. '
  + 'Ex: <watermark>OFFICIAL COPY</watermark>. Page numbers should be wrapped in brackets. '
  + 'Ex: <page_number>14</page_number>. Prefer using ☐ and ☑ for check boxes.';

/**
 * olmOCR's prompt, from the model card for olmOCR-7B-0725.
 *
 * The published olmOCR toolchain builds a longer prompt that also carries the
 * PDF's own extracted text as an anchor. This is the plain image-only form; a
 * book read this way gets no anchor, so the model is doing the same job the
 * others are and the comparison is fair.
 */
const OLMOCR_PROMPT =
  'Below is the image of one page of a document. Just return the plain text '
  + 'representation of this document as if you were reading it naturally. '
  + 'Convert equations to LaTeX and tables to markdown. Return your output as markdown.';

export const VLM_MODELS: readonly VlmModelDef[] = [
  {
    id: 'nanonets-ocr2-3b',
    repo: 'mlx-community/Nanonets-OCR2-3B-8bit',
    prompt: NANONETS_PROMPT,
    dialect: 'nanonets-markdown',
    maxTokens: 4096,
    notes:
      'A Qwen2.5-VL-3B fine-tune, 8-bit MLX, ~2.6 GB. The default because it is the one '
      + 'measured: against the embedded text layer of a born-digital book (Kershaw, '
      + '"Working Towards the Führer", 1993) it read pages 4, 5 and 9 at 0.07%, 0.74% and '
      + '0.39% character error, at roughly 15 s a page on an M1 Ultra. It marks page '
      + 'numbers and running feet with tags, which is what lets this mode drop page '
      + 'furniture without guessing. It does NOT tag the running HEAD: a repeated title '
      + 'across the top of every page arrives as an ordinary paragraph and lands in the '
      + 'book. Nothing here removes it, because the only way to find it is to notice a '
      + 'line repeating — and a chapter that opens with the same sentence twice is a book '
      + 'that has been edited by a guess.',
  },
  {
    id: 'qwen2.5-vl-7b',
    repo: 'mlx-community/Qwen2.5-VL-7B-Instruct-8bit',
    prompt: 'QwenVL HTML',
    dialect: 'qwen-html',
    maxTokens: 4096,
    notes:
      'The general-purpose model this mode is measured against, in its own document '
      + 'format. Two words is the whole prompt — that is not an abbreviation, it is the '
      + 'trained trigger, and anything longer gets a different and worse behaviour. Emits '
      + 'a bbox on every element; the boxes are dropped here, because this mode produces '
      + 'a book rather than a layout.',
  },
  {
    id: 'olmocr-7b',
    repo: 'mlx-community/olmOCR-7B-0725-8bit',
    prompt: OLMOCR_PROMPT,
    dialect: 'markdown',
    maxTokens: 4096,
    notes:
      'Allen AI\'s document model, 8-bit MLX, ~8 GB. Plain markdown with no furniture '
      + 'tags, so running heads and folios arrive as ordinary paragraphs and land in the '
      + 'book — a real cost of this dialect, not a bug in the parser.',
  },
];

/**
 * The default, named rather than ranked.
 *
 * `src/models/catalog.ts` picks its default by `rank` among the weights present
 * on disk, because those are foundry's own weights and several versions of one
 * stage exist. Nothing here is installed in that sense — mlx-vlm downloads a
 * repo on first use — so "which is present" is not a question with an answer at
 * this point, and the default is the model that was measured.
 */
export const DEFAULT_VLM_MODEL_ID = 'nanonets-ocr2-3b';

/** Look one up by id, or fail naming every id there is. */
export function requireVlmModel(id: string): VlmModelDef {
  const found = VLM_MODELS.find((m) => m.id === id);
  if (!found) {
    throw new Error(
      `unknown --vlm-model "${id}". Known models: ${VLM_MODELS.map((m) => m.id).join(', ')}`,
    );
  }
  return found;
}
