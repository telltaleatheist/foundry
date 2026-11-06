/**
 * The export card's seed: what a project says about itself when nobody has
 * filled the card yet (Owen, 2026-11-05: "when i export an epub, it doesnt
 * automatically fill the metadata").
 *
 * Fails on main before the fix: `mintSeedFor` did not exist, and the card's own
 * read of the scan went through `admittedPdf`, which refuses the project's
 * working PDF because nothing ever opened it. The last test pins that refusal,
 * so the reason the read had to move into main stays written down.
 *
 * And the exports nobody confirms at a card (2026-11-06, Owen: "yes, they
 * should fill metadata from the pdf if its available") are stamped from the
 * same stack: before, the settle stopped after the host's record, and the
 * unattended test below came back null.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PDFDocument } from 'pdf-lib';

import { admittedPdf, mintSeedFor } from '../../src/node/doors-meta';
import { inheritedMintMetaFor } from '../../src/node/job-queue-settling';
import { mintMetaFromName, parseBookFilename } from '../../src/shared/book-filename';
import { fillMintGaps, type MintMeta } from '../../src/shared/mint-meta';
import { useTestPlatform } from './platform-fixture';

const STEM = 'Working Towards The Fuhrer. Kershaw, Ian. (1993)';
let root = '';
let projectDir = '';

/** A PDF whose Info names a title and no author, the shape of the real scan. */
async function scan(file: string, author?: string): Promise<void> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  doc.setTitle("'Working Towards the Führer.' Reflections on the Nature of the Hitler Dictatorship");
  if (author !== undefined) doc.setAuthor(author);
  await fsp.writeFile(file, await doc.save());
}

/** A project of one imported PDF, catalogued the way an import catalogues it, with no stored block. */
async function project(dir: string, stem: string, author?: string): Promise<void> {
  await fsp.mkdir(path.join(dir, 'archive'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'working'), { recursive: true });
  await scan(path.join(dir, 'archive', `${stem}.pdf`), author);
  await scan(path.join(dir, 'working', `${stem}.pdf`), author);
  const key = path.basename(dir);
  await fsp.writeFile(path.join(dir, 'project.json'), JSON.stringify({
    version: 2,
    key,
    title: stem,
    stem,
    createdAt: 1,
    archive: { file: `${stem}.pdf`, kind: 'pdf', contentKey: key.slice(-8) },
    documents: [{
      kind: 'pdf',
      steps: [{
        file: `archive/${stem}.pdf`, kind: 'origin', label: 'The scan you imported',
        appliedAt: 1, retention: 'irreplaceable', why: 'the only copy',
      }],
    }],
    working: { files: [{ file: `${stem}.pdf`, kind: 'pdf', from: `archive/${stem}.pdf`, madeAt: 2 }] },
  }));
}

let unattendedDir = '';

beforeAll(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'foundry-mint-seed-'));
  const userData = path.join(root, 'userData');
  const library = path.join(root, 'library');
  await fsp.mkdir(userData, { recursive: true });
  await fsp.writeFile(path.join(userData, 'app-settings.json'), JSON.stringify({ libraryDir: library }));
  useTestPlatform((name) => (name === 'userData' ? userData : path.join(root, name)));

  projectDir = path.join(library, 'projects', 'kershaw-d3f7ae65');
  await project(projectDir, STEM);
  // A stem outside the naming convention, so the name answers nothing and
  // only the scan can say who the book is.
  unattendedDir = path.join(library, 'projects', 'fuhrer-scan-0badc0de');
  await project(unattendedDir, 'fuhrer scan 0412', 'Ian Kershaw');
});

