/**
 * ASK THE DOCUMENT — an experiment, not a feature.
 *
 * A person types what they want done to a book ("strike every study question,
 * and anything that isn't prose worth hearing"), and a model works through the
 * book with tools and MARKS blocks, each with a reason. Nothing is written to
 * the book: the marks go to a report, and with --reference they are scored
 * against a known answer.
 *
 * The questions it exists to answer: does a tool loop find the structure of a
 * book the way a person working through it does, how many rounds and tokens
 * that takes, and whether a local model can do it as well as Claude. Owen
 * expects the loop itself to become a Crucible feature, so this keeps it in
 * one file and plain: an OpenAI-shaped chat with `tools`, sent to Crucible,
 * which writes each model's own tool format (Qwen's XML, the Messages API).
 *
 * The book is read the app's way: the reading's book file through
 * `parseBookFile`, the ledger's edit steps through `parseOpsFile`, and
 * `replayOps` over both. Blocks already struck are gone from the model's view.
 *
 *   bun tools/ask-document/ask-document.ts --project <dir> --model <id>
 *       (--question <text> | --question-file <path>)
 *       [--ops-file <path>]      replay this ops file instead of the ledger's edit chain
 *       [--reference <ids.json>] score the marks against these block ids
 *       [--out <dir>]            where the report goes (default: the cwd)
 *       [--server <url>]         default http://localhost:7100
 *       [--max-rounds <n>]       default 40
 *       [--keep-rounds <n>]      tool results older than this many rounds are trimmed; default 6
 *       [--max-tokens <n>]       per reply; default 8000
 *       [--reasoning <effort>]   sent as reasoning_effort when given
 *       [--thinking on|off]      sent as chat_template_kwargs.enable_thinking (local models)
 *       [--context <tokens>]     the model's window; the history is trimmed to fit it
 *       [--transport crucible|claude-cli]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { clip, loadBook, type Block } from './book';
import { cliArgs, runLoop, type Tool } from './loop';

const opt = cliArgs();
function need(name: string): string {
  const value = opt[name];
  if (value === undefined) throw new Error(`--${name} is required`);
  return value;
}
const projectDir = resolve(need('project'));
const model = need('model');
const question = opt['question'] ?? (opt['question-file'] ? readFileSync(opt['question-file'], 'utf8').trim() : need('question'));
const maxRounds = Number(opt['max-rounds'] ?? 40);
const outDir = resolve(opt['out'] ?? '.');
const transport = opt['transport'] ?? 'crucible';
if (transport !== 'crucible' && transport !== 'claude-cli') throw new Error('--transport is crucible or claude-cli');

const book = loadBook(projectDir, opt['ops-file']);
const { live, byId, originals, alreadyStruck, chapterTitle } = book;

// ─────────────────────────────────────────────────────────────────────────────
// Marks
// ─────────────────────────────────────────────────────────────────────────────

const marks = new Map<string, string>();

function line(b: Block, n = 200): string {
  const mark = marks.has(b.id) ? ` [MARKED: ${marks.get(b.id)}]` : '';
  const head = b.category === 'Text' ? '' : ` [${b.category}]`;
  const was = originals.has(b.id) ? ` (edited by the person; originally: "${clip(originals.get(b.id)!, 80)}")` : '';
  return `${b.id}${head}${mark}${was} ${clip(b.text, n)}`;
}

function regex(pattern: unknown, flags: unknown): RegExp {
  if (typeof pattern !== 'string' || pattern.length === 0) throw new Error('pattern must be a non-empty regular expression string');
  const f = typeof flags === 'string' ? flags.replace(/[gy]/g, '') : '';
  return new RegExp(pattern, f);
}

function filtered(only: unknown): (b: Block) => boolean {
  if (only === undefined || only === 'all') return () => true;
  if (only === 'unmarked') return (b) => !marks.has(b.id);
  if (only === 'marked') return (b) => marks.has(b.id);
  throw new Error('only must be "all", "unmarked" or "marked"');
}

function position(ref: unknown): number {
  if (typeof ref === 'number') return Math.max(0, Math.min(live.length - 1, Math.floor(ref)));
  if (typeof ref === 'string') {
    const b = byId.get(ref);
    if (b === undefined) throw new Error(`there is no live block ${ref} (it may be struck already, or not exist)`);
    return b.index;
  }
  return 0;
}

/** The blocks a selector names: exactly one of ids, pattern, span, range. */
function select(a: Record<string, any>): Block[] {
  const given = ['ids', 'pattern', 'span', 'range'].filter((k) => a[k] !== undefined);
  if (given.length !== 1) throw new Error(`give exactly one of ids, pattern, span, range (got ${given.join(', ') || 'none'})`);
  const inChapter = a.chapter === undefined ? () => true : (b: Block) => b.chapter === Number(a.chapter);
  if (a.ids !== undefined) {
    if (!Array.isArray(a.ids)) throw new Error('ids must be an array of block ids');
    const missing = a.ids.filter((id: string) => !byId.has(id));
    if (missing.length > 0) throw new Error(`not live blocks: ${missing.slice(0, 10).join(', ')}`);
    return a.ids.map((id: string) => byId.get(id)!);
  }
  if (a.pattern !== undefined) {
    const re = regex(a.pattern, a.flags);
    return live.filter((b) => inChapter(b) && re.test(b.text));
  }
  if (a.range !== undefined) {
    const from = position(a.range.from);
    const to = position(a.range.to);
    if (to < from) throw new Error('range.to is before range.from');
    return live.slice(from, to + 1);
  }
  // A span: each block matching `start`, and the blocks after it up to (not
  // including) the next block matching `until`, or the next chapter.
  const start = regex(a.span.start, a.span.flags);
  const until = regex(a.span.until, a.span.flags);
  const includeStart = a.span.include_start !== false;
  const out: Block[] = [];
  for (let i = 0; i < live.length; i += 1) {
    const b = live[i];
    if (!inChapter(b) || !start.test(b.text)) continue;
    if (includeStart) out.push(b);
    for (let j = i + 1; j < live.length; j += 1) {
      const next = live[j];
      if (next.chapter !== b.chapter || until.test(next.text) || start.test(next.text)) break;
      out.push(next);
    }
  }
  return [...new Map(out.map((b) => [b.id, b])).values()];
}

