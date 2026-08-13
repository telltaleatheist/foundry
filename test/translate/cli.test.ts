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
import { chatBody, normaliseEndpoint, takesThinkField } from '../../src/translate/ollama.js';

const translate = findCommand('translate')!;

test('the command is registered with its flags', () => {
  assert.ok(translate !== undefined);
  const names = (translate.options ?? []).map((o) => o.name).sort();
  assert.deepEqual(names, ['epub', 'from', 'instructions', 'model', 'ollama', 'out', 'to']);
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

test('the help says what is skipped and that nothing is written on a refusal', () => {
  assert.match(translate.detail, /table, formula and\npicture/);
  assert.match(translate.detail, /THE JOB FAILS/);
  assert.match(translate.detail, /Used, never started|does not start it/);
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
  assert.deepEqual(body.options, { temperature: 0.2, num_ctx: 8192 });
  assert.deepEqual(body.messages, [
    { role: 'system', content: 'SYS' },
    { role: 'user', content: 'USER' },
  ]);
});

test('a model without thinking support carries no think field at all', () => {
  const body = JSON.parse(chatBody('qwen2.5:14b', 'SYS', 'USER'));
  assert.equal('think' in body, false);
});

test('a trailing slash on the endpoint does not become a double slash', () => {
  assert.equal(normaliseEndpoint('http://localhost:11434/'), 'http://localhost:11434');
  assert.equal(normaliseEndpoint('http://localhost:11434'), 'http://localhost:11434');
});
