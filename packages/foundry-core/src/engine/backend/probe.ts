/**
 * backend/probe — can the reading endpoint actually be reached, right now?
 *
 * The probe answers available or not, and a DETAIL string a person can act on.
 * The detail is the product here, exactly as error messages are in the rest of
 * foundry.
 *
 * PROBES REPORT; THEY NEVER DECIDE. Ranking and choosing live in plan.ts, and
 * degrading lives nowhere (ARCHITECTURE §8): a probe that finds nothing
 * produces a named reason, not a quieter tier.
 *
 * The contract probed is the one foundry actually consumes:
 *
 *  - endpoint   GET <url>/models answers with the OpenAI list shape — the
 *               configured server the pages are read through (a Crucible's
 *               OpenAI door).
 *
 * THE OTHER PROBES ARE GONE (2026-11-04). `mlx` and `rasteriser` (mlx_vlm and
 * PyMuPDF in a local interpreter) went with Foundry's Python; `wsl-vllm` and
 * `vllm-local` (could a vLLM be STARTED in WSL or on this Linux box) went with
 * Owen's ruling that followed it: *"foundry will never ship without a crucible
 * engine, so we can offload all model calls to crucible."* Foundry starts,
 * provisions and probes no model server of its own.
 */
import { resolveEndpointHeaders, type EndpointHeaders } from './endpoint-headers.js';

export interface ProbeReport {
  available: boolean;
  detail: string;
}

export interface EndpointProbe extends ProbeReport {
  url: string;
  models: string[];
  latencyMs: number | null;
}

/**
 * GET <url>/models with a short deadline. `url` is the base the run would be
 * given (`http://host:8000/v1`), so the probe exercises the exact base the
 * chat request would extend.
 *
 * WITH THE HEADERS A RUN WOULD SEND (`resolveEndpointHeaders`, the one owner),
 * because the probe's whole claim is "a run could read pages right now". It
 * used to send none, so every current Crucible, which refuses a request without
 * `X-Crucible-Api` (426), was reported down while real runs read through it.
 * Headers that will not parse are a miss with their reason, not a throw: a
 * probe reports, and that reason is the detail a person can act on.
 */
export async function probeEndpoint(url: string, timeoutMs = 3000): Promise<EndpointProbe> {
  const miss = (detail: string): EndpointProbe =>
    ({ available: false, detail, url, models: [], latencyMs: null });
  let headers: EndpointHeaders | undefined;
  try {
    headers = resolveEndpointHeaders();
  } catch (err) {
    return miss(`${url}: ${(err as Error).message}`);
  }
  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(`${url.replace(/\/$/, '')}/models`, {
      signal: AbortSignal.timeout(timeoutMs),
      ...(headers !== undefined ? { headers: { ...headers } } : {}),
    });
  } catch (err) {
    const cause = err instanceof Error && err.name === 'TimeoutError'
      ? `no answer within ${timeoutMs}ms`
      : (err as Error).message;
    return miss(`${url}: ${cause}`);
  }
  const latencyMs = Date.now() - started;
  if (!response.ok) return miss(`${url}/models answered ${response.status}`);

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return miss(`${url}/models did not answer JSON`);
  }
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    return miss(`${url}/models answered without the OpenAI "data" list — not an OpenAI-compatible server`);
  }
  const models = data
    .map((m) => (typeof (m as { id?: unknown }).id === 'string' ? (m as { id: string }).id : null))
    .filter((id): id is string => id !== null);
  return {
    available: true,
    detail: `${url} answered in ${latencyMs}ms${models.length > 0 ? `, serving ${models.join(', ')}` : ''}`,
    url,
    models,
    latencyMs,
  };
}
