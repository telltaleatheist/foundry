/**
 * The run: what comes out of a whole book, and what happens when the model will
 * not do its job.
 *
 * Every test here drives the real orchestrator against a fake HTTP boundary, so
 * the verification loop, the retries, the refusals and the container rewrite
 * are all the production code. Nothing is mocked except the server.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { readZipMap } from '../../src/translate/unzip.js';
import { checkAnswer, systemPrompt, translateEpub, TranslateError } from '../../src/translate/run.js';
import { readLanguage } from '../../src/translate/languages.js';
import { CHAPTER_PATH, NAV_PATH, OPF_PATH, PICTURE, fakeOllama, foundryEpub, plainEpub, shout } from './fixture.js';

function scratch(): { epub: string; out: string; clean: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-translate-'));
  const epub = path.join(dir, 'Buch.epub');
  fs.writeFileSync(epub, foundryEpub());
  return { epub, out: path.join(dir, 'Buch.en.epub'), clean: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const quiet = (): void => {};

// ── the whole book ───────────────────────────────────────────────────────────

test('a foundry book comes out translated, with its skips counted', async () => {
  const { epub, out, clean } = scratch();
  try {
    const server = fakeOllama();
    const report = await translateEpub({
      epubPath: epub, outPath: out, to: 'en', from: 'de', transport: server, log: quiet,
    });

    // Seven blocks: the chapter heading, the paragraph, the section header, the
    // list item, the quote's inner <p>, the caption and the footnote. The <ul>
    // and the <blockquote> are stamped too and are NOT blocks — the thing
    // inside them is.
    assert.equal(report.blocks, 7);
    assert.equal(report.documents, 1);
    assert.equal(report.retries, 0);
    assert.deepEqual([...report.skipped].sort(), [['formula', 1], ['picture', 1], ['table', 1]]);
    assert.equal(server.asked.length, 7);

    const written = readZipMap(new Uint8Array(fs.readFileSync(out)));
    const chapter = written.get(CHAPTER_PATH)!.text();

    // Prose replaced, inline markup identical, page provenance untouched.
    assert.match(chapter, /<em>VOELKISCHER<\/em>/);
    assert.match(chapter, /EIN <em>VOELKISCHER<\/em> STAAT WAR DAS ZIEL<a class="noteref" epub:type="noteref" role="doc-noteref" href="#fn1"><sup>1<\/sup><\/a> DER GANZEN BEWEGUNG\./);
    assert.match(chapter, /<span epub:type="pagebreak" role="doc-pagebreak" id="pb-7" data-bf-page="7" aria-label="7"><\/span>DER STAAT/);
    assert.match(chapter, /data-bf-page="9" data-bf-cat="caption">ABBILDUNG DES GROSSEN GEBAEUDES\./);
    assert.match(chapter, /<aside class="footnote" epub:type="footnote" role="doc-footnote" id="fn1"[^>]*><sup>1<\/sup> SIEHE DAZU DAS WERK VON GESTERN\./);

    // The three skipped categories are byte-for-byte what they were.
    assert.match(chapter, /<div class="tablewrap" data-bf-page="9" data-bf-cat="table"><table><tr><td>Jahr<\/td><td>Zahl<\/td><\/tr><\/table><\/div>/);
    assert.match(chapter, /<p class="formula" data-bf-page="9" data-bf-cat="formula">a = b \+ c<\/p>/);
    assert.match(chapter, /<img src="\.\.\/images\/p0009-1\.png" alt="figure from page 9"\/>/);

    // The language declarations moved and nothing else about the head did.
    assert.match(chapter, /<html xmlns="http:\/\/www\.w3\.org\/1999\/xhtml" xmlns:epub="http:\/\/www\.idpf\.org\/2007\/ops" xml:lang="en" lang="en">/);
    assert.match(chapter, /<title>Der Staat<\/title>/);
  } finally {
    clean();
  }
});

test('the package keeps its title and changes its language', async () => {
  const { epub, out, clean } = scratch();
  try {
    await translateEpub({ epubPath: epub, outPath: out, to: 'en', transport: fakeOllama(), log: quiet });
    const opf = readZipMap(new Uint8Array(fs.readFileSync(out))).get(OPF_PATH)!.text();
    assert.match(opf, /<dc:language>en<\/dc:language>/);
    assert.match(opf, /<dc:title>Der Staat<\/dc:title>/);
    assert.match(opf, /<dc:creator>Ein Verfasser<\/dc:creator>/);
    // The metadata is still German, so the package's own xml:lang stays.
    assert.match(opf, /<package [^>]*xml:lang="de">/);
  } finally {
    clean();
  }
});

test('contents entries are relabelled only where they are provably copies', async () => {
  const { epub, out, clean } = scratch();
  try {
    const report = await translateEpub({
      epubPath: epub, outPath: out, to: 'en', transport: fakeOllama(), log: quiet,
    });
    assert.equal(report.navRelabelled, 2);
    assert.equal(report.navUnmapped, 1);

    const nav = readZipMap(new Uint8Array(fs.readFileSync(out))).get(NAV_PATH)!.text();
    assert.match(nav, /<a href="text\/c0001\.xhtml">DER STAAT<\/a>/);
    assert.match(nav, /<a href="text\/c0001\.xhtml#sh1">DIE ORDNUNG<\/a>/);
    // The entry pointing at a fragment no heading owns is left alone rather
    // than guessed at.
    assert.match(nav, /<a href="text\/c0001\.xhtml#nowhere">Ein Eintrag ohne Ziel<\/a>/);
  } finally {
    clean();
  }
});

test('the pictures and the stylesheet come through untouched', async () => {
  const { epub, out, clean } = scratch();
  try {
    await translateEpub({ epubPath: epub, outPath: out, to: 'en', transport: fakeOllama(), log: quiet });
    const written = readZipMap(new Uint8Array(fs.readFileSync(out)));
    assert.deepEqual([...written.get('EPUB/images/p0009-1.png')!.data], [...PICTURE]);
    assert.equal(written.get('EPUB/style.css')!.text(), 'body { margin: 0 5%; }\n');
    // `mimetype` is still first, still stored — an EPUB is identified by it.
    assert.equal([...written.keys()][0], 'mimetype');
    assert.equal(written.get('mimetype')!.method, 0);
  } finally {
    clean();
  }
});

test('the input EPUB is not written to', async () => {
  const { epub, out, clean } = scratch();
  try {
    const before = fs.readFileSync(epub);
    await translateEpub({ epubPath: epub, outPath: out, to: 'en', transport: fakeOllama(), log: quiet });
    assert.deepEqual([...fs.readFileSync(epub)], [...before]);
  } finally {
    clean();
  }
});

// ── the model misbehaving ────────────────────────────────────────────────────

test('a rejected answer is asked again, and a good second answer is kept', async () => {
  const { epub, out, clean } = scratch();
  try {
    // The first request for every block comes back empty; the retry works.
    const server = fakeOllama((user, attempt) => (attempt === 1 ? '' : shout(user)));
    const report = await translateEpub({
      epubPath: epub, outPath: out, to: 'en', transport: server, log: quiet,
    });
    assert.equal(report.retries, 7);
    assert.equal(server.asked.length, 14);
    assert.match(readZipMap(new Uint8Array(fs.readFileSync(out))).get(CHAPTER_PATH)!.text(), /DER STAAT/);
  } finally {
    clean();
  }
});

test('three bad answers refuse the block by name and write no book at all', async () => {
  const { epub, out, clean } = scratch();
  try {
    const logged: string[] = [];
    // Every answer drops the markers and is far too short.
    const server = fakeOllama(() => 'nope');
    await assert.rejects(
      translateEpub({
        epubPath: epub, outPath: out, to: 'en', transport: server, log: (m) => logged.push(m),
      }),
      (error: Error) => {
        assert.ok(error instanceof TranslateError);
        /*
         * FIVE of the seven, and the two that got through are the honest limit
         * of a ratio test. "nope" is four characters against "Die Ordnung"'s
         * eleven and "Der Staat"'s nine — over a quarter of each — so a
         * two-word heading is short enough that a junk answer is not
         * distinguishable from a terse translation by length alone. "Der
         * Staat" used to be refused, and for a reason that was an ACCIDENT:
         * its only marker was its leading pagebreak span, and the junk answer
         * dropped it. The same accident refused three correct translations of
         * "Kirchenwahlen 1932" on the first real run — a heading that is
         * mostly token sheds the token — which is why edge atomics no longer
         * travel to the model at all (`markers.ts`), and why length is one of
         * five checks rather than the check: every block with an INTERIOR
         * marker is still refused on the markers.
         */
        assert.match(error.message, /5 of 7 blocks could not be translated/);
        assert.match(error.message, /NOTHING WAS WRITTEN/);
        // Named: the document, the block, its category, its page, its words.
        assert.match(error.message, /block 2 \(text, page 7\)[^\n]*dropped 2 of 2 marker/);
        assert.match(error.message, /block 5 \(quote, page 8\)[^\n]*under 25%/);
        assert.match(error.message, /block 7 \(footnote, page 9\)/);
        assert.doesNotMatch(error.message, /block 1 /);
        assert.doesNotMatch(error.message, /block 3 /);
        return true;
      },
    );
    assert.equal(fs.existsSync(out), false, 'no partial book is left behind');
    assert.equal(server.asked.length, 17, 'three attempts each, and two blocks that passed');
    assert.ok(logged.some((l) => l.startsWith('translate: REFUSED ')));
  } finally {
    clean();
  }
});

