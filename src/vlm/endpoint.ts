/**
 * vlm/endpoint — reading the pages on somebody else's GPU.
 *
 * The MLX path holds the model in one Python process on this machine and reads
 * the pages one at a time, because that is what Apple silicon can do. A vLLM
 * server on a 3090 reads twelve at a time and is an order of magnitude faster
 * per book, and it speaks the OpenAI chat-completions shape. `--vlm-endpoint`
 * points at one; everything else about the run is identical, and deliberately
 * so — the SAME verbatim prompt, the same 200 dpi render, the same dialect.
 *
 * A CHAT ENDPOINT IS ALLOWED HERE, AND IS NOT ALLOWED ANYWHERE ELSE IN FOUNDRY.
 * ARCHITECTURE §4 forbids one for the stage models, and the reason is precise:
 * those weights were trained on a prompt THIS PROJECT built, byte for byte,
 * with an empty `<think>\n\n</think>` block a stock template omits — so a server
 * that re-templates hands the model a shape it never saw and quietly answers
 * worse. A document VLM is the other case. Its published interface IS the chat
 * template: the model card's example is a chat turn with an image part and a
 * text part, the MLX path reaches the same template through
 * `apply_chat_template`, and building the string by hand HERE would be the
 * violation. What is sacred is that the model gets the shape it was trained on.
 * On this route that shape is a chat turn.
 *
 * TEMPERATURE ZERO, always. A layout answer is a measurement of a page; the
 * same page read twice has one right answer, and sampling would make a book
 * that cannot be reproduced from the PDF it came from.
 *
 * CONCURRENCY IS TWELVE by default, which is the measured knee on the machine
 * this was built against — the server keeps its batch full and per-page latency
 * has not started climbing. It is an option because the number is a property of
 * somebody else's GPU, not of this program.
 *
 * NOTHING IS RETRIED. A page that failed is named and the run stops, and
 * `--readings` is what makes that cheap: every page that landed is already on
 * disk, so the re-run pays for the pages that did not.
 */
import * as fs from 'node:fs';

export class VlmEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VlmEndpointError';
  }
}

/** One page, read over HTTP. Same shape the MLX path reports. */
export interface EndpointPageResult {
  number: number;
  text: string;
  tokens: number;
  finishReason: string | null;
  seconds: number;
  /**
   * THE SERVER'S WHOLE ANSWER, decoded and otherwise untouched.
   *
   * The four fields above are what this program reads out of it, and they used
   * to be all that survived this function. Everything else the server said went
   * on the floor here: the prompt/completion token split, the model id it
   * actually served under, the response id that identifies the request in its
   * own logs, and whatever a particular build adds. A page costs GPU-minutes, so
   * getting any of that back means reading the page again — which is the one
   * thing the bank exists to prevent. It is carried up to `convert.ts` and
   * banked verbatim beside the parsed fields (`readings.ts`).
   */
  response: unknown;
}

export interface EndpointRequest {
  number: number;
  /** The PNG the render pass left on disk. */
  imagePath: string;
}

export interface VlmEndpointOptions {
  /** Base URL, OpenAI-compatible — `http://host:8000/v1`. */
  endpoint: string;
  /** The name the server was started with. */
  model: string;
  /** The model card's prompt, verbatim. Never built here. */
  prompt: string;
  maxTokens: number;
  concurrency: number;
  pages: readonly EndpointRequest[];
  onPage: (page: EndpointPageResult) => void;
}

export const DEFAULT_VLM_CONCURRENCY = 12;

export async function readPagesFromEndpoint(opts: VlmEndpointOptions): Promise<void> {
  const url = `${opts.endpoint.replace(/\/+$/, '')}/chat/completions`;
  const queue = [...opts.pages];
  const workers = Math.max(1, Math.min(opts.concurrency, queue.length));

  const next = (): EndpointRequest | undefined => queue.shift();

  const run = async (): Promise<void> => {
    for (let page = next(); page !== undefined; page = next()) {
      opts.onPage(await readOnePage(url, page, opts));
    }
  };

  await Promise.all(Array.from({ length: workers }, run));
}

async function readOnePage(
  url: string,
  page: EndpointRequest,
  opts: VlmEndpointOptions,
): Promise<EndpointPageResult> {
  const image = fs.readFileSync(page.imagePath).toString('base64');
  const started = Date.now();

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: opts.model,
        temperature: 0,
        max_tokens: opts.maxTokens,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/png;base64,${image}` } },
            { type: 'text', text: opts.prompt },
          ],
        }],
      }),
    });
  } catch (err) {
    throw new VlmEndpointError(
      `page ${page.number}: ${url} could not be reached (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  if (!response.ok) {
    const body = (await response.text()).slice(0, 400);
    throw new VlmEndpointError(
      `page ${page.number}: ${url} answered ${response.status} ${response.statusText}. ${body}`,
    );
  }

  /*
   * Decoded ONCE and read twice: `payload` is the record that gets banked and
   * `answer` is the same object seen through the few fields this program needs.
   * Parsing it a second time into a narrower shape would be the moment the two
   * could disagree about what the server said.
   */
  const payload: unknown = await response.json();
  const answer = payload as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
    usage?: { completion_tokens?: number };
  };
  const choice = answer.choices?.[0];
  if (!choice || typeof choice.message?.content !== 'string') {
    throw new VlmEndpointError(
      `page ${page.number}: the server's answer carries no message content. `
      + `It was: ${JSON.stringify(payload).slice(0, 400)}`,
    );
  }

  return {
    number: page.number,
    text: choice.message.content.trim(),
    tokens: answer.usage?.completion_tokens ?? 0,
    finishReason: choice.finish_reason ?? null,
    seconds: (Date.now() - started) / 1000,
    response: payload,
  };
}
