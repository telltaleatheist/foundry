/**
 * The book as the app replays it: the reading's book file through
 * `parseBookFile`, the ledger's edit steps through `parseOpsFile`, and
 * `replayOps` over both. Blocks already struck are left out.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseBookFile, type BookRow } from '../../app/shared/book';
import { parseOpsFile, replayOps, type BookOp, type TextOp } from '../../app/shared/ops';
import { positionOf } from '../../app/shared/ledger';
import type { LedgerStep, ProjectLedger } from '../../app/shared/types';

export interface Block {
  id: string;
  index: number;
  text: string;
  category: string;
  /** Index into `chapters`; -1 before the first chapter. */
  chapter: number;
}

export interface LoadedBook {
  title: string;
  live: Block[];
  byId: Map<string, Block>;
  /** The original text of each block the person edited. */
  originals: Map<string, string>;
  alreadyStruck: number;
  chapters: { id: string; title: string }[];
  chapterTitle(i: number): string;
}

interface Manifest {
  title: string;
  ledger: ProjectLedger;
}

function chainOps(projectDir: string, manifest: Manifest): BookOp[] {
  // From the position back to the import. An edit step contributes its ops;
  // any other step would change the bank under them, which these experiments
  // do not reproduce, so it refuses by name rather than replay a wrong book.
  const steps = manifest.ledger.steps;
  const chain: LedgerStep[] = [];
  for (let step = positionOf(manifest.ledger); step !== null; ) {
    chain.unshift(step);
    const parent = step.parent;
    step = parent === null ? null : steps.find((s) => s.id === parent) ?? null;
  }
  const ops: BookOp[] = [];
  for (const step of chain) {
    if (step.action === 'import') continue;
    if (step.action !== 'edit') throw new Error(`the chain holds a "${step.action}" step; only import + edit chains are supported here`);
    ops.push(...parseOpsFile(readFileSync(join(projectDir, ...String(step.payload).split('/')), 'utf8')));
  }
  return ops;
}

export function loadBook(projectDir: string, opsFile?: string): LoadedBook {
  const manifest = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8')) as Manifest;
  const bookFile = readdirSync(join(projectDir, 'readings')).find((f) => f.endsWith('.book.jsonl'));
  if (bookFile === undefined) throw new Error(`no reading in ${projectDir}/readings`);
  const book = parseBookFile(readFileSync(join(projectDir, 'readings', bookFile), 'utf8'));
  const ops = opsFile ? parseOpsFile(readFileSync(opsFile, 'utf8')) : chainOps(projectDir, manifest);
  const replayed = replayOps(book.rows, ops, book.header.loose, book.header.chapters);

  const originals = new Map<string, string>();
  const edited = new Set(ops.filter((op): op is TextOp => op.op === 'text').map((op) => op.id));
  for (const row of book.rows) if (edited.has(row.id)) originals.set(row.id, row.text);

  const chapterStarts = new Map(replayed.chapters.map((c, i) => [c.id, i]));
  const live: Block[] = [];
  let chapter = -1;
  let alreadyStruck = 0;
  for (const row of replayed.rows as (BookRow & { struck?: true })[]) {
    if (chapterStarts.has(row.id)) chapter = chapterStarts.get(row.id)!;
    if (row.struck) {
      alreadyStruck += 1;
      continue;
    }
    live.push({ id: row.id, index: live.length, text: row.text, category: row.category, chapter });
  }
  const chapters = replayed.chapters.map((c) => ({ id: c.id, title: c.title }));
  return {
    title: manifest.title,
    live,
    byId: new Map(live.map((b) => [b.id, b])),
    originals,
    alreadyStruck,
    chapters,
    chapterTitle: (i) => (i < 0 ? '(before the first chapter)' : chapters[i].title),
  };
}

export function clip(text: string, n: number): string {
  const flat = text.replace(/\s+/g, ' ');
  return flat.length <= n ? flat : `${flat.slice(0, n)}…`;
}
