/**
 * The doctor's probe sends what a run would send (2026-11-06).
 *
 * It used to send no headers, so every current Crucible, which answers 426
 * without `X-Crucible-Api`, was reported down while real runs read through it.
 * The fake here keeps that rule. On main the two "reaches" tests fail with
 * "answered 426". Settings come from a temporary config folder, so no test can
 * read a real profile's.
 */
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import * as fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import { forgetSettingsHeaders } from '../../../src/engine/backend/endpoint-headers.js';
import { probeEndpoint } from '../../../src/engine/backend/probe.js';

const SECRET = 'Bearer not-a-value-to-repeat';
let server: Server;
let url = '';
let config = '';
const saved = { dir: process.env['FOUNDRY_CONFIG_DIR'], headers: process.env['FOUNDRY_ENDPOINT_HEADERS'] };

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(async () => {
  config = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-probe-headers-'));
  process.env['FOUNDRY_CONFIG_DIR'] = config;
  delete process.env['FOUNDRY_ENDPOINT_HEADERS'];
  forgetSettingsHeaders();
  server = createServer((req, res) => {
    const ok = req.headers['x-crucible-api'] === '1';
    res.writeHead(ok ? 200 : 426, { 'content-type': 'application/json' });
    res.end(ok ? JSON.stringify({ data: [{ id: 'dots-ocr' }] }) : '{}');
  });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/openai/v1`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => { server.close(() => resolve()); });
  restore('FOUNDRY_CONFIG_DIR', saved.dir);
  restore('FOUNDRY_ENDPOINT_HEADERS', saved.headers);
  forgetSettingsHeaders();
  fs.rmSync(config, { recursive: true, force: true });
});

test('with no headers configured, a server that wants one is a miss naming its answer', async () => {
  const probe = await probeEndpoint(url);
  assert.equal(probe.available, false);
  assert.match(probe.detail, /answered 426/);
});

test('it reaches the server with the headers from the settings file', async () => {
  fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({
    backend: { mode: 'endpoint', endpointUrl: url, endpointHeaders: { 'X-Crucible-Api': '1' } },
  }));
  const probe = await probeEndpoint(url);
  assert.equal(probe.available, true, probe.detail);
  assert.deepEqual(probe.models, ['dots-ocr']);
});

test('it reaches the server with the headers from the environment, which win over settings', async () => {
  fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({
    backend: { endpointHeaders: { 'X-Crucible-Api': '0' } },
  }));
  process.env['FOUNDRY_ENDPOINT_HEADERS'] = JSON.stringify({ 'X-Crucible-Api': '1' });
  assert.equal((await probeEndpoint(url)).available, true);
});

test('a wrong header value is still a miss', async () => {
  process.env['FOUNDRY_ENDPOINT_HEADERS'] = JSON.stringify({ 'X-Crucible-Api': '0' });
  const probe = await probeEndpoint(url);
  assert.equal(probe.available, false);
  assert.match(probe.detail, /answered 426/);
});

test('headers that will not parse are a miss with the reason, and the value is not repeated', async () => {
  process.env['FOUNDRY_ENDPOINT_HEADERS'] = SECRET;
  const probe = await probeEndpoint(url);
  assert.equal(probe.available, false);
  assert.match(probe.detail, /FOUNDRY_ENDPOINT_HEADERS is not valid JSON/);
  assert.ok(!probe.detail.includes('not-a-value'), probe.detail);
});
