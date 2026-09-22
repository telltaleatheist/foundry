/**
 * The page reader through the weather — Owen's rule (BookForge, 2026-09-20):
 * a transient fault from the model server is retried within a stated budget,
 * then the run is PARKED by name, and the pages in flight beside the fault
 * LAND rather than being thrown away with the process.
 *
 * Every test stands up a real HTTP server, because the fault that started this
 * (page 32 of Everyday Denazification, a 502 from a proxy over a stale socket)
 * was a fact about a socket and a status, and a mocked `fetch` proves nothing
 * about either.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  PARKED_EXIT_CODE,
  readPagesFromEndpoint,
  VlmEndpointError,
  VlmParkedError,
  type EndpointPageResult,
} from '../../src/vlm/endpoint.js';

const image = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'weather-')), 'page.png');
fs.writeFileSync(image, Buffer.from('not really a png'));

const answer = (page: number): Response => Response.json({
  choices: [{ message: { content: `page ${page}` }, finish_reason: 'stop' }],
  usage: { completion_tokens: 3 },
});

/** A server whose behaviour per request is scripted by the test. */
function serve(handle: (nth: number, req: Request) => Response | Promise<Response>): { url: string; stop: () => void } {
  let nth = 0;
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      nth += 1;
      return handle(nth, req);
    },
  });
  return { url: `http://127.0.0.1:${server.port}/v1`, stop: () => server.stop(true) };
}

function options(url: string, pages: number[], concurrency = 1) {
  const landed: EndpointPageResult[] = [];
  const weather: string[] = [];
  return {
    landed,
    weather,
    opts: {
      endpoint: url,
      model: 'dots-ocr',
      prompt: 'read the page',
      temperature: 0,
      maxTokens: 100 as number | ((page: { number: number }) => number),
      concurrency,
      pages: pages.map((number) => ({ number, imagePath: image })),
      onPage: (page: EndpointPageResult) => { landed.push(page); },
      onWeather: (sentence: string) => { weather.push(sentence); },
      weatherWaitsMs: [1, 1, 1],
    },
  };
}

describe('the page reader through the weather', () => {
  test('a 502 that clears on the next try costs nothing but a sentence', async () => {
    const server = serve((nth) => (nth === 1
      ? new Response('{"error":{"code":"engine_unreachable","message":"ReadError: ."}}', { status: 502, statusText: 'Bad Gateway' })
      : answer(32)));
    try {
      const { opts, landed, weather } = options(server.url, [32]);
      await readPagesFromEndpoint(opts);
      expect(landed.map((p) => p.text)).toEqual(['page 32']);
      expect(weather).toHaveLength(1);
      expect(weather[0]).toContain('page 32');
      expect(weather[0]).toContain('502 Bad Gateway');
      expect(weather[0]).toContain('engine_unreachable');
      expect(weather[0]).toContain('trying again in');
      expect(weather[0]).toContain('(1 of 4)');
    } finally {
      server.stop();
    }
  });

  test('a socket that refuses is weather too, and the deadline is honoured as a park', async () => {
    // A port nobody is listening on: a connect refusal, the socket speaking.
    const { opts, weather } = options('http://127.0.0.1:1/v1', [7]);
    const err = await readPagesFromEndpoint(opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VlmParkedError);
    expect(weather).toHaveLength(3);
    expect(weather[0]).toContain('could not be reached');
  });

  test('weather that outlasts the budget parks the run by name, with its own exit code', async () => {
    const server = serve(() => new Response('busy', { status: 503, statusText: 'Service Unavailable' }));
    try {
      const { opts, landed, weather } = options(server.url, [32]);
      const err = await readPagesFromEndpoint(opts).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(VlmParkedError);
      const parked = err as VlmParkedError;
      expect(parked.exitCode).toBe(PARKED_EXIT_CODE);
      expect(parked.page).toBe(32);
      expect(parked.endpoint).toBe(server.url);
      expect(parked.message).toContain('parked:');
      expect(parked.message).toContain('page 32');
      expect(parked.message).toContain('4 tries');
      expect(parked.message).toContain('503 Service Unavailable');
      expect(parked.message).toContain('run the same command again');
      expect(weather).toHaveLength(3);
      expect(landed).toHaveLength(0);
    } finally {
      server.stop();
    }
  });

  test('a refusal that is not weather is named at once and never retried', async () => {
    let asked = 0;
    const server = serve(() => {
      asked += 1;
      return new Response('no such model', { status: 404, statusText: 'Not Found' });
    });
    try {
      const { opts, weather } = options(server.url, [3]);
      const err = await readPagesFromEndpoint(opts).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(VlmEndpointError);
      expect(err).not.toBeInstanceOf(VlmParkedError);
      expect((err as Error).message).toContain('404');
      expect(asked).toBe(1);
      expect(weather).toHaveLength(0);
    } finally {
      server.stop();
    }
  });

  test('the pages in flight beside a park LAND before the park is let out, and nothing more is sent', async () => {
    // Page 2 parks at once (every answer 503); pages 1 and 3 are slow but
    // healthy. With three in flight, 1 and 3 must land and 4 must never be sent.
    const sent: number[] = [];
    const server = serve(async (_nth, req) => {
      // The request does not carry the page number, so the test makes the
      // per-page cap the number and reads it back here.
      const cap = ((await req.json()) as { max_tokens: number }).max_tokens;
      sent.push(cap);
      if (cap === 2) return new Response('busy', { status: 503, statusText: 'Service Unavailable' });
      await new Promise((resolve) => setTimeout(resolve, 150));
      return answer(cap);
    });
    try {
      const { opts, landed } = options(server.url, [1, 2, 3, 4], 3);
      // The cap names the page, so the server can tell them apart.
      opts.maxTokens = (page: { number: number }) => page.number;
      const err = await readPagesFromEndpoint(opts).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(VlmParkedError);
      expect((err as VlmParkedError).page).toBe(2);
      expect(landed.map((p) => p.number).sort()).toEqual([1, 3]);
      expect(sent).not.toContain(4);
    } finally {
      server.stop();
    }
  });
});
