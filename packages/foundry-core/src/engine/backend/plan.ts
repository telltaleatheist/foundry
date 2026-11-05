/**
 * backend/plan — turn probe results into the doctor report.
 *
 * Pure. Probes measured; this ranks. The tier ORDER is the product decision
 * and it is fixed per platform, fastest first:
 *
 *     win32         endpoint → wsl-vllm → vllm-local(n/a)
 *     linux         endpoint → vllm-local → wsl-vllm
 *     darwin        endpoint → vllm-local(n/a) → wsl-vllm(n/a)
 *
 * An endpoint that answers beats everything everywhere: it is the measured-3s
 * -a-page path, and it is also the tier foundry understands least about and
 * therefore cannot misjudge — the server answered or it did not.
 *
 * THERE IS NO LOCAL READER AND NO RASTERISER LINE (2026-11-04). The `mlx` tier
 * (pages read on this machine by `vlm_page.py`), the planned `native` tier (a
 * transformers path in the same script) and the `rasteriser` line (PyMuPDF,
 * which every run needed) went with the Python: Owen, "Foundry always ships
 * with Crucible", so every model call goes to Crucible, and the pages are
 * rasterised in-process on MuPDF (`vlm/raster.ts`) with nothing to find or be
 * missing. Removing fields is a version bump, so the report is version 2.
 *
 * `chosen` NAMES; IT NEVER DEGRADES. In auto mode it is the first available
 * tier. In an explicit mode it is that tier if available and null if not —
 * never the next one down (ARCHITECTURE §8). wsl-vllm available means a
 * server COULD be started there, not that one is running; the caller that
 * starts it re-probes the endpoint before reading a page.
 *
 * The JSON shape here is versioned and consumed by the Electron app's
 * settings screen. Grow it by adding fields; renaming or removing one is a
 * version bump.
 */
import type { BackendMode } from './settings.js';
import type { EndpointProbe, PythonProbe, WslVllmProbe } from './probe.js';

export const DOCTOR_REPORT_VERSION = 2;

export type TierId = 'endpoint' | 'wsl-vllm' | 'vllm-local';

export interface TierReport {
  id: TierId;
  available: boolean;
  detail: string;
}

export interface DoctorReport {
  version: typeof DOCTOR_REPORT_VERSION;
  platform: NodeJS.Platform;
  /**
   * WSL itself, separate from the wsl-vllm tier: "WSL exists but no
   * environment does" is the state where a setup screen OFFERS to build one,
   * and it needs the distro list to offer a choice. Added within version 1 —
   * fields are added, never renamed.
   */
  wsl: { available: boolean; distros: string[] };
  tiers: TierReport[];
  /** The tier a run would use, or null with the reason living in its tier's detail. */
  chosen: TierId | null;
}

export interface PlanInputs {
  platform: NodeJS.Platform;
  mode: BackendMode;
  endpoint: EndpointProbe;
  wslVllm: WslVllmProbe;
  vllmLocal: PythonProbe;
}

export function buildReport(inputs: PlanInputs): DoctorReport {
  const endpoint: TierReport = {
    id: 'endpoint',
    available: inputs.endpoint.available,
    detail: inputs.endpoint.detail,
  };
  const wslVllm: TierReport = {
    id: 'wsl-vllm',
    available: inputs.wslVllm.available,
    detail: inputs.wslVllm.detail,
  };
  const vllmLocal: TierReport = {
    id: 'vllm-local',
    available: inputs.platform === 'linux' && inputs.vllmLocal.available,
    detail: inputs.vllmLocal.detail,
  };

  /*
   * Fastest-first per platform. Linux ranks vllm-local right after the
   * endpoint because that IS the vLLM machine class (including foundry run
   * inside a WSL distro); Windows reaches vLLM through WSL instead.
   */
  const tiers: TierReport[] =
    inputs.platform === 'linux'
      ? [endpoint, vllmLocal, wslVllm]
      : [endpoint, wslVllm, vllmLocal];

  let chosen: TierId | null;
  if (inputs.mode === 'auto') {
    chosen = tiers.find((t) => t.available)?.id ?? null;
  } else {
    // An explicit mode is an instruction, not a preference: the named tier or
    // nothing. The next tier down is what the operator explicitly did NOT ask
    // for, at 10–100× the runtime.
    chosen = tiers.find((t) => t.id === 'endpoint' && t.available)?.id ?? null;
  }

  return {
    version: DOCTOR_REPORT_VERSION,
    platform: inputs.platform,
    wsl: {
      available: inputs.wslVllm.distros.length > 0,
      distros: inputs.wslVllm.distros,
    },
    tiers,
    chosen,
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
