/**
 * The band: how long the next page may be, given what this book has shown.
 *
 * TWO KINDS OF CLAIM ARE MADE HERE and they are worth telling apart. The
 * arithmetic ones are exhaustive, because a pure function of two numbers can be
 * — every boundary it has is named. The POPULATION ones walk a book page by
 * page and assert what the band would have done to it, and each is a case that
 * was measured in a real library before it was written down: they are here so
 * that the five behaviours this design was ruled on cannot silently become four.
 *
 * The numbers in the population cases are not invented. 1,273 is the longest
 * real page of Michelle Remembers, whose twelve runaways are half of every
 * runaway measured across 18,202 pages; 7,677 is a full-page newspaper facsimile
 * reproduced inside another book, and the reason the margin is 4 rather than 3.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BAND_FLOOR, BAND_MARGIN, capFor, RETRY_RISE, worthRetrying } from '../../src/vlm/band.js';

const MODEL_CAP = 8192;

test('with nothing accepted yet the band does not tighten at all', () => {
  // No evidence means no guess. A book that opens dense keeps its first page.
  assert.equal(capFor(0, MODEL_CAP), MODEL_CAP);
});

test('the floor holds the band up over a book that has only shown short pages', () => {
  // 400 x 4 is 1,600, which is under the floor, so the floor answers.
  assert.equal(capFor(400, MODEL_CAP), BAND_FLOOR);
  // A title page of 54 tokens would otherwise cap the next page at 216.
  assert.equal(capFor(54, MODEL_CAP), BAND_FLOOR);
});

test('between the floor and the clamp the margin decides', () => {
  // Michelle Remembers: its longest real page is 1,273, so its band is 5,092 —
  // the number its twelve runaways would have stopped at instead of 8,192.
  assert.equal(capFor(1273, MODEL_CAP), 1273 * BAND_MARGIN);
  assert.equal(capFor(1273, MODEL_CAP), 5092);
});

test('the densest books are untouched by the clamp, not by a threshold', () => {
  // The facsimile book's ceiling is 7,677; four times that is 30,708, which
  // clamps straight back to the model's own cap. Its band never moves.
  assert.equal(capFor(7677, MODEL_CAP), MODEL_CAP);
  // And the boundary: 2,048 x 4 is exactly the cap.
  assert.equal(capFor(2048, MODEL_CAP), MODEL_CAP);
  assert.equal(capFor(2047, MODEL_CAP), 8188);
});

test('the band never leaves its bounds, for any input a caller can produce', () => {
  for (const longest of [-1, 0, 1, 499, 500, 501, 2047, 2048, 8192, 99999, Number.NaN, Number.POSITIVE_INFINITY]) {
    const cap = capFor(longest, MODEL_CAP);
    assert.ok(cap <= MODEL_CAP, `${longest} produced ${cap}, above the model cap`);
    assert.ok(cap >= Math.min(BAND_FLOOR, MODEL_CAP), `${longest} produced ${cap}, below the floor`);
  }
});

test('the band never falls as a book shows longer pages', () => {
  let last = 0;
  for (let longest = 0; longest <= 3000; longest += 7) {
    const cap = capFor(longest, MODEL_CAP);
    if (longest > 0) assert.ok(cap >= last, `${longest} lowered the band from ${last} to ${cap}`);
    if (longest > 0) last = cap;
  }
});

test('a small model cap wins over both the floor and the margin', () => {
  // Nothing here may hand a model more tokens than it will take.
  assert.equal(capFor(0, 1024), 1024);
  assert.equal(capFor(50, 1024), 1024);
  assert.equal(capFor(5000, 1024), 1024);
});

/**
 * A book, walked page by page, exactly as a run walks it: the band is asked
 * before each page and only an ACCEPTED page raises it.
 *
 * THE ACCEPTED-ONLY RULE IS THE POINT OF THIS HELPER. It is the invariant
 * `capFor` cannot enforce — it takes a number and cannot know where it came
 * from — so it is modelled here and asserted below, because a refused page
 * feeding the band would inflate the ceiling meant to catch it, further with
 * every runaway.
 */
function walk(pages: readonly { tokens: number; runaway?: boolean }[]): {
  refusedAt: number[];
  lostPages: number[];
  finalBand: number;
} {
  let longest = 0;
  const refusedAt: number[] = [];
  const lostPages: number[] = [];
  pages.forEach((page, index) => {
    const cap = capFor(longest, MODEL_CAP);
    if (page.runaway === true) {
      refusedAt.push(cap);
      return;
    }
    if (page.tokens > cap) lostPages.push(index);
    else if (page.tokens > longest) longest = page.tokens;
  });
  return { refusedAt, lostPages, finalBand: capFor(longest, MODEL_CAP) };
}

const proseOf = (count: number, tokens: number) => Array.from({ length: count }, () => ({ tokens }));

