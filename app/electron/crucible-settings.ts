/**
 * THE ENGINE'S SETTINGS — three requests, and no store behind them.
 *
 * ── What this module is, and the ruling that made it ───────────────────────
 *
 * Owen, 2026-09-14: *"Bookforge and foundry setup/settings should be able to
 * configure crucible settings. If the user enters an anthropic api key, it
 * should pass through to crucible … the user shouldn't have to interact with
 * crucible almost at all but should have access to it if they want to."* And
 * BookForge's addition, which he agreed: the GPU engine is the SINGLE SOURCE OF
 * TRUTH for these settings, so a key entered in Foundry is saved in the engine
 * and BookForge uses the same one.
 *
 * The contract is crucible `docs/PHASE15-HOST.md` §3.1 (`GET /v1/settings`),
 * §3.2 (`PUT /v1/settings`, and the upstream test) and §5.2 (what a window is
 * allowed to be). §5.2 is the sentence that decides everything in this file:
 *
 *   *"every control in these sections is a request to the engine, and its
 *   result is the engine's answer re-read. There is no Save button that writes
 *   an app file and syncs later."*
 *
 * So there is NO CACHE here, no debounce, no optimistic copy, and nothing
 * written to `app-settings.json`. Every function below is one round trip, and
 * the PUT hands back the whole document the server holds AFTER the write (§3.2:
 * *"so a window never has to guess what took"*), which is what the card redraws
 * from. A window that redrew from what it sent would be showing a route the
 * server may have refused.
 *
 * ── THE KEY GOES ONE WAY ──────────────────────────────────────────────────
 *
 * Renderer → main → server, and it stops there. It is in no answer (§3.1: *"a
 * key is write-only"*; the document carries `key_hint`, the last four
 * characters, and nothing more), in no log line — including the failure lines,
 * where the temptation to print the body is greatest — and on no command line.
 * That is electron/crucible-registry.ts's rule for a server token, one wire
 * along, and it is why no function in this file logs a request body.
 *
 * ── WHY THESE ARE HAND-ROLLED FETCHES ─────────────────────────────────────
 *
 * The vendored `@crucible/client` (0.5.0) has no `settings()`, `putSettings()`
 * or `testUpstream()`; PHASE15 §3.8 says the SDK gains all three. Until the
 * tarball carries them these go through `crucibleRequest`, the dispatcher's own
 * one-fetch-with-the-SDK's-error-mapping (electron/crucible-dispatch.ts says
 * why at length) — NOT a second parser, because a refusal that arrived as a
 * bare `Error` would lose the code every card below prints.
 *
 * **Switch all three to the SDK's own methods the moment the tarball carries
 * them.**
 */
import { CrucibleAuthError, CrucibleRefused, CrucibleServerError } from '@crucible/client';

import { crucibleRequest } from './crucible-dispatch';
import type { CrucibleServerEntry } from './app-settings';
import {
  LLM_CLASSES,
  UPSTREAM_LABEL,
  type LlmClass,
  type SettingsDocument,
  type SettingsPatch,
  type UpstreamName,
  type UpstreamProbe,
  type UpstreamTestResult,
} from '../shared/engine-settings';

/**
 * THE THREE REFUSALS `POST …/test` CAN ANSWER WITH (PHASE15 §3.2), and the only
 * codes that become a RESULT rather than a rejection.
 *
 * They are a result for `CrucibleProbe`'s reason (shared/slots.ts): the card
 * prints the sentence beside the box somebody is typing in and offers nothing
 * to press, and a rejection would make a wrong key look like a broken app.
 * Anything else — a version refusal, an engine that is not answering at all —
 * is a different kind of news and is left to throw, so it reads as "the engine
 * is down" rather than "your key is bad".
 *
 * ── AND THEY ARRIVE AS THREE DIFFERENT ERROR TYPES, WHICH IS WHY THE CODE IS
 * THE DISCRIMINATOR AND THE STATUS IS NOT ─────────────────────────────────
 *
 * §3.2 gives them statuses: `502 upstream_unreachable`, `401 upstream_rejected`,
 * `400 upstream_unconfigured`. `crucibleRequest` maps a status onto the SDK's
 * error classes before anything here sees it, so those become
 * `CrucibleServerError`, `CrucibleAuthError` and `CrucibleRefused`
 * respectively — three classes, one meaning. All three carry `code` and
 * `serverMessage`, so this switches on the CODE, which is the name the contract
 * actually owns. It also keeps the one distinction that matters: a 401 about
 * the SERVER's own token carries a different code and still throws, because a
 * stale registry token is not something to draw beside a key box.
 */
const TEST_REFUSALS: readonly string[] = [
  'upstream_unreachable',
  'upstream_rejected',
  'upstream_unconfigured',
];

/** A refusal that named itself, whatever class `crucibleRequest` chose for it. */
type NamedRefusal = { code: string; serverMessage: string };

