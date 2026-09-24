/**
 * The cleanup's sentence unit (src/clean/sentences.ts): where it cuts, where it
 * refuses to, Owen's 30-character floor, and a block put back byte for byte.
 */
import { expect, test } from 'bun:test';

import { cleanSentences, MIN_SENTENCE_CHARS, reassemble } from '../../src/clean/sentences.js';

const texts = (text: string): string[] => cleanSentences(text).map((s) => s.text);

test('cuts at a full stop before a capital, keeping the punctuation with its sentence', () => {
  expect(texts('The railway opened in the spring of that year. Nobody had expected it to pay. It did.'))
    .toEqual(['The railway opened in the spring of that year.', 'Nobody had expected it to pay. It did.']);
});

test('never cuts after an abbreviation, an initial or a dotted run', () => {
  for (const one of [
    'The Diary of a Napoleonic Foot Soldier, ed. Marc Raeff, appeared in New York much later.',
    'In 1844 the painter J. M. W. Turner tried to capture these novel sensations on canvas.',
    'In the hurry and agitation of the moment, Mr. Huskisson did not pursue this advice at all.',
    'The biographies come from works such as those by F. S. L. Lyons and others of his generation.',
    'Some things, e.g. The Times of London, were read aloud in every coffee house in the city.',
    'The leader Toussaint (c. 1743–1803) was himself inspired by the ideas of the Revolution in France.',
    'It is quoted from Rom. 5:17 and from nowhere else in the whole of the pamphlet that survives.',
  ]) expect(texts(one)).toEqual([one]);
});

test('a sentence shorter than the floor joins the NEXT one; the last joins the one before', () => {
  expect(MIN_SENTENCE_CHARS).toBe(30);
  expect(texts('It rained. The whole of the harvest was lost in a single week that year.'))
    .toEqual(['It rained. The whole of the harvest was lost in a single week that year.']);
  expect(texts('The whole of the harvest was lost in a single week that year. It rained.'))
    .toEqual(['The whole of the harvest was lost in a single week that year. It rained.']);
  // A block that is one short line is still one sentence.
  expect(texts('THE AFTERMATH OF WAR')).toEqual(['THE AFTERMATH OF WAR']);
});

test('a block comes back byte for byte, whatever lies between its sentences', () => {
  const text = '  The railway opened in the spring of that year.\u00a0 \nNobody had expected it to pay a penny. ';
  const spans = cleanSentences(text);
  expect(spans.map((s) => text.slice(s.start, s.end))).toEqual(spans.map((s) => s.text));
  expect(reassemble(text, spans, spans.map((s) => s.text))).toBe(text);
  expect(reassemble(text, spans, ['A.', 'B.'])).toBe('  A.\u00a0 \nB. ');
  expect(() => reassemble(text, spans, ['only one'])).toThrow(/2 sentence\(s\) and 1 answer/);
});

test('an empty or all-space block has no sentences', () => {
  expect(cleanSentences('')).toEqual([]);
  expect(cleanSentences('   ')).toEqual([]);
});
