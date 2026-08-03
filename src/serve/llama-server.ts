/**
 * llama-server — one resident base model, adapters selected per request.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PROMPT IS SACRED: VERBATIM, TO /completion, NEVER A CHAT ENDPOINT.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * This is the single most fragile invariant in the project (ARCHITECTURE §4),
 * and it is a property of THIS file because this file is the only thing that
 * talks to the model.
 *
 * The adapters were trained under Qwen3's chat template with thinking disabled.
 * That template inserts an empty `<think>\n\n</think>` block which stock chat
 * templates omit. Any server that builds the prompt itself — `/v1/chat/
 * completions`, Ollama's chat API, anything taking `messages` — will construct a
 * DIFFERENT prompt from the same content and hand the model a shape it never saw
 * in training.
 *
 * The failure mode is what makes it dangerous: **it does not error.** Answers
 * just get worse, in a way that reads as an undertrained model rather than a
 * malformed request, and the natural response is to train longer on more data,
 * which costs days and fixes nothing.
 *
 * Therefore:
 *
 *   - The caller's encoder produces the FINAL prompt string. This file receives
 *     a complete string and sends it unchanged.
 *   - It goes to **`/completion`**, which takes `prompt` as a string and does
 *     not re-template it.
 *   - **No chat endpoint. Ever.** Not for convenience, not for a quick test, not
 *     "just to check the server is up" — that is what `/health` is for.
 *   - This file must never build, template, wrap, trim or normalise a prompt. It
 *     knows nothing about pages, blocks, lines or footnotes. A prompt string
 *     goes in, a completion string comes out. Prompt formats live with the stage
 *     that owns them, and so does parsing the answer.
 *
 * The stop token is part of the format, not a tuning knob — the caller passes
 * it, this file forwards it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE SERVER, THREE ADAPTERS — the inversion from BookForge
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * BookForge's `llama-model-server.ts` runs a SEPARATE instance per fine-tune,
 * because rubric and dagger are different full models and sharing one process
 * would mean unloading and reloading several GB whenever the user alternates
 * between tasks.
 *
 * Foundry inverts that, deliberately, and it is the one place the source design
 * does not carry over (MIGRATION §4). Here there is one Qwen3-4B base and three
 * LoRA adapters (ARCHITECTURE §3). `convert` moves between blocks → ocr →
 * footnotes constantly, and three separate 4B servers would be gigabytes of
 * unload/reload on every transition. Adapters are tens of megabytes. So: one
 * process, base resident, all adapters loaded at startup, and each request names
 * which one it wants.
 *
 * Also dropped on the way in:
 *   - The GPU **arbiter**. It sequenced llama-server against BookForge's TTS
 *     engines for the device. Foundry is one process with no other tenants.
 *   - Everything Electron: `app.getPath`, the userData pid file, IPC progress.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

/** Long enough to be useful across a book, short enough to give the RAM back. */
const DEFAULT_IDLE_SHUTDOWN_MS = 5 * 60_000;

/** A cold model load off a cold page cache is genuinely slow. */
const DEFAULT_STARTUP_TIMEOUT_MS = 3 * 60_000;

/** How often to ask /health during startup. */
const HEALTH_POLL_INTERVAL_MS = 250;

/** Loopback only. This server never listens off-box. */
const HOST = '127.0.0.1';

/** A named LoRA adapter to load alongside the base. */
export interface AdapterSpec {
  /** How requests name it — 'blocks', 'ocr', 'footnotes'. */
  name: string;
  /** Absolute path to the adapter GGUF. Must exist at startup. */
  path: string;
}

