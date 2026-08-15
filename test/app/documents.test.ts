import { describe, expect, test } from 'bun:test';

import { spokenStem } from '../../app/shared/documents';

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
