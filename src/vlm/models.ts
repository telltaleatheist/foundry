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
 *  - `dots-json`          one JSON array per page: `{bbox, category, text}` in
 *                         reading order, eleven categories, geometry included.
 *                         The only dialect that answers with WHERE as well as
 *                         WHAT, which is why it is the one that can drop
 *                         furniture, crop a picture, and tell a centered
 *                         epigraph from a paragraph.
 */
export type VlmDialect = 'nanonets-markdown' | 'qwen-html' | 'markdown' | 'dots-json';

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
  /**
   * The processor's own pixel budget — the FRAME THE MODEL'S BOXES ARE IN.
   *
   * A Qwen-family vision tower resizes its input to a multiple of 28 with the
   * area inside `[min_pixels, max_pixels]`, and a model that answers with
   * geometry answers in THAT space, not in the render's. Scaling a box back
   * therefore needs the same number the processor used, which is why it is
   * declared here beside the repo rather than read off a page — a preprocessor
   * config that changed under us would move every box by a few per cent, which
   * is a paragraph that loses its indent test and a picture cropped slightly
   * wrong. Absent for the dialects that carry no geometry, because for them
   * there is nothing to scale.
   *
   * `bridge.ts` OVERRIDES it downward on the MLX path (`MLX_MAX_PIXELS`) and
   * hands the override to the dialect, so the two always agree.
   */
  maxPixels?: number;
  /**
   * The name an OpenAI-compatible server knows this model by (`--vlm-endpoint`).
   *
   * vLLM serves the upstream repo, not the MLX conversion, and the `model`
   * field of a chat request has to match what the server was started with.
   * `--vlm-endpoint-model` overrides it for a server started under another name.
   */
  endpointModel?: string;
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

/**
 * dots.ocr's `layout-all` prompt, from the rednote-hilab model card.
 *
 * Written as a line array rather than one string so the four-space indents
 * under rules 3 and 4 are visible and cannot be reflowed by an editor. It is
 * byte-for-byte the card's prompt with no trailing newline;
 * `test/vlm/dots.test.ts` pins its sha256 so a well-meant tidy of the wording
 * fails a test instead of quietly costing accuracy (ARCHITECTURE §4).
 */
const DOTS_PROMPT = [
  "Please output the layout information from the PDF image, including each layout element's bbox, its category, and the corresponding text content within the bbox.",
  '',
  '1. Bbox format: [x1, y1, x2, y2]',
  '',
  "2. Layout Categories: The possible categories are ['Caption', 'Footnote', 'Formula', 'List-item', 'Page-footer', 'Page-header', 'Picture', 'Section-header', 'Table', 'Text', 'Title'].",
  '',
  '3. Text Extraction & Formatting Rules:',
  "    - Picture: For the 'Picture' category, the text field should be omitted.",
  '    - Formula: Format its text as LaTeX.',
  '    - Table: Format its text as HTML.',
  '    - All Others (Text, Title, etc.): Format their text as Markdown.',
  '',
  '4. Constraints:',
  '    - The output text must be the original text from the image, with no translation.',
  '    - All layout elements must be sorted according to human reading order.',
  '',
  '5. Final Output: The entire output must be a single JSON object.',
].join('\n');

export const VLM_MODELS: readonly VlmModelDef[] = [
  {
    id: 'dots-ocr',
    repo: 'mlx-community/dots.ocr-4bit',
    prompt: DOTS_PROMPT,
    dialect: 'dots-json',
    // A dense index page — two columns of surnames and page numbers, no prose —
    // ran past 4096 and came back truncated. The cap is not a budget, it is a
    // stop for a model that has started repeating itself, so it is set where a
    // real page cannot reach it. Measured on this machine, no page of any book
    // read today went past 1,700 tokens.
    maxTokens: 8192,
    maxPixels: 11289600,
    endpointModel: 'rednote-hilab/dots.ocr',
    notes:
      'THE DEFAULT (Aug 7 2026), and the only model here that answers with geometry. Its '
      + 'answer is a JSON array of {bbox, category, text} in reading order over eleven '
      + 'categories, which is what lets this mode do the things a stream of markdown cannot: '
      + 'drop Page-header and Page-footer without a tag convention, crop a Picture out of the '
      + 'page render and embed it with its Caption, judge a centered epigraph against the '
      + "BOOK'S body column, collect Footnote blocks to the end of their chapter, and join a "
      + 'paragraph across a page turn by measuring ink in the render. Measured on the 17-page '
      + 'Kershaw article: 0.80% character error against the PDF\'s own text layer at roughly '
      + '27 s a page (4-bit MLX, M1 Ultra), and 35% of blocks arriving as Text that a human '
      + 'would call furniture is what the categories fix. The weights are somebody else\'s '
      + 'and no prompting adds a category the model was not trained on.',
  },
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
 *
 * It became `dots-ocr` on 7 Aug 2026. Nanonets reads a page marginally more
 * accurately and produces a WORSE BOOK, because a stream of markdown cannot say
 * which paragraph was a running head, where a picture was, or that four lines
 * were a footnote — a third of its blocks arrive as ordinary body text that a
 * reader would call furniture, and nothing downstream can tell. The three
 * markdown models stay: they are what dots is measured against.
 */
export const DEFAULT_VLM_MODEL_ID = 'dots-ocr';

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
