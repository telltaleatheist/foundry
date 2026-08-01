#!/usr/bin/env bun
/**
 * A stand-in for llama-server, for testing the lifecycle without weights.
 *
 * It exists to reproduce the one behaviour that is easy to get wrong and
 * impossible to see without a real model load: **llama-server binds its port
 * and answers /health with HTTP 503 while the model is still loading.** A
 * readiness check that accepts "something answered" therefore passes instantly
 * and the first real request lands on a 503. The stub answers 503 a configurable
 * number of times before switching to 200, so a readiness check that does not
 * require a 200 fails the test.
 *
 * It also echoes back exactly what it was sent, which is how the verbatim-prompt
 * rule and the per-request LoRA scale vector are asserted.
 *
 * Not a test file — `bun test` only collects `*.test.ts`.
 *
 * Configured entirely by environment, because it is spawned by the code under
 * test with llama-server's own argv:
 *
 *   STUB_HEALTH_503   how many /health calls answer 503 before 200 (default 2)
 *   STUB_ALWAYS_503   never become ready (for the startup-timeout test)
 *   STUB_EXIT_CODE    exit immediately with this code (for the crash test)
 *   STUB_ARGS_FILE    write the received argv here as JSON, then serve
 */
import * as fs from 'node:fs';
import * as http from 'node:http';

const argv = process.argv.slice(2);

const exitCode = process.env['STUB_EXIT_CODE'];
if (exitCode !== undefined) {
  process.exit(Number(exitCode));
}

function flagValue(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const port = Number(flagValue('--port'));
const host = flagValue('--host') ?? '127.0.0.1';
if (!Number.isInteger(port) || port <= 0) {
  process.stderr.write(`stub-llama-server: no usable --port in ${JSON.stringify(argv)}\n`);
  process.exit(2);
}

const argsFile = process.env['STUB_ARGS_FILE'];
if (argsFile) fs.writeFileSync(argsFile, JSON.stringify(argv), 'utf-8');

const alwaysLoading = process.env['STUB_ALWAYS_503'] === '1';
const loadingProbes = Number(process.env['STUB_HEALTH_503'] ?? '2');
let healthProbes = 0;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const server = http.createServer((req, res) => {
  const url = req.url ?? '/';

  if (url === '/health') {
    healthProbes += 1;
    if (alwaysLoading || healthProbes <= loadingProbes) {
      // Exactly what llama.cpp sends while the weights are still loading: a
      // well-formed HTTP response that is NOT a readiness signal.
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 503, message: 'Loading model' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (url === '/completion' && req.method === 'POST') {
    void readBody(req).then((raw) => {
      // Echo the request back inside `content` so the test can assert on the
      // prompt byte-for-byte and on the lora scale vector.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        content: JSON.stringify({ received: JSON.parse(raw), healthProbes }),
      }));
    });
    return;
  }

  // Anything else — notably /v1/chat/completions — is a bug in the caller, not
  // a route to be helpful about.
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: `stub-llama-server: no route ${req.method} ${url}` }));
});

server.listen(port, host, () => {
  // llama-server prints a listening line here. Kept so the log-tail plumbing
  // has something realistic to capture.
  process.stdout.write(`stub-llama-server: listening on ${host}:${port}\n`);
});