test('a server that stops answering ends the run instead of retrying the book', async () => {
  const { epub, out, clean } = scratch();
  try {
    const server = fakeOllama();
    let calls = 0;
    const dying = {
      ...server,
      post: async (url: string, body: string) => {
        calls += 1;
        if (calls > 2) return { status: 500, body: 'model runner has crashed' };
        return server.post(url, body);
      },
    };
    await assert.rejects(
      translateEpub({ epubPath: epub, outPath: out, to: 'en', transport: dying, log: quiet }),
      /answered 500/,
    );
    assert.equal(calls, 3, 'it stops at the first server failure, it does not retry it');
  } finally {
    clean();
  }
});

test('a missing model is refused before any block is sent, with the list of models', async () => {
  const { epub, out, clean } = scratch();
  try {
    const server = fakeOllama(undefined, ['qwen2.5:14b', 'llama3.1:8b']);
    await assert.rejects(
      translateEpub({ epubPath: epub, outPath: out, to: 'en', transport: server, log: quiet }),
      (error: Error) => {
        assert.match(error.message, /has no model named "qwen3:32b"/);
        assert.match(error.message, /qwen2\.5:14b, llama3\.1:8b/);
        return true;
      },
    );
    assert.equal(server.asked.length, 0);
  } finally {
    clean();
  }
});

