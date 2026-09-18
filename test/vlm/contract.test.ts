/**
 * The page-reading contract, read off the server rather than pinned here.
 *
 * `crucible/pages.py` owns the prompt, the dpi, the pixel budget, the ceiling
 * and the dialect, and publishes them on `GET /v1/info` as `pages_engine`
 * — because a prompt and a pixel budget are facts about the WEIGHTS, and this
 * program was keeping its own copies of all four. They agreed on the day they
 * were copied. The failure when they stop agreeing is not an error: it is a
 * book read slightly wrong, every figure cropped slightly wrong, and nobody
 * able to tell which run did it.
 *
 * So what is asserted here is the two halves of the seam: where the document
 * is, and that nothing is filled in when it is not there.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PageContractError,
  pagesInfoUrl,
  parsePagesEngine,
  readPageContract,
} from '../../src/vlm/contract.js';
import type { HttpResponse, Transport } from '../../src/translate/transport.js';

/**
 * `GET /v1/info` as a Crucible answers it, `pages_engine` verbatim from
 * `crucible/pages.py`'s `engine_block()` and `request_shape()`. The prompt is
 * a stand-in: what this file is about is the field names and the plumbing, and
 * the bytes of the prompt are the server's to be right about.
 */
function info(block: unknown): string {
  const body: Record<string, unknown> = {
    server: { name: 'crucible@owens-pc-wsl', version: '1.0.2', api_version: 1 },
    host: { platform: 'linux', arch: 'x86_64', backend: 'cuda-linux' },
    job_types: ['llm'],
    capabilities: [],
  };
  if (block !== undefined) body['pages_engine'] = block;
  return JSON.stringify(body);
}

function servedBlock(): Record<string, unknown> {
  return {
    engine: 'vllm',
    installed: true,
    detail: 'vllm serves dots-ocr from /home/telltale/.crucible/weights/dots-ocr',
    request: {
      model: 'dots-ocr',
      dpi: 200,
      max_pixels: 11289600,
      max_tokens: 8192,
      temperature: 0.0,
      prompt: 'Please output the layout information from the PDF image, …',
      dialect: 'dots-json',
      truncated_finish_reason: 'length',
    },
  };
}

function answering(status: number, body: string): Transport {
  return {
    get: async (): Promise<HttpResponse> => ({ status, body }),
    post: async (): Promise<HttpResponse> => {
      throw new Error('the contract is a GET');
    },
  };
}

// ── where the document is ────────────────────────────────────────────────────

test('the info document is the OpenAI base with its door taken off', () => {
  // `crucible-dispatch.ts` puts `<engine.url>/openai` on the placement and
  // `job-queue.ts` appends `/v1`, because `endpoint.ts` speaks
  // `<base>/chat/completions`. So the root is two segments up.
  assert.equal(
    pagesInfoUrl('http://owens-pc:7100/openai/v1'),
    'http://owens-pc:7100/v1/info',
  );
  assert.equal(
    pagesInfoUrl('http://owens-pc:7100/openai/v1/'),
    'http://owens-pc:7100/v1/info',
  );
});

test('an endpoint that is not a Crucible door is refused by name, not guessed at', () => {
  // A bare vLLM on :8000 publishes no contract, and there is deliberately
  // nothing here to fall back on — a default would be the pinned copies back
  // again, with nobody able to tell which run used which.
  assert.throws(
    () => pagesInfoUrl('http://localhost:8000/v1'),
    (error: unknown) => error instanceof PageContractError
      && /is not a Crucible's OpenAI door/.test((error as Error).message),
  );
});

// ── the parse ────────────────────────────────────────────────────────────────

test('a served block parses into the whole request, field for field', () => {
  const contract = parsePagesEngine(JSON.parse(info(servedBlock())), 'u');
  assert.equal(contract.model, 'dots-ocr');
  assert.equal(contract.dpi, 200);
  assert.equal(contract.maxPixels, 11289600);
  assert.equal(contract.maxTokens, 8192);
  assert.equal(contract.temperature, 0);
  assert.equal(contract.dialect, 'dots-json');
  assert.equal(contract.truncatedFinishReason, 'length');
  assert.match(contract.prompt, /^Please output the layout information/);
  assert.equal(contract.engine, 'vllm');
});

test('a host that serves no pages still publishes what a page request is', () => {
  // `engine: null` says THIS machine reads none; the request block is not a
  // property of the host and is there regardless. Nothing in this program
  // branches on the engine name — that is the whole point of the contract.
  const block = { ...servedBlock(), engine: null, installed: false };
  const contract = parsePagesEngine(JSON.parse(info(block)), 'u');
  assert.equal(contract.engine, null);
  assert.equal(contract.dialect, 'dots-json');
});

test('a document with no pages_engine is refused by name', () => {
  assert.throws(
    () => parsePagesEngine(JSON.parse(info(undefined)), 'http://x/v1/info'),
    (error: unknown) => error instanceof PageContractError
      && /publishes no "pages_engine"/.test((error as Error).message),
  );
});

test('a block with no request half is refused by name', () => {
  const block = servedBlock();
  delete block['request'];
  assert.throws(
    () => parsePagesEngine(JSON.parse(info(block)), 'http://x/v1/info'),
    (error: unknown) => error instanceof PageContractError
      && /carries no "request" block/.test((error as Error).message),
  );
});

test('a request missing one field is refused naming that field', () => {
  // Not a partial contract with the rest filled in: a request built out of
  // half of what the server said is a request this program invented the other
  // half of, and inventing a pixel budget is the exact failure in question.
  for (const key of [
    'model', 'dpi', 'max_pixels', 'max_tokens', 'temperature', 'prompt',
    'dialect', 'truncated_finish_reason',
  ]) {
    const block = servedBlock();
    const request = { ...(block['request'] as Record<string, unknown>) };
    delete request[key];
    block['request'] = request;
    assert.throws(
      () => parsePagesEngine(JSON.parse(info(block)), 'http://x/v1/info'),
      (error: unknown) => error instanceof PageContractError
        && new RegExp(`no usable "${key}"`).test((error as Error).message),
      `a missing ${key} must be refused by that name`,
    );
  }
});

// ── over the wire ────────────────────────────────────────────────────────────

test('the contract is read from the endpoint the pages would be posted to', async () => {
  const contract = await readPageContract(
    'http://owens-pc:7100/openai/v1', undefined, answering(200, info(servedBlock())),
  );
  assert.equal(contract.maxPixels, 11289600);
});

test('a server that answers something other than 200 is refused by name', async () => {
  await assert.rejects(
    readPageContract('http://owens-pc:7100/openai/v1', undefined, answering(404, '')),
    (error: unknown) => error instanceof PageContractError
      && /answered 404/.test((error as Error).message),
  );
});
