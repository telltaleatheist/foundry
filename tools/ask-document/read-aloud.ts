/**
 * READ-ALOUD CLEANUP — an experiment, not a feature.
 *
 * The tool loop of ask-document.ts put to a cleanup job: rewrite what a
 * narrator cannot read as printed (years, numbers, abbreviations, symbols)
 * into the words they would say, one exact substitution at a time.
 *
 * What differs from asking the document, and why:
 * - The HARNESS owns the worklist. Every block holding a candidate (a digit,
 *   an abbreviation from a fixed list, a dotted acronym, a symbol, a roman
 *   numeral) starts unreviewed, and the run is not done until each one is
 *   fixed or kept on purpose. A model that stops early is handed the rest.
 *   (The ask-document runs showed a local model's coverage fading as its own
 *   memory of the book was trimmed away; coverage cannot depend on that.)
 * - Edits are substitutions, never retyping: fix(id, find, replace) must find
 *   its text in the block, so a model cannot quietly change words it was not
 *   asked to touch.
 * - Nothing is written to the project. The proposed edits go to a report and
 *   an ops file of `text` ops, for review.
 *
 *   bun tools/ask-document/read-aloud.ts --project <dir> --model <id>
 *       (--request <text> | --request-file <path>)
 *       [--ops-file <path>]      replay this ops file instead of the ledger's edit chain
 *       [--out <dir>]            where the report goes (default: the cwd)
 *       [--server <url>]         default http://localhost:7100
 *       [--max-rounds <n>]       default 200
 *       [--keep-rounds <n>]      default 3
 *       [--max-tokens <n>]       per reply; default 4000
 *       [--context <tokens>]     the model's window; the history is trimmed to fit it
 *       [--thinking on|off]      sent as chat_template_kwargs.enable_thinking (local models)
 *       [--reasoning <effort>]   sent as reasoning_effort when given
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
const request = opt['request'] ?? (opt['request-file'] ? readFileSync(opt['request-file'], 'utf8').trim() : need('request'));
const maxRounds = Number(opt['max-rounds'] ?? 200);
const outDir = resolve(opt['out'] ?? '.');
const transport = opt['transport'] ?? 'crucible';
if (transport !== 'crucible' && transport !== 'claude-cli') throw new Error('--transport is crucible or claude-cli');

const book = loadBook(projectDir, opt['ops-file']);
const { live, byId, chapterTitle } = book;

// ─────────────────────────────────────────────────────────────────────────────
// Candidates: what a narrator may not read as printed
// ─────────────────────────────────────────────────────────────────────────────

const ABBREVIATIONS = [
  'Mr', 'Mrs', 'Ms', 'Dr', 'St', 'Mt', 'Ft', 'Jr', 'Sr', 'Prof', 'Rev', 'Gen', 'Col', 'Capt', 'Lt', 'Sgt', 'Gov', 'Sen', 'Rep', 'Pres',
  'No', 'Nos', 'Vol', 'Vols', 'vol', 'vols', 'p', 'pp', 'ch', 'chap', 'ed', 'eds', 'trans', 'ca', 'cf', 'viz', 'vs', 'etc', 'approx', 'esp', 'incl',
  'Co', 'Corp', 'Inc', 'Ltd', 'Bros', 'Ave', 'Rd', 'Blvd',
  'Jan', 'Feb', 'Mar', 'Apr', 'Aug', 'Sep', 'Sept', 'Oct', 'Nov', 'Dec',
  'lb', 'lbs', 'oz', 'ft', 'in', 'yd', 'yds', 'mi', 'km', 'cm', 'mm', 'kg', 'mg', 'hr', 'hrs', 'min', 'sec',
];
const KINDS: { kind: string; re: RegExp }[] = [
  { kind: 'number', re: /\d[\d,.:\-–/]*\d|\d/g },
  { kind: 'abbreviation', re: new RegExp(`\\b(?:${ABBREVIATIONS.join('|')})\\.|\\b(?:[A-Za-z]\\.){2,}|\\b(?:e\\.g|i\\.e)\\b`, 'g') },
  { kind: 'symbol', re: /[%&$£€°§¶#@+=×÷½¼¾]/g },
  { kind: 'roman numeral', re: /\b[IVXLC]{2,}\b/g },
];

interface Hit {
  kind: string;
  text: string;
}

function candidates(text: string): Hit[] {
  const hits: Hit[] = [];
  for (const { kind, re } of KINDS) for (const m of text.matchAll(re)) hits.push({ kind, text: m[0] });
  return hits;
}

/** The current text of every block an edit touched. */
const current = new Map<string, string>();
const textOf = (b: Block): string => current.get(b.id) ?? b.text;