export interface LlamaServerOptions {
  /** From `resolveLlamaServer()`. Never a bare name — no PATH lookup. */
  binaryPath: string;
  /** Absolute path to the base model GGUF. */
  basePath: string;
  /** Adapters to load. Names must be unique. May be empty (base only). */
  adapters?: AdapterSpec[];
  /**
   * `-c`. Size it against the CORPUS, never guess.
   *
   * BookForge learned this the expensive way on rubric: 8192 was fine until the
   * segmentation changed, after which the longest real page measured 10,404
   * tokens and was silently truncated — and truncation lands on the END of the
   * block list, so the model simply stops answering for blocks it was never
   * shown. That reads as "the new model drops blocks" rather than "the server
   * cut the prompt", which is the wrong place to go looking. RE-MEASURE
   * WHENEVER SEGMENTATION CHANGES.
   */
  contextSize: number;
  /** Loopback port. Omit to take a free ephemeral one. */
  port?: number;
  /**
   * `-ngl`. Layers to offload: all of them, or none.
   *
   * Not a ladder. A device that cannot hold 4B of weights plus the KV cache
   * cannot hold a useful fraction of them either, and a partial offload spends
   * PCIe traffic per token to save little. Defaults to 99 on Apple Silicon,
   * where unified memory means "VRAM" is system RAM, and to 0 elsewhere — the
   * caller decides, because only the caller knows what probing was done.
   */
  nGpuLayers?: number;
  /** `n_predict` ceiling when a request does not set one. */
  maxPredict?: number;
  idleShutdownMs?: number;
  startupTimeoutMs?: number;
  /** Server log lines, for `--verbose`. */
  onLog?: (line: string) => void;
}

export interface CompletionRequest {
  /**
   * The FINAL prompt, exactly as the caller's encoder produced it. Sent
   * unchanged. See the file header — this is not a place to add a prefix.
   */
  prompt: string;
  /**
   * Which adapter to apply, by name, or null/undefined for the bare base.
   *
   * Every request states this explicitly and every request sends the full
   * scale vector, so what is applied never depends on what the previous request
   * happened to leave set.
   */
  adapter?: string | null;
  /** Stop strings. Part of the trained format, passed through verbatim. */
  stop?: string[];
  nPredict?: number;
  /** Defaults to 0: these are deterministic tasks, greedy, never sampled. */
  temperature?: number;
}

/**
 * The single `--lora-scaled` argument for one adapter, at scale 0.0.
 *
 * THE FLAG TAKES ONE ARGUMENT, `FNAME:SCALE` — not two. llama.cpp's parser
 * rejects the two-argument spelling outright ("lora-scaled format: FNAME:SCALE"),
 * so a server launched the old way never starts and the failure lands as "the
 * stage could not reach a model".
 *
 * AND THAT ONE ARGUMENT IS SPLIT AT THE **FIRST** COLON. On Windows that is the
 * drive letter, so an absolute adapter path — `C:\Users\...\ocr.gguf:0.0` —
 * parses as filename `C` with scale `\Users\...:0.0`, and llama-server exits
 * during startup with exactly that error. Confirmed against b7482 on a real
 * Windows install: absolute path → parse error, colon-free relative path →
 * parses and proceeds. Mac and Linux never hit it because POSIX paths have no
 * colons, which is why this survived until the first Windows user ran `ocr`.
 *
 * So on win32 the adapter is spelled RELATIVE to the spawn cwd, which `start()`
 * already sets to the binary's directory for DLL resolution. In practice the
 * adapter and the binary sit under the same `C:\Users\<u>\AppData` tree, so the
 * relative form has no colon in it.
 *
 * If they are on DIFFERENT drives the relative form is still absolute and still
 * has a colon — llama.cpp's format simply cannot express that path, so this
 * THROWS before the spawn rather than shipping an argument the parser will
 * reject. There is no fallback: a silently skipped adapter is a stage answering
 * from the bare base model, which does not error, it just answers worse.
 *
 * `platform` is a parameter (and `path.win32` is used explicitly) so the
 * Windows spelling is testable from any host.
 */
export function loraScaledArg(
  adapterPath: string,
  binaryDir: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32') return `${adapterPath}:0.0`;

  const relative = path.win32.relative(binaryDir, adapterPath);
  if (relative.includes(':')) {
    throw new Error(
      `Adapter '${adapterPath}' cannot be passed to llama-server: it is not on `
      + `the same drive as the server's working directory '${binaryDir}', so the `
      + `shortest way to name it is still '${relative}'. llama.cpp's `
      + `--lora-scaled takes one FNAME:SCALE argument and splits it at the FIRST `
      + `colon, so no path containing a colon — including a drive letter — can be `
      + `expressed. Put the adapter on the same drive as the llama-server binary.`,
    );
  }
  return `${relative}:0.0`;
}

