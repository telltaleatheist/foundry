/**
 * plan — the ranking is the product decision, so it is pinned here:
 * endpoint beats everything, explicit modes never degrade, and the native
 * tier exists only to say it does not exist.
 */
import { describe, expect, test } from 'bun:test';

import { buildReport, formatReport, type PlanInputs } from '../../src/backend/plan.js';

const AVAILABLE = { available: true, detail: 'ok' };
const MISSING = { available: false, detail: 'missing' };

function inputs(overrides: Partial<PlanInputs>): PlanInputs {
  return {
    platform: 'win32',
    mode: 'auto',
    endpoint: { ...MISSING, url: 'http://localhost:8000/v1', models: [], latencyMs: null },
    wslVllm: { ...MISSING, distro: null, python: null, distros: [] },
    mlx: { ...MISSING, python: null },
    rasteriser: { ...MISSING, python: null },
    ...overrides,
  };
}

describe('buildReport', () => {
  test('auto picks the endpoint over an available wsl-vllm', () => {
    const report = buildReport(inputs({
      endpoint: { ...AVAILABLE, url: 'http://localhost:8000/v1', models: ['dots.ocr'], latencyMs: 5 },
      wslVllm: { ...AVAILABLE, distro: 'Ubuntu', python: '~/miniconda3/envs/vllm/bin/python', distros: ['Ubuntu'] },
    }));
    expect(report.chosen).toBe('endpoint');
  });

  test('auto falls through to wsl-vllm when nothing answers the URL', () => {
    const report = buildReport(inputs({
      wslVllm: { ...AVAILABLE, distro: 'Ubuntu', python: 'python', distros: ['Ubuntu'] },
    }));
    expect(report.chosen).toBe('wsl-vllm');
  });

  test('auto with nothing available chooses null, not native', () => {
    const report = buildReport(inputs({}));
    expect(report.chosen).toBeNull();
  });

  test('explicit endpoint mode with the endpoint down chooses null, never the next tier', () => {
    const report = buildReport(inputs({
      mode: 'endpoint',
      wslVllm: { ...AVAILABLE, distro: 'Ubuntu', python: 'python', distros: ['Ubuntu'] },
    }));
    expect(report.chosen).toBeNull();
  });

  test('mlx never reports available off darwin, whatever the probe said', () => {
    const report = buildReport(inputs({
      mlx: { ...AVAILABLE, python: '/some/python' },
    }));
    const mlx = report.tiers.find((t) => t.id === 'mlx')!;
    expect(mlx.available).toBe(false);
    expect(mlx.detail).toContain('Apple silicon');
  });

  test('darwin ranks mlx ahead of wsl-vllm; win32 the reverse', () => {
    const mac = buildReport(inputs({ platform: 'darwin' }));
    const win = buildReport(inputs({ platform: 'win32' }));
    const order = (r: typeof mac) => r.tiers.map((t) => t.id);
    expect(order(mac)).toEqual(['endpoint', 'mlx', 'wsl-vllm', 'native']);
    expect(order(win)).toEqual(['endpoint', 'wsl-vllm', 'mlx', 'native']);
  });

  test('native is always reported and never available', () => {
    const report = buildReport(inputs({}));
    const native = report.tiers.find((t) => t.id === 'native')!;
    expect(native.available).toBe(false);
    expect(native.detail).toContain('not implemented');
  });

  test('wsl facts are reported even when the tier is a miss — the setup-screen state', () => {
    const report = buildReport(inputs({
      wslVllm: { ...MISSING, distro: null, python: null, distros: ['Ubuntu', 'Debian'] },
    }));
    expect(report.wsl).toEqual({ available: true, distros: ['Ubuntu', 'Debian'] });
    expect(report.tiers.find((t) => t.id === 'wsl-vllm')!.available).toBe(false);
  });

  test('the report carries the rasteriser verdict verbatim', () => {
    const report = buildReport(inputs({
      rasteriser: { available: true, detail: 'python ok', python: '/envs/vlmtest/python' },
    }));
    expect(report.rasteriser).toEqual({ available: true, detail: 'python ok', python: '/envs/vlmtest/python' });
  });
});

describe('formatReport', () => {
  test('names the chosen tier, or the absence of one', () => {
    const chosen = buildReport(inputs({
      endpoint: { ...AVAILABLE, url: 'u', models: [], latencyMs: 1 },
    }));
    expect(formatReport(chosen)).toContain('read through: endpoint');

    const none = buildReport(inputs({}));
    expect(formatReport(none)).toContain('No reading backend is usable');
  });
});
