/**
 * THE POOL IS THE SERVER'S NUMBER, AND THE WAIT IS A CLOCK — BUG-HUNT §A, PK8.
 *
 * ── The night these are about ───────────────────────────────────────────────
 *
 * 2026-09-20, ~05:05 ET. Crucible 1.0.10 admits `chat.max_in_flight` chats per
 * engine — 2 on the Mac's serial `mlx-lm` — and refuses the rest `503
 * chat_queue_full` with its own `Retry-After`. Foundry's clean pass sent four:
 * two were admitted and generated for ~30 s each, and the two that were refused
 * burned six attempts at the server's 4 s retry-after — twenty-four seconds —
 * and then FAILED THE WHOLE PASS on a condition that was seconds from clearing.
 *
 * Three facts were wrong, and each has its own describe below:
 *
 *  1. The pool was a number this program chose (`CRUCIBLE_CHAT_CONCURRENCY`, the
 *     Sep 8 throughput knee) against a server that publishes what it will ACCEPT.
 *     A knee is an opinion about speed; an admission limit is a fact about
 *     refusal, and it wins — over the default AND over `--concurrency`, because
 *     the number arriving on that flag is usually a PLACEMENT composed by a build
 *     of the app older than the server it is placing against, and a running dist
 *     cannot be corrected without a restart. Below the stated maximum a flag is
 *     honoured untouched: fewer is a preference the server has no view on.
 *  2. The wait was counted in ATTEMPTS. Six is the right shape for a token
 *     bucket and the wrong one for a serial engine, where "no lane free" means
 *     "when the block in front of you finishes" and the block takes what it takes.
 *  3. The failure named the wrong pass. `askForEdits` said "the number-
 *     normalization pass" to every caller, including the clean pass that died.
 */
import { describe, expect, test } from 'bun:test';

import {
  askAboutEach, type NormalizerAsk, type NumberNormalizerRunner,
} from '../../src/clean/tts-number-normalizer.js';
import {
  CRUCIBLE_CHAT_CONCURRENCY, chatDepthStated, DEFAULT_TEXT_CONCURRENCY, resolveConcurrency,
} from '../../src/translate/model-server.js';
import {
  REQUEST_TIMEOUT_MS, TransportError, withBusyWait,
  type HttpResponse, type Transport,
} from '../../src/translate/transport.js';
import { chatActivityUrl } from '../../src/vlm/contract.js';

const CRUCIBLE = 'http://fake:7100/openai/v1';
const VLLM = 'http://fake:8000/v1';

/**
 * A transport that answers ONE `/v1/activity` document and refuses everything
 * else, remembering what it was asked. `chat.max_in_flight` is spelled as
 * Crucible spells it on the wire, snake_case, because that is the whole thing
 * under test — a reader keyed on a camelCase name would pass here and read
 * nothing from a real server.
 */
function activitySaying(maxInFlight: number | null, basis = 'engine concurrency 1, +1'): Transport & { asked: string[] } {
  const fake = {
    asked: [] as string[],
    async get(url: string): Promise<HttpResponse> {
      fake.asked.push(url);
      return {
        status: 200,
        body: JSON.stringify({
          chat: { in_flight: 0, rows: [], max_in_flight: maxInFlight, max_in_flight_basis: basis },
          slots: { accelerated: { busy: 0, of: 1, queue_depth: 0, accepts_work: true } },
        }),
      };
    },
    async post(): Promise<HttpResponse> { throw new Error('the depth read never POSTs'); },
  };
  return fake;
}