test('a book with no foundry stamps never reaches the model', async () => {
  const { out, clean } = scratch();
  const dir = path.dirname(out);
  const plain = path.join(dir, 'Publisher.epub');
  try {
    fs.writeFileSync(plain, plainEpub());
    const server = fakeOllama();
    await assert.rejects(
      translateEpub({ epubPath: plain, outPath: out, to: 'en', transport: server, log: quiet }),
      /not a foundry-converted book/,
    );
    assert.equal(server.asked.length, 0);
  } finally {
    clean();
  }
});

// ── the verification rules, one at a time ────────────────────────────────────

test('an empty answer is rejected', () => {
  assert.match(checkAnswer('Ein langer deutscher Satz hier.', '   ')!, /empty/);
});

test('an answer under a quarter of the source is an omission', () => {
  const source = 'Ein sehr langer deutscher Satz, der viele Woerter hat und weitergeht.';
  assert.match(checkAnswer(source, 'A sentence.')!, /under 25%/);
});

test('an answer over three times the source is commentary', () => {
  assert.match(checkAnswer('Ein kurzer Satz hier.', 'A short sentence. '.repeat(12))!, /over 3×/);
});

test('an echoed source is rejected once there is enough of it to be sure', () => {
  const source = 'Ein sehr langer deutscher Satz mit vielen Woertern.';
  assert.match(checkAnswer(source, source)!, /echoed the text/);
});

