/**
 * The policy half of the adaptive cap: which answers may raise the band, which
 * refusals are worth reading again, and what a page is sent with.
 *
 * The arithmetic lives in `band.ts` and is asserted there. THIS FILE IS ABOUT
 * THE DECISIONS `capFor` CANNOT MAKE, because a pure function of two numbers
 * cannot know where a number came from or which page it belonged to.
 *
 * ── Where the numbers come from, which matters more than usual here ─────────
 *
 * Every expected value below is hand-written or read off a walk of the real
 * library. NONE is computed by the rule under test, and none is derived from a
 * description of the design — because that is exactly how this feature nearly
 * shipped a rule that made its worst book worse. A contract said "Michelle
 * Remembers' band never rises, so nothing retries"; nobody had walked the caps;
 * they run 3,348 to 5,092 and eight of its twelve refusals sit below the final
 * band. An assertion derived from the designer's description of the design
 * proves the description.
 *
 * So the twelve caps in the Michelle case are the ones that book was actually
 * sent, in order.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bandAfter, capToSend, pagesToReread } from '../../src/vlm/read.js';

const MODEL_CAP = 8192;

/** A page as the endpoint reports one, with only the fields the rules read. */
function answered(tokens: number, text = 'a page of ordinary prose'): {
  tokens: number; finishReason: string | null; text: string;
} {
  return { tokens, finishReason: 'stop', text };
}
function cutOff(tokens: number): { tokens: number; finishReason: string | null; text: string } {
  return { tokens, finishReason: 'length', text: 'nonsense, at length, still going when it was cut' };
}

// ── the invariant capFor cannot enforce ─────────────────────────────────────

test('A REFUSED PAGE DOES NOT RAISE THE BAND', () => {
  // The one whose failure is silent AND self-inflating: a runaway that raised
  // the band would push it toward the model's own cap, so the band would loosen
  // exactly where it should tighten and every later runaway would cost more.
  assert.equal(bandAfter(1273, cutOff(5092)), 1273);
});

test('an empty answer does not raise the band either', () => {
  // It is refused for a different reason and measures the book just as little.
  assert.equal(bandAfter(1273, { tokens: 4000, finishReason: 'stop', text: '   ' }), 1273);
});

test('an accepted page longer than anything before it raises the band', () => {
  assert.equal(bandAfter(1273, answered(2294)), 2294);
});

test('an accepted page shorter than the longest leaves it alone', () => {
  // The band is a running MAXIMUM: it rises and never falls, or a book would
  // tighten around whichever page happened to come last.
  assert.equal(bandAfter(2294, answered(300)), 2294);
});

test('a server that reports no finish reason is still an accepted page', () => {
  // `finishReason` is nullable on the wire. Absent is not `length`, and a page
  // with text in it is a page.
  assert.equal(bandAfter(100, { tokens: 900, finishReason: null, text: 'real words' }), 900);
});

// ── which refusals are worth reading again ──────────────────────────────────

test('MICHELLE REMEMBERS: a band that CREEPS retries nothing', () => {
  /*
   * The twelve caps its runaways were actually sent under, walked in page
   * order, against the band the run ended with. The largest gap is
   * 5,092 / 3,348 = 1.52x — a creep, not a step — so nothing is re-read.
   *
   * This is the case that would have passed the rule this design nearly
   * shipped: "below the final band" retries eight of these, spends 65,536
   * tokens to save 44,640, and leaves his worst book worse than doing nothing.
   */
  const sent = new Map([
    [10, 3348], [11, 3348], [12, 3348], [13, 3636],
    [14, 4904], [15, 4904], [16, 4904], [17, 4904],
    [18, 5092], [19, 5092], [20, 5092], [21, 5092],
  ]);
  assert.deepEqual(pagesToReread(sent.keys(), sent, 5092), []);
});

test('A CREEP IS NOT A STEP — the pair, in one book', () => {
  // The same event, a refusal, distinguished only by whether the band moved
  // underneath it. Either alone would only prove that refusals exist.
  const sent = new Map([[4, 4600], [9, 2000]]);   // 0.9x and 0.4x of the final band
  assert.deepEqual(pagesToReread(sent.keys(), sent, 5092), [9]);
});

test('A TRUE RUNAWAY, refused AT the final band, is never re-read', () => {
  // If this one ever fires the feature costs more time than it saves: the page
  // was judged by the number this book still stands behind.
  const sent = new Map([[7, 5092]]);
  assert.deepEqual(pagesToReread(sent.keys(), sent, 5092), []);
});

test('THE PLATE RUN: a whole cohort sent stale is retried, all of it', () => {
  /*
   * Twenty pages of a different KIND, dispatched before the first answer could
   * raise the band. THE COUNT IS THE ASSERTION: once-per-book — the rule this
   * one replaced — would have kept exactly one of them.
   */
  const sent = new Map(Array.from({ length: 20 }, (_, i) => [100 + i, 2000] as const));
  const worth = pagesToReread(sent.keys(), sent, 8192);
  assert.equal(worth.length, 20);
  assert.deepEqual(worth, Array.from({ length: 20 }, (_, i) => 100 + i));
});

test('a page this pass never sent is never overturned by it', () => {
  // No recorded cap means it came out of the bank, or from a run before this
  // feature existed. This pass did not judge it and may not un-judge it.
  const sent = new Map([[4, 2000]]);
  assert.deepEqual(pagesToReread([4, 99], sent, 8192), [4]);
});

test('the pages come back in book order', () => {
  const sent = new Map([[31, 2000], [7, 2000], [19, 2000]]);
  assert.deepEqual(pagesToReread(sent.keys(), sent, 8192), [7, 19, 31]);
});

// ── the escape hatch ────────────────────────────────────────────────────────

test('THE FLAG restores the model\'s own cap on every page', () => {
  // Without it, "you can read the page again" would be false: a second run
  // walks the same pages, builds the same band, and refuses the same page.
  assert.equal(capToSend(true, 1273, MODEL_CAP), MODEL_CAP);
  assert.equal(capToSend(true, 0, MODEL_CAP), MODEL_CAP);
});

test('and without the flag the book decides', () => {
  // 1,273 x 4 = 5,092 — Michelle Remembers' real band, from band.ts's own
  // arithmetic rather than restated here.
  assert.equal(capToSend(false, 1273, MODEL_CAP), 5092);
});

test('THE COPYRIGHT PAGE: under the floor, the margin is never consulted', () => {
  /*
   * The library's worst step ratio is 5.04x — a Penguin copyright page of 1,038
   * tokens after three nearly empty leaves, where the running maximum was 206.
   * 206 x 4 is 824, which would have refused it; the floor answers instead and
   * the page is untouched. The biggest ratio in the library is not a threat.
   */
  assert.equal(capToSend(false, 206, MODEL_CAP), 2000);
  assert.ok(capToSend(false, 206, MODEL_CAP) > 1038);
});