test('MICHELLE REMEMBERS: the band creeps, never steps, and the runaways stop at half', () => {
  // Its real pages sit around 900 and top out at 1,273; the twelve runaways are
  // spread through it. Nothing here is dense enough to step the band.
  const pages = [
    ...proseOf(20, 900),
    { tokens: 8192, runaway: true },
    ...proseOf(200, 1100),
    { tokens: 8192, runaway: true },
    ...proseOf(100, 1273),
    { tokens: 8192, runaway: true },
  ];
  const { refusedAt, lostPages, finalBand } = walk(pages);
  assert.deepEqual(lostPages, [], 'no real page of this book may be refused');
  assert.equal(finalBand, 5092, 'its band ends at four times its longest real page');
  // Each runaway stopped well under the model cap, which is the whole saving.
  for (const cap of refusedAt) assert.ok(cap < MODEL_CAP, `a runaway ran to ${cap}`);
  assert.ok(refusedAt[0]! <= 3600, 'the earliest runaway stops earliest of all');
});

test('A RUNAWAY NEVER RAISES THE BAND, which is the invariant capFor cannot check', () => {
  const withRunaways = walk([...proseOf(5, 800), { tokens: 8192, runaway: true },
    { tokens: 8192, runaway: true }, ...proseOf(5, 800)]);
  const without = walk(proseOf(10, 800));
  assert.equal(withRunaways.finalBand, without.finalBand,
    'two runaways moved the ceiling that exists to catch them');
  assert.equal(withRunaways.finalBand, 3200);
});

test('THE COPYRIGHT PAGE: the library\'s worst ratio sits under the floor and is untouched', () => {
  // Page 4 of a real book: three near-empty leaves and then a dense imprint
  // notice — 1,038 tokens against a running maximum of 206, a 5.04x step, and
  // the biggest ratio measured anywhere. The floor absorbs it without the
  // margin being consulted at all.
  const { lostPages } = walk([{ tokens: 206 }, { tokens: 30 }, { tokens: 198 }, { tokens: 1038 }]);
  assert.deepEqual(lostPages, []);
  assert.ok(1038 < BAND_FLOOR, 'the floor is what makes that page safe');
});

test('THE LONE FACSIMILE: a 3.35x step is kept by the margin, and 3x would have lost it', () => {
  // A full page of Der Stürmer between two ordinary pages of prose: 7,677
  // tokens where the running maximum stood at 2,294.
  const pages = [...proseOf(50, 700), { tokens: 2294 }, ...proseOf(10, 350), { tokens: 7677 },
    ...proseOf(10, 700)];
  assert.deepEqual(walk(pages).lostPages, [], 'the facsimile must survive the band');
  // And the measurement that set the margin: three would not have kept it.
  assert.ok(2294 * 3 < 7677, 'a 3x margin refuses this page');
  assert.ok(2294 * BAND_MARGIN > 7677, 'a 4x margin keeps it');
});

test('THE INDEX: fifty-one dense pages in a row cost nothing, because a run ramps', () => {
  // The longest dense run measured is 51 consecutive pages, and its step over
  // the running maximum is 1.08x — an index raises the band ahead of itself.
  const pages = [...proseOf(300, 1000), ...Array.from({ length: 51 }, (_unused, index) => ({
    tokens: 1200 + index * 60,
  }))];
  assert.deepEqual(walk(pages).lostPages, [], 'a gradual climb never outruns its own band');
});

test('A TRUE RUNAWAY IS NEVER RE-READ: refused at the final band, so the rise is nothing', () => {
  // The band did not move after it was refused, so its refusal was a fair one.
  assert.equal(worthRetrying(5092, 5092), false);
  assert.equal(worthRetrying(8192, 8192), false);
});

test('A BAND THAT CREEPS RETRIES NOTHING — the case that made the first rule net negative', () => {
  // Michelle Remembers: its twelve runaways were sent under these caps and its
  // band ended at 5,092. Every one of them is BELOW the final band, and the
  // first version of this rule retried all eight of the ones that were —
  // spending 65,536 tokens to save 44,640 and leaving the book worse than
  // untouched. None of them is a factor below it, so none of them retries.
  const sentCaps = [3348, 3348, 3348, 3636, 4904, 4904, 4904, 4904, 5092, 5092, 5092, 5092];
  const finalBand = 5092;
  for (const cap of sentCaps) {
    assert.ok(cap <= finalBand, 'these are the caps that a below-the-band test would catch');
    assert.equal(worthRetrying(cap, finalBand), false, `${cap} was retried against a band of ${finalBand}`);
  }
});

test('A STEP IS RETRIED: a page judged before the book showed what it was', () => {
  // A cohort of plates dispatched while the band was still set by prose: sent
  // at the floor, and the band ends four times the first plate that landed.
  assert.equal(worthRetrying(2000, 8192), true);
  // The boundary is exact and stated: twice is enough, a hair under is not.
  assert.equal(worthRetrying(2000, 2000 * RETRY_RISE), true);
  assert.equal(worthRetrying(2000, 2000 * RETRY_RISE - 1), false);
});

test('the retry test is about the cap and not about a count', () => {
  // Ten refusals at the same cap all answer the same way: nothing here counts
  // how many have happened, because that says nothing about whether any one of
  // them carried information.
  const answers = new Set(Array.from({ length: 10 }, () => worthRetrying(2000, 6000)));
  assert.deepEqual([...answers], [true]);
});
