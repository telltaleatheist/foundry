/**
 * The light gate (src/clean/light-gate.ts): it refuses a reading that changes
 * what is already spoken as printed, and nothing else. Every case here is an
 * edit the model actually proposed in the gate-off runs of 2026-09-24/25.
 */
import { expect, test } from 'bun:test';

import { lightGateRefusal } from '../../src/clean/light-gate.js';
import * as norm from '../../src/clean/tts-number-normalizer.js';

const refuses = (find: string, replace: string) => expect(lightGateRefusal(find, replace)).not.toBeNull();
const passes = (find: string, replace: string) => expect(lightGateRefusal(find, replace)).toBeNull();

test('refuses a word that is already spoken as printed, changed', () => {
  refuses('Führer', 'F u h r e r');
  refuses('Führer.', 'Fuehrer.');
  refuses('Eberhard Jäckel', 'Eberhard Jaekel');
  refuses("'idea'", 'idea');
  refuses('Marxist-Leninist', 'Marxist Leninist');
  refuses('Nazi Movement', 'Nazi movement');
  refuses('a decade later', 'a ten year period later');
  refuses('Partei und Staat im Dritten Reich', 'Partei und Staat im Third Reich');
  refuses('Hitlers', "Hitler's");
  refuses('Goebbels not Hitler', 'Goebbels, not Hitler');
  refuses('nineteen eighty-seven', 'nineteen eighty seven');
});

test('refuses words invented between words it kept, and a dropped word', () => {
  refuses("Stalin's", "Stalin the First's");
  refuses('Hans Frank', 'Hans the Frank');
  refuses('Franz Joseph', 'Franz the Second Joseph');
  refuses('Vittorio Emanuele', 'Vittorio Emanuele the Second');
  refuses('Hitler', 'the Hitler');
  refuses('Pope Pius IX', 'Pope the Ninth');
});

test('refuses a reading that is still digits', () => {
  refuses('eighteen forty-eight', '1848');
});

test('passes every reading of a printed form', () => {
  passes('Napoleon III', 'Napoleon the Third');
  passes('Alexander I', 'Alexander the First');
  passes('Vittorio Emanuele II', 'Vittorio Emanuele the Second');
  passes('14–15 May 1848', 'May fourteenth to fifteenth, eighteen forty-eight');
  passes('£803.11.0', 'eight hundred three pounds, eleven shillings');
  passes('2.00 p.m.', 'two p.m.');
  passes('Vol. 23', 'Volume twenty-three');
  passes('ii. 207', 'volume two, page two hundred seven');
  passes('vii-xi', 'pages seven to eleven');
  passes('chs. 8-9', 'chapters eight to nine');
  passes('fol. 15', 'folio fifteen');
  passes('Werner Jochmann, ed.,', 'Werner Jochmann, editor,');
  passes('Günther Doecker and Winfried Steffani, eds,', 'Günther Doecker and Winfried Steffani, editors,');
  passes('third edn', 'third edition');
  passes("St Paul's", "Saint Paul's");
  passes('IAN KERSHAW', 'Ian Kershaw');
  passes('FBI', 'F B I');
  passes('13-35', 'pages thirteen to thirty-five');
});

test('passes the whole shapes: a dash, dropped brackets, apparatus, a broken word', () => {
  passes('Hitler himself - written', 'Hitler himself—written');
  passes('– intentionally', '—intentionally');
  passes('Lammers [head of the Reich Chancellory]', 'Lammers head of the Reich Chancellory');
  passes(' (see page twelve)', '');
  passes('fini sh', 'finish');
  passes('Hanseatische Verlag- sanstalt', 'Hanseatische Verlagsanstalt');
  passes('willing 帮pers', 'willing helpers');
});

test('the light gate in the validator: a strict refusal it passes is applied; one it refuses stays out', () => {
  const policy = { ...norm.EVERY_CLASS, gate: 'light' as const };
  const target = 'It is reprinted in Werner Jochmann, ed., Monologe, beside the Führer and Stalin\'s own notes.';
  const { records, accepted } = norm.validateNumberEdits(target, [target.length], [
    { find: 'Werner Jochmann, ed.,', replace: 'Werner Jochmann, editor,' },
    { find: 'Führer', replace: 'Fuehrer' },
    { find: "Stalin's", replace: "Stalin the First's" },
  ], [], policy);
  expect(accepted.map((a) => a.replace)).toEqual(['Werner Jochmann, editor,']);
  expect(records[0]!.status).toBe('APPLIED');
  expect(records[1]!.status).not.toBe('APPLIED');
  expect(records[1]!.detail).toMatch(/^LIGHT GATE — /);
});
