/**
 * backend/plan — turn probe results into the doctor report.
 *
 * Pure. Probes measured; this ranks. The tier ORDER is the product decision
 * and it is fixed per platform, fastest first:
 *
 *     win32/linux   endpoint → wsl-vllm → mlx(n/a) → native
 *     darwin        endpoint → mlx → wsl-vllm(n/a) → native
 *
 * An endpoint that answers beats everything everywhere: it is the measured-3s
 * -a-page path, and it is also the tier foundry understands least about and
 * therefore cannot misjudge — the server answered or it did not.
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

export const DOCTOR_REPORT_VERSION = 1;

export type TierId = 'endpoint' | 'wsl-vllm' | 'vllm-local' | 'mlx' | 'native';

export interface TierReport {
  id: TierId;
  available: boolean;
  detail: string;
}

export interface DoctorReport {
  version: typeof DOCTOR_REPORT_VERSION;
  platform: NodeJS.Platform;
  /** PyMuPDF — needed by every run on every tier; reported beside the tiers. */
  rasteriser: { available: boolean; python: string | null; detail: string };
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
  mlx: PythonProbe;
  rasteriser: PythonProbe;
}

/**
 * The planned transformers path in vlm_page.py — a roadmap slot, not vapour.
 * When it lands it is the OVERNIGHT tier: dots.ocr without vLLM's paged
 * attention runs the vision tower eagerly, which is quadratic over ~3,450
 * patches per page (BookForge measured it against 4.8 s/page through vLLM).
 * The detail says so now so nobody reads the future tier as a fast one.
 */
const NATIVE_TIER: TierReport = {
  id: 'native',
  available: false,
  detail: 'not built yet — a transformers path in vlm_page.py is planned as the runs-anywhere tier;'
    + ' expect it to be 10-100x slower than vLLM when it lands, and to say so',
};

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
  const mlx: TierReport = {
    id: 'mlx',
    available: inputs.platform === 'darwin' && inputs.mlx.available,
    detail: inputs.platform === 'darwin' ? inputs.mlx.detail : 'MLX is Apple silicon only',
  };

  /*
   * Fastest-first per platform. Linux ranks vllm-local right after the
   * endpoint because that IS the vLLM machine class (including foundry run
   * inside a WSL distro); Windows reaches vLLM through WSL instead; macOS
   * reads locally through MLX.
   */
  const tiers: TierReport[] =
    inputs.platform === 'darwin'
      ? [endpoint, mlx, vllmLocal, wslVllm, NATIVE_TIER]
      : inputs.platform === 'linux'
        ? [endpoint, vllmLocal, wslVllm, mlx, NATIVE_TIER]
        : [endpoint, wslVllm, vllmLocal, mlx, NATIVE_TIER];

  let chosen: TierId | null;
  if (inputs.mode === 'auto') {
    chosen = tiers.find((t) => t.available)?.id ?? null;
  } else {
    // An explicit mode is an instruction, not a preference: the named tier or
    // nothing. The next tier down is what the operator explicitly did NOT ask
    // for, at 10–100× the runtime.
    const wanted: TierId = inputs.mode === 'endpoint' ? 'endpoint' : 'mlx';
    chosen = tiers.find((t) => t.id === wanted && t.available)?.id ?? null;
  }

  return {
    version: DOCTOR_REPORT_VERSION,
    platform: inputs.platform,
    rasteriser: {
      available: inputs.rasteriser.available,
      python: inputs.rasteriser.python,
      detail: inputs.rasteriser.detail,
    },
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
    `  ${mark(report.rasteriser.available)}  rasteriser  ${indented(report.rasteriser.detail)}`,
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