function examples(blocks: Block[], n: number): string {
  if (blocks.length <= n) return blocks.map((b) => line(b, 160)).join('\n');
  const step = blocks.length / n;
  const picks = Array.from({ length: n }, (_, i) => blocks[Math.floor(i * step)]);
  return picks.map((b) => line(b, 160)).join('\n');
}

function perChapter(blocks: Block[]): string {
  const counts = new Map<number, number>();
  for (const b of blocks) counts.set(b.chapter, (counts.get(b.chapter) ?? 0) + 1);
  return [...counts.entries()].map(([c, n]) => `ch${c}:${n}`).join(' ');
}

// ─────────────────────────────────────────────────────────────────────────────
// Tools
// ─────────────────────────────────────────────────────────────────────────────

const selectorProps = {
  ids: { type: 'array', items: { type: 'string' }, description: 'Exact block ids.' },
  pattern: { type: 'string', description: 'A JavaScript regular expression tested against each block\'s text.' },
  flags: { type: 'string', description: 'Regex flags for pattern, e.g. "i".' },
  span: {
    type: 'object',
    description: 'Each block matching start, plus the blocks after it until (not including) the next block matching until, the next block matching start, or the next chapter.',
    properties: { start: { type: 'string' }, until: { type: 'string' }, flags: { type: 'string' }, include_start: { type: 'boolean' } },
    required: ['start', 'until'],
  },
  range: { type: 'object', description: 'Every live block from one id to another, inclusive.', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
  chapter: { type: 'integer', description: 'Limit pattern or span to this chapter number (from outline).' },
};

const tools: Tool[] = [
  {
    name: 'outline',
    description: 'The book\'s chapters: number, title, first block id, how many live blocks and how many are marked. Start here.',
    parameters: { type: 'object', properties: {} },
    run() {
      const rows = book.chapters.map((c, i) => {
        const blocks = live.filter((b) => b.chapter === i);
        if (blocks.length === 0) return `ch${i} "${c.title}" — already removed`;
        return `ch${i} "${c.title}" first=${blocks[0].id} blocks=${blocks.length} marked=${blocks.filter((b) => marks.has(b.id)).length}`;
      });
      const before = live.filter((b) => b.chapter === -1).length;
      return [`"${book.title}": ${live.length} live blocks, ${alreadyStruck} already struck by the person (hidden), ${marks.size} marked.`, before ? `${before} blocks before the first chapter.` : '', ...rows].filter(Boolean).join('\n');
    },
  },
  {
    name: 'read',
    description: 'Read blocks in order from a block id, one per line: id, mark if any, text (clipped unless full). Use only:"unmarked" to review what is left.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Block id to start at (default: the first block).' },
        count: { type: 'integer', description: 'How many blocks, at most 80 (default 40).' },
        full: { type: 'boolean', description: 'Whole text instead of the first 200 characters.' },
        only: { type: 'string', enum: ['all', 'unmarked', 'marked'] },
        chapter: { type: 'integer', description: 'Read this chapter from its start instead of from.' },
      },
    },
    run(a) {
      const count = Math.min(80, Math.max(1, Number(a.count ?? 40)));
      const keep = filtered(a.only);
      let i = a.chapter !== undefined ? live.findIndex((b) => b.chapter === Number(a.chapter)) : position(a.from);
      if (i < 0) throw new Error(`chapter ${a.chapter} has no live blocks`);
      const out: string[] = [];
      let lastChapter = -2;
      for (; i < live.length && out.length < count; i += 1) {
        const b = live[i];
        if (!keep(b)) continue;
        if (b.chapter !== lastChapter) {
          out.push(`— ch${b.chapter} "${chapterTitle(b.chapter)}" —`);
          lastChapter = b.chapter;
        }
        out.push(line(b, a.full ? 2000 : 200));
      }
      out.push(i < live.length ? `(next: ${live[i].id})` : '(end of book)');
      return out.join('\n');
    },
  },
  {
    name: 'search',
    description: 'Find live blocks whose text matches a regular expression: the count, where they fall by chapter, and spread-out examples.',
    parameters: {
      type: 'object',
      properties: {
        pattern: selectorProps.pattern,
        flags: selectorProps.flags,
        chapter: selectorProps.chapter,
        only: { type: 'string', enum: ['all', 'unmarked', 'marked'] },
        show: { type: 'integer', description: 'How many examples, at most 30 (default 10).' },
      },
      required: ['pattern'],
    },
    run(a) {
      const re = regex(a.pattern, a.flags);
      const keep = filtered(a.only);
      const hits = live.filter((b) => keep(b) && (a.chapter === undefined || b.chapter === Number(a.chapter)) && re.test(b.text));
      const show = Math.min(30, Math.max(1, Number(a.show ?? 10)));
      return `${hits.length} matches (${hits.filter((b) => marks.has(b.id)).length} already marked). By chapter: ${perChapter(hits) || 'none'}\n${examples(hits, show)}`;
    },
  },
  {
    name: 'mark',
    description: 'Mark blocks for removal, with a short reason the person will review them under. Give exactly one selector. Use dry_run:true first to see what a selector catches.',
    parameters: {
      type: 'object',
      properties: { ...selectorProps, reason: { type: 'string', description: 'Short label, e.g. "study question". Blocks are grouped by it for review.' }, dry_run: { type: 'boolean' } },
      required: ['reason'],
    },
    run(a) {
      if (typeof a.reason !== 'string' || a.reason.trim().length === 0) throw new Error('reason is required');
      const blocks = select(a);
      const fresh = blocks.filter((b) => !marks.has(b.id));
      const summary = `${blocks.length} blocks (${blocks.length - fresh.length} already marked). By chapter: ${perChapter(blocks) || 'none'}`;
      if (a.dry_run) return `WOULD MARK ${summary}\n${examples(blocks, 12)}`;
      for (const b of fresh) marks.set(b.id, a.reason.trim());
      return `MARKED ${fresh.length} new as "${a.reason.trim()}". ${summary}. Total marked: ${marks.size}.`;
    },
  },
  {
    name: 'unmark',
    description: 'Take marks off: by selector, or every block marked with a given reason.',
    parameters: { type: 'object', properties: { ...selectorProps, reason: { type: 'string', description: 'Unmark every block marked with exactly this reason.' } } },
    run(a) {
      const blocks = a.reason !== undefined && ['ids', 'pattern', 'span', 'range'].every((k) => a[k] === undefined)
        ? live.filter((b) => marks.get(b.id) === a.reason)
        : select(a);
      let n = 0;
      for (const b of blocks) if (marks.delete(b.id)) n += 1;
      return `Unmarked ${n}. Total marked: ${marks.size}.`;
    },
  },
  {
    name: 'marks_summary',
    description: 'Every reason used so far, how many blocks each holds, and examples.',
    parameters: { type: 'object', properties: {} },
    run() {
      const groups = new Map<string, Block[]>();
      for (const b of live) if (marks.has(b.id)) groups.set(marks.get(b.id)!, [...(groups.get(marks.get(b.id)!) ?? []), b]);
      if (groups.size === 0) return 'Nothing marked yet.';
      return [...groups.entries()].map(([r, bs]) => `"${r}": ${bs.length}\n${examples(bs, 3)}`).join('\n\n');
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// The loop
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM = `You help a person edit a book they are turning into an audiobook. The book is a list of blocks (paragraphs, headings, captions, and so on), each with an id like e-123. Blocks the person already removed are hidden from you.

Your job: carry out the person's request by MARKING blocks for removal, each with a short reason. You never delete anything; the person reviews your marks grouped by reason and decides. Marks are kept by the tools, not by you; use marks_summary or read with only:"marked" to see them.

Work the way a careful editor would with a long book:
1. Survey: outline, then read a sample of the start and of a few chapters to learn how the book is built — what recurs, what is body text, what is apparatus.
2. Turn what you find into rules. Search to see how far a pattern reaches and what it would catch by mistake. Use mark with dry_run first, then mark.
3. Use exact ids for one-off judgment calls.
4. Check your work: read with only:"unmarked" through each chapter's non-body regions, and spot-check what you marked, so nothing is missed and nothing wrongly caught. Unmark mistakes.
5. When you are done, stop calling tools and write a short summary for the person: what you marked under each reason and anything you were unsure of.

Tool results older than a few rounds are trimmed to save space, so do not rely on re-reading old results; call the tool again if you need it. You have at most ${maxRounds} rounds of tool calls.`;

console.log(`${book.title}: ${live.length} live blocks, ${alreadyStruck} already struck. Model ${model} via ${transport}.`);
const run = await runLoop({
  tools,
  system: SYSTEM,
  user: question,
  model,
  transport,
  server: (opt['server'] ?? 'http://localhost:7100').replace(/\/$/, ''),
  clientName: 'ask-document',
  maxRounds,
  keepRounds: Number(opt['keep-rounds'] ?? 6),
  maxTokens: Number(opt['max-tokens'] ?? 8000),
  context: opt['context'] ? Number(opt['context']) : undefined,
  reasoning: opt['reasoning'],
  thinking: opt['thinking'] as 'on' | 'off' | undefined,
  scratchDir: outDir,
  status: () => `marked ${marks.size}`,
});
const { finalText, failure } = run;

// ─────────────────────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────────────────────

const totals = run.tokens;
const report: Record<string, unknown> = {
  model,
  question,
  project: projectDir,
  liveBlocks: live.length,
  rounds: run.rounds.length,
  seconds: run.seconds,
  tokens: totals,
  failure,
  marked: marks.size,
  byReason: Object.fromEntries([...new Set(marks.values())].map((r) => [r, [...marks.values()].filter((x) => x === r).length])),
  finalText,
  marks: Object.fromEntries(marks),
  log: run.rounds,
};

console.log(`\n${run.rounds.length} rounds, ${report.seconds}s, ${totals.in} tokens in, ${totals.out} out. Marked ${marks.size}.`);
console.log(report.byReason);

if (opt['reference']) {
  const reference = new Set<string>((JSON.parse(readFileSync(opt['reference'], 'utf8')) as string[]).filter((id) => byId.has(id)));
  const tp = [...marks.keys()].filter((id) => reference.has(id));
  const fp = [...marks.keys()].filter((id) => !reference.has(id));
  const fn = [...reference].filter((id) => !marks.has(id));
  const score = {
    reference: reference.size,
    agreed: tp.length,
    precision: +(tp.length / Math.max(1, marks.size)).toFixed(3),
    recall: +(tp.length / Math.max(1, reference.size)).toFixed(3),
    extra: fp.map((id) => `${id} [${marks.get(id)}] ${clip(byId.get(id)!.text, 140)}`),
    missed: fn.map((id) => `${id} ${clip(byId.get(id)!.text, 140)}`),
  };
  report['score'] = score;
  console.log(`score: agreed ${tp.length}/${reference.size}, precision ${score.precision}, recall ${score.recall}, extra ${fp.length}, missed ${fn.length}`);
}

mkdirSync(outDir, { recursive: true });
const file = join(outDir, `ask-${model.replace(/[^\w.-]+/g, '_')}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
console.log(`report: ${file}`);
console.log(`\n${finalText}`);
if (failure) process.exitCode = 1;