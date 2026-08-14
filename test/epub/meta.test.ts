/**
 * Editing a book's record without editing the book.
 *
 * The assertion this file exists for is the BORING one, and it is made over and
 * over in different words: after a metadata edit, the package document is its
 * own former self with one element's text different and nothing else — not the
 * comment, not the second namespace declaration, not the manifest's attribute
 * quoting, not one byte of the indentation. That is the offset-splice promise,
 * and it is the only reason this command is allowed near a file every reading
 * system trusts and nobody ever reads.
 *
 * The other half is the two pointers an OPF contains. `unique-identifier` names
 * a `dc:identifier` by its id, and `<meta refines="#id">` names anything by its
 * id, so every test that changes a field also asserts that the ids are exactly
 * where they were. A command that rewrote a start tag would pass every "the
 * title changed" test in this file and quietly unlink a book from its own
 * identity.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { UsageError } from '../../src/args.js';
import { findCommand, runCommand } from '../../src/commands.js';
import { epubMeta, MetaError, type EpubMetaReport } from '../../src/epub/meta.js';
import { LanguageError } from '../../src/translate/languages.js';
import { unzip, unzipMap } from '../export/unzip.js';
import {
  CHAPTER_PATH, NAV_PATH, OPF_PATH,
  METADATA_OPF, METADATA_OPF_LOST_ID, METADATA_OPF_NO_METADATA, METADATA_OPF_ODD,
  METADATA_OPF_TWO_CREATORS,
  foundryEpub, metadataEpub,
} from '../translate/fixture.js';

const quiet = (): void => {};

interface Run {
  report: EpubMetaReport;
  /** The package as it stands after the run. */
  opf: string;
  /** Every member of the written book, for the byte-identity assertions. */
  written: Map<string, { data: Uint8Array; text: () => string }>;
  dir: string;
  clean: () => void;
}

/** Write the book to a scratch FILE, edit it into a second file, read both back. */
async function editFile(
  book: Uint8Array,
  set: Record<string, string>,
): Promise<Run> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-meta-'));
  const epub = path.join(dir, 'Buch.epub');
  const out = path.join(dir, 'Buch.edited.epub');
  fs.writeFileSync(epub, book);
  const wanted = Object.keys(set).length > 0;
  const report = await epubMeta({
    epubPath: epub,
    ...(wanted ? { outPath: out } : {}),
    set,
    log: quiet,
  });
  const written = report.written ? unzipMap(new Uint8Array(fs.readFileSync(out))) : unzipMap(book);
  return {
    report,
    opf: written.get(OPF_PATH)!.text(),
    written,
    dir,
    clean: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** The book unpacked into a directory — the app's working tree, which is edited in place. */
function unpackTo(root: string, book: Uint8Array): void {
  for (const entry of unzip(book)) {
    const file = path.join(root, ...entry.path.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, entry.data);
  }
}

/** The same edit against a working tree, returning the OPF as it now stands on disk. */
async function editTree(
  book: Uint8Array,
  set: Record<string, string>,
): Promise<{ report: EpubMetaReport; opf: string; tree: string; clean: () => void }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-meta-tree-'));
  const tree = path.join(dir, 'working');
  unpackTo(tree, book);
  const report = await epubMeta({ epubPath: tree, set, log: quiet });
  return {
    report,
    opf: fs.readFileSync(path.join(tree, ...OPF_PATH.split('/')), 'utf8'),
    tree,
    clean: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Reading
// ═════════════════════════════════════════════════════════════════════════════

test('reading the metadata writes nothing and reports every field, absent ones as null', async () => {
  const run = await editFile(metadataEpub(), {});
  try {
    assert.equal(run.report.written, false);
    assert.deepEqual(run.report.metadata, {
      title: 'Der Staat',
      creator: 'Ein Verfasser',
      language: 'de',
      publisher: null,
      date: null,
      identifier: 'urn:uuid:test-metadata',
    });
    assert.equal(run.report.uniqueIdentifier, 'pub-id');
    assert.equal(run.report.opfPath, OPF_PATH);
    // A read leaves no second file behind: nothing was ordered, so nothing is
    // written, and the 20 MB no-op never happens.
    assert.equal(fs.existsSync(path.join(run.dir, 'Buch.edited.epub')), false);
  } finally {
    run.clean();
  }
});

test('--json prints the metadata on stdout and reads a file with no --out at all', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-meta-json-'));
  const epub = path.join(dir, 'Buch.epub');
  fs.writeFileSync(epub, metadataEpub());
  const chunks: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string) => { chunks.push(String(chunk)); return true; }) as never;
  try {
    await runCommand(findCommand('epub-meta')!, ['--epub', epub, '--json']);
  } finally {
    process.stdout.write = write;
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const parsed = JSON.parse(chunks.join('')) as {
    version: number; kind: string; fields: Record<string, string | null>;
    counts: Record<string, number>; uniqueIdentifier: string; written: boolean;
  };
  assert.equal(parsed.version, 1);
  assert.equal(parsed.kind, 'epub');
  assert.equal(parsed.written, false);
  assert.equal(parsed.fields['title'], 'Der Staat');
  assert.equal(parsed.fields['publisher'], null);
  assert.equal(parsed.uniqueIdentifier, 'pub-id');
  assert.equal(parsed.counts['title'], 1);
  assert.equal(parsed.counts['publisher'], 0);
});

