/**
 * dash — an UNSPACED hyphen read as the em dash it stands for (n18; Owen, 2026-10-02).
 *
 * "emdashes dramatically affect prosody. its something we want to get exactly
 * right." The shapes that can be nothing else are fixed deterministically in
 * narrator's engine input (BookForge 2340aab7); the rest is the cleanup model's,
 * by the prompt's general rule. What code owns here is that the model's reading is
 * accepted when it is exactly that - hyphens made em dashes, nothing else - and
 * refused otherwise, under every gate.
 */
import { test } from 'bun:test';
import assert from 'node:assert/strict';

import { lightGateRefusal, unspacedDashReading } from '../../src/clean/light-gate.js';
import { narrationTextPrompt } from '../../src/clean/prompt.js';
import { triageQuestion } from '../../src/clean/triage.js';
import * as norm from '../../src/clean/tts-number-normalizer.js';

const D = '—';

function judge(target: string, find: string, replace: string, gate: boolean | 'light' = true) {
  return norm.validateNumberEdits(target, [target.length], [{ find, replace }], [], { ...norm.EVERY_CLASS, gate });
}

test('the shape: hyphens made em dashes and nothing else', () => {
  assert.ok(unspacedDashReading('wrong-if', `wrong${D}if`));
  assert.ok(unspacedDashReading('fifth-or sixth-time', `fifth${D}or sixth${D}time`));
  assert.ok(!unspacedDashReading('wrong-if', 'wrong-if'), 'no change is not a reading');
  assert.ok(!unspacedDashReading('wrong-if', `wrong${D}If`), 'a letter changed too');
  assert.ok(!unspacedDashReading('wrong-if', `wrong ${D} if`), 'spaces added');
  assert.ok(!unspacedDashReading('NG-5428', `NG${D}5428`), 'an identifier');
  assert.ok(!unspacedDashReading('1914-18', `1914${D}18`), 'a range');
});

test('the validator accepts the reading under every gate, and the gate stays shut on the rest', () => {
  const target = "If you're wrong-if he is a bad guy, we run.";
  for (const gate of [true, 'light', false] as const) {
    const { accepted, records } = judge(target, 'wrong-if', `wrong${D}if`, gate);
    assert.equal(records[0]!.status, 'APPLIED', `gate ${String(gate)}: ${records[0]!.detail ?? ''}`);
    assert.equal(records[0]!.editClass, 'unspaced-dash');
    assert.deepEqual(accepted.map((a) => a.replace), [`wrong${D}if`]);
  }
  // A real compound made a dash plus a changed word is not this reading.
  assert.notEqual(judge('a high-efficiency engine', 'high-efficiency', `high${D}Efficiency`).records[0]!.status, 'APPLIED');
  assert.equal(lightGateRefusal('fifth-or sixth-time', `fifth${D}or sixth${D}time`), null);
});

test('the prompt states the rule, and the triage asks about it', () => {
  assert.match(narrationTextPrompt(), /A hyphen with NO spaces is a dash when the sentence breaks there/);
  const q = triageQuestion('b1#s0', 'sentence', "If you're wrong-if he is a bad guy.");
  assert.match(q.instructions, /a hyphen with no spaces standing where the sentence breaks/);
  // The dash moved the rules to n18; a later bump carries it (n19, 2026-10-03).
  assert.ok(Number(norm.NORMALIZER_VERSION.slice(1)) >= 18, norm.NORMALIZER_VERSION);
});
