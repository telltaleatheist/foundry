/**
 * translate/model-server — which server the language passes speak to, decided once.
 *
 * ── WHAT THIS IS AND WHY IT IS ONE FILE ─────────────────────────────────────
 *
 * Three passes ask a model for text: `translate`, its `--rewrite` siblings
 * (simplify, narration cleanup's prose rewrite) and `clean-text`. Every one of
 * them asks exactly three things of a server — prove you are there and hold the
 * model, answer this block, give the card back — and until 2026-09-08 all three
 * asked them of Ollama, because Ollama was the only thing on the other end.
 *
 * `vllm.ts` is now the other thing. This file is the ONLY place that chooses,
 * so that a pass reads the same however the machine is configured, and so that
 * "which server" can never be answered differently by two commands on the same
 * run. Nothing above this seam branches on the server, and nothing below it
 * knows there is a choice.
 *
 * ── THE CHOICE IS DECLARED, NEVER SNIFFED ───────────────────────────────────
 *
 * `--server ollama|vllm`, and no probing of the URL to work it out. A sniff gets
 * it right until it doesn't: a proxy in front of both, an Ollama on 8000 because
 * somebody moved it, a vLLM behind a path that also answers `/api/tags`. What a
 * wrong guess costs is not an error — it is a book translated by a model nobody
 * chose, or a run that fails at block one with a message about the wrong
 * protocol. A person who launched a vLLM knows they launched one, and saying so
 * costs them one flag.
 *
 * ── WHY A POOL IS THE PREREQUISITE, WRITTEN HERE BECAUSE THIS IS WHERE ──────
 * ── SOMEBODY ARRIVES ASKING WHETHER vLLM IS WORTH IT ────────────────────────
 *
 * vLLM's advantage is AGGREGATE throughput across requests in flight together:
 * continuous batching keeps the GPU's tensor cores fed by running many sequences
 * through one forward pass, and CUDA graphs replay that pass without re-issuing
 * the kernels each step. Its single-stream latency is no better than llama.cpp's
 * — on one request at a time there is nothing to batch, and a serial caller
 * hands it a batch of one. So the worker pools in `run.ts` and
 * `tts-number-normalizer.ts` are not an optimisation on top of this: they are
 * the thing that makes it pay at all, which is why `concurrencyFor` raises the
 * default here rather than leaving both servers on the same number.
 */
import {
  chat, normaliseEndpoint, requireModel, unloadModel, type ChatTuning, type Transport,
} from './ollama.js';
import {
  complete, DEFAULT_VLLM_ENDPOINT, normaliseVllmEndpoint, requireServedModel,
  type ServedModel,
} from './vllm.js';

/** Ollama's own default, which is where it is unless somebody moved it. */
export const DEFAULT_OLLAMA_ENDPOINT = 'http://localhost:11434';

/** The two things that can be on the other end. Declared, never sniffed. */
export const SERVER_KINDS = ['ollama', 'vllm'] as const;
export type ServerKind = (typeof SERVER_KINDS)[number];

export function isServerKind(value: string): value is ServerKind {
  return (SERVER_KINDS as readonly string[]).includes(value);
}

/** Where this kind of server lives when nobody said. */
export function defaultEndpointFor(kind: ServerKind): string {
  return kind === 'vllm' ? DEFAULT_VLLM_ENDPOINT : DEFAULT_OLLAMA_ENDPOINT;
}

/**
 * A proved server: what to speak to, in what dialect, about which model.
 *
 * `model` is RESOLVED — under Ollama it is the tag that was asked for and
 * proved, under vLLM it is the id the server said it is serving, which may be a
 * name nobody typed (`requireServedModel`). Everything that records a model —
 * the bank key, the stamp, the log line — reads it from here, so a run can never
 * record a model different from the one that answered.
 */
export interface ModelServer {
  kind: ServerKind;
  /** The base URL as it is actually spoken to, after normalisation. */
  endpoint: string;
  model: string;
  /** vLLM's `--max-model-len` when it reported one. Null under Ollama. */
  maxModelLen: number | null;
}

/**
 * How many requests to keep in flight when the caller named no number.
 *
 * FOUR IS OLLAMA'S, and it stays what it was: the acts declare it
 * (`DEFAULT_TRANSLATE_CONCURRENCY`, `DEFAULT_CLEAN_CONCURRENCY`) and each says
 * out loud that it is a starting point rather than a measurement. This function
 * takes that number and answers it back unchanged for Ollama, so nothing about
 * an existing machine moves.
 *
 * TWELVE IS vLLM'S, AND IS ALSO NOT A MEASUREMENT — but it is not arbitrary
 * either. It is the number `DEFAULT_VLM_CONCURRENCY` was measured at for the
 * reading path against a vLLM on this project's own hardware, where twelve in
 * flight kept the batch full without per-request latency climbing. The scheduler
 * being fed is the same scheduler. It is safe to be wrong high in a way it is
 * not under Ollama: vLLM admits what fits in its KV cache and QUEUES the rest,
 * so extra requests wait in the server instead of thrashing a card.
 *
 * `--concurrency` overrides both, and on a small card it is the flag to reach
 * for first.
 */