// ═════════════════════════════════════════════════════════════════════════════
// Updating a field that is there
// ═════════════════════════════════════════════════════════════════════════════

test('updating one field changes that element and NOTHING else in the package', async () => {
  const run = await editFile(metadataEpub(), { title: 'Der neue Staat' });
  try {
    assert.equal(run.report.written, true);
    assert.deepEqual(run.report.changes, [{
      field: 'title',
      element: 'dc:title',
      from: 'Der Staat',
      to: 'Der neue Staat',
      created: false,
    }]);

    /*
     * THE OFFSET-SPLICE PROMISE, stated as an equation. The package that came
     * out is the package that went in with exactly one substring different. Any
     * re-serialisation — a normalised attribute quote, a collapsed empty
     * element, a re-indented manifest, a dropped comment — breaks this line and
     * nothing else in this file would notice.
     */
    assert.equal(
      run.opf,
      METADATA_OPF.replace(
        '<dc:title id="t1">Der Staat</dc:title>',
        '<dc:title id="t1">Der neue Staat</dc:title>',
      ),
    );
    // Said again in the two ways that matter most, so a failure says which:
    assert.ok(run.opf.includes('<!-- Cast by foundry.'), 'the comment survived');
    assert.ok(run.opf.includes('xmlns:opf="http://www.idpf.org/2007/opf"'), 'the second namespace survived');
    assert.ok(run.opf.includes('<dc:language>de</dc:language>'), 'dc:language was not touched');
    assert.ok(run.opf.includes('<dc:creator id="creator1">Ein Verfasser</dc:creator>'), 'dc:creator was not touched');
  } finally {
    run.clean();
  }
});

test('every member but the package comes back byte-identical', async () => {
  const before = metadataEpub();
  const run = await editFile(before, { creator: 'Ian Kershaw' });
  try {
    const original = unzipMap(before);
    for (const [memberPath, entry] of run.written) {
      if (memberPath === OPF_PATH) continue;
      assert.deepEqual(
        [...entry.data],
        [...original.get(memberPath)!.data],
        `${memberPath} was re-encoded by a run that only touched the package`,
      );
    }
    // And the members are all still there, in the order an EPUB needs.
    assert.equal([...run.written.keys()][0], 'mimetype');
    assert.ok(run.written.has(CHAPTER_PATH));
    assert.ok(run.written.has(NAV_PATH));
  } finally {
    run.clean();
  }
});

test('a field given the value it already holds writes nothing at all', async () => {
  const run = await editFile(metadataEpub(), { title: 'Der Staat' });
  try {
    assert.equal(run.report.written, false);
    assert.deepEqual(run.report.changes, []);
    assert.deepEqual(run.report.unchanged, ['title']);
  } finally {
    run.clean();
  }
});

