/**
 * Where weights land, on each platform.
 *
 * The per-platform branches are exercised from whichever platform the suite
 * happens to run on by injecting a PlatformContext — that is the whole reason
 * `defaultModelsDir` takes one. A test that only checks the branch for the
 * machine it runs on leaves two thirds of the function unverified until a
 * Windows user reports it.
 */
import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';

import {
  defaultModelsDir,
  ensureModelsDir,
  isModelPresent,
  modelFilePath,
  modelsDir,
  type PlatformContext,
} from '../../src/models/paths.js';

const HOME = '/home/tester';

function ctx(platform: NodeJS.Platform, env: Record<string, string | undefined> = {}): PlatformContext {
  return { platform, env, homedir: HOME };
}

describe('defaultModelsDir', () => {
  test('macOS uses Application Support', () => {
    expect(defaultModelsDir(ctx('darwin'))).toBe(
      path.join(HOME, 'Library', 'Application Support', 'foundry', 'models'),
    );
  });

  test('Windows uses LOCALAPPDATA — Local, never Roaming', () => {
    const dir = defaultModelsDir(ctx('win32', { LOCALAPPDATA: 'C:\\Users\\t\\AppData\\Local' }));
    expect(dir).toBe(path.join('C:\\Users\\t\\AppData\\Local', 'foundry', 'models'));
    expect(dir).not.toContain('Roaming');
  });

  test('Windows without LOCALAPPDATA reconstructs the same default location', () => {
    expect(defaultModelsDir(ctx('win32'))).toBe(
      path.join(HOME, 'AppData', 'Local', 'foundry', 'models'),
    );
  });

  test('Linux honours XDG_DATA_HOME', () => {
    expect(defaultModelsDir(ctx('linux', { XDG_DATA_HOME: '/data/xdg' }))).toBe(
      path.join('/data/xdg', 'foundry', 'models'),
    );
  });

  test('Linux without XDG_DATA_HOME falls to the spec default ~/.local/share', () => {
    expect(defaultModelsDir(ctx('linux'))).toBe(
      path.join(HOME, '.local', 'share', 'foundry', 'models'),
    );
  });

  test('an empty env var is not a value', () => {
    // A blank XDG_DATA_HOME would otherwise resolve the models dir to
    // `/foundry/models` at the filesystem root.
    expect(defaultModelsDir(ctx('linux', { XDG_DATA_HOME: '   ' }))).toBe(
      path.join(HOME, '.local', 'share', 'foundry', 'models'),
    );
  });

  test('never uses the OwenMorgan shared dir — that is BookForge\'s', () => {
    for (const p of ['darwin', 'win32', 'linux'] as const) {
      expect(defaultModelsDir(ctx(p))).not.toContain('OwenMorgan');
    }
  });

  test('creates nothing — reading must not have side effects', () => {
    const dir = defaultModelsDir(ctx('linux', { XDG_DATA_HOME: '/definitely/not/here' }));
    expect(Bun.file(dir).exists()).resolves.toBe(false);
  });
});

describe('modelsDir override', () => {
  test('--models-dir wins over the platform default', () => {
    expect(modelsDir('/tmp/weights', ctx('darwin'))).toBe('/tmp/weights');
  });

  test('a relative override is resolved against cwd', () => {
    // Otherwise `models list` and `convert` can disagree about whether a model
    // is installed, purely because of where the user was standing.
    expect(modelsDir('./weights', ctx('darwin'))).toBe(path.resolve('./weights'));
  });

  test('a blank override is not an override', () => {
    expect(modelsDir('  ', ctx('darwin'))).toBe(defaultModelsDir(ctx('darwin')));
  });
});

describe('ensureModelsDir', () => {
  test('creates the directory it returns', async () => {
    const tmp = path.join(
      import.meta.dir,
      '..',
      '..',
      'tmp',
      `paths-test-${process.pid}-${Date.now()}`,
    );
    const dir = ensureModelsDir(tmp);
    expect(dir).toBe(path.resolve(tmp));
    const { rmSync, statSync } = await import('node:fs');
    expect(statSync(dir).isDirectory()).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('model file resolution', () => {
  test('an unknown id throws naming the id, not a plausible path', () => {
    // A path into nowhere would be reported downstream as a missing file, which
    // sends the reader to the disk instead of to the id they mistyped.
    expect(() => modelFilePath('foundry-boxes-v1-4b', '/tmp/weights')).toThrow(
      /Unknown model id: foundry-boxes-v1-4b/,
    );
  });

  test('an unknown id is simply not present', () => {
    expect(isModelPresent('foundry:4b', '/tmp/weights')).toBe(false);
  });
});
