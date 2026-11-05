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
  return {
    asked,
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
    clientForHere: async () => client as never,
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
    ({ server: 'reinstalled', service: 'started', task: RESULT, healthy: true }));
  const state = await repairs.run('studio', false);
  expect(state.outcome).toEqual({ outcome: 'finished', result: RESULT, server: 'reinstalled', service: 'started' });
});

test('Check only on this machine never takes the road that can change it', async () => {
  remoteRow('http://127.0.0.1:7100');
  const fake = fakeClient({});
  const state = await door(fake.client).run('studio', true);
  expect(fake.asked).toEqual([{ type: 'repair', scope: { verifyOnly: true } }]);
  expect(state.outcome?.outcome).toBe('finished');
});

test('a server without the repair task fails by name, in a sentence', async () => {
  remoteRow();
  for (const refuse of [
    new CrucibleRefused(400, 'invalid_task', 'bad', null),
    new CrucibleRefused(422, 'bad_request', 'unknown task type: repair', null),
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
