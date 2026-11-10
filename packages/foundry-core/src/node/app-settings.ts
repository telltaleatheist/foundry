/**
 * app-settings — the APP's own knobs, in the app's own file.
 *
 * `userData/app-settings.json`, deliberately NOT the engine's settings.json:
 * that file's schema belongs to the engine, is read by every `vlm-convert` on
 * the machine (BookForge's included), and describes WHERE reading happens.
 * Server lifecycle is nobody's concern but this app's — the engine neither
 * starts nor stops servers — so its knob lives here, where no other consumer
 * of the engine can trip over it.
 *
 * Same forgiveness rules as the engine-settings module: unknown keys in the
 * file are preserved on write and ignored on read, and out-of-range values
 * clamp to something legal rather than throwing — a hand-edited "999999" is a
 * user asking for "a long time", not a corrupt installation.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeAtomicallySync } from './atomic';
import { hostedLibraryDir } from './host';
import { userDataDir } from './platform';
import { clampAskPresets, clampCheckedPresets } from '../shared/ask-presets';
import { readJson } from '../shared/json';
import type { AppSettings } from './app-settings-types';
import { clampLibraryDir, clampAnalysisCategories, clampNewJobsWaitFor, clampQueueGpuDial, clampWslDistro, clampCrucibleServers, clampCloudProviders, clampSkipped, clampLastJobModels } from './app-settings-clamp';

export { CRUCIBLE_SERVER_MAX, CLOUD_PROVIDER_MAX, CUSTOM_CATEGORY_MAX } from './app-settings-types';
export type { CrucibleServerEntry, CloudProviderEntry, AppSettings } from './app-settings-types';
export { defaultLibraryDir, clampLibraryDir, clampAnalysisCategories, clampNewJobsWaitFor, clampQueueGpuDial, clampWslDistro, clampCrucibleServers, clampCloudProviders, clampCloudModel, clampCloudEndpoint, clampCrucibleUrl, sameCrucibleAddress, clampSkipped, clampLastJobModels } from './app-settings-clamp';

/**
 * The fixed part of the defaults. `libraryDir`'s default is a FUNCTION
 * (`defaultLibraryDir`) rather than a constant because it reads the home
 * directory, and a module-level constant would freeze whatever HOME happened to
 * be when this file was first imported.
 */

function settingsFile(): string {
  // userData through the platform port (2026-11-04), asked at the moment of use
  // exactly as `app.getPath` was — see platform.ts.
  return path.join(userDataDir(), 'app-settings.json');
}

/** Whatever the file holds, as an object; null when absent or unreadable. */
function readRaw(): Record<string, unknown> | null {
  // The path is asked OUTSIDE the try: an unset platform is misconfiguration and
  // must surface as its own sentence, not read as an absent file and defaults.
  const file = settingsFile();
  try {
    const parsed: unknown = readJson(fs.readFileSync(file, 'utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    // Absent, unreadable or unparsable all read as defaults. Unlike the
    // engine's file this one has no other writers whose intent could be lost,
    // so there is nothing to protect by refusing.
    return null;
  }
}

export function readAppSettings(): AppSettings {
  const raw = readRaw();
  return {
    libraryDir: clampLibraryDir(hostedLibraryDir() ?? raw?.['libraryDir']),
    analysisCategories: clampAnalysisCategories(raw?.['analysisCategories']),
    crucibleServers: clampCrucibleServers(raw?.['crucibleServers']),
    cloudProviders: clampCloudProviders(raw?.['cloudProviders']),
    newJobsWaitFor: clampNewJobsWaitFor(raw?.['newJobsWaitFor']),
    queueGpuDial: clampQueueGpuDial(raw?.['queueGpuDial']),
    wslDistro: clampWslDistro(raw?.['wslDistro']),
    setupCompleted: raw?.['setupCompleted'] === true,
    setupSkipped: clampSkipped(raw?.['setupSkipped']),
    lastJobModels: clampLastJobModels(raw?.['lastJobModels']),
    lastJobServers: clampLastJobModels(raw?.['lastJobServers']),
    askPresets: clampAskPresets(raw?.['askPresets']),
    askPresetsChecked: clampCheckedPresets(raw?.['askPresetsChecked']),
  };
}

/**
 * The removal receipt, read defensively.
 *
 * NULL FOR ANYTHING THAT IS NOT A COMPLETE ONE, including a half-written record
 * from a version that stored it differently. This value is printed at a person
 * in a sentence about their disk; a partial one would produce "Foundry removed
 * undefined on undefined", and no record at all is a better sentence than that —
 * the disk is measured either way, so nothing is lost but the explanation.
 */
export function writeAppSettings(patch: Partial<AppSettings>): AppSettings {
  const root: Record<string, unknown> = readRaw() ?? {};
  if (patch.libraryDir !== undefined) {
    root['libraryDir'] = clampLibraryDir(patch.libraryDir);
  }
  if (patch.analysisCategories !== undefined) {
    root['analysisCategories'] = clampAnalysisCategories(patch.analysisCategories);
  }
  if (patch.crucibleServers !== undefined) {
    root['crucibleServers'] = clampCrucibleServers(patch.crucibleServers);
  }
  if (patch.cloudProviders !== undefined) {
    root['cloudProviders'] = clampCloudProviders(patch.cloudProviders);
  }
  if (patch.newJobsWaitFor !== undefined) {
    root['newJobsWaitFor'] = clampNewJobsWaitFor(patch.newJobsWaitFor);
  }
  if (patch.wslDistro !== undefined) {
    root['wslDistro'] = clampWslDistro(patch.wslDistro);
  }
  if (patch.setupCompleted !== undefined) {
    root['setupCompleted'] = patch.setupCompleted === true;
  }
  if (patch.setupSkipped !== undefined) {
    root['setupSkipped'] = clampSkipped(patch.setupSkipped);
  }
  if (patch.lastJobModels !== undefined) {
    root['lastJobModels'] = clampLastJobModels(patch.lastJobModels);
  }
  if (patch.lastJobServers !== undefined) {
    root['lastJobServers'] = clampLastJobModels(patch.lastJobServers);
  }
  if (patch.askPresets !== undefined) {
    root['askPresets'] = clampAskPresets(patch.askPresets);
  }
  if (patch.askPresetsChecked !== undefined) {
    root['askPresetsChecked'] = clampCheckedPresets(patch.askPresetsChecked);
  }
  /*
   * NULL IS A VALUE HERE and clears the receipt — which is what re-installing
   * the page reader does. `undefined` still means "not in this patch", so the
   * two are genuinely different and the check has to be on `undefined` rather
   * than on truthiness.
   */
  // Whole or not at all: a write interrupted half way would read back as defaults, and lose every server and button.
  writeAtomicallySync(settingsFile(), `${JSON.stringify(root, null, 2)}\n`);
  return readAppSettings();
}
