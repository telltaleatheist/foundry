/**
 * The transport's header layers merge BY NAME, case-insensitively.
 *
 * 2026-09-24: `clean-triage` passed `Content-Type` as its dialect and the
 * transport added `content-type`; a plain object keeps both, Node's fetch sent
 * `content-type: application/json, application/json`, and Crucible refused
 * every decide request. The later layer must replace the earlier one whatever
 * its spelling — see `fetchTransport`.
 */
import { expect, test } from 'bun:test';

import { fetchTransport } from '../../src/translate/transport.js';

test('a dialect header spelled differently is REPLACED by the later layer, never sent twice', async () => {
  let contentType: string | null = null;
  let auth: string | null = null;
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      contentType = request.headers.get('content-type');
      auth = request.headers.get('authorization');
      return new Response('{}');
    },
  });
  try {
    const transport = fetchTransport(5_000, { authorization: 'Bearer from-the-map' });
    await transport.post(`http://127.0.0.1:${server.port}/x`, '{}', {
      'Content-Type': 'text/plain',
      Authorization: 'Bearer from-the-dialect',
    });
    expect(contentType).toBe('application/json');
    expect(auth).toBe('Bearer from-the-map');
  } finally {
    server.stop(true);
  }
});
