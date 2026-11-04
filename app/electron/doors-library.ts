/**
 * doors-library — the library folder, the settings file, Ask's presets and the other small app-settings doors.
 *
 * Moved out of electron/ipc.ts on 2026-11-04 (docs/FOUNDRY-CORE-PLAN.md step 2): the
 * handler bodies and helpers are here, word for word, and ipc.ts keeps only the
 * registrations that call them. Library code — nothing here reaches Electron.
 */
import { promises as fsp } from 'node:fs';

import {
  readAppSettings,
  writeAppSettings
} from './app-settings';
import {
  prepareFoundryForUse
} from './crucible-coordinate';
import type { AskPresetsKept } from '../shared/ask-presets';
import { admitted } from './openable';
import { hosted } from './host';
import * as queue from './job-queue';
import { finishSetup, finishPreparedSetup } from './setup';
import { writeSettings } from './settings';
import type {
  BackendSettingsPatch
} from '../shared/types';

/** `document:read-bytes`: a whole opened document, for the app's own PDF viewer. */
export async function readDocumentBytes(target: string) {
  const resolved = admitted(target);
  if (resolved === null) {
    throw new Error(`${target} was never opened in this app.`);
  }
  return fsp.readFile(resolved);
}

export const recordsBusy = (recordsFile: string): string | null => (
  queue.producing(recordsFile)
    ? 'A translation is writing this book\'s records right now, so the correction was not '
      + 'recorded — the edit is on screen and in this copy of the book. Let the run finish '
      + '(or cancel it) and make the edit again.'
    : null
);

/*
 * ── HOSTED, THE LIBRARY IS NOT THIS APP'S TO MOVE ─────────────────────────
 *
 * BookForge opens the Foundry window over books that live inside ITS data
 * directory, and its own metadata maps each book to a project folder by path
 * (docs/BOOKFORGE-HANDOFF.md §8). A Foundry settings screen that could point
 * `libraryDir` somewhere else would strand every one of those mappings — the
 * host would go on naming folders under a root nothing writes to any more, and
 * nothing in either app would say what had happened.
 *
 * So the two doors that CHANGE it refuse, and the one that REPORTS it answers
 * as it always did: `readAppSettings` returns the host's directory while a host
 * is mounted (electron/app-settings.ts), so `library:dir` names the folder the
 * books are actually in, which is what every caller of it wanted to know. The
 * refusal is a sentence rather than a silent no-op because a control that
 * appears to work and does nothing is the worse failure — the renderer hides
 * the control when `hosted()` is true, and this is what backs that up.
 */
export const refuseHostedLibraryMove = (): void => {
  if (!hosted()) return;
  throw new Error(
    'This library belongs to the app Foundry is running inside, which keeps your books with '
    + 'the rest of its own data. Move them from there, not from here.',
  );
};

/** `ask:presets`: Ask's presets are the app's, kept in app-settings.json (shared/ask-presets.ts). */
export function readAskPresets(): AskPresetsKept {
  const kept = readAppSettings();
  return { presets: kept.askPresets, checked: kept.askPresetsChecked };
}

/** `ask:save-presets`. */
export function saveAskPresets(patch: Partial<AskPresetsKept>): AskPresetsKept {
  const kept = writeAppSettings({
    ...(patch.presets === undefined ? {} : { askPresets: patch.presets }),
    ...(patch.checked === undefined ? {} : { askPresetsChecked: patch.checked }),
  });
  return { presets: kept.askPresets, checked: kept.askPresetsChecked };
}

/** `settings:write`: the engine's settings are not ours to write inside a host. */
export function writeSettingsOutsideHost(patch: BackendSettingsPatch) {
  if (hosted()) {
    throw new Error(
      'The engine\'s settings belong to the application Foundry is running inside, which '
      + 'runs the same engine. Change them there.',
    );
  }
  return writeSettings(patch);
}

/** `setup:finish`. */
export function finishSetupFor(skipped: string[], prepare?: boolean) {
  const choices = Array.isArray(skipped) ? skipped : [];
  if (prepare === true && !choices.includes('routes')) return finishPreparedSetup(choices, prepareFoundryForUse);
  return finishSetup(choices);
}
