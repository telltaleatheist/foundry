/**
 * crucible-registry-views — the registered servers as the settings pages show them.
 */
import { readAppSettings, type CrucibleServerEntry } from './app-settings';
import { cloudProviderViews } from './cloud-providers';
import { hosted } from './host';
import { isLoopbackUrl, type CloudSettingsView, type CrucibleServerView, type CrucibleSettingsView } from '../shared/slots';
import { crucibleServers } from './crucible-registry-read';
import { computeSlots, engineSharedWith, sharesEngineWith } from './crucible-registry-slots';

/** The registry as the renderer is allowed to see it. */
export function crucibleServerViews(): CrucibleServerView[] {
  /*
   * THE SLOTS ARE DERIVED FIRST, and that is not a wasted call: `slotsFrom` is
   * what decides which entries share a machine, and reading `engineSharedWith`
   * without it would hand back whatever the last derivation happened to say —
   * on a fresh process, nothing at all. It is a pure pass over the registry
   * against a cache, with no network in it.
   */
  computeSlots();
  return crucibleServers().map(viewOf);
}

export function viewOf(entry: CrucibleServerEntry): CrucibleServerView {
  return {
    name: entry.name,
    url: entry.url,
    enabled: entry.enabled,
    tokenSet: entry.token.length > 0,
    loopback: isLoopbackUrl(entry.url),
    sharesEngineWith: engineSharedWith(entry.name),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The settings card's one read
// ─────────────────────────────────────────────────────────────────────────────

/** Everything the Servers card draws, in one answer — see `CrucibleSettingsView`. */
export function crucibleSettingsView(): CrucibleSettingsView {
  const settings = readAppSettings();
  return {
    servers: crucibleServerViews(),
    slots: computeSlots(),
    newJobsWaitFor: settings.newJobsWaitFor,
    queueGpuDial: settings.queueGpuDial,
    wslDistro: settings.wslDistro,
    hosted: hosted(),
  };
}

/**
 * And the Cloud providers card's one read — see `CloudSettingsView`.
 *
 * ── Why it is composed HERE and not in `cloud-providers.ts` ────────────────
 *
 * Because it carries the SLOT LIST, and `computeSlots` lives in this module.
 * Putting this function beside the providers would mean that module importing
 * this one while this one already imports it for the cloud slots — a cycle,
 * around a function whose whole job is to answer one question consistently. The
 * division stays what the two headers say: that module reads and writes the
 * providers, this one derives the slots, and the card's read is a slot question
 * with a list attached.
 */
export function cloudSettingsView(): CloudSettingsView {
  return {
    providers: cloudProviderViews(),
    slots: computeSlots(),
    hosted: hosted(),
  };
}