type State = { status: 'unreviewed' } | { status: 'fixed'; note: string } | { status: 'kept'; reason: string };
/** One entry per block that held a candidate when the run began. */
const work = new Map<string, State>();
for (const b of live) if (candidates(b.text).length > 0) work.set(b.id, { status: 'unreviewed' });
const edits = new Map<string, { find: string; replace: string }[]>();

const unreviewed = (): Block[] => live.filter((b) => work.get(b.id)?.status === 'unreviewed');
const counts = () => {
  const c = { unreviewed: 0, fixed: 0, kept: 0 };
  for (const s of work.values()) c[s.status] += 1;
  return c;
};

/** The block's text with each candidate bracketed, so the model sees exactly what was found. */
function marked(text: string): string {
  const spans: [number, number][] = [];
  for (const { re } of KINDS) for (const m of text.matchAll(re)) spans.push([m.index!, m.index! + m[0].length]);
  spans.sort((a, b) => a[0] - b[0]);
  let out = '';
  let at = 0;
  for (const [s, e] of spans) {
    if (s < at) continue;
    out += `${text.slice(at, s)}⟦${text.slice(s, e)}⟧`;
    at = e;
  }
  return out + text.slice(at);
}

function regex(pattern: unknown, flags: unknown, global = false): RegExp {
  if (typeof pattern !== 'string' || pattern.length === 0) throw new Error('pattern must be a non-empty regular expression string');
  const f = (typeof flags === 'string' ? flags.replace(/[gy]/g, '') : '') + (global ? 'g' : '');
  return new RegExp(pattern, f);
}

