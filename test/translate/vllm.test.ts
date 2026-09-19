/**
 * The OpenAI door's listing and the body it builds from what the listing said.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 *
 * Crucible publishes per-model `defaults` on `/openai/v1/models` — temperature,
 * top_p, top_k, max_tokens, repetition_penalty and thinking — and it added them
 * BY NAME for this program (PHASE2-LLM.md section 9). Foundry read `id` and
 * `max_model_len` and dropped the rest on the floor, and the header of
 * `vllm.ts` still said the switch was sent "until they land". They had landed.
 *
 * The precedence is the server's and it is one line: a field the request STATES
 * wins, a field the request omits takes the manifest's, a field neither states
 * is the engine's. So what is asserted here is which fields Foundry has a
 * reason to state and which it does not — because a pinned number with no
 * reason beside it is exactly the thing that makes somebody's `[defaults]`
 * block inert without saying so.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  completionsBody,
  constrainedChatBody,
  servedModels,
  type ServedModel,
} from '../../src/translate/vllm.js';
import type { HttpResponse, Transport } from '../../src/translate/transport.js';

const ENDPOINT = 'http://fake:7100/openai/v1';

/**
 * `GET /openai/v1/models` as Crucible answers it, captured from `api.py`'s
 * `openai_models`. `max_tokens` is null there and null means "the engine's
 * own" — never a number Crucible picked.
 */
const CRUCIBLE_LISTING = JSON.stringify({
  object: 'list',
  data: [
    {
      id: 'qwen3.5-9b',
      object: 'model',
      created: 1789000000,
      owned_by: 'crucible@owens-pc-wsl',
      engine_model_name: 'Qwen/Qwen3.5-9B-Instruct-AWQ',
      revision: 'main',
      fingerprint: 'sha256:abc',
      max_model_len: 32768,
      defaults: {
        temperature: 0.7,
        top_p: 0.8,
        top_k: 20,
        max_tokens: null,
        repetition_penalty: 1.05,
        thinking: false,
      },
    },
  ],
});

/** A plain vLLM: no `defaults` key at all. */
const BARE_LISTING = JSON.stringify({
  object: 'list',
  data: [{ id: 'Qwen/Qwen3-32B-AWQ', object: 'model', max_model_len: 40960 }],
});

function listing(body: string): Transport {
  return {
    get: async (): Promise<HttpResponse> => ({ status: 200, body }),
    post: async (): Promise<HttpResponse> => {
      throw new Error('this fixture answers listings only');
    },
  };
}

// ── the parse ────────────────────────────────────────────────────────────────

test('a Crucible listing hands back all six defaults, nulls included', async () => {
  const [served] = await servedModels(listing(CRUCIBLE_LISTING), ENDPOINT);
  assert.equal(served!.id, 'qwen3.5-9b');
  assert.equal(served!.maxModelLen, 32768);
  assert.deepEqual(served!.defaults, {
    temperature: 0.7,
    topP: 0.8,
    topK: 20,
    maxTokens: null,
    repetitionPenalty: 1.05,
    thinking: false,
  });
});

test('a server that publishes no defaults says so with null, not with an empty block', async () => {
  // Two different statements: "this server states nothing about sampling" and
  // "this server states that every knob is the engine's". Collapsing them
  // would make a bare vLLM and a manifest with an empty `[defaults]` read the
  // same, and only the second one is a decision somebody made.
  const [served] = await servedModels(listing(BARE_LISTING), ENDPOINT);
  assert.equal(served!.defaults, null);
});

// ── the body ─────────────────────────────────────────────────────────────────

function bodyOf(defaults: ServedModel['defaults']): Record<string, unknown> {
  return JSON.parse(completionsBody(
    'qwen3.5-9b', 'system', 'user', { temperature: 0.2 }, 32768, defaults,
  )) as Record<string, unknown>;
}

test('a knob Foundry has no reason for is sent as the server published it', async () => {
  const [served] = await servedModels(listing(CRUCIBLE_LISTING), ENDPOINT);
  const body = bodyOf(served!.defaults);
  assert.equal(body['top_p'], 0.8);
  assert.equal(body['top_k'], 20);
  assert.equal(body['repetition_penalty'], 1.05);
});

test('a knob the server left at the engine\'s own is not invented here', () => {
  // `max_tokens: null` in the block is the server saying "the engine's", and
  // Foundry's own `max_tokens` is sized from the request either way — what
  // must not happen is a `repetition_penalty: null` reaching the wire, where
  // it is a stated field with no value.
  const body = bodyOf({
    temperature: null, topP: null, topK: null,
    maxTokens: null, repetitionPenalty: null, thinking: null,
  });
  assert.equal('top_p' in body, false);
  assert.equal('top_k' in body, false);
  assert.equal('repetition_penalty' in body, false);
});

test('a server with nothing to say leaves the body exactly as it was', () => {
  const body = bodyOf(null);
  assert.equal('top_p' in body, false);
  assert.equal('top_k' in body, false);
  assert.equal('repetition_penalty' in body, false);
  assert.equal(body['temperature'], 0.2);
});

test('the server\'s temperature never displaces the act\'s measured one', async () => {
  // 0.2 is translate's, measured: zero made the 14b repeat clauses and above
  // ~0.4 the 32b invented connectives. That is a stated reason, so it wins —
  // the precedence rule is about knobs nobody stated, not about deferring.
  const [served] = await servedModels(listing(CRUCIBLE_LISTING), ENDPOINT);
  assert.equal(bodyOf(served!.defaults)['temperature'], 0.2);
});

test('the server\'s max_tokens never displaces the one sized for this request', async () => {
  const [served] = await servedModels(listing(CRUCIBLE_LISTING), ENDPOINT);
  const withCeiling = JSON.parse(completionsBody(
    'qwen3.5-9b', 'system', 'user', { temperature: 0.2, numPredict: 700 }, 32768,
    { ...served!.defaults!, maxTokens: 64 },
  )) as Record<string, unknown>;
  assert.equal(withCeiling['max_tokens'], 700);
});

test('the thinking switch is still STATED for the family that takes it', async () => {
  // The header's ruling, preserved: `takesThinkField` is a reason in code, and
  // a family that takes the argument gets it stated whatever the manifest
  // says. A server that also states `thinking` is answering the same way.
  const [served] = await servedModels(listing(CRUCIBLE_LISTING), ENDPOINT);
  const body = bodyOf(served!.defaults);
  assert.deepEqual(body['chat_template_kwargs'], { enable_thinking: false });
});

test('a family that takes no thinking argument is not given one by the block', () => {
  const body = JSON.parse(completionsBody(
    'gpt-4o', 'system', 'user', { temperature: 0.2 }, null,
    { temperature: null, topP: 0.8, topK: null, maxTokens: null, repetitionPenalty: null, thinking: true },
  )) as Record<string, unknown>;
  assert.equal('chat_template_kwargs' in body, false);
  assert.equal(body['top_p'], 0.8);
});

test('the closed question takes the same unstated knobs', () => {
  // `analyze` constrains the decode and pins temperature 0; everything it does
  // NOT state is the server's, exactly as on the open door.
  const body = JSON.parse(constrainedChatBody(
    'qwen3.5-9b', 'prompt', { type: 'object' }, 256, 32768,
    { temperature: 0.7, topP: 0.8, topK: 20, maxTokens: null, repetitionPenalty: 1.05, thinking: false },
  )) as Record<string, unknown>;
  assert.equal(body['temperature'], 0);
  assert.equal(body['top_p'], 0.8);
  assert.equal(body['repetition_penalty'], 1.05);
});
