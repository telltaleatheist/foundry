/**
 * translate/model-server — the server the language passes speak to, proved once.
 *
 * ── WHAT THIS IS AND WHY IT IS ONE FILE ─────────────────────────────────────
 *
 * Four passes ask a model for text: `translate`, its `--rewrite` siblings
 * (simplify), `clean-text` and `analyze`. Every one of them asks exactly two
 * things of a server — prove you are there and say which model you hold, and
 * answer this block — and this file is the ONLY place a pass learns which
 * server and which model, so that "which model answered" can never be answered
 * differently by two commands on the same run. Everything that records a model
 * (the bank key, the stamp, the verdict key, the log line) reads it from the
 * `ModelServer` this hands back.
 *
 * ── ONE KIND OF SERVER, BY RULING ───────────────────────────────────────────
 *
 * Until 2026-09-13 this file chose between two dialects on `--server
 * ollama|vllm`. Owen ended the choice: every model call goes to one
 * OpenAI-compatible chat door — the inference service the app registers, which
 * is vLLM-shaped on a CUDA box and mlx-lm-shaped on a Mac and the same door
 * either way — and if there is no such server there is no run. So there is no
 * kind to declare, no default port for a second product, and nothing here
 * branches. `vllm.ts` is the dialect; this file is the proof and the record.
 *
 * ── THE PASS NEVER LOADS AND NEVER UNLOADS ──────────────────────────────────
 *
 * The operator makes a model resident before a pass is spawned, and a load
 * EVICTS whatever else was on the card — which is exactly why a pass must never
 * be the thing that asks for one: a cleanup that loaded its model would be one
 * job taking a narrator's voice off the card mid-sentence. So a server that is
 * answering but does not hold the model this run wants is a refusal BY NAME,
 * naming what is resident instead, and the run stops there. There is no
 * release either: the card belongs to whoever put a model on it, and a pass
 * ending is not a reason to take it off.
 *
 * ── WHY A POOL IS THE PREREQUISITE, WRITTEN HERE BECAUSE THIS IS WHERE ──────
 * ── SOMEBODY ARRIVES ASKING WHY TWELVE REQUESTS ARE IN FLIGHT ───────────────
 *
 * The server's advantage is AGGREGATE throughput across requests in flight
 * together: continuous batching keeps the GPU's tensor cores fed by running
 * many sequences through one forward pass, and CUDA graphs replay that pass
 * without re-issuing the kernels each step. Its single-stream latency is no
 * better than a serial runner's — on one request at a time there is nothing to
 * batch. So the worker pools in `run.ts`, `tts-number-normalizer.ts` and
 * `analyze/run.ts` are not an optimisation on top of this: they are the thing
 * that makes the server pay at all.
 */
import { isPageReadingModel } from '../vlm/models.js';
import type { ChatTuning, Transport } from './transport.js';
import { TRANSLATE_TUNING } from './transport.js';
import {
  complete, normaliseVllmEndpoint, requireServedModel, VllmError, type ServedModel,
} from './vllm.js';

/**
 * A proved server: what to speak to, about which model.
 *
 * `model` is RESOLVED — the id the server said it is serving, which may be a
 * name nobody typed (`requireServedModel`). Everything that records a model
 * reads it from here, so a run can never record a model different from the one
 * that answered.
 */
export interface ModelServer {
  /** The base URL as it is actually spoken to, after normalisation. */
  endpoint: string;
  model: string;
  /** The server's context window when it reported one. Null when it did not. */
  maxModelLen: number | null;
}

/**
 * How many requests to keep in flight when the caller named no number.
 *
 * NOT A MEASUREMENT FOR THE TEXT ACTS, but not arbitrary either: it is the
 * number `DEFAULT_VLM_CONCURRENCY` was measured at for the reading path against
 * a vLLM on this project's own hardware, where twelve in flight kept the batch
 * full without per-request latency climbing. The scheduler being fed is the
 * same scheduler, and it is safe to be wrong high: the server admits what fits
 * in its KV cache and QUEUES the rest, so extra requests wait in the server
 * instead of thrashing a card. `--concurrency` overrides it, and on a small
 * card it is the flag to reach for first.
 */
export const DEFAULT_TEXT_CONCURRENCY = 12;

/**
 * Prove the server, and hand back what the rest of the run needs to talk to it.
 *
 * The proof is FIRST, before a block is read: the run would discover a dead
 * server on request one anyway, and what asking early buys is the MESSAGE — a
 * sentence naming the URL that was silent, which is the only thing the person
 * about to check their server needs from this program.
 *
 * `model` is optional, and `requireServedModel` argues why: the server holds
 * ONE resident model, so naming it is retyping what the operator already chose,
 * and where nothing is named the served model IS the answer. A name that was
 * given is still proved, and a mismatch is refused with both names in it.
 */
export async function openModelServer(options: {
  transport: Transport;
  endpoint: string;
  model?: string;
}): Promise<ModelServer> {
  const endpoint = normaliseVllmEndpoint(options.endpoint);
  const served: ServedModel = await requireServedModel(options.transport, endpoint, options.model);
  // The one thing a text act must not accept from discovery. See
  // `isPageReadingModel` (vlm/models.ts) for the whole reason; the short of
  // it is that the reading model and the text model are served through the
  // same door, and a cleanup answered by a page reader is banked and stamped
  // as if it were prose.
  if (isPageReadingModel(served.id)) {
    throw new VllmError(
      `${endpoint} is serving "${served.id}", which is a model that READS PAGE IMAGES — a text `
      + 'act cannot use it, and a book cleaned or translated through it would be nonsense '
      + 'banked under its name. The server holds one model at a time; make the text model '
      + 'resident before this act runs, or name a text model with --model if this server '
      + 'really does serve both.',
    );
  }
  return { endpoint, model: served.id, maxModelLen: served.maxModelLen };
}

/** Ask the proved server for one block. */
export async function askModel(
  transport: Transport,
  server: ModelServer,
  system: string,
  user: string,
  tuning: ChatTuning = TRANSLATE_TUNING,
): Promise<string> {
  return complete(
    transport,
    server.endpoint,
    { id: server.model, maxModelLen: server.maxModelLen },
    system,
    user,
    tuning,
  );
}