describe('the chat pool comes from the server that has to admit it', () => {
  test('the activity URL is composed from either spelling of the door, and only from a door', () => {
    expect(chatActivityUrl(CRUCIBLE)).toBe('http://fake:7100/v1/activity');
    expect(chatActivityUrl('http://fake:7100/openai/v1/')).toBe('http://fake:7100/v1/activity');
    // What a person types, before `normaliseVllmEndpoint` appends the version.
    expect(chatActivityUrl('http://fake:7100/openai')).toBe('http://fake:7100/v1/activity');
    // And what is not a Crucible door at all.
    expect(chatActivityUrl(VLLM)).toBeNull();
    expect(chatActivityUrl('http://fake:11434')).toBeNull();
  });

  test('a stated depth is read; anything that is not a usable number is "it did not say"', () => {
    expect(chatDepthStated({ chat: { max_in_flight: 2 } })).toBe(2);
    // Null is the server's own word for "no engine resident / nothing measured".
    expect(chatDepthStated({ chat: { max_in_flight: null } })).toBeNull();
    // A vLLM behind the same door states nothing at all.
    expect(chatDepthStated({ chat: { in_flight: 3, rows: [] } })).toBeNull();
    // Zero would be a server saying it admits nothing, which no client can act
    // on — read as silence rather than as a pool of none.
    expect(chatDepthStated({ chat: { max_in_flight: 0 } })).toBeNull();
    expect(chatDepthStated({ chat: { max_in_flight: 'two' } })).toBeNull();
    expect(chatDepthStated(null)).toBeNull();
  });

  test('a server that admits 2 gets a pool of 2', async () => {
    const transport = activitySaying(2);
    const lines: string[] = [];
    const pool = await resolveConcurrency({
      kind: 'openai', openaiDefault: DEFAULT_TEXT_CONCURRENCY, endpoint: CRUCIBLE,
      transport, log: (line) => lines.push(line),
    });
    expect(pool).toBe(2);
    expect(transport.asked).toEqual(['http://fake:7100/v1/activity']);
    // It says which number it took and where from — a run at four against a
    // server admitting two must not look like a run that asked and was told four.
    expect(lines.join('\n')).toContain('admits 2 chats at once');
  });

  test('a server that states nothing gets the measured knee of four, said out loud', async () => {
    const lines: string[] = [];
    const pool = await resolveConcurrency({
      kind: 'openai', openaiDefault: DEFAULT_TEXT_CONCURRENCY, endpoint: CRUCIBLE,
      transport: activitySaying(null), log: (line) => lines.push(line),
    });
    expect(pool).toBe(CRUCIBLE_CHAT_CONCURRENCY);
    expect(lines.join('\n')).toContain('states no chat depth');
  });

  test('a door that publishes no such thing is never asked, and keeps its own default', async () => {
    const transport = activitySaying(2);
    expect(await resolveConcurrency({
      kind: 'openai', openaiDefault: DEFAULT_TEXT_CONCURRENCY, endpoint: VLLM, transport,
    })).toBe(DEFAULT_TEXT_CONCURRENCY);
    expect(await resolveConcurrency({
      kind: 'ollama', openaiDefault: DEFAULT_TEXT_CONCURRENCY, endpoint: CRUCIBLE, transport,
    })).toBe(4);
    expect(await resolveConcurrency({
      kind: 'anthropic', openaiDefault: DEFAULT_TEXT_CONCURRENCY, endpoint: CRUCIBLE, transport,
    })).toBe(4);
    expect(transport.asked).toEqual([]);
  });

  test('a depth read that fails is a fallback and a line, never the end of the run', async () => {
    const lines: string[] = [];
    const dead: Transport = {
      async get(): Promise<HttpResponse> { throw new TransportError('gone', 'network'); },
      async post(): Promise<HttpResponse> { throw new Error('not asked'); },
    };
    expect(await resolveConcurrency({
      kind: 'openai', openaiDefault: DEFAULT_TEXT_CONCURRENCY, endpoint: CRUCIBLE,
      transport: dead, log: (line) => lines.push(line),
    })).toBe(CRUCIBLE_CHAT_CONCURRENCY);
    expect(lines.join('\n')).toContain('could not be read');
  });

  test('a 404 — a Crucible older than 1.0.10 — is "it did not say", not a failure', async () => {
    const old: Transport = {
      async get(): Promise<HttpResponse> { return { status: 404, body: 'Not Found' }; },
      async post(): Promise<HttpResponse> { throw new Error('not asked'); },
    };
    expect(await resolveConcurrency({
      kind: 'openai', openaiDefault: DEFAULT_TEXT_CONCURRENCY, endpoint: CRUCIBLE, transport: old,
      log: () => {},
    })).toBe(CRUCIBLE_CHAT_CONCURRENCY);
  });

  /**
   * ── THE CLAMP, WHICH IS THE ONE PLACE A FLAG DOES NOT WIN ─────────────────
   *
   * The number on `--concurrency` is most often not a person: it is
   * `Placement.concurrency`, composed by whatever build of the app is running,
   * and the app that was running the night this was found sends 4 and cannot be
   * told otherwise without a restart. A stale number about somebody else's
   * backend must not outrank that backend's own admission limit.
   */
  test('a flag ABOVE the stated maximum is clamped to it, naming both numbers', async () => {
    const lines: string[] = [];
    const pool = await resolveConcurrency({
      asked: 4,
      kind: 'openai', openaiDefault: DEFAULT_TEXT_CONCURRENCY, endpoint: CRUCIBLE,
      transport: activitySaying(2), log: (line) => lines.push(line),
    });
    expect(pool).toBe(2);
    const said = lines.join('\n');
    expect(said).toContain('asked for 4 requests in flight and the server admits 2');
    expect(said).toContain('503 chat_queue_full');
  });

  test('a flag BELOW the stated maximum is honoured untouched', async () => {
    const lines: string[] = [];
    const pool = await resolveConcurrency({
      asked: 1,
      kind: 'openai', openaiDefault: DEFAULT_TEXT_CONCURRENCY, endpoint: CRUCIBLE,
      transport: activitySaying(2), log: (line) => lines.push(line),
    });
    expect(pool).toBe(1);
    expect(lines.join('\n')).not.toContain('so it will keep');
  });

  test('with nothing stated, the flag stands whole', async () => {
    expect(await resolveConcurrency({
      asked: 8,
      kind: 'openai', openaiDefault: DEFAULT_TEXT_CONCURRENCY, endpoint: CRUCIBLE,
      transport: activitySaying(null), log: () => {},
    })).toBe(8);
  });
});