function namedRefusal(err: unknown): NamedRefusal | null {
  if (err instanceof CrucibleRefused
    || err instanceof CrucibleAuthError
    || err instanceof CrucibleServerError) {
    return { code: err.code, serverMessage: err.serverMessage };
  }
  return null;
}

/**
 * `GET /v1/settings` — the document, for one server.
 *
 * EVERY FIELD IS READ DEFENSIVELY, `readCapability`'s rule: a server one
 * version ahead may carry a field this build has never heard of, and a reader
 * that trusted the shape would throw on the whole document because one number
 * arrived as a string. The four route rows are filled in even when the server
 * omits one — §2 says *"absent key = local"*, so an absent row IS an answer and
 * is spelled out here rather than left for a template to find missing.
 */
export async function readEngineSettings(
  entry: CrucibleServerEntry,
  timeoutMs?: number,
): Promise<SettingsDocument> {
  const body = await crucibleRequest(entry, '/v1/settings', { method: 'GET', timeoutMs });
  return documentFrom(body);
}

/**
 * `PUT /v1/settings` — a partial write, answered with the whole document.
 *
 * ONE REQUEST CARRIES BOTH HALVES when both halves are needed. §3.2: *"upstreams
 * are applied, then routes, then the whole is validated; a refusal applies
 * nothing."* That ordering is the server's promise and it is what lets the
 * wizard configure a key AND set the routes that name it in a single press —
 * two requests would leave a configured key behind whenever the second failed.
 *
 * REJECTS WITH A SENTENCE THAT NAMES THE FIELD. The four named refusals
 * (`route_not_routable`, `route_bad_model`, `route_upstream_unconfigured`,
 * `upstream_in_use`) each arrive with `details` saying which field or which
 * classes; {@link refusalSentence} composes one line from that and the card
 * draws it beside the control. A thrown Error rather than a result arm because
 * unlike a Test there is nothing to show instead — the write did not happen and
 * the document on screen is still the truth.
 */
export async function writeEngineSettings(
  entry: CrucibleServerEntry,
  patch: SettingsPatch,
): Promise<SettingsDocument> {
  try {
    const body = await crucibleRequest(entry, '/v1/settings', {
      method: 'PUT',
      body: httpBodyOf(patch),
    });
    return documentFrom(body);
  } catch (err) {
    if (err instanceof CrucibleRefused) throw new Error(refusalSentence(err));
    throw err;
  }
}

/**
 * `POST /v1/settings/upstreams/{name}/test` — what model ids this credential
 * can actually use.
 *
 * THIS IS HOW A PERSON PICKS A MODEL, and it is deliberately the only way.
 * §2: *"the server does not ship a cloud model list"*, and neither does this
 * app — a catalog compiled into a build is wrong by the next release and
 * confidently so, offering models that have been retired and hiding the one
 * somebody is paying for (the Cloud card made the same argument for itself).
 * The engine asks the upstream's own listing — Anthropic `GET /v1/models`,
 * OpenAI `GET /v1/models`, Ollama `GET /api/tags` — unbilled.
 *
 * `probe` IS THE UNSAVED CREDENTIAL, or absent for the one already configured.
 * The key crosses into main out of a box somebody is typing in, is used for one
 * request and is dropped; nothing here stores it and no answer carries it back.
 */
