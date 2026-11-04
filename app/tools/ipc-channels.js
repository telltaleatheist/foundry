#!/usr/bin/env node
/*
 * ipc-channels — every IPC channel NAME the main process and the preload use,
 * read out of the source, so a refactor can be diffed against it.
 *
 * ── WHAT IT IS FOR ────────────────────────────────────────────────────────
 *
 * docs/FOUNDRY-CORE-PLAN.md moves Foundry's main-process logic into a library
 * in steps that must not change behaviour, and the renderer↔main contract is
 * untyped at runtime: a handler that is renamed, dropped or registered twice is
 * not a compile error anywhere. A COUNT ("158 handlers") cannot see a rename —
 * one channel lost and one gained reads the same — so the step-0 baseline is
 * the full list of names, and each later step diffs against it (plan §7, step 2:
 * "diff the channel list, not just the count").
 *
 * ── WHAT IT READS, AND HOW ────────────────────────────────────────────────
 *
 * Every `.ts` under `app/electron/`, PARSED with the TypeScript compiler (not
 * grepped — about a third of the handlers open `ipcMain.handle(` on one line
 * and put the channel on the next, behind a comment). It records:
 *
 *   handle   `ipcMain.handle | handleOnce | on | once` (main receives)
 *   push     `broadcast('x', …)` and `<anything>.send('x', …)` (main sends)
 *   invoke   `ipcRenderer.invoke | send | sendSync('x')` and preload's
 *            `ask('x', …)` helper (renderer asks)
 *   listen   `ipcRenderer.on | once('x')` and preload's `subscribe('x', …)`
 *
 * A channel that is not a string literal is printed as `<dynamic>` with its
 * file, rather than skipped: a computed channel is exactly what a name diff
 * cannot see, so its appearance must itself show up in the diff. (The two in
 * the baseline are preload's own `subscribe`/`ask` helper bodies.)
 *
 * Output is `kind<TAB>channel<TAB>file`, sorted, without line numbers — lines
 * move in every refactor and the list must not. Moving a handler to another
 * file DOES change the list, deliberately: step 2 moves bodies, not
 * registrations, and a registration that left ipc.ts should be seen.
 *
 * ── USE ───────────────────────────────────────────────────────────────────
 *
 *   node tools/ipc-channels.js            print the list
 *   node tools/ipc-channels.js --check    diff against tools/ipc-channels.baseline.txt;
 *                                         exit 1 on any difference
 *   node tools/ipc-channels.js --write    rewrite the baseline (only when a
 *                                         channel change is the intent)
 *
 * Recorded 2026-11-04 at foundry f2a6fa5 (FOUNDRY-CORE-PLAN step 0).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const APP = path.resolve(__dirname, '..');
const ELECTRON = path.join(APP, 'electron');
const BASELINE = path.join(__dirname, 'ipc-channels.baseline.txt');

const HANDLE = new Set(['handle', 'handleOnce', 'on', 'once']);
const INVOKE = new Set(['invoke', 'send', 'sendSync']);
const LISTEN = new Set(['on', 'once']);

function channelOf(arg) {
  if (arg === undefined) return '<dynamic>';
  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) return arg.text;
  return '<dynamic>';
}

function collect() {
  const rows = [];
  const files = fs.readdirSync(ELECTRON).filter((f) => f.endsWith('.ts')).sort();
  for (const file of files) {
    const text = fs.readFileSync(path.join(ELECTRON, file), 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    const rel = `electron/${file}`;
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const first = node.arguments[0];
        if (ts.isPropertyAccessExpression(callee)) {
          const method = callee.name.text;
          const target = ts.isIdentifier(callee.expression) ? callee.expression.text : null;
          if (target === 'ipcMain' && HANDLE.has(method)) rows.push(['handle', channelOf(first), rel]);
          else if (target === 'ipcRenderer' && INVOKE.has(method)) rows.push(['invoke', channelOf(first), rel]);
          else if (target === 'ipcRenderer' && LISTEN.has(method)) rows.push(['listen', channelOf(first), rel]);
          else if (target !== 'ipcRenderer' && method === 'send' && first !== undefined
            && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) {
            // `webContents.send('x', …)` in any spelling. A `.send` whose first
            // argument is not a literal is some other API's send, not a push.
            rows.push(['push', first.text, rel]);
          }
        } else if (ts.isIdentifier(callee)) {
          const name = callee.text;
          if (name === 'broadcast' && node.arguments.length >= 1) rows.push(['push', channelOf(first), rel]);
          else if (file === 'preload.ts' && name === 'subscribe') rows.push(['listen', channelOf(first), rel]);
          else if (file === 'preload.ts' && name === 'ask') rows.push(['invoke', channelOf(first), rel]);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return rows.map((r) => r.join('\t')).sort();
}

const lines = collect();
const out = lines.join('\n') + '\n';
const counts = {};
for (const l of lines) { const k = l.split('\t')[0]; counts[k] = (counts[k] || 0) + 1; }
const summary = Object.entries(counts).map(([k, n]) => `${k} ${n}`).join(', ');

if (process.argv.includes('--write')) {
  fs.writeFileSync(BASELINE, out);
  console.log(`ipc-channels: baseline written (${summary})`);
} else if (process.argv.includes('--check')) {
  const want = fs.readFileSync(BASELINE, 'utf8').replace(/\r\n/g, '\n').split('\n').filter(Boolean);
  const have = new Set(lines);
  const had = new Set(want);
  const lost = want.filter((l) => !have.has(l));
  const gained = lines.filter((l) => !had.has(l));
  // Duplicates matter too: the same channel handled twice throws at startup.
  const dup = lines.length !== have.size || want.length !== had.size
    ? `\n(row multiplicity differs: ${lines.length} now vs ${want.length} recorded)` : '';
  if (lost.length === 0 && gained.length === 0 && lines.length === want.length) {
    console.log(`ipc-channels: unchanged against the baseline (${summary})`);
  } else {
    console.error('ipc-channels: the channel list CHANGED against tools/ipc-channels.baseline.txt');
    for (const l of lost) console.error(`  - ${l}`);
    for (const l of gained) console.error(`  + ${l}`);
    if (dup) console.error(dup);
    process.exitCode = 1;
  }
} else {
  process.stdout.write(out);
}
