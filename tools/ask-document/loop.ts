/**
 * The tool loop both experiments share: an OpenAI-shaped chat with `tools`,
 * sent to Crucible (which writes each model's own tool format: Qwen's XML,
 * the Messages API) or to `claude -p` as plain text, round after round until
 * the model stops calling tools.
 *
 * The history is fitted to the model's window before every request: old tool
 * results and old replies are trimmed, newest kept longest, and a request
 * that cannot fit even fully trimmed is refused by name (the window is too
 * small for the job, a configuration to repair).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clip } from './book';

export function cliArgs(): Record<string, string> {
  const out: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`unexpected argument ${key}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`${key} needs a value`);
    out[key.slice(2)] = value;
    i += 1;
  }
  return out;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(a: Record<string, any>): string;
}

interface Msg {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  /** Not sent: the round a message belongs to, for trimming. */
  round?: number;
}

export interface LoopOptions {
  tools: Tool[];
  system: string;
  user: string;
  model: string;
  transport: 'crucible' | 'claude-cli';
  server: string;
  /** Sent as X-Crucible-Client, so every round is an item of the queue session this client opened. */
  clientName: string;
  maxRounds: number;
  /** Rounds of history kept whole when the window allows; older ones are trimmed. */
  keepRounds: number;
  maxTokens: number;
  /** The model's window in tokens. Absent, the history is trimmed by keepRounds alone. */
  context?: number;
  reasoning?: string;
  thinking?: 'on' | 'off';
  /** Where claude -p's scratch files go. */
  scratchDir: string;
  /**
   * Asked when the model stops calling tools. A string is sent back as the
   * next user turn and the loop goes on (work the harness knows is left);
   * null lets the run end.
   */
  onStop?: () => string | null;
  /** Shown after each round's line, e.g. a progress count. */
  status?: () => string;
}

export interface LoopResult {
  rounds: { round: number; ms: number; usage: any; calls: string[]; text: string | null }[];
  finalText: string;
  failure: string | null;
  seconds: number;
  tokens: { in: number; out: number };
}

