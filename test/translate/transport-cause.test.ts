/**
 * THE TRANSPORT'S OWN FAILURES, AS FACTS RATHER THAN AS PROSE.
 *
 * ── WHAT THESE PIN ──────────────────────────────────────────────────────────
 *
 * Three findings of BUG-HUNT-2026-09-20 §A, all of them one defect seen from
 * three sides: this program composed a sentence about a failure and then had to
 * read the sentence back to decide what to do.
 *
 *  - **F3b.** `fetchTransport` turns its own deadline into *"<url> — no answer
 *    in 300s"*, and the clean pass's `isTransportFailure` regexed
 *    `fetch|network|socket|timeout|…` out of it. None of those words is in that
 *    sentence, so the ONE failure this program raises itself was the one it did
 *    not re-roll: a dropped socket got a second chance and a timeout ended the
 *    book on attempt one.
 *  - **F3a.** `REQUEST_TIMEOUT_MS` is armed at SEND, so it is a TOTAL deadline;
 *    twelve of them in flight against a server that queues gives the last one
 *    the eleven ahead of it out of its own budget. And twelve was chosen for a
 *    vLLM's batch, not for a Crucible chat proxy fronting a serial engine.
 *  - **F3b, second half.** A Crucible answers 503 when no lane is free and 409
 *    when the lane is leased. Both were hard failures of the whole book on a
 *    door whose busy list held only 429.
 */
import { describe, expect, test } from 'bun:test';

import {
  askAboutEach, type NormalizerAsk, type NumberNormalizerRunner,
} from '../../src/clean/tts-number-normalizer.js';
import {
  CRUCIBLE_CHAT_CONCURRENCY, concurrencyFor, DEFAULT_TEXT_CONCURRENCY,
} from '../../src/translate/model-server.js';
import {
  deadlineForConcurrency, fetchTransport, REQUEST_TIMEOUT_MS, TransportError,
  type HttpResponse, type Transport,
} from '../../src/translate/transport.js';
import { complete } from '../../src/translate/vllm.js';
import { isCrucibleOpenAiDoor } from '../../src/vlm/contract.js';

const CRUCIBLE = 'http://fake:7100/openai/v1';
const VLLM = 'http://fake:8000/v1';

/**
 * A `fetch` that answers nothing until its signal aborts — which is exactly
 * what the real one does to a request that outruns its deadline, and is the
 * only way to reach that branch without waiting on a wedged server.
 */
async function withHangingFetch<T>(body: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = ((_url: unknown, init?: RequestInit) => new Promise((_ok, fail) => {
    init?.signal?.addEventListener('abort', () => {
      const aborted = new Error('The operation was aborted.');
      aborted.name = 'AbortError';
      fail(aborted);
    });
  })) as typeof fetch;
  try {
    return await body();
  } finally {
    globalThis.fetch = real;
  }
}

describe('F3b — the engine\'s own deadline says so in a field', () => {
  test('a request that outruns its deadline throws a TransportError whose cause is timeout',
    async () => {
      const error = await withHangingFetch(async () => {
        try {
          await fetchTransport(5, {}).post('http://fake:8000/v1/chat/completions', '{}');
          return null;
        } catch (err) { return err; }
      });

      expect(error).toBeInstanceOf(TransportError);
      // The prose is still for people, and still names the endpoint.
      expect((error as Error).message).toContain('http://fake:8000/v1/chat/completions');
      expect((error as Error).message).toContain('no answer in');
      // And the CAUSE is a value, which is what a caller reads.
      expect((error as TransportError).cause).toBe('timeout');
    });

  test('the deadline\'s own error re-rolls exactly once, and the block is answered', async () => {
    const asks: NormalizerAsk[] = [
      { key: 'b1-1', text: 'They met on the first floor.', segments: [28], previous: null, next: null },
    ];
    let calls = 0;
    const runner: NumberNormalizerRunner = {
      model: 'a stub that times out once',
      async generate(): Promise<string> {
        calls += 1;
        // Byte for byte what `fetchTransport` composes for its own deadline —
        // the sentence the old regex could not recognise.
        if (calls === 1) throw new TransportError(`${VLLM} — no answer in 300s`, 'timeout');
        return '{"edits": []}';
      },
      async release(): Promise<void> { /* nothing was loaded. */ },
    };

    const settled = await askAboutEach(asks, runner, 'clean-text', 'system', undefined, 'every-block');

    expect(calls).toBe(2);
    expect(settled.decisions.get('b1-1')!.status).toBe('ANSWERED');
    expect(settled.parseFailed).toBe(0);
  });

  test('a failure that survives its one re-roll still ends the pass', async () => {
    const asks: NormalizerAsk[] = [
      { key: 'b1-1', text: 'They met on the first floor.', segments: [28], previous: null, next: null },
    ];
    let calls = 0;
    const runner: NumberNormalizerRunner = {
      model: 'a stub that always times out',
      async generate(): Promise<string> {
        calls += 1;
        throw new TransportError(`${VLLM} — no answer in 300s`, 'timeout');
      },
      async release(): Promise<void> { /* nothing was loaded. */ },
    };

    await expect(askAboutEach(asks, runner, 'clean-text', 'system', undefined, 'every-block'))
      .rejects.toThrow(/could not reach the model/);
    expect(calls).toBe(2);
  });

  test('a foreign runner\'s prose is still read, because that is all it offers', async () => {
    const asks: NormalizerAsk[] = [
      { key: 'b1-1', text: 'They met on the first floor.', segments: [28], previous: null, next: null },
    ];
    let calls = 0;
    const runner: NumberNormalizerRunner = {
      model: 'a stub bound by another program',
      async generate(): Promise<string> {
        calls += 1;
        if (calls === 1) throw new Error('fetch failed: ECONNRESET');
        return '{"edits": []}';
      },
      async release(): Promise<void> { /* nothing was loaded. */ },
    };

    const settled = await askAboutEach(asks, runner, 'clean-text', 'system', undefined, 'every-block');
    expect(calls).toBe(2);
    expect(settled.decisions.get('b1-1')!.status).toBe('ANSWERED');
  });

  test('a refusal that is NOT the transport is not re-rolled', async () => {
    const asks: NormalizerAsk[] = [
      { key: 'b1-1', text: 'They met on the first floor.', segments: [28], previous: null, next: null },
    ];
    let calls = 0;
    const runner: NumberNormalizerRunner = {
      model: 'a stub with no such model',
      async generate(): Promise<string> {
        calls += 1;
        throw new Error('no model named qwen3.8:27b — installed: qwen3:8b');
      },
      async release(): Promise<void> { /* nothing was loaded. */ },
    };

    await expect(askAboutEach(asks, runner, 'clean-text', 'system', undefined, 'every-block'))
      .rejects.toThrow(/no model named/);
    expect(calls).toBe(1);
  });
});

