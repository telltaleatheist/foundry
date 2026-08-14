/**
 * The command surface: the request shapes that are refused before anything is
 * read, and the name the output gets when nobody chose one.
 *
 * Everything here fails at the argv layer, so none of it needs a server, a file
 * or a model — which is the point. The mistakes worth catching early are the
 * ones whose cost is an evening of GPU.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { UsageError } from '../../src/args.js';
import { defaultTranslationOut, findCommand, runCommand } from '../../src/commands.js';
import { LanguageError, readLanguage } from '../../src/translate/languages.js';
import { answerBudget, chatBody, normaliseEndpoint, takesThinkField } from '../../src/translate/ollama.js';

const translate = findCommand('translate')!;

test('the command is registered with its flags', () => {
  assert.ok(translate !== undefined);
  const names = (translate.options ?? []).map((o) => o.name).sort();
  assert.deepEqual(names, [
    'bank', 'concurrency', 'epub', 'fresh-bank', 'from', 'instructions', 'model', 'ollama',
    'out', 'to',
  ]);
});

test('--fresh-bank without --bank is refused rather than doing nothing quietly', async () => {
  // It is an instruction ABOUT A BANK and there is no bank. A flag dropped on
  // the floor here is somebody believing they ordered a fresh translation.
  await assert.rejects(
    runCommand(translate, ['--epub', 'Buch.epub', '--to', 'en', '--fresh-bank']),
    (error: Error) => error instanceof UsageError && /no --bank was given/.test(error.message),
  );
});

test('a concurrency that is not a count of requests is refused by name', async () => {
  for (const bad of ['0', '-2', 'four', '2.5']) {
    await assert.rejects(
      runCommand(translate, ['--epub', 'Buch.epub', '--to', 'en', '--concurrency', bad]),
      (error: Error) => error instanceof UsageError && /positive whole number/.test(error.message),
      `--concurrency ${bad}`,
    );
  }
});

test('--out equal to --epub is refused, and the sentence says it is the input', async () => {
  await assert.rejects(
    runCommand(translate, ['--epub', 'books/Buch.epub', '--to', 'en', '--out', 'books/Buch.epub']),
    (error: Error) => error instanceof UsageError && /is the input itself/.test(error.message),
  );
});

test('--out equal to --epub is caught through a different spelling of the same path', async () => {
  await assert.rejects(
    runCommand(translate, ['--epub', 'books/Buch.epub', '--to', 'en', '--out', 'books/./Buch.epub']),
    UsageError,
  );
});

test('a missing --epub or --to is refused by name', async () => {
  await assert.rejects(runCommand(translate, ['--to', 'en']), UsageError);
  await assert.rejects(runCommand(translate, ['--epub', 'Buch.epub']), UsageError);
});

test('the default output puts the language tag before the extension', () => {
  assert.equal(defaultTranslationOut('Buch.epub', 'en'), 'Buch.en.epub');
  assert.equal(defaultTranslationOut('/books/Der Staat.epub', 'pt-BR'), '/books/Der Staat.pt-BR.epub');
  assert.equal(defaultTranslationOut('C:\\books\\Buch.epub', 'en'), 'C:\\books\\Buch.en.epub');
  // No extension to go before: the tag goes on the end rather than into the
  // directory name.
  assert.equal(defaultTranslationOut('/books/Buch', 'en'), '/books/Buch.en');
  assert.equal(defaultTranslationOut('/a.b/Buch', 'en'), '/a.b/Buch.en');
});

test('the help says what is skipped and what happens to a block that fails', () => {
  // TWO, not three: a table's words are translated now. The help has to say so
  // and say WHY it reversed, because "a table whose columns quietly swapped is
  // worse than one nobody translated" was the published reason for the old
  // behaviour and somebody who read it is owed the argument that replaced it.
  assert.match(translate.detail, /TWO ARE SKIPPED AND COUNTED —\nformula and picture/);
  assert.doesNotMatch(translate.detail, /table, formula and\npicture/);
  assert.match(translate.detail, /A TABLE USED TO BE THE THIRD SKIP AND IS NOT ANY MORE/);
  assert.match(translate.detail, /structure a model cannot see\nis structure a model cannot rearrange/i);
  assert.match(translate.detail, /WHAT TRAVELS IN ONE REQUEST/);
  /*
   * The help described the behaviour that 52e3625 deleted for three commits —
   * marker and echo rejections, and a job that fails on a refused block. Help
   * that describes a version of the program that no longer exists is worse than
   * no help: it is the one document a person consults instead of reading the
   * source. These pin the behaviour that replaced it.
   */
  assert.match(translate.detail, /STAYS IN THE SOURCE LANGUAGE/);
  assert.match(translate.detail, /TWO GUARDS/);
  assert.doesNotMatch(translate.detail, /THE JOB FAILS/);
  assert.doesNotMatch(translate.detail, /drops, doubles, invents or crosses a marker/);
  assert.match(translate.detail, /Used, never started|does not start it/);
});

