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
import { checkAnswer, systemPrompt, translateEpub, unfence, TranslateError } from '../../src/translate/run.js';
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

test('three bad answers leave the block in the source language and finish the book', async () => {
  /*
   * IT USED TO THROW AWAY THE WHOLE BOOK, on the argument that a book missing a
   * paragraph and looking finished is worse than no book. Measured against a
   * real scan, that argument cost 455 translated blocks: block 8 of the
   * Dannenmann book is `HV111$007458S`, a library accession number stamped on
   * the flyleaf, and no model will ever translate it. The blocks that cannot be
   * done are now left exactly as the book wrote them, named in the log, named
   * in the report, and counted on the completion line.
   */
  const { epub, out, clean } = scratch();
  try {
    const logged: string[] = [];
    // Every answer drops the markers and is far too short.
    const server = fakeOllama(() => 'nope');
    const report = await translateEpub({
      epubPath: epub, outPath: out, to: 'en', transport: server, log: (m) => logged.push(m),
    });

    {
      const named = report.keptUntranslated.join('\n');
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
      assert.equal(report.keptUntranslated.length, 5);
      // Named: the document, the block, its category, its page, its words.
      assert.match(named, /block 2 \(text, page 7\)[^\n]*under 25%/);
      assert.match(named, /block 5 \(quote, page 8\)[^\n]*under 25%/);
      assert.match(named, /block 7 \(footnote, page 9\)/);
      assert.doesNotMatch(named, /block 1 /);
      assert.doesNotMatch(named, /block 3 /);
    }

    assert.equal(server.asked.length, 17, 'three attempts each, and two blocks that passed');
    assert.ok(logged.some((l) => /block 2 LEFT IN THE SOURCE LANGUAGE after 3 attempts/.test(l)));
    // Said again at the end, as a list, where somebody returning to a finished
    // run will see it without scrolling back through the whole log.
    assert.ok(logged.some((l) => /5 of 7 blocks stayed in the source language/.test(l)));

    // THE BOOK EXISTS, and the five carry their original German — untouched,
    // because a block with no translation is a range the splice never visits.
    const chapter = readZipMap(new Uint8Array(fs.readFileSync(out))).get(CHAPTER_PATH)!.text();
    assert.match(chapter, /Ein <em>voelkischer<\/em> Staat war das Ziel/);
    assert.match(chapter, /Siehe dazu das Werk von gestern\./);
    // And the two the ratio let through carry the junk, because that is what
    // "write what the model hands back" means: "nope" against a two-word
    // heading is not distinguishable from a terse translation by length, and
    // length is the only thing the engine still judges.
    assert.match(chapter, /<\/span>nope<\/h1>/);
  } finally {
    clean();
  }
});

test('a book where nothing at all passed verification is refused outright', async () => {
  /*
   * The floor under the rule above. Leaving a stamp in German is a fact about
   * one block; "translating" a book into its own source text and stamping the
   * package `en` is a lie about the file, and it would look exactly like a
   * success to anyone reading the completion line.
   */
  const { epub, out, clean } = scratch();
  try {
    // Junk short enough to fail the ratio test on every block, markers dropped.
    const server = fakeOllama(() => 'x');
    await assert.rejects(
      translateEpub({ epubPath: epub, outPath: out, to: 'en', transport: server, log: quiet }),
      (error: Error) => {
        assert.ok(error instanceof TranslateError);
        assert.match(error.message, /not one of 7 blocks came back as a translation/);
        assert.match(error.message, /NOTHING WAS WRITTEN/);
        return true;
      },
    );
    assert.equal(fs.existsSync(out), false, 'no partial book is left behind');
  } finally {
    clean();
  }
});

test('a model that echoes everything is written out, and is the operator\'s problem', async () => {
  /*
   * THIS IS THE COST OF DROPPING THE ECHO TEST, written down so it is a choice
   * rather than a surprise.
   *
   * A model that hands every block back unchanged now produces a book that is
   * entirely its source text with `en` on the package. The engine does not
   * police that any more, and the reason it does not is the first real run: the
   * echo test refused three CORRECT translations ("Henkel & Cie. A.-G.,
   * Düsseldorf", whose English is itself) and killed a 96-block job to do it.
   * Two witnesses and a word-count floor were not enough to make it safe.
   *
   * The remedy for a lazy model is a different model or a better prompt — both
   * one flag away — not an engine that decides which German sentences are
   * allowed to resemble English ones. What the engine still guarantees is that
   * nothing is INVENTED and nothing is LOST: every word the model returned is
   * in the book, and the run says how many blocks it could not do at all.
   */
  const { epub, out, clean } = scratch();
  try {
    const server = fakeOllama((user) => user); // echoes everything, always
    const report = await translateEpub({
      epubPath: epub, outPath: out, to: 'en', transport: server, log: quiet,
    });

    assert.equal(report.keptUntranslated.length, 0, 'an echo is an answer, not a failure');
    assert.equal(report.retries, 0, 'and it costs nothing to accept');

    const chapter = readZipMap(new Uint8Array(fs.readFileSync(out))).get(CHAPTER_PATH)!.text();
    assert.match(chapter, /Ein <em>voelkischer<\/em> Staat war das Ziel/);
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

test('an answer identical to its source is written, not refused', () => {
  /*
   * THE ECHO TEST IS GONE, deliberately. It cost three correct translations on
   * the first real run — "Henkel & Cie. A.-G., Düsseldorf", whose English is
   * itself — and needed two witnesses and a word-count floor to survive at all.
   * A model that hands back the source is a model to replace or a prompt to
   * fix; it is not a run to kill, and the engine is no longer in the business
   * of deciding which German sentences are allowed to look like English ones.
   */
  const source = 'Ein sehr langer deutscher Satz mit vielen Woertern.';
  assert.equal(checkAnswer(source, source), null);
  assert.equal(checkAnswer('Berlin', 'Berlin'), null);
});

test('a code fence is peeled off the answer rather than costing the block', () => {
  // A fence is the model formatting its reply; the translation inside it is
  // usually perfect, and refusing it used to cost three attempts and the run.
  const source = 'Ein langer deutscher Satz mit vielen Woertern darin.';
  const fenced = '```\nA long German sentence with many words in it.\n```';
  assert.equal(checkAnswer(source, fenced), null);
  assert.equal(unfence(fenced), 'A long German sentence with many words in it.');
  assert.equal(unfence('```xml\n<p>Hallo</p>\n```'), '<p>Hallo</p>');

  // A fence in the MIDDLE is part of the text — a book about code has code in
  // it — and is left exactly where it is.
  const inside = 'Erst Text.\n```\ncode\n```\nDann mehr Text.';
  assert.equal(unfence(inside), inside);
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

test('the prompt gives the model an honest way out of a block with no language in it', () => {
  /*
   * The upstream half of the accession-number fix. A block arrives with no
   * context, and the front matter of a scanned book is full of things that are
   * not prose: a stamp, a shelf mark, OCR noise. Told nothing, qwen3 invented
   * 16,876 characters for a thirteen-character one. Told it may hand the block
   * back, it lands in the echo rule that already exists — kept, said out loud,
   * and counted — instead of burning three attempts to be refused.
   */
  const prompt = systemPrompt(null, readLanguage('en', '--to'), undefined);
  assert.match(prompt, /ONE block from a book/);
  assert.match(prompt, /library stamp, an accession number/);
  assert.match(prompt, /RETURN IT EXACTLY AS GIVEN/);
  assert.match(prompt, /never pad the answer/);
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
