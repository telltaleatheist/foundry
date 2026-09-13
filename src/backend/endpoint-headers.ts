/**
 * backend/endpoint-headers — what an endpoint wants on every request, as an
 * opaque map, and the one place that decides where it comes from.
 *
 * ── Why a MAP, and not a token ──────────────────────────────────────────────
 *
 * The server this was built against wants two headers and only one of them is a
 * secret: a bearer token, and a constant naming the API version it speaks. A
 * `FOUNDRY_API_TOKEN` would have carried the first and left the second to be
 * hardcoded somewhere — which is teaching this program what that particular
 * server IS, inside files whose whole job is to know only that something at a
 * URL speaks OpenAI.
 *
 * So what crosses is a map: THESE headers, on every request to THIS endpoint.
 * foundry does not know which of them is a credential and does not need to. The
 * day an endpoint wants a third header, or a different one, or none, nothing in
 * this program changes.
 *
 * ── Why the environment, and NEVER a flag ───────────────────────────────────
 *
 * A command line is the most COPIED thing a program has. It is pasted into bug
 * reports, printed by the queue that composed it — `app/electron/job-queue.ts`
 * can spell a command line without spawning it — listed by the process table
 * and remembered by shells. A secret on one is a secret in all of those places
 * afterwards, and no care at the call site takes it back out.
 *
 * The settings file is the honest alternative, and it loses on one point.
 * `fromFlagOrSettings` (commands.ts) PRINTS a settings-sourced value into the
 * run log, deliberately: a run reading through an endpoint nobody typed must
 * say where the URL came from, or the file becomes spooky action. Keeping a
 * secret out of a code path that prints values BY DESIGN is a rule somebody has
 * to remember every time that code is touched. The environment's problem —
 * inheritance — is fixed ONCE, mechanically, at each spawn
 * (`withoutEndpointHeaders`). A mechanical fix beats a remembered one.
 *
 * So: the environment is the path the app and the queue use, and settings is
 * the fallback for a person running the CLI by hand. Settings is read only when
 * the environment says nothing.
 *
 * ── What must fail, and why ─────────────────────────────────────────────────
 *
 * A malformed value REFUSES THE RUN. It must never be dropped and carried on
 * with, because the map exists to authenticate: a run that quietly discarded it
 * would either fail at the server with an error about something else, or — far
 * worse — reach a server that does not require the headers and SUCCEED, having
 * silently stopped doing the thing it was configured to do.
 *
 * NOTHING IN THIS FILE EVER PRINTS A VALUE. Errors name the offending KEY and
 * where the map came from, never what was in it. A message that quoted the
 * value to be helpful would write the token into the log this design exists to
 * keep it out of.
 */
import { loadSettings, settingsPath } from './settings.js';

/**
 * The one variable, and the reason it is spelled for foundry rather than for a
 * product: the engine must not be able to tell WHICH server wants headers.
 */
export const ENDPOINT_HEADERS_ENV = 'FOUNDRY_ENDPOINT_HEADERS';

/** A map that cannot be honoured. Names the key, never the value. */
export class EndpointHeadersError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EndpointHeadersError';
  }
}

export type EndpointHeaders = Readonly<Record<string, string>>;

/**
 * Headers this program sets itself, which a map may not overwrite.
 *
 * `content-type` is ours on every POST and the body is JSON; a map that changed
 * it would describe the body as something it is not. The other two are computed
 * by the HTTP stack from the request itself, and a value supplied here would be
 * either ignored or wrong. Refusing is better than either.
 */
const RESERVED = new Set(['content-type', 'content-length', 'host']);

/**
 * Parse and validate one map. `source` is how the map arrived, for the refusal
 * sentence — it is the only context a person has when this fails.
 */
export function parseEndpointHeaders(raw: string, source: string): EndpointHeaders {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new EndpointHeadersError(
      `${source} is not valid JSON (${(err as Error).message}). It must be a JSON object of `
      + 'header names to string values, e.g. {"Authorization": "Bearer ...", "X-Api": "1"}.',
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new EndpointHeadersError(
      `${source} must be a JSON OBJECT of header names to string values, e.g. `
      + '{"Authorization": "Bearer ...", "X-Api": "1"}.',
    );
  }
  return validateEndpointHeaders(parsed as Record<string, unknown>, source);
}

