/**
 * settings — a missing file is a state, a wrong value is an error by name,
 * and an unknown key from a newer writer is ignored rather than fatal.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { loadSettings, SettingsError, settingsPath } from '../../src/backend/settings.js';

let dir: string | null = null;

function withSettingsFile(content: string | null): void {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-settings-'));
  process.env['FOUNDRY_CONFIG_DIR'] = dir;
  if (content !== null) fs.writeFileSync(path.join(dir, 'settings.json'), content);
}

afterEach(() => {
  delete process.env['FOUNDRY_CONFIG_DIR'];
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('loadSettings', () => {
  test('a missing file is empty settings, not an error', () => {
    withSettingsFile(null);
    expect(loadSettings()).toEqual({});
  });

  test('FOUNDRY_CONFIG_DIR decides where the file is looked for', () => {
    withSettingsFile('{}');
    expect(settingsPath()).toBe(path.join(dir!, 'settings.json'));
  });

  test('a full valid backend block round-trips', () => {
    withSettingsFile(JSON.stringify({
      backend: {
        mode: 'endpoint',
        endpointUrl: 'http://localhost:8000/v1',
        endpointModel: 'dots.ocr',
        wslDistro: 'Ubuntu',
        vllmPython: '~/miniconda3/envs/vllm/bin/python',
        python: 'C:/py/python.exe',
      },
    }));
    expect(loadSettings().backend).toEqual({
      mode: 'endpoint',
      endpointUrl: 'http://localhost:8000/v1',
      endpointModel: 'dots.ocr',
      wslDistro: 'Ubuntu',
      vllmPython: '~/miniconda3/envs/vllm/bin/python',
      python: 'C:/py/python.exe',
    });
  });

  test('unknown keys — a newer writer — are ignored, not fatal', () => {
    withSettingsFile(JSON.stringify({
      backend: { mode: 'auto', futureKnob: 12 },
      ui: { theme: 'dark' },
    }));
    expect(loadSettings()).toEqual({ backend: { mode: 'auto' } });
  });

  test.each([
    ['not JSON at all', 'nonsense{', 'not valid JSON'],
    ['a JSON array', '[]', 'JSON object'],
    ['an unknown mode', '{"backend":{"mode":"turbo"}}', '"backend.mode" is "turbo"'],
    ['a non-URL endpoint', '{"backend":{"endpointUrl":"not a url"}}', 'not a URL'],
    ['a numeric python path', '{"backend":{"python":7}}', '"backend.python"'],
    ['an empty distro', '{"backend":{"wslDistro":""}}', '"backend.wslDistro"'],
  ])('refuses %s, naming the problem', (_name, content, needle) => {
    withSettingsFile(content);
    expect(() => loadSettings()).toThrow(SettingsError);
    expect(() => loadSettings()).toThrow(needle);
  });
});

describe('what PowerShell writes', () => {
  test('a settings file with a UTF-8 BOM on it still parses', () => {
    /*
     * `Set-Content -Encoding utf8` and `>` both put U+FEFF on the front of the
     * file, and JSON.parse refuses one — so a settings file written by a setup
     * script on the one shell that ships with Windows used to read as "not
     * valid JSON". See src/bom.ts.
     */
    withSettingsFile(`\uFEFF${JSON.stringify({ backend: { mode: 'endpoint', endpointUrl: 'http://host:8000/v1' } })}`);
    expect(loadSettings().backend?.endpointUrl).toBe('http://host:8000/v1');
  });
});