test('a value with XML in it is escaped rather than injected', async () => {
  const run = await editFile(metadataEpub(), { title: 'Krieg & Frieden <1933>' });
  try {
    assert.ok(run.opf.includes('<dc:title id="t1">Krieg &amp; Frieden &lt;1933&gt;</dc:title>'));
    // And it reads back as what was typed, which is the round trip that proves
    // the escape is an escape and not a corruption.
    assert.equal(run.report.metadata.title, 'Krieg & Frieden <1933>');
  } finally {
    run.clean();
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Creating a field that is not there
// ═════════════════════════════════════════════════════════════════════════════

test('a missing dc:publisher is created inside <metadata>, indented like its siblings', async () => {
  const run = await editFile(metadataEpub(), { publisher: 'Ein Verlag' });
  try {
    assert.deepEqual(run.report.changes, [{
      field: 'publisher',
      element: 'dc:publisher',
      from: null,
      to: 'Ein Verlag',
      created: true,
    }]);
    /*
     * AFTER THE LAST DUBLIN CORE ELEMENT, not at the end of `<metadata>`: the
     * `<meta refines>` block is the other half of the file, and a
     * `<dc:publisher>` landing under it reads as an accident. Four spaces,
     * because that is what its siblings use — copied, never chosen.
     */
    assert.equal(
      run.opf,
      METADATA_OPF.replace(
        '    <dc:creator id="creator1">Ein Verfasser</dc:creator>\n',
        '    <dc:creator id="creator1">Ein Verfasser</dc:creator>\n'
        + '    <dc:publisher>Ein Verlag</dc:publisher>\n',
      ),
    );
  } finally {
    run.clean();
  }
});

test('two missing fields at once come out in the order they were asked for', async () => {
  const run = await editFile(metadataEpub(), { publisher: 'Ein Verlag', date: '1933-04-01' });
  try {
    assert.equal(
      run.opf,
      METADATA_OPF.replace(
        '    <dc:creator id="creator1">Ein Verfasser</dc:creator>\n',
        '    <dc:creator id="creator1">Ein Verfasser</dc:creator>\n'
        + '    <dc:publisher>Ein Verlag</dc:publisher>\n'
        + '    <dc:date>1933-04-01</dc:date>\n',
      ),
    );
    assert.equal(run.report.metadata.publisher, 'Ein Verlag');
    assert.equal(run.report.metadata.date, '1933-04-01');
  } finally {
    run.clean();
  }
});

test('the prefix and the indentation are READ off the file, not assumed', async () => {
  const run = await editFile(metadataEpub(METADATA_OPF_ODD), { publisher: 'Ein Verlag' });
  try {
    // `d:`, because that is what this package binds the Dublin Core namespace
    // to, and two tabs, because that is what its siblings are indented with.
    assert.ok(
      run.opf.includes('\t\t<d:language>de</d:language>\n\t\t<d:publisher>Ein Verlag</d:publisher>\n'),
      `the element was not written the way this package writes elements:\n${run.opf}`,
    );
    assert.equal(run.report.changes[0]!.element, 'd:publisher');
    // And the whole file is otherwise itself.
    assert.equal(
      run.opf,
      METADATA_OPF_ODD.replace(
        '\t\t<d:language>de</d:language>\n',
        '\t\t<d:language>de</d:language>\n\t\t<d:publisher>Ein Verlag</d:publisher>\n',
      ),
    );
  } finally {
    run.clean();
  }
});

test('a missing dc:language is created — the one place this diverges from translate', async () => {
  const withoutLanguage = METADATA_OPF.replace('    <dc:language>de</dc:language>\n', '');
  const run = await editFile(metadataEpub(withoutLanguage), { language: 'en' });
  try {
    assert.equal(run.report.changes[0]!.created, true);
    assert.ok(run.opf.includes('<dc:language>en</dc:language>'));
    assert.equal(run.report.metadata.language, 'en');
  } finally {
    run.clean();
  }
});

test('an existing dc:language is spliced at the range translate splices', async () => {
  const run = await editFile(metadataEpub(), { language: 'en' });
  try {
    assert.equal(
      run.opf,
      METADATA_OPF.replace('<dc:language>de</dc:language>', '<dc:language>en</dc:language>'),
    );
  } finally {
    run.clean();
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// The two pointers
// ═════════════════════════════════════════════════════════════════════════════

test('rewriting dc:identifier keeps its id and the unique-identifier link intact', async () => {
  const run = await editFile(metadataEpub(), { identifier: 'urn:uuid:corrected' });
  try {
    assert.ok(
      run.opf.includes('<dc:identifier id="pub-id">urn:uuid:corrected</dc:identifier>'),
      'the id was lost or moved',
    );
    assert.ok(run.opf.includes('unique-identifier="pub-id"'), 'the package stopped naming its identifier');
    assert.equal(run.report.uniqueIdentifier, 'pub-id');
    assert.equal(run.report.metadata.identifier, 'urn:uuid:corrected');
    assert.equal(
      run.opf,
      METADATA_OPF.replace('urn:uuid:test-metadata', 'urn:uuid:corrected'),
    );
  } finally {
    run.clean();
  }
});

test('every meta refines target still exists after an edit, and the stale one is NAMED', async () => {
  const run = await editFile(metadataEpub(), { creator: 'Ian Kershaw', title: 'Hitler' });
  try {
    // Nothing was orphaned: every `refines="#x"` still points at an element
    // carrying `id="x"`. Checked mechanically rather than by eye, because that
    // is the property, not the three particular ids this fixture happens to
    // have.
    for (const match of run.opf.matchAll(/refines="#([^"]+)"/g)) {
      assert.ok(
        run.opf.includes(`id="${match[1]}"`),
        `refines="#${match[1]}" points at nothing after the edit`,
      );
    }
    assert.ok(run.opf.includes('<dc:creator id="creator1">Ian Kershaw</dc:creator>'));
    assert.ok(run.opf.includes('<dc:title id="t1">Hitler</dc:title>'));
    // The refinements themselves are untouched — the file-as still sorts under
    // the old name, and that is REPORTED rather than guessed at.
    assert.ok(run.opf.includes('<meta refines="#creator1" property="file-as">Verfasser, Ein</meta>'));
    const properties = run.report.stale.map((s) => `${s.field}/${s.property}`).sort();
    assert.deepEqual(properties, ['creator/file-as', 'creator/role', 'title/title-type']);
    assert.equal(run.report.stale.find((s) => s.property === 'file-as')!.value, 'Verfasser, Ein');
  } finally {
    run.clean();
  }
});

test('a field nobody edited has no stale refinements reported for it', async () => {
  const run = await editFile(metadataEpub(), { publisher: 'Ein Verlag' });
  try {
    assert.deepEqual(run.report.stale, []);
  } finally {
    run.clean();
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Twice, and two ways
// ═════════════════════════════════════════════════════════════════════════════

test('running the same edit twice changes nothing the second time', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-meta-twice-'));
  try {
    const tree = path.join(dir, 'working');
    unpackTo(tree, metadataEpub());
    const opfFile = path.join(tree, ...OPF_PATH.split('/'));

    const first = await epubMeta({ epubPath: tree, set: { publisher: 'Ein Verlag' }, log: quiet });
    assert.equal(first.written, true);
    const afterFirst = fs.readFileSync(opfFile, 'utf8');

    const second = await epubMeta({ epubPath: tree, set: { publisher: 'Ein Verlag' }, log: quiet });
    assert.equal(second.written, false);
    assert.deepEqual(second.changes, []);
    assert.deepEqual(second.unchanged, ['publisher']);
    assert.equal(fs.readFileSync(opfFile, 'utf8'), afterFirst);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a directory in place and a file with --out produce the same package', async () => {
  const set = { title: 'Der neue Staat', publisher: 'Ein Verlag', creator: 'Ian Kershaw' };
  const file = await editFile(metadataEpub(), set);
  const tree = await editTree(metadataEpub(), set);
  try {
    assert.equal(tree.opf, file.opf);
    assert.equal(tree.report.inPlace, true);
    assert.equal(file.report.inPlace, false);
    assert.equal(tree.report.outPath, tree.tree);
    // The two reports say the same thing about the book, whatever shape it was
    // handed to the command in.
    assert.deepEqual(tree.report.metadata, file.report.metadata);
    assert.deepEqual(
      tree.report.changes.map((c) => `${c.field}:${c.to}`).sort(),
      file.report.changes.map((c) => `${c.field}:${c.to}`).sort(),
    );
  } finally {
    file.clean();
    tree.clean();
  }
});

test('a working tree keeps every other file on disk untouched', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-meta-tree-bytes-'));
  try {
    const tree = path.join(dir, 'working');
    unpackTo(tree, metadataEpub());
    const chapter = path.join(tree, ...CHAPTER_PATH.split('/'));
    const before = fs.readFileSync(chapter);
    await epubMeta({ epubPath: tree, set: { date: '1933' }, log: quiet });
    assert.deepEqual([...fs.readFileSync(chapter)], [...before]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a book with no foundry stamps in it is edited like any other', async () => {
  // Deliberately NOT held to the admission rule: a publisher's EPUB imported
  // this morning has the wrong title just as often as a cast one, and refusing
  // to fix it until somebody ran `epub-stamp` would be a rule about foundry's
  // pipeline imposed on a fact about the book.
  const run = await editFile(foundryEpub(), { title: 'Etwas anderes' });
  try {
    assert.equal(run.report.metadata.title, 'Etwas anderes');
  } finally {
    run.clean();
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Every refusal
// ═════════════════════════════════════════════════════════════════════════════

test('a package with no <metadata> is refused, by the name of the file', async () => {
  await assert.rejects(
    () => editFile(metadataEpub(METADATA_OPF_NO_METADATA), { title: 'X' }),
    (error: unknown) => {
      assert.ok(error instanceof MetaError);
      assert.match(error.message, /declares no <metadata>/);
      assert.ok(error.message.includes(OPF_PATH), 'the refusal does not name the file');
      return true;
    },
  );
});

test('a --language that is not a language tag is refused by the translate table', async () => {
  await assert.rejects(
    () => editFile(metadataEpub(), { language: 'German' }),
    (error: unknown) => {
      assert.ok(error instanceof LanguageError);
      assert.match(error.message, /--language "German" is not a language tag/);
      return true;
    },
  );
});

test('an empty value is refused rather than blanking the field', async () => {
  await assert.rejects(
    () => editFile(metadataEpub(), { title: '   ' }),
    (error: unknown) => {
      assert.ok(error instanceof MetaError);
      assert.match(error.message, /--title was given an empty value/);
      return true;
    },
  );
});

test('two dc:creator elements are refused rather than one of them picked', async () => {
  await assert.rejects(
    () => editFile(metadataEpub(METADATA_OPF_TWO_CREATORS), { creator: 'Ian Kershaw' }),
    (error: unknown) => {
      assert.ok(error instanceof MetaError);
      assert.match(error.message, /declares 2 <dc:creator> elements/);
      return true;
    },
  );
});

test('two dc:creator elements are still READ, because reading decides nothing', async () => {
  const run = await editFile(metadataEpub(METADATA_OPF_TWO_CREATORS), {});
  try {
    assert.equal(run.report.counts.creator, 2);
    assert.equal(run.report.metadata.creator, 'Ein Verfasser');
  } finally {
    run.clean();
  }
});

test('a unique-identifier naming nothing is refused rather than guessed at', async () => {
  await assert.rejects(
    () => editFile(metadataEpub(METADATA_OPF_LOST_ID), { identifier: 'urn:uuid:x' }),
    (error: unknown) => {
      assert.ok(error instanceof MetaError);
      assert.match(error.message, /names a dc:identifier this package does not contain/);
      return true;
    },
  );
});

test('a file input with no --out is refused when a field is being set', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-meta-noout-'));
  try {
    const epub = path.join(dir, 'Buch.epub');
    fs.writeFileSync(epub, metadataEpub());
    await assert.rejects(
      () => epubMeta({ epubPath: epub, set: { title: 'X' }, log: quiet }),
      (error: unknown) => {
        assert.ok(error instanceof MetaError);
        assert.match(error.message, /--out says where the edited book is written/);
        return true;
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--out on a directory input is refused rather than ignored', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-meta-dirout-'));
  try {
    const tree = path.join(dir, 'working');
    unpackTo(tree, metadataEpub());
    await assert.rejects(
      () => epubMeta({ epubPath: tree, outPath: path.join(dir, 'x.epub'), set: { title: 'X' }, log: quiet }),
      (error: unknown) => {
        assert.ok(error instanceof MetaError);
        assert.match(error.message, /is a directory, so it is edited in place/);
        return true;
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('--out equal to --epub is refused at the argv layer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-meta-same-'));
  try {
    const epub = path.join(dir, 'Buch.epub');
    fs.writeFileSync(epub, metadataEpub());
    await assert.rejects(
      () => runCommand(findCommand('epub-meta')!, ['--epub', epub, '--out', epub, '--title', 'X']),
      (error: unknown) => {
        assert.ok(error instanceof UsageError);
        assert.match(error.message, /is the input itself/);
        return true;
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an input that cannot be read is refused by name', async () => {
  await assert.rejects(
    () => epubMeta({ epubPath: path.join(os.tmpdir(), 'foundry-no-such-book.epub'), set: {}, log: quiet }),
    (error: unknown) => {
      assert.ok(error instanceof MetaError);
      assert.match(error.message, /cannot be read/);
      assert.match(error.message, /foundry-no-such-book\.epub/);
      return true;
    },
  );
});

test('a directory that is not an unpacked EPUB is refused by name', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-meta-notepub-'));
  try {
    await assert.rejects(
      () => epubMeta({ epubPath: dir, set: {}, log: quiet }),
      (error: unknown) => {
        assert.ok(error instanceof MetaError);
        assert.match(error.message, /is a directory with no mimetype in it/);
        return true;
      },
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