afterAll(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

test('main reads the scan by project, and the name answers what the scan does not', async () => {
  const seed = await mintSeedFor(projectDir);
  expect(seed.problems).toEqual([]);
  // Nothing stored and no host: the scan's title, then the name's author and year.
  expect(seed.meta).toEqual({
    title: "'Working Towards the Führer.' Reflections on the Nature of the Hitler Dictatorship",
    contributors: [{ first: 'Ian', last: 'Kershaw' }],
    year: '1993',
  });
  expect(mintMetaFromName(STEM)).toEqual({
    title: 'Working Towards The Fuhrer',
    contributors: [{ first: 'Ian', last: 'Kershaw' }],
    year: '1993',
  });
});

test('the edit mode of the card stops after the host, so the file itself is the next witness', async () => {
  expect(await mintSeedFor(projectDir, false)).toEqual({ meta: null, problems: [] });
});

test('an unattended export of a PDF with an Info title and author, and nothing stored, fills both', async () => {
  // What the settle stamps an EPUB export nobody confirmed at a card with
  // (job-queue-carry.ts): the card's own stack, from the card's own function.
  expect(await inheritedMintMetaFor(unattendedDir)).toEqual({
    title: "'Working Towards the Führer.' Reflections on the Nature of the Hitler Dictatorship",
    contributors: [{ first: 'Ian', last: 'Kershaw' }],
  });
  // And the card reads the same answer for the same project.
  expect((await mintSeedFor(unattendedDir)).meta).toEqual(await inheritedMintMetaFor(unattendedDir));
});

test('a project whose own record will not read is refused, by name', async () => {
  const broken = path.join(path.dirname(projectDir), 'broken-record-0badf00d');
  await project(broken, 'broken record');
  const manifest = path.join(broken, 'project.json');
  const good = await fsp.readFile(manifest, 'utf8');
  // Listed first, while its record reads; then the record is damaged.
  await mintSeedFor(broken);
  await fsp.writeFile(manifest, '{ "version": 2, "key": ');
  try {
    await expect(mintSeedFor(broken)).rejects.toThrow('The record of "broken-record-0badf00d" (project.json) could not be read');
  } finally {
    await fsp.writeFile(manifest, good);
  }
});

test('an unattended export of a directory the library does not hold stamps nothing, and fails nothing', async () => {
  expect(await inheritedMintMetaFor(path.join(root, 'elsewhere'))).toBeNull();
});

test('a directory that is not a project in this library is refused', async () => {
  await expect(mintSeedFor(path.join(root, 'elsewhere'))).rejects.toThrow('is not a project in this library');
});

test('a higher source wins field by field', () => {
  const stored: MintMeta = { title: 'Stored', contributors: [], year: '2001' };
  const below: MintMeta = { title: 'Below', subtitle: 'Sub', contributors: [{ first: 'A', last: 'B' }], year: '1999' };
  expect(fillMintGaps(stored, below)).toEqual({
    title: 'Stored', subtitle: 'Sub', contributors: [{ first: 'A', last: 'B' }], year: '2001',
  });
  expect(fillMintGaps(null, null)).toBeNull();
});

test('only a name that is the convention fills anything', () => {
  expect(mintMetaFromName('Killing America. Bailey, Gene')).toEqual({
    title: 'Killing America', contributors: [{ first: 'Gene', last: 'Bailey' }],
  });
  expect(mintMetaFromName('Evolution_ Still a Theory in Crisis. Denton, Michael. (2016)')?.year).toBe('2016');
  // The parser reads these, and reads them wrong: they fill nothing.
  expect(mintMetaFromName('Agents of Light and Darkness - Simon R. Green')).toBeNull();
  expect(mintMetaFromName('Flashpoint Of Revival - The Third Great Awakening. Bailey, Gene and Murillo, Mar')).toBeNull();
  expect(mintMetaFromName('evangelische kirche')).toBeNull();
  expect(mintMetaFromName('Killing America. Gene Bailey')).toBeNull();
});

test('the parser is BookForge\'s, as it was', () => {
  expect(parseBookFilename('Title - Sub. Last, First. (2001).epub')).toEqual({
    title: 'Title', subtitle: 'Sub', authorLast: 'Last', authorFirst: 'First', authorFull: 'First Last', year: 2001,
  });
  expect(parseBookFilename('Title. Author.epub')).toEqual({ title: 'Title', authorLast: 'Author', authorFull: 'Author' });
  expect(parseBookFilename('Just a title.pdf')).toEqual({ title: 'Just a title' });
});

test('why the read moved into main: the working PDF was never opened, so the old door refuses it', () => {
  expect(() => admittedPdf(path.join(projectDir, 'working', `${STEM}.pdf`)))
    .toThrow('is not a document this app has open');
});
