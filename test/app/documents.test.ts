import { describe, expect, test } from 'bun:test';

import { documentNames, spokenName, spokenStem } from '../../app/shared/documents';
import type { NamedDocument } from '../../app/shared/documents';

/**
 * The fallback voice for a title nothing ever chose — see `readManifest`, which
 * only speaks a stem that is still the placeholder. A chosen title never comes
 * through here, so these cases are all about what filesystems do to names.
 */
describe('spokenStem', () => {
  test('a citation stem reads as a citation, dots kept', () => {
    expect(spokenStem('Working-Towards-The-Fuhrer.-Kershaw-Ian.-1993'))
      .toBe('Working Towards The Fuhrer. Kershaw Ian. 1993');
  });

  test('underscores are the same silence as dashes', () => {
    expect(spokenStem('animal_farm_-_orwell')).toBe('animal farm orwell');
  });

  test('a stem with nothing to say stays itself', () => {
    expect(spokenStem('Nuremberg')).toBe('Nuremberg');
  });

  test('leading and trailing separators leave no blank edges', () => {
    expect(spokenStem('-gospel-of-lies-')).toBe('gospel of lies');
  });
});

/**
 * The last resort for a document no project has claimed — a file dropped on the
 * window, or one opened out of somebody's own folder. The extension goes because
 * it is bookkeeping, exactly as the directory is.
 */
describe('spokenName', () => {
  test('a windows path is named by its file and not by where it sits', () => {
    expect(spokenName('C:\\books\\Working-Towards-The-Fuhrer.-Kershaw-Ian.-1993.pdf'))
      .toBe('Working Towards The Fuhrer. Kershaw Ian. 1993');
  });

  test('a posix path is read the same way', () => {
    expect(spokenName('/home/owen/scans/animal_farm.epub')).toBe('animal farm');
  });

  test('only the last extension goes, so a dotted citation survives', () => {
    expect(spokenName('Kershaw. Ian. 1993.pdf')).toBe('Kershaw. Ian. 1993');
  });

  test('a file with no extension keeps every character it has', () => {
    expect(spokenName('/tmp/Nuremberg')).toBe('Nuremberg');
  });

  test('a name that is nothing but an extension is not emptied out', () => {
    expect(spokenName('.epub')).toBe('.epub');
  });
});

/**
 * What the side nav calls the rows under a book's name. The header has already
 * said which book this is; a row says which of its faces you are looking at.
 */
describe('documentNames', () => {
  const step = (
    kind: NamedDocument['steps'][number]['kind'],
    label: string,
  ): NamedDocument['steps'][number] => ({ kind, label });

  test('an ordinary project names its rows by what they are', () => {
    const names = documentNames([
      { kind: 'pdf', steps: [step('origin', 'The scan you imported')] },
      { kind: 'epub', steps: [step('origin', 'Cast from the scan')] },
      { kind: 'txt', steps: [step('origin', 'Written out as plain text')] },
    ]);
    expect(names).toEqual(['PDF', 'EPUB', 'text']);
  });

  test('a reprinted PDF is still one row and is still called the PDF', () => {
    const names = documentNames([
      {
        kind: 'pdf',
        steps: [step('origin', 'The scan you imported'), step('convert', 'Reprinted as real text')],
      },
      { kind: 'epub', steps: [step('origin', 'Cast from the scan')] },
    ]);
    expect(names).toEqual(['PDF', 'EPUB']);
  });

  test('a translated book says which language it is now in', () => {
    const names = documentNames([
      { kind: 'pdf', steps: [step('origin', 'The scan you imported')] },
      {
        kind: 'epub',
        steps: [step('origin', 'Cast from the scan'), step('translate', 'Translated (Hungarian)')],
      },
    ]);
    expect(names).toEqual(['PDF', 'EPUB · Translated (Hungarian)']);
  });

  test('two rows of one kind are told apart by what was done to each, never by a file', () => {
    const names = documentNames([
      { kind: 'pdf', steps: [step('origin', 'The scan you imported')] },
      {
        kind: 'pdf',
        steps: [step('origin', 'The scan you imported'), step('convert', 'Reprinted as real text')],
      },
    ]);
    expect(names).toEqual(['PDF · The scan you imported', 'PDF · Reprinted as real text']);
  });

  test('a row with no chain at all is still named rather than left blank', () => {
    expect(documentNames([{ kind: 'epub', steps: [] }])).toEqual(['EPUB']);
  });
});