test('the help says what the bank is keyed by and that the concurrency default is not measured', () => {
  // The key is the whole feature: somebody who does not know that editing a
  // paragraph re-asks that paragraph ONLY cannot predict what a second run
  // costs, which is the only question anybody has about a cache.
  assert.match(translate.detail, /THE KEY IS THE QUESTION, NOT THE POSITION/);
  assert.match(translate.detail, /A block the\nmodel could NOT do is never banked/);
  assert.match(translate.detail, /A chunk with some parts already banked is still sent WHOLE/);
  // And the honesty about the default, which is the difference between this
  // number and --vlm-concurrency's measured knee.
  assert.match(translate.detail, /THE DEFAULT IS A STARTING POINT AND NOT A MEASUREMENT/);
  assert.match(translate.detail, /`block N\/M` counts blocks FINISHED/);
});

// ── languages ────────────────────────────────────────────────────────────────

test('a language tag becomes a name the prompt can use', () => {
  assert.deepEqual(readLanguage('en', '--to'), { tag: 'en', name: 'English' });
  assert.deepEqual(readLanguage('de', '--from'), { tag: 'de', name: 'German' });
  assert.deepEqual(readLanguage('pt-BR', '--to'), { tag: 'pt-BR', name: 'Brazilian Portuguese' });
  // The region survives into the prompt even when it is not a named pair.
  assert.deepEqual(readLanguage('es-MX', '--to'), { tag: 'es-MX', name: 'Spanish (es-MX)' });
});

test('a language with no name is refused rather than passed through as a code', () => {
  assert.throws(
    () => readLanguage('xq', '--to'),
    (error: Error) => error instanceof LanguageError && /no name for the language "xq"/.test(error.message),
  );
});

test('something that is not a language tag at all is refused', () => {
  assert.throws(() => readLanguage('English', '--to'), LanguageError);
  assert.throws(() => readLanguage('', '--to'), LanguageError);
});

// ── the Ollama request body ──────────────────────────────────────────────────

test('qwen3 gets "think": false and qwen2.5 must not', () => {
  assert.equal(takesThinkField('qwen3:32b'), true);
  assert.equal(takesThinkField('qwen3.1:8b-instruct-q4_K_M'), true);
  assert.equal(takesThinkField('qwen2.5:14b'), false);
  assert.equal(takesThinkField('llama3.1:8b'), false);
  // Not a prefix match on anything that merely starts with the letters.
  assert.equal(takesThinkField('qwen30b-experiment'), false);
});

test('the request body is what Ollama documents, at the measured settings', () => {
  const body = JSON.parse(chatBody('qwen3:32b', 'SYS', 'USER'));
  assert.equal(body.model, 'qwen3:32b');
  assert.equal(body.stream, false);
  assert.equal(body.think, false);
  assert.deepEqual(body.options, { temperature: 0.2, num_ctx: 8192, num_predict: 128 });
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'USER' },
  ]);
});

test('the answer is bounded by the block, above the length the check would refuse', () => {
  /*
   * MEASURED: `HV111$007458S` — a library accession number stamped on the
   * flyleaf of the Dannenmann scan — drew a 16,876-character answer out of
   * qwen3:32b, three times, at minutes a go, before the length check refused
   * each one. Nothing told the server how long an answer could be.
   *
   * The bound must sit ABOVE the ceiling `checkAnswer` enforces (LONG_RATIO,
   * 3× the source) or it would truncate answers that were going to be accepted.
   * At 4× the source in characters and 2.5 characters a token, it does.
   */
  const stamp = 'HV111$007458S';
  assert.equal(answerBudget(stamp), 128, 'the floor, which is a paragraph a short block cannot reach');

  const paragraph = 'x'.repeat(2000);
  const budget = answerBudget(paragraph);
  // Room for an answer 4× the source, which is comfortably past the 3× the
  // verification refuses — so a truncation here can only ever hit an answer
  // that was already doomed.
  assert.ok(budget * 2.5 > paragraph.length * 3, 'the cap clears the refusal ceiling');
  assert.equal(budget, 3200);
});

test('a model without thinking support carries no think field at all', () => {
  const body = JSON.parse(chatBody('qwen2.5:14b', 'SYS', 'USER'));
  assert.equal('think' in body, false);
});

test('a trailing slash on the endpoint does not become a double slash', () => {
  assert.equal(normaliseEndpoint('http://localhost:11434/'), 'http://localhost:11434');
  assert.equal(normaliseEndpoint('http://localhost:11434'), 'http://localhost:11434');
});
