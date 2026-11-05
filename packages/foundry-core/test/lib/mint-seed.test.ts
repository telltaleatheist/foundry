/**
 * The export card's seed: what a project says about itself when nobody has
 * filled the card yet (Owen, 2026-11-05: "when i export an epub, it doesnt
 * automatically fill the metadata").
 *
 * Fails on main before the fix: `mintSeedFor` did not exist, and the card's own
 * read of the scan went through `admittedPdf`, which refuses the project's
 * working PDF because nothing ever opened it. The last test pins that refusal,
 * so the reason the read had to move into main stays written down.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PDFDocument } from 'pdf-lib';

import { admittedPdf, mintSeedFor } from '../../src/node/doors-meta';
import { mintMetaFromName, parseBookFilename } from '../../src/shared/book-filename';
import { fillMintGaps, type MintMeta } from '../../src/shared/mint-meta';
import { useTestPlatform } from './platform-fixture';

const STEM = 'Working Towards The Fuhrer. Kershaw, Ian. (1993)';
let root = '';
let projectDir = '';

/** A PDF whose Info names a title and no author, the shape of the real scan. */
async function scan(file: string): Promise<void> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  doc.setTitle("'Working Towards the Führer.' Reflections on the Nature of the Hitler Dictatorship");
  await fsp.writeFile(file, await doc.save());
}

beforeAll(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'foundry-mint-seed-'));
  const userData = path.join(root, 'userData');
  const library = path.join(root, 'library');
  await fsp.mkdir(userData, { recursive: true });
  await fsp.writeFile(path.join(userData, 'app-settings.json'), JSON.stringify({ libraryDir: library }));
  useTestPlatform((name) => (name === 'userData' ? userData : path.join(root, name)));

  projectDir = path.join(library, 'projects', 'kershaw-d3f7ae65');
  await fsp.mkdir(path.join(projectDir, 'archive'), { recursive: true });
  await fsp.mkdir(path.join(projectDir, 'working'), { recursive: true });
  await scan(path.join(projectDir, 'archive', `${STEM}.pdf`));
  await scan(path.join(projectDir, 'working', `${STEM}.pdf`));
  await fsp.writeFile(path.join(projectDir, 'project.json'), JSON.stringify({
    version: 2,
    key: 'kershaw-d3f7ae65',
    title: STEM,
    stem: STEM,
    createdAt: 1,
    archive: { file: `${STEM}.pdf`, kind: 'pdf', contentKey: 'd3f7ae65' },
    documents: [{
      kind: 'pdf',
      steps: [{
        file: `archive/${STEM}.pdf`, kind: 'origin', label: 'The scan you imported',
        appliedAt: 1, retention: 'irreplaceable', why: 'the only copy',
      }],
    }],
    working: { files: [{ file: `${STEM}.pdf`, kind: 'pdf', from: `archive/${STEM}.pdf`, madeAt: 2 }] },
  }));
});

afterAll(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

test('main reads the scan by project, and the name answers what the scan does not', async () => {
  const seed = await mintSeedFor(projectDir);
  expect(seed.problem).toBeNull();
  expect(seed.pdf?.title).toBe("'Working Towards the Führer.' Reflections on the Nature of the Hitler Dictatorship");
  expect(seed.pdf?.contributors).toEqual([]);
  expect(seed.name).toEqual({
    title: 'Working Towards The Fuhrer',
    contributors: [{ first: 'Ian', last: 'Kershaw' }],
    year: '1993',
  });
  // The card's order below the stored block and the host: the scan, then the name.
  const card = fillMintGaps(fillMintGaps(null, seed.pdf), seed.name);
  expect(card).toEqual({
    title: "'Working Towards the Führer.' Reflections on the Nature of the Hitler Dictatorship",
    contributors: [{ first: 'Ian', last: 'Kershaw' }],
    year: '1993',
  });
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