/** Apply one substitution to a block's current text; the find must be there, and only once unless `occurrence` says which. */
function substitute(b: Block, find: string, replace: string, occurrence?: number): void {
  if (typeof find !== 'string' || find.length === 0) throw new Error('find must be non-empty text copied from the block');
  if (typeof replace !== 'string') throw new Error('replace must be text');
  const text = textOf(b);
  const at: number[] = [];
  for (let i = text.indexOf(find); i >= 0; i = text.indexOf(find, i + 1)) at.push(i);
  if (at.length === 0) throw new Error(`"${find}" is not in ${b.id}; its text is now: ${clip(text, 300)}`);
  let index: number;
  if (occurrence !== undefined) {
    if (!Number.isInteger(occurrence) || occurrence < 1 || occurrence > at.length) throw new Error(`"${find}" occurs ${at.length} times in ${b.id}; occurrence must be 1 to ${at.length}`);
    index = at[occurrence - 1];
  } else {
    if (at.length > 1) throw new Error(`"${find}" occurs ${at.length} times in ${b.id}; give occurrence (1 to ${at.length}) or a longer find`);
    index = at[0];
  }
  current.set(b.id, text.slice(0, index) + replace + text.slice(index + find.length));
  edits.set(b.id, [...(edits.get(b.id) ?? []), { find, replace }]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tools
// ─────────────────────────────────────────────────────────────────────────────

const tools: Tool[] = [
  {
    name: 'progress',
    description: 'How many candidate blocks are unreviewed, fixed and kept. The job is done when none are unreviewed.',
    parameters: { type: 'object', properties: {} },
    run() {
      const c = counts();
      return `${work.size} candidate blocks: ${c.unreviewed} unreviewed, ${c.fixed} fixed, ${c.kept} kept.`;
    },
  },
  {
    name: 'next_batch',
    description: 'The next unreviewed candidate blocks in book order, full text, with each candidate bracketed ⟦like this⟧. Resolve every block shown, with fix or keep, before asking for more.',
    parameters: { type: 'object', properties: { count: { type: 'integer', description: 'How many blocks, at most 12 (default 8).' } } },
    run(a) {
      const n = Math.min(12, Math.max(1, Number(a.count ?? 8)));
      const batch = unreviewed().slice(0, n);
      if (batch.length === 0) return 'Nothing is left unreviewed. Write your summary.';
      const left = counts().unreviewed;
      return [
        `${batch.length} of ${left} unreviewed:`,
        ...batch.map((b) => {
          const before = live[b.index - 1];
          const context = before ? `   (after: "${clip(textOf(before), 90)}")` : '';
          return `${b.id} [${b.category}] ch${b.chapter} "${clip(chapterTitle(b.chapter), 40)}"${context}\n   ${marked(textOf(b))}`;
        }),
      ].join('\n');
    },
  },
  {
    name: 'fix',
    description: 'Rewrite parts of ONE block for reading aloud, as exact substitutions: each find is text copied from the block, replaced by what the narrator should say. Edits apply in order. The block is then resolved. Change nothing else.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              find: { type: 'string', description: 'Exact text from the block, long enough to be unique (or give occurrence).' },
              replace: { type: 'string' },
              occurrence: { type: 'integer', description: 'Which occurrence of find, from 1, when it appears more than once.' },
            },
            required: ['find', 'replace'],
          },
        },
        note: { type: 'string', description: 'Optional: why, when a choice was not obvious (e.g. "St. here is Saint").' },
      },
      required: ['id', 'edits'],
    },
    run(a) {
      const b = byId.get(a.id);
      if (b === undefined) throw new Error(`there is no live block ${a.id}`);
      if (!Array.isArray(a.edits) || a.edits.length === 0) throw new Error('edits must be a non-empty array of {find, replace}');
      const hadText = current.get(b.id);
      const hadEdits = edits.get(b.id);
      try {
        for (const e of a.edits) substitute(b, e.find, e.replace, e.occurrence);
      } catch (error) {
        // All of a call's edits or none: put the block back as it was.
        if (hadText === undefined) current.delete(b.id);
        else current.set(b.id, hadText);
        if (hadEdits === undefined) edits.delete(b.id);
        else edits.set(b.id, hadEdits);
        throw error;
      }
      work.set(b.id, { status: 'fixed', note: typeof a.note === 'string' ? a.note : '' });
      const left = candidates(textOf(b));
      const warn = left.length ? `\nStill bracketed in it: ${left.map((h) => `⟦${h.text}⟧`).join(' ')}. Fix them too if they should be read differently; leave them if they read fine.` : '';
      return `${b.id} now reads: ${textOf(b)}${warn}\n${counts().unreviewed} unreviewed.`;
    },
  },
  {
    name: 'keep',
    description: 'Resolve blocks whose candidates already read correctly aloud (for example "No." meaning the word no), unchanged.',
    parameters: {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'string' } }, reason: { type: 'string', description: 'Short reason, e.g. "already reads fine".' } },
      required: ['ids', 'reason'],
    },
    run(a) {
      if (!Array.isArray(a.ids) || a.ids.length === 0) throw new Error('ids must be a JSON array of block ids, like ["e-1", "e-2"], and reason is a separate parameter');
      if (typeof a.reason !== 'string' || !a.reason.trim()) throw new Error('reason is required');
      const unknown = a.ids.filter((id: string) => !work.has(id));
      if (unknown.length) throw new Error(`not candidate blocks: ${unknown.join(', ')}`);
      for (const id of a.ids) if (work.get(id)!.status === 'unreviewed') work.set(id, { status: 'kept', reason: a.reason.trim() });
      return `Kept ${a.ids.length}. ${counts().unreviewed} unreviewed.`;
    },
  },
  {
    name: 'search',
    description: 'Find blocks anywhere in the book whose current text matches a regular expression, to see how a term is used elsewhere and keep choices consistent.',
    parameters: {
      type: 'object',
      properties: { pattern: { type: 'string' }, flags: { type: 'string' }, show: { type: 'integer', description: 'At most 20 (default 8).' } },
      required: ['pattern'],
    },
    run(a) {
      const re = regex(a.pattern, a.flags);
      const hits = live.filter((b) => re.test(textOf(b)));
      const show = Math.min(20, Math.max(1, Number(a.show ?? 8)));
      return `${hits.length} blocks match.\n${hits.slice(0, show).map((b) => `${b.id} [${work.get(b.id)?.status ?? 'no candidate'}] ${clip(textOf(b), 200)}`).join('\n')}`;
    },
  },
  {
    name: 'undo',
    description: 'Put a block back to its text before this run and mark it unreviewed again.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    run(a) {
      if (!work.has(a.id)) throw new Error(`${a.id} is not a candidate block`);
      current.delete(a.id);
      edits.delete(a.id);
      work.set(a.id, { status: 'unreviewed' });
      return `${a.id} restored: ${clip(byId.get(a.id)!.text, 200)}`;
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// The run
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM = `You prepare a book for an audiobook narrator, who reads exactly what is written. Your job is to rewrite the parts a narrator cannot read correctly as printed into the words they should say, following the person's request.

How the work goes:
- The tools keep a worklist of every block holding something that may need rewriting: numbers, abbreviations, symbols, roman numerals. Each candidate is shown bracketed ⟦like this⟧. The brackets are not in the book.
- Call next_batch, then resolve EVERY block it shows: fix it (exact substitutions) or keep it (it already reads correctly). Then call next_batch again.
- You may resolve a whole batch in one round: several fix and keep calls together.
- Use search when a choice should be consistent across the book (how a recurring term or date style was handled).
- The job is done only when progress shows 0 unreviewed. Then stop calling tools and write a short summary: what kinds of changes you made, and any you were unsure of.

Rules for a fix:
- Change only what the narrator would misread. Never rephrase, correct, or tidy anything else; keep punctuation, quotes and capitalisation as they are around your change.
- find is text copied exactly from the block (without the brackets); replace is what should be read.
- Write what a careful narrator would SAY, in words, as it should sound in that sentence.
- When the right reading is not certain from context, keep the block rather than guess, and say so in your summary.

Older results are trimmed from your history to save space; the tools remember the work, so call progress or next_batch rather than relying on memory. You have at most ${maxRounds} rounds.`;

const total = work.size;
console.log(`${book.title}: ${live.length} live blocks, ${total} hold a candidate. Model ${model} via ${transport}.`);

// Stopping with work left is handed the rest; stopping twice in a row with
// nothing resolved in between ends the run, so a model that will not go on
// cannot hold it open.
let lastLeft = -1;
let stalls = 0;
const run = await runLoop({
  tools,
  system: SYSTEM,
  user: request,
  model,
  transport,
  server: (opt['server'] ?? 'http://localhost:7100').replace(/\/$/, ''),
  clientName: 'ask-document',
  maxRounds,
  keepRounds: Number(opt['keep-rounds'] ?? 3),
  maxTokens: Number(opt['max-tokens'] ?? 4000),
  context: opt['context'] ? Number(opt['context']) : undefined,
  reasoning: opt['reasoning'],
  thinking: opt['thinking'] as 'on' | 'off' | undefined,
  scratchDir: outDir,
  status: () => {
    const c = counts();
    return `${c.unreviewed} unreviewed, ${c.fixed} fixed, ${c.kept} kept`;
  },
  onStop: () => {
    const left = counts().unreviewed;
    if (left === 0) return null;
    stalls = left === lastLeft ? stalls + 1 : 0;
    lastLeft = left;
    if (stalls >= 2) return null;
    return `${left} candidate blocks are still unreviewed, so the job is not done. Call next_batch and keep going until progress shows 0 unreviewed.`;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────────────────────

const c = counts();
const fixed = live.filter((b) => current.has(b.id) && current.get(b.id) !== b.text);
const report = {
  model,
  request,
  project: projectDir,
  liveBlocks: live.length,
  candidates: total,
  ...c,
  rounds: run.rounds.length,
  seconds: run.seconds,
  tokens: run.tokens,
  failure: run.failure,
  finalText: run.finalText,
  changes: fixed.map((b) => ({ id: b.id, before: b.text, after: current.get(b.id), edits: edits.get(b.id), note: (work.get(b.id) as { note?: string }).note || undefined })),
  kept: [...work.entries()].filter(([, s]) => s.status === 'kept').map(([id, s]) => ({ id, reason: (s as { reason: string }).reason, text: byId.get(id)!.text })),
  unreviewed: unreviewed().map((b) => ({ id: b.id, text: b.text })),
  log: run.rounds,
};

mkdirSync(outDir, { recursive: true });
const stem = join(outDir, `read-aloud-${model.replace(/[^\w.-]+/g, '_')}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
writeFileSync(`${stem}.json`, `${JSON.stringify(report, null, 2)}\n`);
// The proposal as the app's own ops, for review; never written to the project here.
writeFileSync(`${stem}.ops.jsonl`, fixed.map((b) => JSON.stringify({ op: 'text', id: b.id, text: current.get(b.id) })).join('\n') + (fixed.length ? '\n' : ''));
console.log(`\n${run.rounds.length} rounds, ${run.seconds}s, ${run.tokens.in} tokens in, ${run.tokens.out} out.`);
console.log(`${total} candidate blocks: ${c.fixed} fixed (${fixed.length} changed), ${c.kept} kept, ${c.unreviewed} unreviewed.`);
console.log(`report: ${stem}.json`);
console.log(`\n${run.finalText}`);
if (run.failure) process.exitCode = 1;