describe('the busy wait is a clock, not six attempts', () => {
  /** Answers `status` `refusals` times, then 200. `retry-after: 0` keeps it quick. */
  function refusing(refusals: number, status = 503): (() => Promise<HttpResponse>) & { sent: number } {
    const send = Object.assign(
      async (): Promise<HttpResponse> => {
        send.sent += 1;
        return send.sent <= refusals
          ? { status, body: '{"error":{"code":"chat_queue_full"}}', headers: { 'retry-after': '0' } }
          : { status: 200, body: 'the answer' };
      },
      { sent: 0 },
    );
    return send;
  }

  test('three refusals then an answer — the request goes through, not six attempts later',
    async () => {
      const send = refusing(3);
      const response = await withBusyWait(send, { retryOn: [503], where: CRUCIBLE, log: () => {} });
      expect(response.status).toBe(200);
      expect(send.sent).toBe(4);
    });

  test('a server refusing past the budget hands the answer back, naming the wait and its words',
    async () => {
      const lines: string[] = [];
      let sent = 0;
      const response = await withBusyWait(
        async () => {
          sent += 1;
          return {
            status: 503,
            body: '{"error":{"code":"chat_queue_full","message":"2 chats in flight"}}',
            // Ten seconds against a one-second budget: the FIRST refusal already
            // has a next wait that outruns it, so nothing is slept off here.
            headers: { 'retry-after': '10' },
          };
        },
        { retryOn: [503], where: CRUCIBLE, budgetMs: 1_000, log: (line) => lines.push(line) },
      );
      expect(response.status).toBe(503);
      expect(sent).toBe(1);
      const said = lines.join('\n');
      expect(said).toContain('still refusing after');
      expect(said).toContain("would outrun this request's 1s budget");
      // The server's own words travel with the refusal, because a 503 from a
      // queue and a 503 from a misconfiguration wear the same status.
      expect(said).toContain('2 chats in flight');
    });

  test('the budget is the request\'s own deadline unless a caller says otherwise', async () => {
    // Not an assertion about a wait — it is the statement that waiting for a
    // slot and waiting for an answer are one clock, which is the whole fix.
    const lines: string[] = [];
    await withBusyWait(refusing(1), { retryOn: [503], where: CRUCIBLE, log: (line) => lines.push(line) });
    expect(lines.join('\n')).toContain(`${REQUEST_TIMEOUT_MS / 1000}s slot budget`);
  });

  test('the attempt cap still guards a server that says 503 for ever at retry-after 0', async () => {
    let sent = 0;
    const response = await withBusyWait(
      async () => {
        sent += 1;
        return { status: 503, body: 'busy', headers: { 'retry-after': '0' } };
      },
      { retryOn: [503], where: CRUCIBLE, log: () => {} },
    );
    expect(response.status).toBe(503);
    // Bounded, and far past six — the bound is time, and this is the guard.
    expect(sent).toBe(60);
  });
});

describe('a failure names the pass that was running', () => {
  const asks: NormalizerAsk[] = [
    { key: 'b1-1', text: 'They met on the first floor.', segments: [28], previous: null, next: null },
  ];

  function alwaysDown(): NumberNormalizerRunner {
    return {
      model: 'qwen3.5-9b',
      async generate(): Promise<string> {
        throw new TransportError(`${CRUCIBLE}/chat/completions — no answer in 300s`, 'timeout');
      },
      async release(): Promise<void> { /* nothing was loaded. */ },
    };
  }

  test('the clean pass says so, where it used to say "number-normalization"', async () => {
    await expect(askAboutEach(asks, alwaysDown(), 'clean-text', 'system', undefined, 'every-block'))
      .rejects.toThrow(/The clean-text pass could not reach the model 'qwen3\.5-9b'/);
  });

  test('and the number pass still says its own name', async () => {
    await expect(
      askAboutEach(asks, alwaysDown(), 'number-normalization', 'system', undefined, 'every-block'),
    ).rejects.toThrow(/The number-normalization pass could not reach the model/);
  });
});