describe('F3a — the pool and the deadline agree, and a Crucible gets its own knee', () => {
  test('a Crucible chat door is recognised in both of the spellings that reach it', () => {
    expect(isCrucibleOpenAiDoor(CRUCIBLE)).toBe(true);
    expect(isCrucibleOpenAiDoor('http://fake:7100/openai/v1/')).toBe(true);
    // What `normaliseVllmEndpoint` has not yet put a `/v1` on — what a person types.
    expect(isCrucibleOpenAiDoor('http://fake:7100/openai')).toBe(true);
    // And what is not one.
    expect(isCrucibleOpenAiDoor(VLLM)).toBe(false);
    expect(isCrucibleOpenAiDoor('http://fake:8000/openai-proxy/v1')).toBe(false);
  });

  test('the OpenAI door takes the act\'s number, and a Crucible chat door takes four', () => {
    expect(concurrencyFor('openai', DEFAULT_TEXT_CONCURRENCY, VLLM)).toBe(DEFAULT_TEXT_CONCURRENCY);
    expect(concurrencyFor('openai', DEFAULT_TEXT_CONCURRENCY, CRUCIBLE))
      .toBe(CRUCIBLE_CHAT_CONCURRENCY);
    // A caller with no endpoint in hand gets exactly what it always got.
    expect(concurrencyFor('openai', DEFAULT_TEXT_CONCURRENCY)).toBe(DEFAULT_TEXT_CONCURRENCY);
    // The other two doors are decided by the door, endpoint or no endpoint.
    expect(concurrencyFor('ollama', DEFAULT_TEXT_CONCURRENCY, CRUCIBLE)).toBe(4);
    expect(concurrencyFor('anthropic', DEFAULT_TEXT_CONCURRENCY, CRUCIBLE)).toBe(4);
  });

  test('the deadline is the per-request budget times the pool depth', () => {
    expect(deadlineForConcurrency(1)).toBe(REQUEST_TIMEOUT_MS);
    expect(deadlineForConcurrency(4)).toBe(REQUEST_TIMEOUT_MS * 4);
    expect(deadlineForConcurrency(12)).toBe(REQUEST_TIMEOUT_MS * 12);
    // Never below one request's worth, whatever nonsense is handed in.
    expect(deadlineForConcurrency(0)).toBe(REQUEST_TIMEOUT_MS);
    expect(deadlineForConcurrency(-3)).toBe(REQUEST_TIMEOUT_MS);
  });
});

describe('F3b — a busy Crucible is waited out, not treated as a broken server', () => {
  /** Answers each status in turn, then 200 forever. `retry-after: 0` keeps it quick. */
  function transportAnswering(statuses: readonly number[]): Transport & { sent: number } {
    const answer = JSON.stringify({ choices: [{ message: { content: 'the answer' } }] });
    const fake = {
      sent: 0,
      async get(): Promise<HttpResponse> { throw new Error('not asked'); },
      async post(): Promise<HttpResponse> {
        const status = statuses[fake.sent];
        fake.sent += 1;
        if (status === undefined) return { status: 200, body: answer };
        return { status, body: '{"detail":"busy"}', headers: { 'retry-after': '0' } };
      },
    };
    return fake;
  }

  const served = { id: 'qwen3.5-9b', maxModelLen: 32768, defaults: null };

  for (const [status, why] of [[503, 'no lane free'], [409, 'the lane is leased']] as const) {
    test(`${status} (${why}) is waited out and the book goes on`, async () => {
      const transport = transportAnswering([status, status]);
      const text = await complete(transport, CRUCIBLE, served, 'system', 'user',
        { temperature: 0 });
      expect(text).toBe('the answer');
      expect(transport.sent).toBe(3);
    });
  }

  test('429 is still waited out — the status that was always on the list', async () => {
    const transport = transportAnswering([429]);
    expect(await complete(transport, CRUCIBLE, served, 'system', 'user', { temperature: 0 }))
      .toBe('the answer');
    expect(transport.sent).toBe(2);
  });

  test('a status that means broken still ends the run on the first answer', async () => {
    const transport = transportAnswering([500]);
    await expect(complete(transport, CRUCIBLE, served, 'system', 'user', { temperature: 0 }))
      .rejects.toThrow();
    expect(transport.sent).toBe(1);
  });
});