export class LlamaServer {
  private proc: ChildProcess | null = null;
  private ready = false;
  private starting: Promise<void> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private resolvedPort: number | null = null;
  private readonly adapters: AdapterSpec[];
  /** Adapter name → the index llama-server assigns it, in load order. */
  private readonly adapterIndex = new Map<string, number>();
  /** Last few server log lines, so a startup failure can quote the reason. */
  private readonly logTail: string[] = [];
  private exitHooksInstalled = false;

  constructor(private readonly opts: LlamaServerOptions) {
    this.adapters = opts.adapters ?? [];
    this.adapters.forEach((a, i) => {
      if (this.adapterIndex.has(a.name)) {
        throw new Error(`Duplicate adapter name '${a.name}' — adapter names select a model.`);
      }
      this.adapterIndex.set(a.name, i);
    });
  }

  get running(): boolean {
    return this.ready && this.proc !== null;
  }

  /** The port in use. Throws before the server has started. */
  get port(): number {
    if (this.resolvedPort === null) {
      throw new Error('The llama-server has not started, so it has no port yet.');
    }
    return this.resolvedPort;
  }

  get endpoint(): string {
    return `http://${HOST}:${this.port}`;
  }

  /** Adapter names this server can apply. */
  get adapterNames(): string[] {
    return [...this.adapterIndex.keys()];
  }

