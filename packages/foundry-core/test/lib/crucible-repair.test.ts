/**
 * The repair door against a scripted server. No live server has the repair task
 * yet, so this is what stands behind the button until one does: both roads answer
 * one state, an old server is named rather than crashed on, and Check only never
 * takes the road that can change a machine.
 */
import { afterAll, afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { BootstrapRefusal } from '@crucible/bootstrap';
import { CrucibleRefused } from '@crucible/client';

import { useTestPlatform } from './platform-fixture';

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-repair-test-'));
useTestPlatform(() => userData);
afterAll(() => fs.rmSync(userData, { recursive: true, force: true }));

const { crucibleRepairDoor, repairRefusal } = await import('../../src/node/crucible-repair');
const { writeAppSettings } = await import('../../src/node/app-settings');
afterEach(() => { writeAppSettings({ crucibleServers: [] }); });

const RESULT = {
  healthy: true, verifyOnly: false, checked: [{ kind: 'env', id: 'tts' }], broken: [], repaired: [],
  failed: [], unverified: [], notHashChecked: [], bytesHashed: 100, bytesSkippedVerified: 0,
};

function fakeClient(script: { refuse?: unknown; result?: unknown; state?: string; error?: unknown }) {
  const asked: unknown[] = [];
  const cancelled: string[] = [];
  return {
    asked,
    cancelled,
    client: {
      async submitTask(request: unknown) {
        asked.push(request);
        if (script.refuse) throw script.refuse;
        return 'task-1';
      },
      async *taskEvents() {
        yield { id: 1, event: 'repair', data: { step: 'plan', state: 'running', subject: null, detail: null, bytesToCheck: 100 } };
        yield { id: 2, event: 'progress', data: { bytesDone: 50, bytesTotal: 100, file: 'a.bin' } };
        yield { id: 3, event: 'repair', data: { step: 'wait', state: 'running', subject: { kind: 'env', id: 'tts' }, detail: null, bytesToCheck: null } };
      },
      async cancelTask(taskId: string) { cancelled.push(taskId); return { taskId, status: 'cancelling' }; },
      async task() {
        return { state: script.state ?? 'done', result: 'result' in script ? script.result : RESULT, error: script.error ?? null };
      },
    },
  };
}

function door(client: unknown, repair?: unknown) {
  return crucibleRepairDoor({
    repair: (repair ?? (async () => { throw new Error('the local road was taken'); })) as never,
    clientForServer: async () => client as never,
    localClient: () => client as never,
    now: () => Date.now(),
  });
}

function remoteRow(url = 'http://192.0.2.20:7100') {
  writeAppSettings({ crucibleServers: [{ name: 'studio', url, token: 't', enabled: true }] });
}

test('a remote server is asked through its task and its result comes back', async () => {
  remoteRow();
  const fake = fakeClient({});
  const seen: unknown[] = [];
  const repairs = door(fake.client);
  repairs.watch((state) => seen.push(state));
  const state = await repairs.run('studio', false);
  expect(fake.asked).toEqual([{ type: 'repair', scope: {} }]);
  expect(state.running).toBe(false);
  expect(state.bytesToCheck).toBe(100);
  expect(state.outcome).toEqual({ outcome: 'finished', result: RESULT, server: null, service: null });
  expect(seen.some((one) => (one as { waitingFor: string | null }).waitingFor === 'env tts')).toBe(true);
});

test('this machine goes through the bootstrapper and answers the same shape', async () => {
  remoteRow('http://127.0.0.1:7100');
  const repairs = door(fakeClient({}).client, async () =>
    ({ server: 'reinstalled', service: 'started', task: RESULT, healthy: true, detail: null }));
  const state = await repairs.run('studio', false);
  expect(state.outcome).toEqual({ outcome: 'finished', result: RESULT, server: 'reinstalled', service: 'started' });
});

test('a Check only that finds the server down says so, and is not called a check', async () => {
  remoteRow('http://127.0.0.1:7100');
  let scope: unknown;
  const detail = 'the service is not running (stopped); a verify-only run does not start it';
  const state = await door(fakeClient({}).client, async (options: { scope: unknown }) => {
    scope = options.scope;
    return { server: 'ok', service: 'stopped', task: null, healthy: false, detail };
  }).run('studio', true);
  expect(scope).toEqual({ verifyOnly: true });
  expect(state.outcome).toEqual({ outcome: 'not-asked', server: 'ok', service: 'stopped', detail });
});

test('a server without the repair task fails by name, in a sentence', async () => {
  remoteRow();
  for (const refuse of [
    new CrucibleRefused(400, 'invalid_task', 'bad', null),
    new CrucibleRefused(422, 'bad_request', 'unknown task type: repair', null),
    new CrucibleRefused(400, 'invalid_request', 'body.scope: Extra inputs are not permitted', null),
  ]) {
    const state = await door(fakeClient({ refuse }).client).run('studio', false);
    expect(state.running).toBe(false);
    expect(state.outcome).toMatchObject({ outcome: 'refused', needsUpdate: true });
    expect((state.outcome as { message: string }).message).toContain('needs updating');
  }
});

test('a task that ends without an answer is a refusal, not a healthy result', async () => {
  remoteRow();
  const state = await door(fakeClient({
    state: 'failed', result: null, error: { code: 'env_build_failed', message: 'no disk' },
  }).client).run('studio', false);
  expect(state.outcome).toMatchObject({ outcome: 'refused', code: 'repair_failed' });
  expect((state.outcome as { message: string }).message).toContain('no disk');
});

test('a server with nothing to put back says installing again is the cure', () => {
  expect(repairRefusal(new BootstrapRefusal('server_unrepairable', 'nothing names its release')))
    .toMatchObject({ code: 'server_unrepairable', reinstall: true, needsUpdate: false });
  expect(repairRefusal(new BootstrapRefusal('repair_failed', 'it ended')))
    .toMatchObject({ code: 'repair_failed', reinstall: false });
});

test('Stop cancels the running task, and a stopped repair is not called a failure', async () => {
  remoteRow();
  const fake = fakeClient({ state: 'cancelled', result: null });
  const repairs = door(fake.client);
  repairs.watch((state) => { if (state.step === 'plan' && !state.stopping) void repairs.stop('studio'); });
  const state = await repairs.run('studio', false);
  expect(fake.cancelled).toEqual(['task-1']);
  expect(state.outcome).toEqual({ outcome: 'stopped' });
});

test('a second press while one runs joins it rather than starting another', async () => {
  remoteRow();
  const fake = fakeClient({});
  const repairs = door(fake.client);
  const first = repairs.run('studio', false);
  const second = await repairs.run('studio', false);
  expect(second.running).toBe(true);
  await first;
  expect(fake.asked).toHaveLength(1);
});
