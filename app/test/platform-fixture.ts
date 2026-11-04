/**
 * platform-fixture — the platform port for tests, in place of an electron mock.
 *
 * Until 2026-11-04 every test that loaded the queue, the settings or the
 * Crucible files had to `mock.module('electron', …)`, because those reached
 * `app.getPath` (and BrowserWindow, through host-ops → window). FOUNDRY-CORE-PLAN
 * step 1 cut those edges into electron/platform.ts, so the same tests now hand
 * the code its platform the way `mountFoundry` does, and load no Electron at
 * all. A test that still needs the electron mock is importing app-side code —
 * which is the test telling you so.
 *
 * `getPath` is the test's own answer to `app.getPath(name)`, kept in the shape
 * the mocks had so each test's directories are exactly what they were.
 *
 * No windows: a push goes nowhere, which is what a process with no window has.
 * No codec: none of these tests decodes an image, and one that starts to should
 * say so rather than meet a stub.
 */
import { setPlatform } from '../electron/platform';

export function useTestPlatform(getPath: (name: string) => string): void {
  setPlatform({
    userDataDir: () => getPath('userData'),
    tempDir: () => getPath('temp'),
    broadcast: () => {},
    image: {
      createFromPath: () => { throw new Error('this test has no image codec (platform-fixture.ts)'); },
      createFromBuffer: () => { throw new Error('this test has no image codec (platform-fixture.ts)'); },
    },
  });
}