  /**
   * Ensure the server is up. Idempotent, and concurrent callers join the same
   * start rather than racing two spawns onto one port.
   */
  async ensureStarted(): Promise<void> {
    if (this.ready && this.proc) {
      this.touch();
      return;
    }
    if (this.starting) return this.starting;

    this.starting = this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /**
   * Send one prompt and return the completion.
   *
   * Sequential by design — `-np 1`, one device. Batching here would only move
   * the queue, and it would make a mid-batch failure lose the prompts that had
   * already succeeded. Callers loop, and own their own progress reporting.
   */
  async complete(req: CompletionRequest): Promise<string> {
    await this.ensureStarted();
    this.touch();

    const body = {
      // VERBATIM. See the file header. Nothing decorates this string.
      prompt: req.prompt,
      temperature: req.temperature ?? 0,
      n_predict: req.nPredict ?? this.opts.maxPredict ?? 2048,
      stop: req.stop,
      // Prompts from one stage share a long identical prefix, so its KV is
      // reused instead of being re-prefilled on every request.
      cache_prompt: true,
      lora: this.loraVector(req.adapter ?? null),
    };

    let res: Response;
    try {
      res = await fetch(`${this.endpoint}/completion`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(
        `Lost the connection to llama-server at ${this.endpoint}: `
        + `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const parsed = (await res.json()) as { content?: string; error?: unknown };
    if (!res.ok) {
      const message = typeof parsed.error === 'string'
        ? parsed.error
        : JSON.stringify(parsed.error ?? `HTTP ${res.status}`);
      throw new Error(`llama-server refused the request: ${message}`);
    }
    if (typeof parsed.content !== 'string') {
      throw new Error(
        `llama-server returned no completion content for a request to `
        + `${this.endpoint}/completion. This is /completion, not a chat endpoint — `
        + `a response without \`content\` means the server is not the one this `
        + `build expects.`,
      );
    }
    return parsed.content;
  }

  /** Stop the server and give the memory back. Idempotent. */
  async stop(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    const proc = this.proc;
    this.ready = false;
    this.proc = null;
    if (!proc) return;

    await new Promise<void>((resolve) => {
      const escalate = setTimeout(() => {
        // A wedged llama-server holding several GB is worse than a hard kill of
        // a process with no state worth saving.
        try {
          if (process.platform === 'win32' && proc.pid) {
            spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
          } else {
            proc.kill('SIGKILL');
          }
        } catch {
          /* already gone */
        }
        resolve();
      }, 5_000);

      proc.once('exit', () => {
        clearTimeout(escalate);
        resolve();
      });
      try {
        proc.kill();
      } catch {
        clearTimeout(escalate);
        resolve();
      }
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Internals
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * The per-request scale vector: 1.0 for the named adapter, 0.0 for every
   * other.
   *
   * Always the FULL vector, never just the one being switched on. llama-server
   * carries forward whatever it was last told, so a partial vector makes the
   * applied adapter depend on request order — and a blocks prompt answered with
   * the ocr adapter still still produces plausible text. Nothing errors; the
   * labels are just wrong. Stating every scale on every request removes the
   * ordering dependency entirely.
   */
  private loraVector(name: string | null): Array<{ id: number; scale: number }> {
    if (name !== null && !this.adapterIndex.has(name)) {
      throw new Error(
        `Unknown adapter '${name}'. This server loaded: `
        + `${this.adapterNames.join(', ') || '(none)'}. An adapter must be `
        + `passed to the constructor to be selectable.`,
      );
    }
    return this.adapters.map((a, id) => ({ id, scale: a.name === name ? 1.0 : 0.0 }));
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const ms = this.opts.idleShutdownMs ?? DEFAULT_IDLE_SHUTDOWN_MS;
    this.idleTimer = setTimeout(() => {
      void this.stop();
    }, ms);
    // A pending shutdown must not be what keeps the CLI alive after its work is
    // done. `unref` exists on node/bun timers; guard for exotic hosts.
    this.idleTimer.unref?.();
  }

  private async start(): Promise<void> {
    assertFile(this.opts.basePath, 'base model');
    for (const a of this.adapters) {
      assertFile(a.path, `adapter '${a.name}'`);
    }
    assertFile(this.opts.binaryPath, 'llama-server binary');

    const port = this.opts.port ?? (await freeLoopbackPort());
    this.resolvedPort = port;

    // The directory the binary lives in. It is the spawn cwd on win32 (below),
    // which is what makes a relative `--lora-scaled` path resolvable there.
    const binaryDir = path.dirname(this.opts.binaryPath);

    const nGpuLayers = this.opts.nGpuLayers ?? (process.platform === 'darwin' ? 99 : 0);

    const args = [
      '-m', this.opts.basePath,
      '--host', HOST,
      '--port', String(port),
      '-c', String(this.opts.contextSize),
      '-np', '1',                     // one at a time; the device serialises anyway
      '-ngl', String(nGpuLayers),
      '--no-webui',
    ];

    // Loaded at scale 0.0, so the server's baseline is "no adapter applied".
    // Every request then states the full scale vector (see loraVector), which
    // means an adapter is only ever active because a request asked for it — not
    // because it happened to be first on the command line.
    //
    // See loraScaledArg for why the path is spelled differently on Windows.
    for (const a of this.adapters) {
      args.push('--lora-scaled', loraScaledArg(a.path, binaryDir));
    }

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (process.platform === 'darwin') {
      // The llama.cpp dylibs ship alongside the binary.
      env['DYLD_LIBRARY_PATH'] = `${binaryDir}:${env['DYLD_LIBRARY_PATH'] ?? ''}`;
    }

    const proc = spawn(this.opts.binaryPath, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Windows needs cwd at the binary dir so it finds its DLLs. It is also
      // what `--lora-scaled`'s relative path is resolved against (loraScaledArg).
      cwd: process.platform === 'win32' ? binaryDir : undefined,
      windowsHide: true,
    });
    this.proc = proc;
    this.installExitHooks();

    // Held in an object rather than in two `let`s: TypeScript narrows a local
    // variable to the type of its initialiser and cannot see that an event
    // callback will reassign it, so a later `if (spawnError)` reads as `never`.
    // Property accesses are re-read after each await instead.
    const startup: {
      spawnError?: Error;
      exit?: { code: number | null; signal: NodeJS.Signals | null };
    } = {};

    proc.on('exit', (code, signal) => {
      startup.exit = { code, signal };
      this.ready = false;
      this.proc = null;
    });

    const watch = (chunk: Buffer): void => {
      const text = chunk.toString();
      this.opts.onLog?.(text.trimEnd());
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        this.logTail.push(line.trim());
        if (this.logTail.length > 20) this.logTail.shift();
      }
    };
    proc.stdout?.on('data', watch);
    proc.stderr?.on('data', watch);

    proc.on('error', (err) => {
      startup.spawnError = err;
    });

    // ── Readiness ──
    //
    // By polling /health for an HTTP **200**, not by watching the log and not by
    // opening a socket.
    //
    // llama-server binds the port before the weights are in, so a successful
    // TCP connect proves nothing. What it does while loading is answer /health
    // with **HTTP 503** and a body saying the model is loading — a perfectly
    // well-formed HTTP response. So a readiness check that treats "the server
    // answered" as "the server is ready" passes the instant the socket is up,
    // and the first real request lands on a 503 that reads as a broken model.
    // Readiness therefore requires status === 200, i.e. `curl -f` semantics.
    const timeoutMs = this.opts.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    let lastStatus: number | null = null;

    for (;;) {
      if (startup.spawnError) {
        await this.stop();
        throw new Error(`Could not start llama-server: ${startup.spawnError.message}`);
      }
      if (startup.exit) {
        const { code, signal } = startup.exit;
        throw new Error(
          `llama-server exited during startup (${signal ? `signal ${signal}` : `code ${code}`}).`
          + this.tailForError(),
        );
      }

      const status = await probeHealth(`http://${HOST}:${port}/health`);
      if (status === 200) break;
      if (status !== null) lastStatus = status;

      if (Date.now() > deadline) {
        await this.stop();
        throw new Error(
          `llama-server did not become ready within ${Math.round(timeoutMs / 1000)}s. `
          + (lastStatus === 503
            ? `It was still answering /health with 503 (loading the model) — the `
              + `model may be too large for this machine, or the load is simply `
              + `slower than the timeout allows.`
            : lastStatus !== null
              ? `Last /health status was ${lastStatus}.`
              : `It never answered on ${HOST}:${port}.`)
          + this.tailForError(),
        );
      }

      await delay(HEALTH_POLL_INTERVAL_MS);
    }

    this.ready = true;
    this.touch();
  }

  private tailForError(): string {
    if (!this.logTail.length) return '';
    return `\nLast llama-server output:\n` + this.logTail.map((l) => `  ${l}`).join('\n');
  }

  /**
   * Kill the child if this process goes away.
   *
   * A llama-server is a CHILD, and on every platform a child outlives a parent
   * that dies without cleaning up — leaving several gigabytes of weights
   * resident under pid 1 with no handle left to stop it. BookForge writes a pid
   * file because its parent is a long-lived app that can crash and be relaunched.
   * A CLI's answer is simpler: the process IS the run, so tie the child's life
   * to it and there is nothing to reap on the next start.
   */
  private installExitHooks(): void {
    if (this.exitHooksInstalled) return;
    this.exitHooksInstalled = true;

    const killNow = (): void => {
      const proc = this.proc;
      this.proc = null;
      this.ready = false;
      try {
        proc?.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    };

    // 'exit' handlers must be synchronous — no awaiting a graceful shutdown here.
    process.once('exit', killNow);
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      process.once(sig, () => {
        killNow();
        process.exit(130);
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One /health probe. Returns the HTTP status, or null when nothing answered.
 *
 * Deliberately does not distinguish "connection refused" from "not yet
 * listening" — both mean keep waiting — but DOES surface a non-200 status, so
 * the timeout message can say whether it spent three minutes loading a model
 * (503) or three minutes failing at something else.
 */
async function probeHealth(url: string): Promise<number | null> {
  try {
    const res = await fetch(url, { method: 'GET' });
    // Drain, or the socket stays open holding the connection pool.
    await res.text().catch(() => undefined);
    return res.status;
  } catch {
    return null;
  }
}

/**
 * Take an ephemeral loopback port by binding port 0 and reading what the OS
 * gave, then releasing it.
 *
 * There is a window between release and llama-server's bind. It is tolerable
 * because the OS does not hand out the same ephemeral port twice in quick
 * succession, and because the alternative — a fixed port — collides with a
 * llama-server the user started themselves, which is a real thing on a machine
 * where someone is developing this.
 */
export function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, HOST, () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        server.close();
        reject(new Error('Could not determine a free loopback port.'));
        return;
      }
      const { port } = addr;
      server.close(() => resolve(port));
    });
  });
}

function assertFile(filePath: string, label: string): void {
  try {
    if (fs.statSync(filePath).isFile()) return;
  } catch {
    throw new Error(`The ${label} is not at ${filePath}.`);
  }
  throw new Error(`The ${label} at ${filePath} is not a file.`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
