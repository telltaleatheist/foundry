/**
 * The transport's header layers merge BY NAME, case-insensitively.
 *
 * 2026-09-24: `clean-triage` passed `Content-Type` as its dialect and the
 * transport added `content-type`; a plain object keeps both, Node's fetch sent
 * `content-type: application/json, application/json`, and Crucible refused
 * every decide request. Bun happened to keep one, so a test that went through
 * Bun's fetch could not see it. This one reads what `fetchTransport` HANDS to
 * fetch, through the standard `Headers` — which joins duplicate names exactly
 * the way undici does — so it fails on any runtime if the merge regresses.
 */
import { afterEach, expect, test } from 'bun:test';

import { fetchTransport } from '../../src/translate/transport.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('a dialect header spelled differently is REPLACED by the later layer, never sent twice', async () => {
  let sent: Headers | null = null;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    sent = new Headers(init?.headers);
    return new Response('{}');
  }) as typeof fetch;
  const transport = fetchTransport(5_000, { authorization: 'Bearer from-the-map' });
  await transport.post('http://127.0.0.1:9/x', '{}', {
    'Content-Type': 'text/plain',
    Authorization: 'Bearer from-the-dialect',
  });
  expect(sent!.get('content-type')).toBe('application/json');
  expect(sent!.get('authorization')).toBe('Bearer from-the-map');
});
