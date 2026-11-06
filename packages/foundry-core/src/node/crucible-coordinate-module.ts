/**
 * crucible-coordinate-module — the Foundry module Crucible prepares, for each backend.
 */
import { type CrucibleModule } from '@crucible/client';
/*
 * THE VENDORED FILE ITSELF, imported so tsc copies it into dist and there is
 * exactly one of it. Read as the SDK's own `CrucibleModule` — the server's
 * snake_case spelling, not a camelCased mirror — because posting the module
 * means posting exactly those bytes. It is GENERATED in the crucible repo from
 * its manifests and vendored here byte for byte (PHASE13 §5.4); nothing in this
 * app edits it, and the ids in it are the manifests', not a second list.
 */
import foundryModule from '../shared/foundry.module.json';

/** What Foundry asks a Crucible for. The generated file, unedited. */
export type ScopedModule = Omit<CrucibleModule, 'job_types' | 'subjects'> & {
  job_types: readonly (CrucibleModule['job_types'][number] & { backends?: readonly string[] })[];
  subjects: readonly (CrucibleModule['subjects'][number] & { backends?: readonly string[] })[];
};

export const FOUNDRY_MODULE: ScopedModule = foundryModule as ScopedModule;

/**
 * Generated backend annotations are app metadata, not fields in the task API.
 *
 * A server that does not STATE its backend (`backendKind` null) is treated
 * exactly as a backend this module's lists do not name: the entries scoped to
 * named backends are left out, and the unscoped ones are asked for. Nothing is
 * guessed about which backend it might be (Owen, 2026-09-24: *"if it can make
 * the call to the crucible server then it should work"*).
 */
export function foundryModuleForBackend(backend: string | null, source: ScopedModule = FOUNDRY_MODULE): CrucibleModule {
  const supported = (entry: { backends?: readonly string[] }) =>
    entry.backends === undefined || (backend !== null && entry.backends.includes(backend));
  return {
    name: source.name, version: source.version, needs: source.needs,
    job_types: source.job_types.filter(supported).map(entry => ({
      type: entry.type, ...(entry.narrator_engine === undefined ? {} : { narrator_engine: entry.narrator_engine }),
    })),
    subjects: source.subjects.filter(supported).map(entry => ({ kind: entry.kind, id: entry.id })),
  };
}
