/**
 * The catalogue migration — v1's `generated` list read as v2's step chains.
 *
 * THIS IS THE RISKIEST CODE IN THE APP AND IT WAS THE ONLY CODE NOTHING COULD
 * REACH. It rewrites the shape of every project on every user's disk, and it
 * lived in `electron/projects.ts`, which imports `app` from electron at module
 * scope — so importing it started an Electron runtime and no test could touch
 * it. Extracting the transform into `app/shared/steps.ts` was the whole of what
 * it needed: it is a pure function of two arguments and never wanted a harness.
 *
 * THE FIXTURES ARE REAL. Both are the exact `generated`/`archive` shapes taken
 * off this machine on the day the migration was written — a project converted to
 * a real-text PDF, and one cast to an EPUB and then translated. Invented
 * fixtures would have tested the shape the migration expects rather than the
 * shape it will actually meet, and the second of these carries the case that
 * changes meaning rather than merely form: a translation stops being a document
 * beside the book and becomes a step on it.
 *
 * What is NOT tested here, deliberately: whether the files a chain names are
 * still on disk. That is `summarise`'s question — it changes between one call
 * and the next, and a migration's answers must not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { migrateToSteps, readTypeRecords, EARLIER_VERSION } from '../../app/shared/steps.ts';
import {
  WHY_IMPORTED,
  WHY_MODEL_PASS,
  type ProjectGenerated,
} from '../../app/shared/types.ts';

/**
 * `Working-Towards-The-Fuhrer.-Kershaw-Ian.-1993-d3f7ae65`, as it sits on disk.
 *
 * A scan, converted to a real-text PDF six times over one evening. Its
 * `working.files` is `[]` — which is the bug that prompted all of this, and
 * which this transform must not paper over or invent its way around.
 */
const KERSHAW = {
  archive: {
    file: 'Working Towards The Fuhrer. Kershaw, Ian. (1993).pdf',
    kind: 'pdf' as const,
  },
  generated: [
    {
      file: 'Working-Towards-The-Fuhrer.-Kershaw-Ian.-1993.pdf',
      kind: 'pdf',
      role: 'searchable',
      madeAt: 1786745448107,
    },
  ] satisfies ProjectGenerated[],
};

/**
 * `The-History-of-the-German-Christian-Faith-Movement.-Arnold-Danne-48372e43`.
 *
 * A scan, cast to an EPUB and then translated — the case where v1 listed two
 * documents and the user says there is one book that is now English.
 */
const GERMAN = {
  archive: {
    file: 'The History of the German Christian Faith Movement. Arnold Dannenmann.pdf',
    kind: 'pdf' as const,
  },
  generated: [
    {
      file: 'The-History-of-the-German-Christian-Faith-Movement.-Arnold-Danne.epub',
      kind: 'epub',
      role: 'cast',
      madeAt: 1786672000000,
    },
    {
      file: 'The-History-of-the-German-Christian-Faith-Movement.-Arnold-Danne (en).epub',
      kind: 'epub',
      role: 'translation',
      madeAt: 1786680000000,
    },
  ] satisfies ProjectGenerated[],
};

/** The chain for one type, or undefined. Every assertion below reads this. */
function chain(records: ReturnType<typeof migrateToSteps>, kind: 'pdf' | 'epub' | 'txt') {
  return records.find((record) => record.kind === kind);
}

// ── the two real catalogues ─────────────────────────────────────────────────

test('a converted scan becomes ONE pdf chain: the import, then the reprint', () => {
  const records = migrateToSteps(KERSHAW.generated, KERSHAW.archive);

  // One type, not two. The reprint is a step on the PDF and never a row of its
  // own — which is the whole correction this model exists to make.
  assert.equal(records.length, 1);
  const pdf = chain(records, 'pdf')!;
  assert.equal(pdf.steps.length, 2);

  const [origin, reprint] = pdf.steps;
  assert.equal(origin.file, `archive/${KERSHAW.archive.file}`);
  assert.equal(origin.kind, 'origin');
  assert.equal(origin.label, 'The scan you imported');
  // The import is the one thing nothing can get back: no copy, no way to fetch
  // it again, and only the user knows where it came from.
  assert.equal(origin.retention, 'irreplaceable');
  assert.equal(origin.why, WHY_IMPORTED);

  assert.equal(reprint.file, `generated/${KERSHAW.generated[0].file}`);
  assert.equal(reprint.kind, 'convert');
  assert.equal(reprint.label, 'Reprinted as real text');
  // Hours of GPU: expensive to redo, but redoable — which is exactly what the
  // readings bank buys and why this is not `irreplaceable`.
  assert.equal(reprint.retention, 'expensive');
  assert.equal(reprint.why, WHY_MODEL_PASS);
});

test('a translation is a STEP ON THE EPUB, not a document beside it', () => {
  const records = migrateToSteps(GERMAN.generated, GERMAN.archive);

  // Two types — the scan and the book — where v1 listed three documents.
  assert.deepEqual(records.map((record) => record.kind).sort(), ['epub', 'pdf']);

  const epub = chain(records, 'epub')!;
  assert.equal(epub.steps.length, 2);
  assert.equal(epub.steps[0].label, 'Cast from the scan');
  assert.equal(epub.steps[0].kind, 'origin');
  assert.equal(epub.steps[1].label, 'Translated');
  assert.equal(epub.steps[1].kind, 'translate');
  // The chain's last step is what the row shows: one EPUB, now English.
  assert.match(epub.steps[1].file, /\(en\)\.epub$/);

  // The scan is still its own type, with only its origin.
  const pdf = chain(records, 'pdf')!;
  assert.equal(pdf.steps.length, 1);
  assert.equal(pdf.steps[0].retention, 'irreplaceable');
});