export async function runLoop(o: LoopOptions): Promise<LoopResult> {
  const definitions = o.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));

  // Tokens per character of the last request, measured from its usage; the
  // first request uses a cautious guess.
  let tokensPerChar = 0.4;

  function trimmed(messages: Msg[], round: number, keep: number, drop = false): Msg[] {
    // With drop, rounds older than keep go entirely (a call and its results
    // leave together), not just their text: a long run's old calls alone can
    // outgrow a small window.
    const kept = drop ? messages.filter((m) => m.round === undefined || round - m.round < keep) : messages;
    if (drop && kept.length < messages.length) {
      const first = kept.findIndex((m) => m.round !== undefined);
      const note: Msg = { role: 'user', content: '[Earlier rounds were removed to fit the window. The tools hold the work so far.]' };
      kept.splice(first < 0 ? kept.length : first, 0, note);
    }
    return kept.map((m) => {
      const { round: r, ...rest } = m;
      if (r !== undefined && round - r >= keep && typeof m.content === 'string' && m.content.length > 240) {
        // Old results and the model's own old prose both go; its calls stay.
        return { ...rest, content: `${m.content.slice(0, 200)}… [older ${m.role === 'assistant' ? 'reply' : 'result'} trimmed]` };
      }
      return rest;
    });
  }

  const size = (ms: Msg[]): number => JSON.stringify(ms).length + (o.transport === 'crucible' ? JSON.stringify(definitions).length : 0);

  /**
   * The history as sent: keepRounds whole if it fits the window; else older
   * text trimmed, fewer rounds kept whole; else older rounds dropped, down to
   * the last one.
   */
  function wire(messages: Msg[], round: number): { wired: Msg[]; chars: number } {
    const fits = (chars: number): boolean => o.context === undefined || chars * tokensPerChar + o.maxTokens <= o.context * 0.95;
    for (let keep = o.keepRounds; keep >= 0; keep -= 1) {
      const wired = trimmed(messages, round, keep);
      const chars = size(wired);
      if (fits(chars)) return { wired, chars };
    }
    for (let keep = o.keepRounds; keep >= 1; keep -= 1) {
      const wired = trimmed(messages, round, keep, true);
      const chars = size(wired);
      if (fits(chars)) return { wired, chars };
    }
    const wired = trimmed(messages, round, 1, true);
    throw new Error(`the history does not fit a ${o.context}-token window even with only the last round kept (about ${Math.round(size(wired) * tokensPerChar)} tokens + ${o.maxTokens} for the reply); give the model a larger context or a smaller --max-tokens`);
  }

  async function chat(messages: Msg[], round: number, final: boolean): Promise<{ message: Msg; usage: any; ms: number; cut: boolean; reasoning: string | null }> {
    const { wired, chars } = wire(messages, round);
    const body: Record<string, unknown> = {
      model: o.model,
      messages: wired,
      max_tokens: o.maxTokens,
      tools: definitions,
      tool_choice: final ? 'none' : 'auto',
    };
    if (o.reasoning) body['reasoning_effort'] = o.reasoning;
    // Crucible's chat door reads thinking from the template's own switch; a
    // top-level "thinking" member is not one of its fields.
    if (o.thinking) body['chat_template_kwargs'] = { enable_thinking: o.thinking === 'on' };
    // Weather gets a budget: a dropped connection, a 429 or a 5xx is retried a
    // few times with a growing wait. A 4xx is a request this script got wrong.
    for (let attempt = 1; ; attempt += 1) {
      const t0 = Date.now();
      let res: Response;
      try {
        res = await fetch(`${o.server}/openai/v1/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json', 'X-Crucible-Api': '1', 'X-Crucible-Client': o.clientName,
            ...(process.env['ASK_TOKEN'] ? { authorization: `Bearer ${process.env['ASK_TOKEN']}` } : {}),
          },
          body: JSON.stringify(body),
          // A local model can take minutes on one round; Bun's default would cut it off.
          timeout: false,
        } as RequestInit);
      } catch (error) {
        if (attempt >= 4) throw error;
        console.error(`  connection failed (${(error as Error).message}); retrying in ${attempt * 5}s`);
        await Bun.sleep(attempt * 5000);
        continue;
      }
      const text = await res.text();
      if (res.ok) {
        const json = JSON.parse(text);
        const m = json.choices[0].message;
        if (json.usage?.prompt_tokens) tokensPerChar = json.usage.prompt_tokens / chars;
        return {
          message: { role: 'assistant', content: m.content ?? null, ...(m.tool_calls?.length ? { tool_calls: m.tool_calls } : {}) },
          usage: json.usage,
          ms: Date.now() - t0,
          cut: json.choices[0].finish_reason === 'length',
          // Thinking, split out by the server (Crucible 2.0.33): logged, never sent back.
          reasoning: typeof m.reasoning === 'string' && m.reasoning.length > 0 ? m.reasoning : null,
        };
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        console.error(`  HTTP ${res.status}; retrying in ${attempt * 10}s: ${text.slice(0, 200)}`);
        await Bun.sleep(attempt * 10000);
        continue;
      }
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 1000)}`);
    }
  }

  // ── claude -p: Claude Code as a plain-text model (Briefcase's claude-cli path)
  //
  // No tool definitions can be sent to `claude -p`, so the tools are described,
  // and called, in the <function_calls>/<invoke> shape Claude was trained on
  // (Briefcase measured Sonnet drifting into it from any other tag format). The
  // conversation is flattened into one prompt per round, USER/ASSISTANT
  // labelled; the system prompt goes in --system-prompt-file. Claude Code's own
  // tools, MCP servers, settings and session are all off, and it runs from the
  // scratch dir so no project's CLAUDE.md is read.

  function claudeToolsPrompt(): string {
    const lines = o.tools.map((t) => `<function>${JSON.stringify({ description: t.description, name: t.name, parameters: t.parameters })}</function>`).join('\n');
    return `In this environment you have access to a set of tools you can use to answer the user's question.
You can invoke functions by writing a "<function_calls>" block like the following as part of your reply to the user:
<function_calls>
<invoke name="$FUNCTION_NAME">
<parameter name="$PARAMETER_NAME">$PARAMETER_VALUE</parameter>
...
</invoke>
<invoke name="$FUNCTION_NAME2">
...
</invoke>
</function_calls>

String and scalar parameters should be specified as is, while lists and objects should use JSON format.

Here are the functions available in JSONSchema format:
<functions>
${lines}
</functions>

After a <function_calls> block, stop and wait: the results come back in the next USER turn as <function_results>. Never write <function_results> yourself.`;
  }

  /** The calls in a reply's text, as {name, JSON arguments}; the prose with the blocks cut out. */
  function parseInvokes(text: string): { prose: string; calls: { id: string; name: string; arguments: string }[] } {
    // Anything after a <function_results> the model wrote itself is a guess at
    // results it was never sent: cut it.
    const own = text.split(/<function_results>/)[0];
    const calls: { id: string; name: string; arguments: string }[] = [];
    // Read every <invoke>, wrapped or not: through `claude -p` the reply comes
    // back with the <function_calls> wrapper gone (Briefcase saw the same).
    for (const inv of own.matchAll(/<invoke name="([^"]+)">([\s\S]*?)(?:<\/invoke>|$)/g)) {
      const params: Record<string, unknown> = {};
      for (const p of inv[2].matchAll(/<parameter name="([^"]+)">([\s\S]*?)<\/parameter>/g)) {
        const raw = p[2].trim();
        let value: unknown = p[2];
        if (/^[[{]/.test(raw) || /^(true|false|-?\d+)$/.test(raw)) {
          try {
            value = JSON.parse(raw);
          } catch {
            value = p[2];
          }
        }
        params[p[1]] = value;
      }
      calls.push({ id: `cli_${calls.length}`, name: inv[1], arguments: JSON.stringify(params) });
    }
    const prose = own
      .replace(/<invoke name="[^"]+">[\s\S]*?(?:<\/invoke>|$)/g, '')
      .replace(/<\/?function_calls>/g, '')
      .trim();
    return { prose, calls };
  }

  const claudeBinary = process.env['ASK_CLAUDE_BIN'] ?? (process.platform === 'win32' ? 'C:/nvm4w/nodejs/node_modules/@anthropic-ai/claude-code/bin/claude.exe' : 'claude');

  async function claudeCli(messages: Msg[], round: number, final: boolean): Promise<{ text: string; usage: any; ms: number }> {
    const { wired } = wire(messages, round);
    const system = `${wired.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n')}\n\n${claudeToolsPrompt()}`;
    const turns = wired.filter((m) => m.role !== 'system');
    let prompt = `${turns.map((m) => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}:\n${m.content}`).join('\n\n')}\n\nReply as the assistant to the last USER turn.`;
    if (final) prompt += ' No more tool calls can be made: write your summary for the person now, with no <function_calls> block.';
    const dir = join(o.scratchDir, '.claude-cli');
    mkdirSync(dir, { recursive: true });
    const systemFile = join(dir, 'system.txt');
    writeFileSync(systemFile, system);
    const argv = ['-p', '--model', o.model, '--system-prompt-file', systemFile, '--tools', '', '--strict-mcp-config',
      '--no-session-persistence', '--setting-sources', '', '--output-format', 'json'];
    for (let attempt = 1; ; attempt += 1) {
      const t0 = Date.now();
      const child = Bun.spawn([claudeBinary, ...argv], { cwd: dir, stdin: new TextEncoder().encode(prompt), stdout: 'pipe', stderr: 'pipe' });
      // One reply is bounded: a call that has not answered in ten minutes is killed and retried.
      const timer = setTimeout(() => child.kill(), 10 * 60_000);
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      clearTimeout(timer);
      if (process.env['ASK_DEBUG']) console.error(`  claude -p exit ${code} in ${Date.now() - t0}ms; prompt ${prompt.length} chars; stderr ${clip(err, 300)}`);
      const ms = Date.now() - t0;
      let json: any = null;
      try {
        json = JSON.parse(out);
      } catch {
        // read below
      }
      if (code === 0 && json !== null && json.is_error !== true && typeof json.result === 'string') {
        const u = json.usage ?? {};
        const inTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        return { text: json.result, usage: { prompt_tokens: inTokens, completion_tokens: u.output_tokens ?? 0, cost_usd: json.total_cost_usd ?? null }, ms };
      }
      // An overloaded or dropped call is weather: a few tries with a growing wait.
      if (attempt < 4) {
        console.error(`  claude -p failed (exit ${code}): ${clip(err || out, 300)}; retrying in ${attempt * 15}s`);
        await Bun.sleep(attempt * 15000);
        continue;
      }
      throw new Error(`claude -p failed (exit ${code}): ${(err || out).slice(0, 1000)}`);
    }
  }

  // ── The rounds

  const messages: Msg[] = [
    { role: 'system', content: o.system },
    { role: 'user', content: o.user },
  ];
  const rounds: LoopResult['rounds'] = [];
  const t0 = Date.now();
  let finalText = '';
  // A run that dies mid-way still returns what it did, with the error, so the
  // caller reports its work rather than losing it.
  let failure: string | null = null;
  try {
    for (let round = 0; ; round += 1) {
      const final = round >= o.maxRounds;
      let calls: { id: string; name: string; arguments: string }[];
      let prose: string | null;
      let usage: any;
      let ms: number;
      let cut = false;
      let reasoning: string | null = null;
      if (o.transport === 'crucible') {
        const reply = await chat(messages, round, final);
        reasoning = reply.reasoning;
        messages.push({ ...reply.message, round });
        calls = (reply.message.tool_calls ?? []).map((c) => ({ id: c.id, name: c.function.name, arguments: c.function.arguments }));
        prose = reply.message.content;
        ({ usage, ms, cut } = reply);
      } else {
        const reply = await claudeCli(messages, round, final);
        const parsed = parseInvokes(reply.text);
        // The reply as the model wrote it (up to any results it guessed at), so it
        // sees its own calls in the next round's history.
        messages.push({ role: 'assistant', content: reply.text.split(/<function_results>/)[0].trim(), round });
        calls = final ? [] : parsed.calls;
        prose = parsed.prose || null;
        ({ usage, ms } = reply);
      }
      const entry = { round, ms, usage, calls: [] as string[], text: prose };
      rounds.push(entry);
      if (prose) finalText = prose;
      console.log(`round ${round}: ${(ms / 1000).toFixed(1)}s, in ${usage?.prompt_tokens ?? '?'} out ${usage?.completion_tokens ?? '?'}, ${calls.length} calls${o.status ? `, ${o.status()}` : ''}`);
      if (prose) console.log(`  says: ${clip(prose, 300)}`);
      if (reasoning) console.log(`  thought (${reasoning.length} chars): …${clip(reasoning.slice(-300), 300)}`);
      if (calls.length === 0) {
        if (final) break;
        // A reply cut off at the token limit before it called anything is not
        // the model's answer: it ran out mid-thought.
        if (cut) {
          console.log('  cut off at max_tokens with no call; asking it to act');
          messages.push({ role: 'user', content: `Your last reply hit the ${o.maxTokens}-token limit before it called a tool. Keep your reasoning to a few sentences and make the next tool call now.`, round });
          continue;
        }
        const more = o.onStop?.() ?? null;
        if (more === null) break;
        console.log(`  stopped with work left; ${clip(more, 160)}`);
        messages.push({ role: 'user', content: more, round });
        continue;
      }
      const results: { name: string; content: string }[] = [];
      for (const call of calls) {
        const tool = o.tools.find((t) => t.name === call.name);
        let content: string;
        try {
          if (tool === undefined) throw new Error(`there is no tool "${call.name}"; the tools are ${o.tools.map((t) => t.name).join(', ')}`);
          const a = call.arguments ? JSON.parse(call.arguments) : {};
          content = tool.run(a);
        } catch (error) {
          content = `couldn't run ${call.name}: ${(error as Error).message}`;
        }
        if (round + 1 >= o.maxRounds) content += '\n\nNo more tool calls can be made. Write your summary for the person now.';
        entry.calls.push(`${call.name}(${clip(call.arguments ?? '', 200)}) → ${clip(content, 120)}`);
        console.log(`  ${call.name}(${clip(call.arguments ?? '', 160)}) → ${clip(content, 100)}`);
        if (o.transport === 'crucible') messages.push({ role: 'tool', tool_call_id: call.id, content, round });
        else results.push({ name: call.name, content });
      }
      if (o.transport === 'claude-cli') {
        const blocks = results.map((r) => `<result>\n<tool_name>${r.name}</tool_name>\n<stdout>\n${r.content}\n</stdout>\n</result>`);
        messages.push({ role: 'user', content: `<function_results>\n${blocks.join('\n')}\n</function_results>`, round });
      }
    }
  } catch (error) {
    failure = (error as Error).message;
    console.error(`\nrun failed: ${failure}`);
  }
  const tokens = rounds.reduce((s, e) => ({ in: s.in + (e.usage?.prompt_tokens ?? 0), out: s.out + (e.usage?.completion_tokens ?? 0) }), { in: 0, out: 0 });
  return { rounds, finalText, failure, seconds: Math.round((Date.now() - t0) / 1000), tokens };
}
