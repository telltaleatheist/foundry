/**
 * backend/decide-door — ONE REQUEST TO A CRUCIBLE'S `POST /v1/decide`, with the
 * weather handled and misconfiguration refused.
 *
 * Two acts ask the door now — the cleanup's triage (src/clean/triage.ts) and the
 * analysis's ranking (src/analyze/snap.ts) — and they ask it the same way: one
 * state, many questions over it, the door priming the shared prefix itself
 * (crucible docs/PHASE22-DECIDE.md §2.2). What each act MEANS by an answer is
 * its own; how a request survives a busy server is this file's, once, so the
 * two cannot drift into two opinions about what `503 chat_queue_full` means.
 *
 * The model must already be resident. The app places the run on the `decide`
 * act, loaded and leased, and releases it when the engine exits; nothing here
 * loads a model or picks one.
 */
import type { Transport } from '../translate/transport.js';

/** How often a transport failure is retried before the run is refused by name. */
const TRANSPORT_RETRIES = 5;

/** The door's URL from a Crucible base, whether or not `/v1` was typed. */
export function decideUrl(endpoint: string): string {
  const base = endpoint.trim().replace(/\/+$/, '').replace(/\/v1$/, '');
  return `${base}/v1/decide`;
}

/** Who is asking, for the sentences, and how that act refuses. */
export interface DecideCaller {
  /** The act's prefix on every line it prints — `clean-triage`, `analyze`. */
  who: string;
  /** The act's own error, so a refusal reads as that act's. */
  fail: (message: string) => Error;
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
}

/** The parts of a reply every caller reads. Each act reads its own answers. */
export interface DecideReply {
  model?: { id?: unknown; revision?: unknown; fingerprint?: unknown };
  engine?: unknown;
  answers?: Record<string, unknown>;
  error?: { code?: unknown; message?: unknown; details?: { retry_after?: unknown; problems?: unknown } };
}

/**
 * ONE REQUEST, with the weather handled and misconfiguration refused.
 *
 * `503 chat_queue_full` is the door saying "not yet" (PHASE22 §2.2 — *"treat it
 * as weather"*): it is waited out, for as long as it lasts, with a sentence each
 * time. A transport failure is retried `TRANSPORT_RETRIES` times and then
 * refused naming the URL. Anything else the door refuses — a model not resident,
 * a malformed request — is a mistake somebody can fix, and is said once.
 */
export async function askDecide(
  transport: Transport,
  url: string,
  body: string,
  caller: DecideCaller,
): Promise<DecideReply> {
  const { who, fail, sleep, log } = caller;
  let transportFailures = 0;
  for (;;) {
    let response;
    try {
      response = await transport.post(url, body);
    } catch (err) {
      transportFailures += 1;
      if (transportFailures > TRANSPORT_RETRIES) {
        throw fail(`${who} could not reach ${url} after ${TRANSPORT_RETRIES} retries: ${(err as Error).message}`);
      }
      log(`${who}: ${url} did not answer (${(err as Error).message}) — retrying (${transportFailures} of ${TRANSPORT_RETRIES})`);
      await sleep(2_000 * transportFailures);
      continue;
    }
    let reply: DecideReply;
    try {
      reply = JSON.parse(response.body) as DecideReply;
    } catch {
      throw fail(`${who}: ${url} answered ${response.status} with a body that is not JSON: ${response.body.slice(0, 200)}`);
    }
    if (response.status === 200) return reply;
    const code = typeof reply.error?.code === 'string' ? reply.error.code : `http_${response.status}`;
    const message = typeof reply.error?.message === 'string' ? reply.error.message : response.body.slice(0, 200);
    if (response.status === 503 && code === 'chat_queue_full') {
      const header = Number(response.headers?.['retry-after']);
      const detail = Number(reply.error?.details?.retry_after);
      const seconds = Number.isFinite(header) && header > 0 ? header
        : Number.isFinite(detail) && detail > 0 ? detail : 2;
      log(`${who}: the server is busy (${message}) — waiting ${seconds} s and asking again`);
      await sleep(seconds * 1_000);
      continue;
    }
    // A 400 names WHICH field was wrong (`details.problems`, Crucible's
    // validation handler); that list is the whole diagnosis, so it is printed.
    // Without it, a malformed request read as "not a valid job request" and
    // nothing else — which is how a duplicated content-type hid (2026-09-24).
    const problems = Array.isArray(reply.error?.details?.problems)
      ? (reply.error!.details!.problems as Array<{ location?: unknown; message?: unknown }>)
        .slice(0, 5)
        .map((p) => `${Array.isArray(p.location) ? p.location.join('.') : '?'}: ${String(p.message)}`)
        .join('; ')
      : '';
    throw fail(
      `${who}: ${url} refused the request (${response.status} ${code}): ${message}`
      + (problems ? ` — ${problems}` : ''));
  }
}

/** Run a pool of `concurrency` over `count` jobs, in any order. */
export async function pool(count: number, concurrency: number, job: (index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(concurrency, count) }, async () => {
    while (next < count) {
      const index = next;
      next += 1;
      await job(index);
    }
  });
  await Promise.all(lanes);
}