test('steps come out oldest first, whatever order the catalogue listed them in', () => {
  // v1's order was insertion order, which a rotation could disturb — so the
  // transform sorts rather than trusting it. Reversed input, same chain.
  const records = migrateToSteps([...GERMAN.generated].reverse(), GERMAN.archive);
  const epub = chain(records, 'epub')!;
  assert.equal(epub.steps[0].label, 'Cast from the scan');
  assert.equal(epub.steps[1].label, 'Translated');
  assert.ok(epub.steps[0].appliedAt < epub.steps[1].appliedAt);
});

// ── the edges ───────────────────────────────────────────────────────────────

test('an imported EPUB is irreplaceable; a cast one is merely expensive', () => {
  /*
   * The distinction the whole retention field exists for. Both are `.epub` files
   * in `generated/` and v1 told them apart only by a role — but one came from
   * outside this program and cannot be fetched again, and the other is an
   * expensive rendering of a scan that is still sitting in the same folder.
   */
  const imported = migrateToSteps(
    [{ file: 'book.epub', kind: 'epub', role: 'imported', madeAt: 1 }],
    null,
  );
  assert.equal(chain(imported, 'epub')!.steps[0].retention, 'irreplaceable');
  assert.equal(chain(imported, 'epub')!.steps[0].why, WHY_IMPORTED);

  const cast = migrateToSteps(
    [{ file: 'book.epub', kind: 'epub', role: 'cast', madeAt: 1 }],
    null,
  );
  assert.equal(chain(cast, 'epub')!.steps[0].retention, 'expensive');
});

test('a project with nothing generated is its import and nothing else', () => {
  // Kershaw's `working.files` was empty and this must NOT invent a step for the
  // working copy that is sitting on disk: what is on disk is `summarise`'s
  // question, and a migration that guessed would write fiction into a catalogue.
  const records = migrateToSteps([], KERSHAW.archive);
  assert.equal(records.length, 1);
  assert.equal(chain(records, 'pdf')!.steps.length, 1);
});

test('a project with no archive at all still migrates what it has', () => {
  // A project adopted from the old flat workspace: outputs, no import. It has an
  // EPUB and no PDF, and the EPUB's first step is its origin by default.
  const records = migrateToSteps(GERMAN.generated, null);
  assert.deepEqual(records.map((record) => record.kind), ['epub']);
  assert.equal(chain(records, 'epub')!.steps.length, 2);
});

test('a text conversion is its own type and never joins the book', () => {
  const records = migrateToSteps(
    [
      { file: 'book.epub', kind: 'epub', role: 'cast', madeAt: 1 },
      { file: 'book.txt', kind: 'txt', role: 'text', madeAt: 2 },
    ],
    null,
  );
  assert.deepEqual(records.map((record) => record.kind).sort(), ['epub', 'txt']);
  assert.equal(chain(records, 'txt')!.steps.length, 1);
});

// ── reading a catalogue that is already v2 ──────────────────────────────────

test('a v2 catalogue passes through with its chain intact', () => {
  const stored = [{
    kind: 'pdf',
    steps: [
      {
        file: 'archive/x.pdf',
        label: 'The scan you imported',
        appliedAt: 5,
        kind: 'origin',
        retention: 'irreplaceable',
        why: WHY_IMPORTED,
      },
      {
        file: 'generated/x.pdf',
        label: 'Reprinted as real text',
        appliedAt: 9,
        kind: 'convert',
        retention: 'expensive',
        why: WHY_MODEL_PASS,
      },
    ],
  }];
  const records = readTypeRecords(stored);
  assert.equal(records.length, 1);
  assert.equal(records[0].steps.length, 2);
  assert.equal(records[0].steps[0].label, 'The scan you imported');
});

test('a step with no retention recorded is kept, not thrown away', () => {
  /*
   * UNKNOWN READS AS `expensive`, which is the conservative middle and a change
   * of mind: it first defaulted to the cheap end, on the reasoning that this app
   * should not keep what it cannot justify. That is right about disk and wrong
   * about risk — the cheap end means "throw it away and make it again", and a
   * step whose provenance nobody wrote down is exactly the one where nobody can
   * promise it CAN be made again.
   */
  const records = readTypeRecords([{
    kind: 'epub',
    steps: [{ file: 'generated/x.epub', appliedAt: 1, kind: 'origin' }],
  }]);
  assert.equal(records[0].steps[0].retention, 'expensive');
  // And a step nobody labelled says so rather than inventing a history.
  assert.equal(records[0].steps[0].label, EARLIER_VERSION);
});

test('a malformed catalogue yields nothing rather than half a chain', () => {
  assert.deepEqual(readTypeRecords('not an array'), []);
  assert.deepEqual(readTypeRecords([{ kind: 'docx', steps: [] }]), []);
  // A type whose every step is unreadable is not a type this project has: the
  // chain being non-empty is what every reader downstream is entitled to assume.
  assert.deepEqual(readTypeRecords([{ kind: 'pdf', steps: [{ file: 42 }] }]), []);
});
