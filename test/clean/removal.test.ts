/**
 * removal — what a cleanup TAKES OUT (Owen, 2026-09-29; src/clean/removal.ts).
 *
 * The box removes printed references a narrator would not read, the person's own
 * words describe anything else, and the model decides each span. What code owns,
 * and what these tests hold it to:
 *
 *  - asking for nothing more is the cleanup that existed before — the same prompt
 *    bytes, the same triage criteria, the same cache keys;
 *  - asking for a removal puts it in the cleaner's prompt, in the triage question
 *    and in every key, so a different request is a different question;
 *  - a removal the model proposes is accepted whole under every gate, and leaves
 *    no doubled space where it stood — inside a sentence, and as a whole sentence.
 */
import { test } from 'bun:test';
import assert from 'node:assert/strict';

import { narrationTextPrompt } from '../../src/clean/prompt.js';
import {
  NO_REMOVAL, removalPromptSection, removalTriageCriteria, withRemoval, type RemovalRequest,
} from '../../src/clean/removal.js';
import { cleanKey, triageKey } from '../../src/clean/run.js';
import { reassemble, cleanSentences } from '../../src/clean/sentences.js';
import { groupState, triageQuestion, TRIAGE_GUIDE } from '../../src/clean/triage.js';
import * as norm from '../../src/clean/tts-number-normalizer.js';

const BOX: RemovalRequest = { references: true, also: '' };
const MINE: RemovalRequest = { references: false, also: 'the running header "THE THIRD REICH AT WAR"' };

/** Apply accepted edits back to front, as the writer does. */
function applied(target: string, accepted: readonly { find: string; replace: string; at: number }[]): string {
  let text = target;
  for (const edit of [...accepted].sort((a, b) => b.at - a.at)) {
    assert.strictEqual(text.slice(edit.at, edit.at + edit.find.length), edit.find);
    text = text.slice(0, edit.at) + edit.replace + text.slice(edit.at + edit.find.length);
  }
  return text;
}

function judge(target: string, find: string, policy: norm.NumberEditPolicy) {
  return norm.validateNumberEdits(target, [target.length], [{ find, replace: '' }], [], policy);
}

// ── Nothing asked: nothing changes ─────────────────────────────────────────────

test('no removal: the prompt, the triage criteria and the keys are exactly what they were', () => {
  assert.strictEqual(withRemoval(narrationTextPrompt(), NO_REMOVAL), narrationTextPrompt());
  assert.strictEqual(removalPromptSection(NO_REMOVAL), '');
  assert.strictEqual(removalTriageCriteria(NO_REMOVAL), '');
  // An empty description is no request at all.
  assert.strictEqual(removalPromptSection({ references: false, also: '  \n ' }), '');

  const base = { text: 'He left (see fig. 2) at dawn.', model: 'qwen3.5-9b', unit: 'sentence' as const };
  assert.strictEqual(cleanKey({ ...base, removal: NO_REMOVAL }), cleanKey(base));
  assert.strictEqual(triageKey({ text: base.text, triageModel: 'm', removal: NO_REMOVAL }),
    triageKey({ text: base.text, triageModel: 'm' }));

  const q = triageQuestion('b1#s0', 'sentence', base.text, NO_REMOVAL);
  assert.strictEqual(q.instructions, triageQuestion('b1#s0', 'sentence', base.text).instructions);
});

// ── Asked: every place the question is made hears it ───────────────────────────

test('the box and the person\'s words reach the cleaner\'s prompt and the triage question', () => {
  const prompt = withRemoval(narrationTextPrompt(), { references: true, also: 'photo credits' });
  assert.ok(prompt.startsWith(narrationTextPrompt()), 'the removal is added after the prompt, which is otherwise untouched');
  assert.match(prompt, /WHAT YOU REMOVE/);
  assert.match(prompt, /would read aloud is removed/);
  assert.match(prompt, /photo credits/);
  assert.match(prompt, /"replace" is empty/);

  const q = triageQuestion('b1#s0', 'sentence', 'He left at dawn.', { references: true, also: 'photo credits' });
  assert.match(q.instructions, /a printed reference a narrator would not read aloud/);
  assert.match(q.instructions, /photo credits/);
  // Among the criteria, before the lines that close the list.
  assert.ok(q.instructions.indexOf('photo credits') < q.instructions.indexOf('Ordinary prose'));

  // The block guide carries them too, and is the old guide byte for byte without them.
  const unit = { parts: 'b1', text: 'He left at dawn.', category: 'text' } as never;
  const group = { from: 0, to: 1, askFrom: 0, askTo: 1 };
  assert.ok(groupState([unit], group, 'block').startsWith(TRIAGE_GUIDE));
  assert.match(groupState([unit], group, 'block', BOX), /a printed reference a narrator would not read aloud/);
});

