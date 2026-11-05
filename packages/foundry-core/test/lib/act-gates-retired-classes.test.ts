/**
 * A real 2.0.34 server's `GET /v1/capability` and `/v1/info`, captured on 2026-11-05. Crucible
 * retired `clean`, `translate`, `simplify` and `analysis` on 2026-10-25, so this
 * document has none of those rows, and Translate, Simplify, Analysis and Clean
 * sat dark on every current server because the gates still asked for them.
 */
import { afterAll, afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { useTestPlatform } from './platform-fixture';

const document = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures', 'capability-2.0.34.json'), 'utf8'));
const info = JSON.parse(fs.readFileSync(path.join(import.meta.dir, 'fixtures', 'info-2.0.34.json'), 'utf8'));
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-gates-test-'));
useTestPlatform(() => userData);
afterAll(() => fs.rmSync(userData, { recursive: true, force: true }));

const { actGates } = await import('../../src/node/act-gates');
const { capabilityRowFor } = await import('../../src/shared/types');
const { writeAppSettings } = await import('../../src/node/app-settings');
const { forgetCrucibleFacts } = await import('../../src/node/crucible-provider');

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

test('the captured document has none of the retired rows', () => {
  for (const cls of ['clean', 'translate', 'simplify', 'analysis']) {
    expect(document.classes.some((row: { capability: string }) => row.capability === cls)).toBe(false);
  }
});

test('each retired class is answered by the generate row, and the others only by their own', () => {
  const generate = document.classes.find((row: { capability: string }) => row.capability === 'generate');
  for (const cls of ['clean', 'translate', 'simplify', 'analysis']) {
    expect(capabilityRowFor(document.classes, cls)).toBe(generate);
  }
  expect(capabilityRowFor<{ capability: string }>(document.classes, 'pages')?.capability).toBe('pages');
  expect(capabilityRowFor<{ capability: string }>(document.classes, 'decide')?.capability).toBe('decide');
  expect(capabilityRowFor(document.classes, 'no-such-class')).toBeUndefined();
});

test('a server old enough to have its own row is answered by that row', () => {
  const classes = [{ capability: 'generate', selected: 'a' }, { capability: 'translate', selected: 'b' }];
  expect(capabilityRowFor(classes, 'translate')?.selected).toBe('b');
});

test('every act tile lights from that document, with no model chosen and no cloud provider', async () => {
  writeAppSettings({ crucibleServers: [{ name: 'local', url: 'http://127.0.0.1:7100', token: '', enabled: true }] });
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/v1/capability')) {
      return new Response(JSON.stringify(document), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/v1/info')) {
      return new Response(JSON.stringify(info), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: { code: 'not_found', message: url } }), { status: 404, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  forgetCrucibleFacts();
  const gates = await actGates();
  for (const act of ['translate', 'simplify', 'analysis', 'clean', 'read'] as const) {
    expect(gates[act].lit).toBe(true);
  }
  expect(gates.translate.why).toContain('qwen3.8-27b-4bit');
});