/**
 * The rules a map must obey whatever door it came through.
 *
 * Split from the JSON parse above because the settings file arrives already
 * decoded — and because a rule that lived only on the environment path would be
 * a rule the settings path silently did not have.
 */
export function validateEndpointHeaders(
  map: Record<string, unknown>,
  source: string,
): EndpointHeaders {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(map)) {
    if (name.trim().length === 0) {
      throw new EndpointHeadersError(`${source} has a header with an empty name.`);
    }
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) {
      throw new EndpointHeadersError(
        `${source}: "${name}" is not a legal header name.`,
      );
    }
    if (RESERVED.has(name.toLowerCase())) {
      throw new EndpointHeadersError(
        `${source}: "${name}" is set by foundry itself and may not be supplied here.`,
      );
    }
    if (typeof value !== 'string') {
      // The VALUE is not quoted back — see the header. Naming its type is
      // enough to fix a map that put a number or a nested object in it.
      throw new EndpointHeadersError(
        `${source}: "${name}" must be a string, not ${Array.isArray(value) ? 'an array' : `a ${typeof value}`}.`,
      );
    }
    if (/[\r\n]/.test(value)) {
      throw new EndpointHeadersError(
        `${source}: the value of "${name}" contains a newline, which cannot be sent as a header.`,
      );
    }
    out[name] = value;
  }
  return out;
}

/** The map the spawner set, if it set one. */
export function endpointHeadersFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): EndpointHeaders | undefined {
  const raw = env[ENDPOINT_HEADERS_ENV];
  if (raw === undefined || raw.trim().length === 0) return undefined;
  return parseEndpointHeaders(raw, `$${ENDPOINT_HEADERS_ENV}`);
}

/*
 * Settings are read at most once per process.
 *
 * Not for speed — it is one small file — but so that a run cannot resolve
 * headers twice and get two answers if the file is rewritten underneath it
 * mid-book. A run is one set of headers throughout, or it is not a run.
 */
let settingsHeaders: EndpointHeaders | undefined | null = null;

/**
 * The headers for this run: the environment if the spawner set any, else the
 * settings file, else none.
 *
 * A CORRUPT SETTINGS FILE STILL THROWS, and deliberately. `loadSettings` states
 * the rule this follows: a value the engine recognises but cannot honour is a
 * misconfiguration to fix, not to guess around. Guessing here would mean
 * proceeding unauthenticated.
 */
export function resolveEndpointHeaders(
  env: NodeJS.ProcessEnv = process.env,
): EndpointHeaders | undefined {
  const fromEnv = endpointHeadersFromEnv(env);
  if (fromEnv !== undefined) return fromEnv;
  if (settingsHeaders === null) {
    const fromFile = loadSettings().backend?.endpointHeaders;
    settingsHeaders = fromFile === undefined
      ? undefined
      : validateEndpointHeaders({ ...fromFile }, `"backend.endpointHeaders" in ${settingsPath()}`);
  }
  return settingsHeaders;
}

/** For tests, which must not inherit one process's answer into the next case. */
export function forgetSettingsHeaders(): void {
  settingsHeaders = null;
}

/**
 * A child's environment with the map taken out.
 *
 * Every `spawn` in this program that does not itself speak to the endpoint gets
 * its environment through here. The rasteriser is the case that motivated it:
 * `vlm_page.py` renders pages and runs MLX locally and makes no HTTP request at
 * all, so a credential in its environment is a credential somewhere it can
 * never be used and could only leak from.
 *
 * STRIPPING, NOT ALLOWLISTING, and the difference matters. An allowlist of
 * variables to pass breaks the moment somebody adds a fourth spawn or the
 * Python needs a variable nobody listed, and the repair for that is always to
 * pass everything again — which puts the secret back. Removing one known name
 * cannot break a child that never wanted it.
 */
export function withoutEndpointHeaders(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const copy = { ...env };
  delete copy[ENDPOINT_HEADERS_ENV];
  return copy;
}