test('a different removal is a different question: every key moves', () => {
  const base = { text: 'He left (see fig. 2) at dawn.', model: 'qwen3.5-9b', unit: 'sentence' as const };
  const keys = new Set([
    cleanKey(base), cleanKey({ ...base, removal: BOX }), cleanKey({ ...base, removal: MINE }),
    cleanKey({ ...base, removal: { references: true, also: MINE.also } }),
  ]);
  assert.strictEqual(keys.size, 4);
  assert.notStrictEqual(triageKey({ text: base.text, triageModel: 'm', removal: BOX }),
    triageKey({ text: base.text, triageModel: 'm' }));
  // Whitespace around the words is not a different request.
  assert.strictEqual(cleanKey({ ...base, removal: { references: false, also: `  ${MINE.also}\r\n` } }),
    cleanKey({ ...base, removal: MINE }));
});

// ── The validator: a removal asked for is the model's decision ─────────────────

test('without the box, only a short bracketed aside may be removed — as before', () => {
  const target = 'The losses were heavy (see Table 3.2 on page 114 below) that winter.';
  const refused = judge(target, '(see Table 3.2 on page 114 below)', norm.EVERY_CLASS);
  assert.strictEqual(refused.accepted.length, 0);
  assert.strictEqual(refused.records[0]!.status, 'EMPTY_REPLACE');
});

test('with the box, a long bracketed reference is removed whole, and its space with it', () => {
  const target = 'The losses were heavy (see Table 3.2 on page 114 below) that winter.';
  for (const gate of [true, 'light', false] as const) {
    const { accepted, records } = judge(target, '(see Table 3.2 on page 114 below)',
      { ...norm.EVERY_CLASS, gate, removal: true });
    assert.strictEqual(records[0]!.status, 'APPLIED', `gate ${String(gate)}: ${records[0]!.detail ?? ''}`);
    assert.strictEqual(records[0]!.editClass, 'removal');
    assert.strictEqual(applied(target, accepted), 'The losses were heavy that winter.');
  }
});

test('with the box, an unbracketed reference and a placeholder are removed', () => {
  const see = 'Output doubled after the reform, see fig. 1-1.';
  const one = judge(see, ', see fig. 1-1', { ...norm.EVERY_CLASS, gate: 'light', removal: true });
  assert.strictEqual(one.records[0]!.status, 'APPLIED', one.records[0]!.detail ?? '');
  assert.strictEqual(applied(see, one.accepted), 'Output doubled after the reform.');

  const image = '[image] The harbour at Kiel, 1917.';
  const two = judge(image, '[image]', { ...norm.EVERY_CLASS, gate: 'light', removal: true });
  assert.strictEqual(two.records[0]!.status, 'APPLIED', two.records[0]!.detail ?? '');
  assert.strictEqual(applied(image, two.accepted), 'The harbour at Kiel, 1917.');

  // A whole sentence that is only a reference.
  const whole = 'See Figure 4.';
  const three = judge(whole, 'See Figure 4.', { ...norm.EVERY_CLASS, gate: 'light', removal: true });
  assert.strictEqual(three.records[0]!.status, 'APPLIED', three.records[0]!.detail ?? '');
  assert.strictEqual(applied(whole, three.accepted), '');
});

test('a removal still may not reach across markup or into a span a rule read', () => {
  const target = 'He left (see fig. 2) at dawn.';
  const segments = ['He left (see '.length, 'fig. 2) at dawn.'.length];
  const { records } = norm.validateNumberEdits(target, segments, [{ find: '(see fig. 2)', replace: '' }], [],
    { ...norm.EVERY_CLASS, gate: 'light', removal: true });
  assert.strictEqual(records[0]!.status, 'SPANS_MARKUP');
});

// ── A sentence removed whole leaves no gap ─────────────────────────────────────

test('reassemble: a sentence cleaned to nothing takes one gap with it', () => {
  // Each sentence past the unit's 30-character floor, so the three stay three.
  const block = 'The fleet sailed out of Kiel at dawn. See Figure 4 for the route it took. It never returned to port again.';
  const spans = cleanSentences(block);
  assert.strictEqual(spans.length, 3);
  const said = spans.map((s) => block.slice(s.start, s.end));
  assert.strictEqual(reassemble(block, spans, [said[0]!, '', said[2]!]),
    'The fleet sailed out of Kiel at dawn. It never returned to port again.');
  assert.strictEqual(reassemble(block, spans, ['', said[1]!, said[2]!]),
    'See Figure 4 for the route it took. It never returned to port again.');
  assert.strictEqual(reassemble(block, spans, [said[0]!, said[1]!, '']),
    'The fleet sailed out of Kiel at dawn. See Figure 4 for the route it took.');
  // Nothing removed is the block byte for byte, as before.
  assert.strictEqual(reassemble(block, spans, said), block);
});