export const DEFAULT_VLLM_CONCURRENCY = 12;

export function concurrencyFor(kind: ServerKind, ollamaDefault: number): number {
  return kind === 'vllm' ? DEFAULT_VLLM_CONCURRENCY : ollamaDefault;
}

/**
 * Prove the server, and hand back what the rest of the run needs to talk to it.
 *
 * The proof is FIRST, before a block is read, for `requireModel`'s reason: the
 * run would discover a dead server on request one anyway, and what asking early
 * buys is the MESSAGE — a sentence naming the URL that was silent, which is the
 * only thing the person about to start a server needs from this program.
 *
 * `model` is optional and the two servers read the absence differently, which is
 * `requireServedModel`'s argument: an Ollama holds a library and a run must say
 * which model it means, so its callers pass their declared default; a vLLM
 * serves one model and naming it is retyping the server's own launch argument.
 */
export async function openModelServer(options: {
  kind: ServerKind;
  transport: Transport;
  endpoint: string;
  model?: string;
}): Promise<ModelServer> {
  const { kind, transport } = options;
  if (kind === 'vllm') {
    const endpoint = normaliseVllmEndpoint(options.endpoint);
    const served: ServedModel = await requireServedModel(transport, endpoint, options.model);
    return { kind, endpoint, model: served.id, maxModelLen: served.maxModelLen };
  }
  const endpoint = normaliseEndpoint(options.endpoint);
  const model = options.model ?? '';
  await requireModel(transport, endpoint, model);
  return { kind, endpoint, model, maxModelLen: null };
}

/** Ask the proved server for one block, in its own dialect. */
export async function askModel(
  transport: Transport,
  server: ModelServer,
  system: string,
  user: string,
  tuning?: ChatTuning,
): Promise<string> {
  if (server.kind === 'vllm') {
    return complete(
      transport,
      server.endpoint,
      { id: server.model, maxModelLen: server.maxModelLen },
      system,
      user,
      tuning ?? VLLM_TRANSLATE_TUNING,
    );
  }
  return chat(transport, server.endpoint, server.model, system, user, tuning);
}

/**
 * Translate's own sampling numbers, spelled out for the vLLM route.
 *
 * `chat()` defaults an absent tuning to `TRANSLATE_TUNING` inside `ollama.ts`,
 * which is private to that file and correctly so — it is the Ollama body
 * builder's default. The vLLM body builder needs the same two numbers and must
 * not invent its own, so the pair is written once here and the two routes are
 * given the SAME temperature. `numCtx` is carried for shape and dropped by the
 * vLLM body (see `completionsBody`), because a vLLM's window is fixed at launch.
 */
const VLLM_TRANSLATE_TUNING: ChatTuning = { temperature: 0.2, numCtx: 8192 };

/** What happened when the run tried to give the card back. */
export type ReleaseOutcome = 'released' | 'refused' | 'not-ours';

/**
 * Give the weights back when the run is over — or say why nothing was asked.
 *
 * ── OLLAMA: `unloadModel`'s courtesy, unchanged ─────────────────────────────
 *
 * A book is thousands of requests over hours, and when the last one lands twenty
 * gigabytes stay pinned on a five-minute idle timer with nothing to answer. On a
 * one-GPU machine that is the next job's memory. Best effort, never a failure.
 *
 * ── vLLM: A DECLARED NO-OP, AND THAT IS THE DESIGN RATHER THAN A GAP ────────
 *
 * A vLLM process IS its model: the weights are loaded at launch, the KV cache is
 * pre-allocated against them, and there is no request that says "let go". The
 * only way to free that card is to stop the process — and a pass must not stop
 * it, for the reason agreed with BookForge on 2026-09-08: the thing that decides
 * when the card changes hands has to watch EVERY job, and a cleanup that killed
 * the server would be one job deciding for all of them. BookForge's GPU arbiter
 * owns the server's life; foundry uses what it is pointed at, which is exactly
 * what `ollama.ts`'s header has always said about a server somebody else runs.
 *
 * So this answers `not-ours` and the caller says so out loud. Silence would look
 * like a release that happened.
 */
export async function releaseModel(
  transport: Transport,
  kind: ServerKind,
  endpoint: string,
  model: string,
): Promise<ReleaseOutcome> {
  if (kind === 'vllm') return 'not-ours';
  return (await unloadModel(transport, endpoint, model)) ? 'released' : 'refused';
}
