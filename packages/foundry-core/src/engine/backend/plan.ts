/**
 * backend/plan — turn probe results into the doctor report.
 *
 * Pure. Probes measured; this ranks. There is ONE tier now, the endpoint: the
 * configured server pages are read through (a Crucible's OpenAI door). It is
 * also the tier foundry understands least about and therefore cannot misjudge —
 * the server answered or it did not.
 *
 * THE OTHER TIERS ARE GONE (2026-11-04). The `mlx` tier (pages read on this
 * machine by `vlm_page.py`), the planned `native` tier (a transformers path in
 * the same script) and the `rasteriser` line (PyMuPDF, which every run needed)
 * went with the Python: the pages are rasterised in-process on MuPDF
 * (`vlm/raster.ts`). The `wsl-vllm` and `vllm-local` tiers — a vLLM foundry
 * COULD start in WSL or on this Linux box — and the `wsl` distro list went with
 * the ruling after it: *"foundry will never ship without a crucible engine, so
 * we can offload all model calls to crucible."* Removing fields is a version
 * bump, so the report is version 3 (2 dropped the Python tiers).
 *
 * `chosen` NAMES; IT NEVER DEGRADES. It is the endpoint when it answers and
 * null when it does not, in either mode (ARCHITECTURE §8).
 *
 * The JSON shape here is versioned and consumed by the Electron app's
 * settings screen. Grow it by adding fields; renaming or removing one is a
 * version bump.
 */
import type { BackendMode } from './settings.js';
import type { EndpointProbe } from './probe.js';

export const DOCTOR_REPORT_VERSION = 3;

export type TierId = 'endpoint';

export interface TierReport {
  id: TierId;
  available: boolean;
  detail: string;
}

export interface DoctorReport {
  version: typeof DOCTOR_REPORT_VERSION;
  platform: NodeJS.Platform;
  tiers: TierReport[];
  /** The tier a run would use, or null with the reason living in its tier's detail. */
  chosen: TierId | null;
}

export interface PlanInputs {
  platform: NodeJS.Platform;
  mode: BackendMode;
  endpoint: EndpointProbe;
}

export function buildReport(inputs: PlanInputs): DoctorReport {
  const endpoint: TierReport = {
    id: 'endpoint',
    available: inputs.endpoint.available,
    detail: inputs.endpoint.detail,
  };
  return {
    version: DOCTOR_REPORT_VERSION,
    platform: inputs.platform,
    tiers: [endpoint],
    chosen: endpoint.available ? 'endpoint' : null,
  };
}

/** The human rendering of the same facts, for `foundry doctor` without --json. */
export function formatReport(report: DoctorReport): string {
  const mark = (ok: boolean) => (ok ? 'ok  ' : 'MISS');
  const lines = [
    `foundry doctor — platform ${report.platform}`,
    '',
    ...report.tiers.map((t) => `  ${mark(t.available)}  ${t.id.padEnd(10)}  ${indented(t.detail)}`),
    '',
    report.chosen === null
      ? 'No reading backend is usable. The tier details above say what is missing.'
      : `A run now would read through: ${report.chosen}`,
  ];
  return lines.join('\n');
}

/** Multi-line probe details stay aligned under their tier name. */
function indented(detail: string): string {
  return detail.split('\n').join('\n              ');
}
