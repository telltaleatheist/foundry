/**
 * The byte-order mark, and the day it made a book unopenable.
 *
 * A project's `project.json` came back "catalogue unreadable". The file was
 * perfect JSON. What was wrong with it was three bytes nobody can see — a UTF-8
 * BOM, put there by whatever had last written the file — which Node decodes into
 * the string rather than dropping, so `JSON.parse` met a character that is not
 * `{` and threw. Every reader in this app then did the honest thing and refused
 * the file, which left a book on the disk that could not be opened, could not be
 * listed, and could not be deleted through the app either, because the delete
 * card is composed out of the catalogue it could not read.
 *
 * These tests are about the two halves of the rule: strip exactly one mark at
 * exactly the front, and change nothing else about what is or is not JSON.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readJson, stripBom } from '../../app/shared/json.ts';

/** U+FEFF, which is what `EF BB BF` decodes to. */
const BOM = '﻿';

test('a BOM in front of an object is dropped and the file reads', () => {
  const catalogue = '{"version":2,"key":"a-book-a1b2c3d4"}';
  // The exact shape of the live failure: a real catalogue with a mark on it.
  assert.throws(() => JSON.parse(`${BOM}${catalogue}`), SyntaxError);
  assert.deepEqual(readJson(`${BOM}${catalogue}`), { version: 2, key: 'a-book-a1b2c3d4' });
});

test('a file without one is untouched', () => {
  assert.equal(stripBom('{"a":1}'), '{"a":1}');
  assert.deepEqual(readJson('{"a":1}'), { a: 1 });
});

test('only ONE mark, and only at the front', () => {
  // Two of them is a file built by concatenating two BOM'd files, which is
  // broken in a way worth refusing rather than papering over.
  assert.equal(stripBom(`${BOM}${BOM}{}`), `${BOM}{}`);
  assert.throws(() => readJson(`${BOM}${BOM}{}`), SyntaxError);
});

test('a U+FEFF inside a string is a character somebody meant', () => {
  // Not this function's business: it is inside a JSON string literal, it is
  // legal, and a reader that went looking for marks in the middle of a document
  // would be editing somebody's data.
  const title = `{"title":"a${BOM}b"}`;
  assert.deepEqual(readJson(title), { title: `a${BOM}b` });
  assert.equal(stripBom(title), title);
});

test('everything else that is not JSON is still not JSON', () => {
  // The helper strips an encoding artefact. It does not repair content: a
  // trailing comma, a comment, a truncated file are all files this app should go
  // on refusing loudly.
  for (const bad of ['{"a":1,}', '// hello\n{}', '{"a":', '', BOM]) {
    assert.throws(() => readJson(bad), SyntaxError, `"${bad}" should still be refused`);
  }
});

test('arrays and scalars come through, because not every file is an object', () => {
  // The recents list is a bare array and the callers check the shape themselves.
  assert.deepEqual(readJson(`${BOM}[1,2]`), [1, 2]);
  assert.equal(readJson(`${BOM}"x"`), 'x');
});