test('a short proper noun that translates to itself is NOT called an echo', () => {
  // The failure this exemption prevents: three wasted retries and a hard stop
  // on a chapter heading whose correct translation is the word it already is.
  assert.equal(checkAnswer('Berlin', 'Berlin'), null);
  assert.equal(checkAnswer('Karl Marx', 'Karl Marx'), null);
});

test('a code fence is markup the model added and is rejected', () => {
  const source = 'Ein langer deutscher Satz mit vielen Woertern darin.';
  assert.match(checkAnswer(source, '```\nA long German sentence with many words in it.\n```')!, /code fence/);
});

test('markers do not count toward the length checks', () => {
  // Four pagebreak spans around one word: without stripping, the answer would
  // look nearly as long as the source however little came back.
  const source = '⟦m1⟧⟦m2⟧⟦m3⟧⟦m4⟧Wort';
  assert.match(checkAnswer(source, '⟦m1⟧⟦m2⟧⟦m3⟧⟦m4⟧')!, /nothing but the markers/);
});

test('a plain good answer complains about nothing', () => {
  assert.equal(checkAnswer('Ein deutscher Satz hier.', 'A German sentence here.'), null);
});

// ── the prompt ───────────────────────────────────────────────────────────────

test('the system prompt names both languages and carries instructions verbatim', () => {
  const prompt = systemPrompt(
    readLanguage('de', '--from'),
    readLanguage('pt-BR', '--to'),
    "  Leave 'völkisch' untranslated.  ",
  );
  assert.match(prompt, /from German into Brazilian Portuguese/);
  assert.match(prompt, /Do not soften, sanitise, modernise or euphemise/);
  assert.match(prompt, /OUTPUT ONLY THE TRANSLATION/);
  assert.match(prompt, /Leave 'völkisch' untranslated\./);
});

test('with no --from the model is told to determine the language itself', () => {
  const prompt = systemPrompt(null, readLanguage('en', '--to'), undefined);
  assert.match(prompt, /determine from the text itself/);
  assert.doesNotMatch(prompt, /ADDITIONAL INSTRUCTIONS/);
});

test('the prompt teaches only the marker kinds the block carries', () => {
  // Measured on the first real run: three blocks with NO markers refused three
  // attempts each for answers containing ⟦e1⟧…⟦/e1⟧ pairs the prompt itself
  // had taught. A model cannot invent a notation it was never shown.
  const en = readLanguage('en', '--to');
  const none = systemPrompt(null, en, undefined, { paired: false, atomic: false });
  assert.match(none, /contains no ⟦…⟧ markers/);
  assert.match(none, /Never write the characters ⟦ or ⟧/);
  assert.doesNotMatch(none, /A pair such as/);
  assert.doesNotMatch(none, /A single marker such as/);

  const atomicOnly = systemPrompt(null, en, undefined, { paired: false, atomic: true });
  assert.match(atomicOnly, /A single marker such as/);
  assert.doesNotMatch(atomicOnly, /A pair such as/);
  assert.match(atomicOnly, /never write a marker not in the source/);

  const pairedOnly = systemPrompt(null, en, undefined, { paired: true, atomic: false });
  assert.match(pairedOnly, /A pair such as/);
  assert.doesNotMatch(pairedOnly, /A single marker such as/);

  // The default is both — the shape every earlier assertion in this file pins.
  const both = systemPrompt(null, en, undefined);
  assert.match(both, /A pair such as/);
  assert.match(both, /A single marker such as/);
});