export async function testUpstream(
  entry: CrucibleServerEntry,
  name: UpstreamName,
  probe?: UpstreamProbe,
): Promise<UpstreamTestResult> {
  try {
    const body = await crucibleRequest(
      entry,
      `/v1/settings/upstreams/${encodeURIComponent(name)}/test`,
      /*
       * A BODY OF `{}` AND NOT NO BODY AT ALL when nothing was typed. §3.2 calls
       * the body optional, and an empty object is the shape that says "test what
       * is configured" without asking a JSON reader to cope with a POST that has
       * a content-type and no content.
       */
      { method: 'POST', body: probe ?? {} },
    );
    const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const listed = Array.isArray(record['models']) ? record['models'] : [];
    return {
      outcome: 'ok',
      models: listed.filter((id): id is string => typeof id === 'string'),
    };
  } catch (err) {
    const refusal = namedRefusal(err);
    if (refusal !== null && TEST_REFUSALS.includes(refusal.code)) {
      return { outcome: 'failed', code: refusal.code, message: refusal.serverMessage };
    }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The HTTP shape ↔ this app's shape, translated exactly once
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The patch, in the doc's own snake_case.
 *
 * ONLY THE KEYS SOMEBODY SET. §3.2's body is *"any subset"*, and sending
 * `{"routes": undefined}` through `JSON.stringify` would drop it anyway — but
 * an explicit build says out loud that an absent key means "leave it" while
 * `upstreams.<name>: null` means REMOVE, which are two different instructions
 * that look alike in a debugger.
 */
function httpBodyOf(patch: SettingsPatch): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (patch.routes !== undefined) body['routes'] = { ...patch.routes };
  if (patch.upstreams !== undefined) body['upstreams'] = { ...patch.upstreams };
  if (patch.desktopAllowanceBytes !== undefined) {
    body['desktop_allowance_bytes'] = patch.desktopAllowanceBytes;
  }
  return body;
}

/** The document, read out of whatever the server actually sent. */
function documentFrom(body: unknown): SettingsDocument {
  const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const routes = asRecord(record['routes']);
  const upstreams = asRecord(record['upstreams']);
  const anthropic = asRecord(upstreams['anthropic']);
  const openai = asRecord(upstreams['openai']);
  const ollama = asRecord(upstreams['ollama']);
  return {
    routes: Object.fromEntries(
      LLM_CLASSES.map((cls) => [cls, routeRowFrom(routes[cls])]),
    ) as Record<LlmClass, SettingsDocument['routes'][LlmClass]>,
    upstreams: {
      anthropic: {
        configured: anthropic['configured'] === true,
        keyHint: typeof anthropic['key_hint'] === 'string' ? anthropic['key_hint'] : null,
      },
      openai: {
        configured: openai['configured'] === true,
        keyHint: typeof openai['key_hint'] === 'string' ? openai['key_hint'] : null,
      },
      ollama: {
        configured: ollama['configured'] === true,
        url: typeof ollama['url'] === 'string' ? ollama['url'] : null,
      },
    },
    desktopAllowanceBytes:
      typeof record['desktop_allowance_bytes'] === 'number' ? record['desktop_allowance_bytes'] : 0,
    backendKind: typeof record['backend_kind'] === 'string' ? record['backend_kind'] : '',
  };
}

/**
 * One route row. `local` IS THE ANSWER FOR ANYTHING UNREADABLE, because it is
 * the answer for an absent one (§2: *"absent key = local"*) and because the
 * conservative direction here is the one that does not claim a person's book is
 * being sent to a company.
 */
function routeRowFrom(raw: unknown): SettingsDocument['routes'][LlmClass] {
  const row = asRecord(raw);
  const model = typeof row['model'] === 'string' && row['model'].length > 0 ? row['model'] : null;
  return { route: row['route'] === 'upstream' ? 'upstream' : 'local', model };
}

function asRecord(raw: unknown): Record<string, unknown> {
  return typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};
}

// ─────────────────────────────────────────────────────────────────────────────
// The four PUT refusals, said in one line each
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WHAT THE CARD SHOWS WHEN A WRITE IS REFUSED — the engine's own message, with
 * the field or the classes its `details` names put in front of it.
 *
 * THE SERVER'S SENTENCE IS KEPT, always. Replacing it with a word of ours is
 * how a fixable problem becomes an unfixable one (`CrucibleProbe` makes the
 * same argument in shared/slots.ts): the engine is the thing that knows WHICH
 * upstream is unconfigured and what it wanted instead, and this app's job is to
 * say which control the answer is about.
 *
 * ── An assumption, said out loud ──────────────────────────────────────────
 *
 * PHASE15 §3.2 says each refusal carries `details` *"saying which field"* and,
 * for `upstream_in_use`, *"the classes that name it"* — it does not name the
 * keys inside `details`. This reads `field` (a string) and `classes` (an array
 * of strings) and falls back to the message alone when neither is there, which
 * is correct whatever the server sends. **If the contract later names those
 * keys and they are different, this is the one place that changes.**
 */
function refusalSentence(err: CrucibleRefused): string {
  const details = asRecord(err.details);
  const field = typeof details['field'] === 'string' ? details['field'] : null;
  const classes = Array.isArray(details['classes'])
    ? details['classes'].filter((value): value is string => typeof value === 'string')
    : [];
  const head = namedBy(err.code, field, classes);
  return head === null ? err.serverMessage : `${head}: ${err.serverMessage}`;
}

/** Which control the refusal is about, in this app's words for it. */
function namedBy(code: string, field: string | null, classes: readonly string[]): string | null {
  switch (code) {
    case 'route_not_routable':
    case 'route_bad_model':
    case 'route_upstream_unconfigured':
      return field === null ? 'That route was refused' : `The route for ${field} was refused`;
    case 'upstream_in_use':
      return classes.length === 0
        ? 'That upstream is still in use'
        : `${upstreamLabelOf(field)} still runs ${classes.join(', ')} — re-route those first`;
    default:
      return null;
  }
}

/** The upstream's name for a person, when `details` named one. */
function upstreamLabelOf(field: string | null): string {
  if (field !== null && field in UPSTREAM_LABEL) {
    return UPSTREAM_LABEL[field as UpstreamName];
  }
  return 'That upstream';
}
