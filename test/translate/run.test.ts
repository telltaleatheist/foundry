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
import {
  CHUNK_CHARS, checkAnswer, chunkAmbiguity, parseChunkAnswer, renderChunk, shapeRules,
  systemPrompt, translateEpub, unfence, TranslateError,
} from '../../src/translate/run.js';
import { bankKey, TranslateBankError, TranslationBank } from '../../src/translate/bank.js';
import { readLanguage } from '../../src/translate/languages.js';
import type { HttpResponse, Transport } from '../../src/translate/ollama.js';
import {
  CHAPTER_PATH, NAV_PATH, OPF_PATH, PICTURE,
  chapterWith, fakeOllama, foundryEpub, foundryEpubWith, plainEpub, shout, type FakeServer,
} from './fixture.js';

function scratch(book: Uint8Array = foundryEpub()): { epub: string; out: string; clean: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-translate-'));
  const epub = path.join(dir, 'Buch.epub');
  fs.writeFileSync(epub, book);
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

    /*
     * THIRTY BLOCKS IN SIXTEEN REQUESTS, and the gap between those two numbers
     * is the whole of this change. A block is still what gets spliced — every
     * `<li>`, every `<p>`, every `<td>` — and `report.blocks` still counts them,
     * so the number still means what it meant about the book. A chunk is what
     * gets SENT: the four-item list is one request, the three-paragraph quote is
     * one request, the nine-cell table is one request.
     *
     * The `<ul>` and the `<blockquote>` are stamped too and are still not blocks
     * themselves — the things inside them are.
     */
    assert.equal(report.blocks, 30);
    assert.equal(report.chunks, 16);
    assert.equal(server.asked.length, 16, 'one request per chunk, and no retries');
    assert.equal(report.documents, 1);
    assert.equal(report.retries, 0);
    // The empty `<td>` in the last row: no words, so nothing was asked for it,
    // but it still occupied its cell in the payload.
    assert.equal(report.wordless, 1);
    // A table's WORDS are translated now. Only the two categories with no words
    // in them are skipped. See the header of `blocks.ts` for why that reversed.
    assert.deepEqual([...report.skipped].sort(), [['formula', 1], ['picture', 1]]);

    const written = readZipMap(new Uint8Array(fs.readFileSync(out)));
    const chapter = written.get(CHAPTER_PATH)!.text();

    // Prose replaced, inline markup identical, page provenance untouched.
    assert.match(chapter, /<em>VOELKISCHER<\/em>/);
    assert.match(chapter, /EIN <em>VOELKISCHER<\/em> STAAT WAR DAS ZIEL<a class="noteref" epub:type="noteref" role="doc-noteref" href="#fn1"><sup>1<\/sup><\/a> DER GANZEN BEWEGUNG\./);
    assert.match(chapter, /<span epub:type="pagebreak" role="doc-pagebreak" id="pb-7" data-bf-page="7" aria-label="7"><\/span>DER STAAT/);
    assert.match(chapter, /data-bf-page="9" data-bf-cat="caption">ABBILDUNG DES GROSSEN GEBAEUDES\./);
    assert.match(chapter, /<aside class="footnote" epub:type="footnote" role="doc-footnote" id="fn1"[^>]*><sup>1<\/sup> SIEHE DAZU DAS WERK VON GESTERN\./);

    // THE TABLE. Every cell holds its own translation and nothing else about the
    // grid moved: the `<th>`s are still `<th>`s, the empty cell is still empty,
    // and not one pipe from the wire format reached the book.
    assert.match(chapter, /<div class="tablewrap" data-bf-page="9" data-bf-cat="table"><table><tr><td>JAHR<\/td><td>ZAHL<\/td><\/tr><\/table><\/div>/);
    assert.match(chapter, /<tr><th>JAHR<\/th><th>MITGLIEDER<\/th><th>BEMERKUNG<\/th><\/tr>/);
    assert.match(chapter, /<tr><td>1931<\/td><td>1\.200<\/td><td>DER ERSTE BERICHT<\/td><\/tr>/);
    assert.match(chapter, /<tr><td>1932<\/td><td>3\.400<\/td><td><\/td><\/tr>/);
    assert.doesNotMatch(chapter, /\| MITGLIEDER/);

    // The two skipped categories are byte-for-byte what they were.
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
    // The first request for every CHUNK comes back empty; the retry works. An
    // empty answer fails a single block on its length and fails a group on its
    // structure — nothing can be read back out of nothing — so every chunk pays
    // exactly one retry, groups included.
    const server = fakeOllama((user, attempt) => (attempt === 1 ? '' : shout(user)));
    const report = await translateEpub({
      epubPath: epub, outPath: out, to: 'en', transport: server, log: quiet,
    });
    assert.equal(report.retries, 16, 'one rejected answer per chunk, not per block');
    assert.equal(server.asked.length, 32);
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
       * THIRTEEN of the thirty, and the seventeen that got through are the
       * honest limit of a ratio test. "nope" is four characters against "Die
       * Ordnung"'s eleven and "Der Staat"'s nine — over a quarter of each — so
       * a two-word heading is short enough that a junk answer is not
       * distinguishable from a terse translation by length alone, and so is a
       * table cell holding a year. "Der Staat" used to be refused, and for a
       * reason that was an ACCIDENT: its only marker was its leading pagebreak
       * span, and the junk answer dropped it. The same accident refused three
       * correct translations of "Kirchenwahlen 1932" on the first real run — a
       * heading that is mostly token sheds the token — which is why edge
       * atomics no longer travel to the model at all (`markers.ts`).
       */
      assert.equal(report.keptUntranslated.length, 13);
      // Named: the document, the block, its category, its page, its words.
      assert.match(named, /block 2 \(text, page 7\)[^\n]*under 25%/);
      assert.match(named, /block 5 \(quote, page 8\)[^\n]*under 25%/);
      assert.match(named, /block 30 \(footnote, page 9\)/);
      // A cell of a table is named exactly like any other block, page and all.
      assert.match(named, /block 22 \(table, page 12\)[^\n]*"Der erste Bericht/);
      assert.doesNotMatch(named, /block 1 /);
      assert.doesNotMatch(named, /block 3 /);
    }

    assert.equal(server.asked.length, 67);
    assert.ok(logged.some((l) => /block 2 LEFT IN THE SOURCE LANGUAGE after 3 attempts/.test(l)));
    /*
     * A GROUP WHOSE ANSWER WILL NOT COME APART FALLS BACK BY NAME. "nope" is one
     * line where four were sent, so the list cannot be read back at all — and
     * rather than guess which item it was, the chunk is asked again twice and
     * then asked for one block at a time. Three of the thirteen refusals above
     * are items of that list, which is what "one block at a time" then costs.
     */
    assert.ok(logged.some((l) => /chunk 9 \(list, 4 parts\) FELL BACK to one request per block/.test(l)));
    assert.ok(logged.some((l) => /chunk 10 \(quote, 3 parts\) FELL BACK/.test(l)));
    assert.ok(logged.some((l) => /chunk 11 \(table, 9 parts\) FELL BACK/.test(l)));
    // Said again at the end, as a list, where somebody returning to a finished
    // run will see it without scrolling back through the whole log.
    assert.ok(logged.some((l) => /13 of 30 blocks stayed in the source language/.test(l)));

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
   *
   * Three paragraphs and nothing else, rather than the whole fixture. The
   * fixture now holds thirty blocks, a dozen of which are one-word table cells
   * and short headings that a one-character junk answer PASSES on length — so
   * against it "nothing passed" is not a state a lazy model can reach, and the
   * run would trip the twenty-five-refusal guard on the way instead. The rule
   * being pinned here is about the floor, not about the fixture.
   */
  const { epub, out, clean } = scratch(foundryEpubWith(chapterWith(
    '<p data-bf-page="1" data-bf-cat="text">Der erste lange Absatz dieses Buches steht hier.</p>\n'
    + '<p data-bf-page="1" data-bf-cat="text">Der zweite lange Absatz dieses Buches steht hier.</p>\n'
    + '<p data-bf-page="2" data-bf-cat="text">Der dritte lange Absatz dieses Buches steht hier.</p>',
  )));
  try {
    // Junk short enough to fail the ratio test on every block, markers dropped.
    const server = fakeOllama(() => 'x');
    await assert.rejects(
      translateEpub({ epubPath: epub, outPath: out, to: 'en', transport: server, log: quiet }),
      (error: Error) => {
        assert.ok(error instanceof TranslateError);
        assert.match(error.message, /not one of 3 blocks came back as a translation/);
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
  /*
   * ONE REQUEST IN FLIGHT, so the count is exact. The rule being pinned is that
   * a server failure is not retried — a machine that is off will still be off
   * on the second attempt, and proving it twice costs a minute of somebody's
   * evening. With several requests in flight the number of calls is whatever
   * was already out when the first one failed, which is a different fact and is
   * pinned by its own test below.
   */
  const { epub, out, clean } = scratch();
  try {
    const server = fakeOllama();
    let calls = 0;
    /*
     * THE UNLOAD IS NOT AN ATTEMPT, and is counted separately for that reason.
     * Every run now ends by asking the server to drop the weights — see
     * `translateEpub` — and on the failing path that request is the whole point:
     * a run that died at block 12 must not leave the model pinned to the card
     * for five minutes on behalf of work that produced nothing. It carries
     * `keep_alive` and no messages, so it is told apart by its body rather than
     * by its position in the sequence.
     */
    let unloaded = 0;
    const dying = {
      ...server,
      post: async (url: string, body: string) => {
        if (body.includes('"keep_alive"')) { unloaded += 1; return { status: 200, body: '{}' }; }
        calls += 1;
        if (calls > 2) return { status: 500, body: 'model runner has crashed' };
        return server.post(url, body);
      },
    };
    await assert.rejects(
      translateEpub({
        epubPath: epub, outPath: out, to: 'en', transport: dying, concurrency: 1, log: quiet,
      }),
      /answered 500/,
    );
    assert.equal(calls, 3, 'it stops at the first server failure, it does not retry it');
    assert.equal(unloaded, 1, 'a failed run still gives the card back');
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

// ── chunks: what travels together, and what happens when it cannot ───────────

/** Every payload the run sent, so a test can say which request carried what. */
function askedFor(asked: readonly string[], needle: string): string | undefined {
  return asked.find((a) => a.includes(needle));
}

test('a list that fits the budget is ONE request, spliced back per <li>', async () => {
  /*
   * The quality argument, mechanically. An item translated alone has lost the
   * list: the parallel grammar that makes six items read as one sentence is a
   * property of the six together, and a model shown one item at a time has no
   * way to keep it. So the items go in one request as numbered lines — and the
   * ANSWER still lands one item per `<li>`, because each part kept its own
   * source range the whole way.
   */
  const { epub, out, clean } = scratch();
  try {
    const server = fakeOllama();
    await translateEpub({ epubPath: epub, outPath: out, to: 'en', transport: server, log: quiet });

    const payload = askedFor(server.asked, 'Aufhebung der Vertraege')!;
    assert.equal(
      payload,
      '1. Erstens die Aufhebung der Vertraege.\n'
      + '2. Zweitens die ⟦e1⟧Gleichschaltung⟦/e1⟧ der Laender.\n'
      + '3. Drittens die Ordnung des Berufsstandes.\n'
      + '4. Viertens die ⟦e2⟧Frage⟦/e2⟧ des Bodens.',
    );
    // All four items came in that one request and nowhere else.
    assert.equal(server.asked.filter((a) => a.includes('Berufsstandes')).length, 1);
    // NO MARKUP TRAVELLED: not the `<ul>`, not the `<li>`, not a stamp.
    assert.doesNotMatch(payload, /<li|<ul|data-bf-/);

    const chapter = readZipMap(new Uint8Array(fs.readFileSync(out))).get(CHAPTER_PATH)!.text();
    // Each line back into its own element, in order, with the numbering gone.
    assert.match(chapter, /<li data-bf-page="10" data-bf-cat="list-item">ERSTENS DIE AUFHEBUNG DER VERTRAEGE\.<\/li>/);
    assert.match(chapter, /<li data-bf-page="10" data-bf-cat="list-item">DRITTENS DIE ORDNUNG DES BERUFSSTANDES\.<\/li>/);
    assert.doesNotMatch(chapter, /<li[^>]*>\d+\. /);
  } finally {
    clean();
  }
});

test('a quotation goes as its paragraphs and comes back as its paragraphs', async () => {
  const { epub, out, clean } = scratch();
  try {
    const server = fakeOllama();
    await translateEpub({ epubPath: epub, outPath: out, to: 'en', transport: server, log: quiet });

    assert.equal(
      askedFor(server.asked, 'Der erste Absatz'),
      '1. Der erste Absatz des langen Zitates.\n'
      + '2. Der zweite Absatz des langen Zitates.\n'
      + '3. Der dritte Absatz des langen Zitates.',
    );
    const chapter = readZipMap(new Uint8Array(fs.readFileSync(out))).get(CHAPTER_PATH)!.text();
    assert.match(
      chapter,
      /<blockquote data-bf-page="11" data-bf-cat="quote"><p data-bf-page="11" data-bf-cat="quote">DER ERSTE ABSATZ DES LANGEN ZITATES\.<\/p><p data-bf-page="11" data-bf-cat="quote">DER ZWEITE ABSATZ DES LANGEN ZITATES\.<\/p>/,
    );
  } finally {
    clean();
  }
});

test('inline markers inside list items are unique across the whole request', async () => {
  /*
   * The one thing grouping could have broken quietly. Two items that both said
   * ⟦e1⟧ would be two different <em>s wearing one name, and an item that moved
   * its marker into the neighbouring line would be restored with the
   * neighbour's markup and no complaint from anything — the emphasis would land
   * on the wrong word, in a book that renders perfectly.
   */
  const { epub, out, clean } = scratch();
  try {
    const server = fakeOllama();
    const report = await translateEpub({
      epubPath: epub, outPath: out, to: 'en', transport: server, log: quiet,
    });
    const payload = askedFor(server.asked, 'Gleichschaltung')!;
    assert.match(payload, /⟦e1⟧Gleichschaltung⟦\/e1⟧/);
    assert.match(payload, /⟦e2⟧Frage⟦\/e2⟧/, 'the second item keeps counting, it does not restart');
    assert.equal(report.markerNotes, 0);

    const chapter = readZipMap(new Uint8Array(fs.readFileSync(out))).get(CHAPTER_PATH)!.text();
    assert.match(chapter, /ZWEITENS DIE <em>GLEICHSCHALTUNG<\/em> DER LAENDER\./);
    assert.match(chapter, /VIERTENS DIE <em>FRAGE<\/em> DES BODENS\./);
  } finally {
    clean();
  }
});

test('a list over the budget is cut into runs of consecutive items', async () => {
  /*
   * The budget cuts BETWEEN items and never inside one — a block is never
   * split. What it buys is that a structural failure costs a page rather than a
   * chapter; what it costs is that item 9 no longer sees item 10. Consecutive
   * and in order, because the neighbours an item's grammar is parallel to are
   * its neighbours.
   */
  const item = 'Ein ziemlich langer Satz, der als Punkt in einer sehr langen Liste steht und weitergeht';
  const items = Array.from({ length: 60 }, (_, i) => `${item} — Nummer ${i + 1}.`);
  const body = `<ul data-bf-page="4" data-bf-cat="list-item">\n`
    + items.map((t) => `  <li data-bf-page="4" data-bf-cat="list-item">${t}</li>`).join('\n')
    + '\n</ul>';
  const { epub, out, clean } = scratch(foundryEpubWith(chapterWith(body)));
  try {
    const server = fakeOllama();
    const report = await translateEpub({
      epubPath: epub, outPath: out, to: 'en', transport: server, log: quiet,
    });

    assert.equal(report.blocks, 60);
    assert.ok(report.chunks > 1 && report.chunks < 60, `cut into runs, not into 60: ${report.chunks}`);
    assert.equal(server.asked.length, report.chunks);

    // Every request is under the budget, numbered from 1, and holds a run of
    // CONSECUTIVE items — the numbers in the source text prove the order.
    let seen = 0;
    for (const payload of server.asked) {
      const lines = payload.split('\n');
      assert.ok(payload.length <= CHUNK_CHARS + lines[0]!.length, 'a chunk stays near the budget');
      for (const [i, line] of lines.entries()) {
        assert.match(line, new RegExp(`^${i + 1}\\. `));
        assert.match(line, new RegExp(`Nummer ${seen + i + 1}\\.$`));
      }
      seen += lines.length;
    }
    assert.equal(seen, 60, 'every item travelled exactly once');

    // And all sixty are in the book, each in its own <li>.
    const chapter = readZipMap(new Uint8Array(fs.readFileSync(out))).get(CHAPTER_PATH)!.text();
    for (const n of [1, 17, 42, 60]) {
      assert.match(chapter, new RegExp(`<li data-bf-page="4" data-bf-cat="list-item">EIN ZIEMLICH[^<]*NUMMER ${n}\\.</li>`));
    }
  } finally {
    clean();
  }
});

test('a table split by the budget carries its header row in the PROMPT, not the payload', async () => {
  const cell = 'Eine ziemlich lange Bemerkung zu dieser Zeile der Tabelle, die weitergeht';
  const rows = Array.from(
    { length: 40 },
    (_, i) => `<tr><td>19${String(i).padStart(2, '0')}</td><td>${cell} ${i + 1}</td></tr>`,
  ).join('');
  const body = '<div class="tablewrap" data-bf-page="5" data-bf-cat="table"><table>'
    + '<tr><th>Jahr</th><th>Bemerkung</th></tr>' + rows + '</table></div>';
  const { epub, out, clean } = scratch(foundryEpubWith(chapterWith(body)));
  try {
    const server = fakeOllama();
    const report = await translateEpub({
      epubPath: epub, outPath: out, to: 'en', transport: server, log: quiet,
    });

    assert.equal(report.blocks, 82, '41 rows of two cells');
    assert.ok(report.chunks > 1, 'the table did not fit in one request');
    // Every row is whole in exactly one request: the budget cuts between rows.
    for (const payload of server.asked) {
      for (const line of payload.split('\n')) {
        assert.equal(line.split('|').length, 2, `a whole row: ${line}`);
      }
    }
    const chapter = readZipMap(new Uint8Array(fs.readFileSync(out))).get(CHAPTER_PATH)!.text();
    assert.match(chapter, /<tr><th>JAHR<\/th><th>BEMERKUNG<\/th><\/tr>/);
    assert.match(chapter, /<tr><td>1939<\/td><td>EINE ZIEMLICH[^<]*40<\/td><\/tr>/);
  } finally {
    clean();
  }
});

test('the header row reaches a later chunk as context and is told not to come back', () => {
  const en = readLanguage('en', '--to');
  const first = systemPrompt(null, en, undefined, { paired: false, atomic: false }, {
    kind: 'table', rows: 3, header: null,
  });
  assert.match(first, /a table of 3 rows/);
  assert.match(first, /cells are separated by \|/);
  assert.doesNotMatch(first, /header row is/, 'the first chunk HAS the header — it is payload there');

  const later = systemPrompt(null, en, undefined, { paired: false, atomic: false }, {
    kind: 'table', rows: 2, header: 'Jahr | Mitglieder',
  });
  assert.match(later, /This table's header row is: Jahr \| Mitglieder/);
  assert.match(later, /do not translate it and do not return it/);

  // And the numbered-lines shape says which of the two things it is.
  assert.match(shapeRules({ kind: 'lines', count: 6, of: 'list' }).join('\n'), /6 numbered lines, which are consecutive items of one list/);
  assert.match(shapeRules({ kind: 'lines', count: 2, of: 'quote' }).join('\n'), /consecutive paragraphs of one quotation/);
  // A lone block is told nothing about shape at all: the wire format for it is
  // exactly what it always was.
  assert.deepEqual(shapeRules({ kind: 'single' }), []);
  assert.match(systemPrompt(null, en, undefined), /Keep the source's paragraph as one paragraph/);
  assert.match(
    systemPrompt(null, en, undefined, { paired: false, atomic: false }, { kind: 'lines', count: 2, of: 'list' }),
    /Keep each line as one line/,
  );
});

test('an answer with the wrong number of lines falls back to one request per block', async () => {
  /*
   * THE FAILURE THIS WHOLE DESIGN IS BUILT AROUND. Four items go out, three
   * lines come back: there is no way to know which item lost its translation,
   * and every guess — take the first three, match by length, drop the shortest
   * — is a guess that sometimes puts item 4's sentence in item 3's `<li>`. That
   * book renders perfectly and is wrong where nobody can see it. So nothing is
   * guessed: the chunk is asked again, twice, and then every item is asked for
   * on its own.
   */
  const { epub, out, clean } = scratch();
  try {
    const logged: string[] = [];
    const server = fakeOllama((user) => {
      const lines = user.split('\n');
      // Only the four-item list is sabotaged, and only by losing a line.
      if (lines.length !== 4 || !user.includes('Vertraege')) return shout(user);
      return shout(lines.slice(0, 3).join('\n'));
    });
    const report = await translateEpub({
      epubPath: epub, outPath: out, to: 'en', transport: server, log: (m) => logged.push(m),
    });

    assert.equal(report.retries, 3, 'the chunk was asked three times before it gave up on the shape');
    assert.equal(report.chunks, 16, 'the plan is unchanged — the fallback is a fact about the run');
    assert.equal(server.asked.length, 16 + 2 + 4, 'two extra chunk attempts, then one per item');
    assert.equal(report.keptUntranslated.length, 0, 'and every item was still translated');

    assert.ok(logged.some((l) => /chunk 9 \(list, 4 parts\) FELL BACK to one request per block after 3 attempts — the answer has 3 line\(s\) where the 4 items sent need 4/.test(l)));
    // Asked one at a time, so the payloads are bare items with no numbering.
    assert.ok(server.asked.includes('Drittens die Ordnung des Berufsstandes.'));

    const chapter = readZipMap(new Uint8Array(fs.readFileSync(out))).get(CHAPTER_PATH)!.text();
    assert.match(chapter, /<li data-bf-page="10" data-bf-cat="list-item">VIERTENS DIE <em>FRAGE<\/em> DES BODENS\.<\/li>/);
  } finally {
    clean();
  }
});

test('a cell holding a "|" makes the whole table go one cell per request, by name', async () => {
  /*
   * The pipe is the cell boundary, and there is no escape for it that would not
   * teach the model an escape it then uses somewhere else. So the table is not
   * rendered as rows at all — it goes as it went before grouping existed, and
   * the log says which table and why.
   */
  const { epub, out, clean } = scratch();
  try {
    const logged: string[] = [];
    const server = fakeOllama();
    await translateEpub({
      epubPath: epub, outPath: out, to: 'en', transport: server, log: (m) => logged.push(m),
    });

    assert.ok(logged.some((l) => /the table at EPUB\/text\/c0001\.xhtml block 26 is sent one block per request rather than whole — cell 1 contains a "\|"/.test(l)));
    // Each of its four cells was its own request, carrying only its own words.
    assert.ok(server.asked.includes('Nord | Sued'));
    assert.ok(server.asked.includes('Zahlen'));
    assert.ok(server.asked.includes('Ost'));

    const chapter = readZipMap(new Uint8Array(fs.readFileSync(out))).get(CHAPTER_PATH)!.text();
    assert.match(chapter, /<tr><td>NORD \| SUED<\/td><td>ZAHLEN<\/td><\/tr><tr><td>OST<\/td><td>WEST<\/td><\/tr>/);
  } finally {
    clean();
  }
});

test('one bad part of a group stays in the source language and the rest do not', async () => {
  /*
   * The per-part guard, which is the reason a group is not all-or-nothing on
   * its WORDS. The answer parses — four lines for four items — so the shape is
   * fine and three of the items are correct; item 3 came back as a stub. It is
   * re-asked ON ITS OWN, three times, and then left exactly as the book wrote
   * it. Re-asking the whole chunk would have re-translated three items that
   * were already right, which is the cost `ollama.ts`'s header measured.
   */
  const { epub, out, clean } = scratch();
  try {
    const logged: string[] = [];
    const server = fakeOllama((user) => {
      if (user === 'Drittens die Ordnung des Berufsstandes.') return 'no';
      const lines = user.split('\n');
      if (lines.length !== 4 || !user.includes('Vertraege')) return shout(user);
      return lines.map((line, i) => (i === 2 ? '3. no' : shout(line))).join('\n');
    });
    const report = await translateEpub({
      epubPath: epub, outPath: out, to: 'en', transport: server, log: (m) => logged.push(m),
    });

    assert.equal(report.keptUntranslated.length, 1);
    assert.match(report.keptUntranslated[0]!, /block 12 \(list-item, page 10\)[^\n]*Drittens die Ordnung/);
    assert.equal(server.asked.length, 16 + 3, 'the chunk was right first time; only item 3 was re-asked');
    assert.ok(logged.some((l) => /block 12 came back inside chunk 9 — .*under 25%.*; asking for it on its own/.test(l)));
    assert.ok(logged.some((l) => /block 12 LEFT IN THE SOURCE LANGUAGE after 3 attempts/.test(l)));

    const chapter = readZipMap(new Uint8Array(fs.readFileSync(out))).get(CHAPTER_PATH)!.text();
    // The one that failed keeps its German; its neighbours are translated.
    assert.match(chapter, /<li data-bf-page="10" data-bf-cat="list-item">Drittens die Ordnung des Berufsstandes\.<\/li>/);
    assert.match(chapter, /<li data-bf-page="10" data-bf-cat="list-item">ZWEITENS DIE <em>GLEICHSCHALTUNG<\/em> DER LAENDER\.<\/li>/);
    assert.match(chapter, /<li data-bf-page="10" data-bf-cat="list-item">VIERTENS DIE <em>FRAGE<\/em> DES BODENS\.<\/li>/);
  } finally {
    clean();
  }
});

test('a table whose cells hold markup with no rule is left in German AND NAMED', async () => {
  /*
   * A `<td>` is the vision model's own HTML, not foundry's markup, and
   * `markers.ts` refuses an element it has no rule for — correctly, since
   * passing one through as atomic would silently leave the prose inside it
   * untranslated. But a `<p>` in a cell must not cost somebody four hours of
   * GPU and a whole book, which is the lesson of the accession number on the
   * flyleaf (52e3625).
   *
   * So the table drops out of the plan. What makes that acceptable rather than
   * a quiet degradation is that it is SAID: a log line naming the table and
   * why, and an entry in `keptUntranslated`, which is what puts it on the
   * completion line beside every other block that came out in the source
   * language. A count with no name behind it would be exactly the undetectable
   * outcome this command exists to refuse.
   */
  const body = '<p data-bf-page="1" data-bf-cat="text">Ein ganz gewoehnlicher Absatz steht hier.</p>\n'
    + '<div class="tablewrap" data-bf-page="2" data-bf-cat="table"><table>'
    + '<tr><td><p>Jahr</p></td><td>Zahl</td></tr></table></div>';
  const { epub, out, clean } = scratch(foundryEpubWith(chapterWith(body)));
  try {
    const logged: string[] = [];
    const server = fakeOllama();
    const report = await translateEpub({
      epubPath: epub, outPath: out, to: 'en', transport: server, log: (m) => logged.push(m),
    });

    assert.equal(report.blocks, 1, 'the table never became blocks at all');
    assert.equal(server.asked.length, 1, 'and not one of its cells was sent anywhere');
    assert.deepEqual([...report.skipped], [['table', 1]]);

    // NAMED, twice: in the log at the moment it happens, and in the list that
    // reaches the completion line.
    assert.equal(report.keptUntranslated.length, 1);
    assert.match(report.keptUntranslated[0]!, /table on page 2 \(2 cells\)/);
    assert.match(report.keptUntranslated[0]!, /<p> is an element this stage has no rule for/);
    assert.ok(logged.some((l) => /table on page 2 \(2 cells\) LEFT IN THE SOURCE LANGUAGE — its cells hold markup this stage has no rule for/.test(l)));

    // The book exists, the paragraph is translated, the table is untouched.
    const chapter = readZipMap(new Uint8Array(fs.readFileSync(out))).get(CHAPTER_PATH)!.text();
    assert.match(chapter, /EIN GANZ GEWOEHNLICHER ABSATZ STEHT HIER\./);
    assert.match(chapter, /<tr><td><p>Jahr<\/p><\/td><td>Zahl<\/td><\/tr>/);
  } finally {
    clean();
  }
});

test('a list this stage cannot take apart is sent one item at a time, by name', async () => {
  /*
   * A nested list. The outer `<ul>`'s items are not leaves, and treating them
   * as parts would send the inner list's text twice — once inside its item's
   * line and once as its own block — and then splice two answers into
   * overlapping ranges. Rather than model nesting, the group is not formed, and
   * the run says so before it starts: this is a WORSE translation (the items
   * lose each other) and it must not be a silent one.
   */
  const body = '<ul data-bf-page="3" data-bf-cat="list-item">\n'
    + '  <li data-bf-page="3" data-bf-cat="list-item">Der aeussere Punkt steht hier oben.\n'
    + '    <ul data-bf-page="3" data-bf-cat="list-item">\n'
    + '      <li data-bf-page="3" data-bf-cat="list-item">Der innere Punkt steht hier unten.</li>\n'
    + '    </ul>\n'
    + '  </li>\n'
    + '</ul>';
  const { epub, out, clean } = scratch(foundryEpubWith(chapterWith(body)));
  try {
    const logged: string[] = [];
    const server = fakeOllama();
    const report = await translateEpub({
      epubPath: epub, outPath: out, to: 'en', transport: server, log: (m) => logged.push(m),
    });

    // The innermost stamp still wins, exactly as it did before grouping: the
    // inner item is a block, and so is the outer item's own text.
    assert.equal(report.blocks, 1);
    assert.equal(report.chunks, 1);
    assert.ok(logged.some((l) => /the list on page 3 holds something other than plain items — its blocks are translated one at a time/.test(l)));
    assert.deepEqual(server.asked, ['Der innere Punkt steht hier unten.']);
  } finally {
    clean();
  }
});

// ── the wire format, one rule at a time ──────────────────────────────────────

test('a chunk renders as numbered lines or as pipe rows, and a lone block as itself', () => {
  assert.equal(renderChunk('single', ['Ein Satz.'], []), 'Ein Satz.');
  assert.equal(renderChunk('lines', ['Eins.', 'Zwei.'], []), '1. Eins.\n2. Zwei.');
  assert.equal(
    renderChunk('table', ['Jahr', 'Zahl', '1931', '1.200'], [2, 2]),
    'Jahr | Zahl\n1931 | 1.200',
  );
});

test('a good answer comes apart into exactly the parts that were sent', () => {
  assert.deepEqual(parseChunkAnswer('lines', 2, [], '1. One.\n2. Two.'), { parts: ['One.', 'Two.'] });
  // Blank lines between the items are the model breathing, not a part.
  assert.deepEqual(parseChunkAnswer('lines', 2, [], '1. One.\n\n2. Two.'), { parts: ['One.', 'Two.'] });
  // `1)` and `1:` are the same claim as `1.`.
  assert.deepEqual(parseChunkAnswer('lines', 2, [], '1) One.\n2: Two.'), { parts: ['One.', 'Two.'] });
  assert.deepEqual(
    parseChunkAnswer('table', 4, [2, 2], 'Year | Number\n1931 | 1,200'),
    { parts: ['Year', 'Number', '1931', '1,200'] },
  );
  // The Markdown habit: outer pipes, which cannot mean anything else.
  assert.deepEqual(
    parseChunkAnswer('table', 2, [2], '| Year | Number |'),
    { parts: ['Year', 'Number'] },
  );
  // An empty cell stays an empty cell rather than closing the gap.
  assert.deepEqual(parseChunkAnswer('table', 3, [3], '1932 | 3,400 |'), { parts: ['1932', '3,400', ''] });
});

test('every way an answer can fail to line up is a complaint, never a guess', () => {
  const short = parseChunkAnswer('lines', 3, [], '1. One.\n2. Two.');
  assert.match((short as { complaint: string }).complaint, /2 line\(s\) where the 3 items sent need 3/);

  const unnumbered = parseChunkAnswer('lines', 2, [], 'One.\nTwo.');
  assert.match((unnumbered as { complaint: string }).complaint, /line 1 of the answer is not numbered/);

  const renumbered = parseChunkAnswer('lines', 2, [], '1. One.\n3. Two.');
  assert.match((renumbered as { complaint: string }).complaint, /numbered 3 — the numbers are how each/);

  const rows = parseChunkAnswer('table', 4, [2, 2], 'Year | Number');
  assert.match((rows as { complaint: string }).complaint, /1 row\(s\) where the table sent 2/);

  const cells = parseChunkAnswer('table', 4, [2, 2], 'Year | Number | Note\n1931 | 1,200');
  assert.match((cells as { complaint: string }).complaint, /row 1 of the answer has 3 cell\(s\) where that row has 2/);

  // A preamble is an extra line, and an extra line is a complaint: there is no
  // reading under which "Here is the translation:" is item 1.
  const chatty = parseChunkAnswer('lines', 2, [], 'Here is the translation:\n1. One.\n2. Two.');
  assert.ok('complaint' in chatty);
});

test('text that would break the rendering is refused before anything is sent', () => {
  assert.equal(chunkAmbiguity('lines', ['Eins.', 'Zwei.'], []), null);
  assert.match(chunkAmbiguity('lines', ['Eins.', '1. Zwei.'], [])!, /item 2 begins "1\. Zwei/);
  assert.match(chunkAmbiguity('lines', ['Eins.\nnoch mehr'], [])!, /part 1 contains a line break/);
  assert.match(chunkAmbiguity('table', ['a | b', 'c'], [2])!, /cell 1 contains a "\|"/);
  /*
   * A row that renders to NOTHING has no line to come back on: blank lines are
   * dropped when the answer is read, so the row could not be counted even from
   * a perfect answer. That is only a one-cell row, and only when the cell is
   * empty — two empty cells still render as `|`, which is a line, and parses
   * back into two empty cells exactly as it should.
   */
  assert.match(chunkAmbiguity('table', ['x', ''], [1, 1])!, /row 2 is entirely empty/);
  assert.equal(chunkAmbiguity('table', ['x', 'y', '', ''], [2, 2]), null);
  assert.deepEqual(parseChunkAnswer('table', 4, [2, 2], 'x | y\n|'), { parts: ['x', 'y', '', ''] });
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

// ── the bank: what a killed run leaves behind, and what a second run pays ─────

/** A book of standalone paragraphs — one block, one chunk, one request each. */
function paragraphs(...texts: readonly string[]): Uint8Array {
  return foundryEpubWith(chapterWith(
    texts.map((t, i) => `<p data-bf-page="${i + 1}" data-bf-cat="text">${t}</p>`).join('\n'),
  ));
}

const P1 = 'Der erste lange Absatz dieses Buches steht hier.';
const P2 = 'Der zweite lange Absatz dieses Buches steht hier.';
const P3 = 'Der dritte lange Absatz dieses Buches steht hier.';

/** The bank beside a scratch book, and the directory both live in. */
function bankIn(out: string): { dir: string; bankPath: string } {
  const dir = path.dirname(out);
  return { dir, bankPath: path.join(dir, 'answers.jsonl') };
}

function bankLines(bankPath: string): { key: string; source: string; answer: string }[] {
  return fs.readFileSync(bankPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

test('a killed run leaves every answer it had accepted in the bank, and the next one pays for the rest', async () => {
  /*
   * THE MEASUREMENT THIS FEATURE EXISTS FOR. 152 blocks of a 456-block book
   * were translated, the run was killed, and NOTHING was on disk — the EPUB is
   * written at the very end, so four hours of GPU came to nothing and the
   * re-run started at block 1.
   *
   * One request in flight, so "the answers accepted before the failure" is an
   * exact number rather than whatever happened to be out.
   */
  const { epub, out, clean } = scratch(paragraphs(P1, P2, P3, 'Der vierte lange Absatz steht hier.'));
  const { bankPath } = bankIn(out);
  try {
    const server = fakeOllama();
    let calls = 0;
    const dying: Transport = {
      ...server,
      post: async (url: string, body: string): Promise<HttpResponse> => {
        calls += 1;
        if (calls > 2) return { status: 500, body: 'model runner has crashed' };
        return server.post(url, body);
      },
    };
    await assert.rejects(
      translateEpub({
        epubPath: epub, outPath: out, to: 'en', transport: dying, bankPath, concurrency: 1, log: quiet,
      }),
      /answered 500/,
    );
    assert.equal(fs.existsSync(out), false, 'no book — but the answers survived it');

    // BANKED AS THEY LANDED, not at the end: two answers, each with the source
    // it answers, so the file is a thing a person can read.
    const lines = bankLines(bankPath);
    assert.equal(lines.length, 2);
    assert.equal(lines[0]!.source, P1);
    assert.equal(lines[0]!.answer, shout(P1));
    assert.equal(lines[1]!.source, P2);

    // The run that follows asks for the two that are missing and nothing else.
    const second = fakeOllama();
    const report = await translateEpub({
      epubPath: epub, outPath: out, to: 'en', transport: second, bankPath, log: quiet,
    });
    assert.equal(second.asked.length, 2, 'the two blocks that never landed, and no others');
    assert.equal(report.fromBank, 2);
    assert.equal(report.answered, 2);
    assert.equal(bankLines(bankPath).length, 4);

    const chapter = readZipMap(new Uint8Array(fs.readFileSync(out))).get(CHAPTER_PATH)!.text();
    assert.match(chapter, new RegExp(shout(P1)));
    assert.match(chapter, new RegExp(shout(P3)));
  } finally {
    clean();
  }
});

test('a second run over the same book with the same bank asks for NOTHING', async () => {
  /*
   * The whole promise, over the real fixture: thirty blocks, sixteen requests,
   * every shape the translator has — a list, a quotation, two tables, a table
   * that goes one cell per request. The second run sends not one request and
   * writes the same bytes.
   */
  const { epub, out, clean } = scratch();
  const { bankPath } = bankIn(out);
  try {
    const first = fakeOllama();
    const one = await translateEpub({
      epubPath: epub, outPath: out, to: 'en', transport: first, bankPath, log: quiet,
    });
    assert.equal(first.asked.length, 16);
    /*
     * TWENTY-NINE ASKABLE BLOCKS, TWENTY-EIGHT QUESTIONS. The `<td>Jahr</td>`
     * of the one-cell table and the `<th>Jahr</th>` of the three-column table
     * are the same words, so they are the same question, and the second one is
     * answered out of the bank on the FIRST run — the duplicate rule, visible
     * in the fixture rather than in a test built to show it.
     */
    assert.equal(one.answered, 28);
    assert.equal(one.fromBank, 1);
    const before = fs.readFileSync(out);

    fs.rmSync(out);
    const second = fakeOllama();
    const logged: string[] = [];
    const two = await translateEpub({
      epubPath: epub, outPath: out, to: 'en', transport: second, bankPath, log: (m) => logged.push(m),
    });

    assert.equal(second.asked.length, 0, 'not one request');
    assert.equal(two.fromBank, 29);
    assert.equal(two.answered, 0);
    assert.equal(two.retries, 0);
    // The zip writer is deterministic, so "the same book" is the same bytes.
    assert.deepEqual([...fs.readFileSync(out)], [...before]);
    // And the run SAYS it resumed, before it does anything, and says what the
    // bank saved when it is finished.
    // Twenty-eight ANSWERS for twenty-nine blocks: the bank counts questions.
    assert.ok(logged.some((l) => /28 answer\(s\) are banked in .*answers\.jsonl/.test(l)));
    assert.ok(logged.some((l) => /29 of 30 block\(s\) came out of the bank and 0 were asked/.test(l)));
  } finally {
    clean();
  }
});

test('editing one paragraph re-asks that paragraph and nothing else', async () => {
  /*
   * THE CONSEQUENCE THAT MAKES THE KEY THE RIGHT KEY. The working copy is a
   * book somebody is editing, so a bank keyed by POSITION would hand block 2's
   * old translation to whatever block 2 is today — a book that renders
   * perfectly and is wrong where nobody can see it.
   */
  const { epub, out, clean } = scratch(paragraphs(P1, P2, P3));
  const { dir, bankPath } = bankIn(out);
  try {
    const first = fakeOllama();
    await translateEpub({
      epubPath: epub, outPath: out, to: 'en', transport: first, bankPath, log: quiet,
    });
    assert.equal(first.asked.length, 3);

    const edited = 'Der zweite Absatz, den jemand von Hand geaendert hat.';
    const epub2 = path.join(dir, 'Buch-bearbeitet.epub');
    fs.writeFileSync(epub2, paragraphs(P1, edited, P3));
    const second = fakeOllama();
    const report = await translateEpub({
      epubPath: epub2, outPath: out, to: 'en', transport: second, bankPath, log: quiet,
    });

    assert.deepEqual(second.asked, [edited], 'exactly the paragraph that changed');
    assert.equal(report.fromBank, 2);
    assert.equal(report.answered, 1);

    const chapter = readZipMap(new Uint8Array(fs.readFileSync(out))).get(CHAPTER_PATH)!.text();
    assert.match(chapter, new RegExp(shout(edited)));
    assert.match(chapter, new RegExp(shout(P3)), 'and its neighbours kept their banked answers');
  } finally {
    clean();
  }
});

test('a different model or different instructions re-asks the whole book', async () => {
  /*
   * Correctly, and this is the other half of the same argument: every answer
   * WOULD have been different. A bank that answered a qwen2.5 run out of
   * qwen3's answers would be a book nobody chose the translator for, and
   * "leave 'völkisch' untranslated" is an instruction about every block.
   */
  const { epub, out, clean } = scratch(paragraphs(P1, P2, P3));
  const { bankPath } = bankIn(out);
  const models = ['qwen3:32b', 'qwen2.5:14b'];
  try {
    const first = fakeOllama(undefined, models);
    await translateEpub({
      epubPath: epub, outPath: out, to: 'en', transport: first, bankPath, log: quiet,
    });

    const other = fakeOllama(undefined, models);
    const byModel = await translateEpub({
      epubPath: epub, outPath: out, to: 'en', model: 'qwen2.5:14b', transport: other, bankPath, log: quiet,
    });
    assert.equal(other.asked.length, 3, 'a different model is a different question');
    assert.equal(byModel.fromBank, 0);

    const told = fakeOllama(undefined, models);
    const byInstructions = await translateEpub({
      epubPath: epub,
      outPath: out,
      to: 'en',
      instructions: 'Leave "völkisch" untranslated.',
      transport: told,
      bankPath,
      log: quiet,
    });
    assert.equal(told.asked.length, 3, 'and so is a different prompt');
    assert.equal(byInstructions.fromBank, 0);

    // Three questions, three answers each block: nothing was overwritten.
    assert.equal(bankLines(bankPath).length, 9);
  } finally {
    clean();
  }
});

test('--fresh-bank asks every block again into a pending bank and swaps it in with the book', async () => {
  const { epub, out, clean } = scratch(paragraphs(P1, P2, P3));
  const { dir, bankPath } = bankIn(out);
  try {
    await translateEpub({
      epubPath: epub, outPath: out, to: 'en', transport: fakeOllama(), bankPath, log: quiet,
    });
    assert.equal(bankLines(bankPath).length, 3);

    const server = fakeOllama();
    const logged: string[] = [];
    const report = await translateEpub({
      epubPath: epub,
      outPath: out,
      to: 'en',
      transport: server,
      bankPath,
      freshBank: true,
      log: (m) => logged.push(m),
    });

    assert.equal(server.asked.length, 3);
    assert.equal(report.fromBank, 0);
    // NO HOARD. The second opinion replaced the first the moment the book was
    // written, and nothing was rotated into `archived-<stamp>/` to do it.
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith('archived-')), []);
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.pending')), []);
    assert.equal(bankLines(bankPath).length, 3, 'and the bank is this run\'s three answers');
    assert.ok(logged.some((l) => /the \d+ banked answer\(s\) in .* are left exactly as they are/.test(l)), logged.join('\n'));
    assert.ok(logged.some((l) => /have taken the place of/.test(l)), logged.join('\n'));
  } finally {
    clean();
  }
});

test('a --fresh-bank run that dies leaves the old answers untouched, and the retry resumes its own', async () => {
  /*
   * The failure the pending file exists for, on this side of the house: the old
   * behaviour rotated a complete bank into `archived-<stamp>/` BEFORE ASKING A
   * SINGLE BLOCK, so a fresh run killed part-way had thrown away a whole book's
   * answers and produced nothing to put in their place.
   */
  const { epub, out, clean } = scratch(paragraphs(P1, P2, P3));
  const { dir, bankPath } = bankIn(out);
  try {
    await translateEpub({
      epubPath: epub, outPath: out, to: 'en', transport: fakeOllama(), bankPath, log: quiet,
    });
    const first = bankLines(bankPath);
    assert.equal(first.length, 3);
    fs.rmSync(out);

    const server = fakeOllama();
    let calls = 0;
    const dying: Transport = {
      ...server,
      post: async (url: string, body: string): Promise<HttpResponse> => {
        calls += 1;
        if (calls > 2) return { status: 500, body: 'model runner has crashed' };
        return server.post(url, body);
      },
    };
    await assert.rejects(
      translateEpub({
        epubPath: epub,
        outPath: out,
        to: 'en',
        transport: dying,
        bankPath,
        freshBank: true,
        concurrency: 1,
        log: quiet,
      }),
      /answered 500/,
    );

    // NOTHING HAPPENED to the bank: the same three answers, byte for byte, and
    // no book. The two the dead run paid for are beside it, waiting.
    assert.equal(fs.existsSync(out), false);
    assert.deepEqual(bankLines(bankPath), first);
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.startsWith('archived-')), []);
    assert.equal(bankLines(`${bankPath}.pending`).length, 2);

    // The retry pays for the one block that is missing, not for three.
    const second = fakeOllama();
    const report = await translateEpub({
      epubPath: epub, outPath: out, to: 'en', transport: second, bankPath, freshBank: true, log: quiet,
    });
    assert.equal(second.asked.length, 1);
    assert.equal(report.fromBank, 2);
    assert.equal(bankLines(bankPath).length, 3);
    assert.equal(fs.existsSync(`${bankPath}.pending`), false);
  } finally {
    clean();
  }
});

test('a bank whose last line was cut off by a kill costs exactly that one block', async () => {
  const { epub, out, clean } = scratch(paragraphs(P1, P2, P3));
  const { bankPath } = bankIn(out);
  try {
    await translateEpub({
      epubPath: epub, outPath: out, to: 'en', transport: fakeOllama(), bankPath, log: quiet,
    });
    // A process killed mid-append leaves half a line. It is DROPPED, because
    // that is the normal consequence of the kill this file exists for.
    const whole = fs.readFileSync(bankPath, 'utf8');
    fs.writeFileSync(bankPath, whole.slice(0, whole.length - 25));

    const server = fakeOllama();
    const report = await translateEpub({
      epubPath: epub, outPath: out, to: 'en', transport: server, bankPath, log: quiet,
    });
    assert.deepEqual(server.asked, [P3]);
    assert.equal(report.fromBank, 2);
  } finally {
    clean();
  }
});

test('a bank line that is not JSON anywhere but the end is refused, naming the line', () => {
  /*
   * The difference that matters: a broken LAST line is an interrupted append,
   * and a broken line in the middle is a file this program did not write —
   * about to supply somebody else's answers to a book they are not from.
   */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foundry-bank-'));
  try {
    const bankPath = path.join(dir, 'answers.jsonl');
    fs.writeFileSync(
      bankPath,
      `${JSON.stringify({ key: 'a', source: 'x', answer: 'y' })}\nnot json at all\n`
      + `${JSON.stringify({ key: 'b', source: 'x', answer: 'y' })}\n`,
    );
    assert.throws(
      () => TranslationBank.open(bankPath),
      (error: Error) => error instanceof TranslateBankError
        && /line 2 is not JSON/.test(error.message)
        && /not a translation bank/.test(error.message),
    );

    // A line that parses but carries no answer is the same fact, said the same way.
    fs.writeFileSync(bankPath, `${JSON.stringify({ page: 3, text: 'hallo' })}\n{}\n`);
    assert.throws(() => TranslationBank.open(bankPath), /line 1 carries no key and answer/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('freshBank with no bank at all is refused rather than doing nothing', async () => {
  const { epub, out, clean } = scratch(paragraphs(P1));
  try {
    await assert.rejects(
      translateEpub({
        epubPath: epub, outPath: out, to: 'en', transport: fakeOllama(), freshBank: true, log: quiet,
      }),
      /no bank for it to act on/,
    );
  } finally {
    clean();
  }
});

test('the key is the question and nothing else about where the block sits', () => {
  const question = {
    text: 'Ein ⟦e1⟧deutscher⟦/e1⟧ Satz.',
    model: 'qwen3:32b',
    to: 'en',
    from: 'de' as string | null,
    instructions: undefined as string | undefined,
  };
  const key = bankKey(question);
  assert.equal(key, bankKey({ ...question }), 'the same question is the same key');
  assert.equal(bankKey({ ...question, instructions: '   ' }), key, 'blank instructions are none');
  assert.notEqual(bankKey({ ...question, model: 'qwen2.5:14b' }), key);
  assert.notEqual(bankKey({ ...question, to: 'fr' }), key);
  assert.notEqual(bankKey({ ...question, from: null }), key, 'detecting the source is a question too');
  assert.notEqual(bankKey({ ...question, instructions: 'Keep names.' }), key);
  assert.notEqual(bankKey({ ...question, text: 'Ein deutscher Satz.' }), key, 'the markers are part of it');
  // The fields cannot be run into each other: moving a character across a
  // boundary is a different question, not the same one.
  assert.notEqual(
    bankKey({ ...question, model: 'qwen3:32', to: 'ben' }),
    bankKey({ ...question, model: 'qwen3:32b', to: 'en' }),
  );
});

test('a chunk with some parts banked travels WHOLE, and a refused block is never banked', async () => {
  /*
   * TWO RULES IN ONE RUN, because the first is what makes the second visible.
   *
   * A refusal is a fact about a run — this model, three attempts — and not an
   * answer, so it is not banked and the next run asks again. That leaves the
   * four-item list with three banked parts and one missing, and the chunk goes
   * out WHOLE: an item sent on its own has lost the list, which is the entire
   * argument for chunking, and a payload with the banked items removed would be
   * a different question (three lines, renumbered) whose answer could not be
   * keyed against anything. What the banked parts do NOT do is take the new
   * answer — the bank stays authoritative, so a resumed run is idempotent.
   */
  const { epub, out, clean } = scratch();
  const { bankPath } = bankIn(out);
  try {
    const first = fakeOllama((user) => {
      if (user === 'Drittens die Ordnung des Berufsstandes.') return 'no';
      const lines = user.split('\n');
      if (lines.length !== 4 || !user.includes('Vertraege')) return shout(user);
      return lines.map((line, i) => (i === 2 ? '3. no' : shout(line))).join('\n');
    });
    const one = await translateEpub({
      epubPath: epub, outPath: out, to: 'en', transport: first, bankPath, log: quiet,
    });
    assert.equal(one.keptUntranslated.length, 1);
    // Twenty-nine askable blocks, one refused and one answered out of the bank
    // by the duplicate "Jahr" — so twenty-seven questions reached the model.
    assert.equal(one.answered, 27);
    assert.equal(bankLines(bankPath).length, 27, 'and the refusal is not in the file');

    // The second run: everything is banked except the item that was refused.
    const second = fakeOllama((user) => user.split('\n').map((line) => {
      const numbered = /^(\d+)\.\s*([\s\S]*)$/.exec(line);
      return numbered === null ? `${shout(line)} [2]` : `${numbered[1]}. ${shout(numbered[2]!)} [2]`;
    }).join('\n'));
    const two = await translateEpub({
      epubPath: epub, outPath: out, to: 'en', transport: second, bankPath, log: quiet,
    });

    assert.equal(second.asked.length, 1, 'one request: the chunk that still has a hole in it');
    assert.equal(second.asked[0]!.split('\n').length, 4, 'and it carried all four items');
    assert.equal(two.fromBank, 28);
    assert.equal(two.answered, 1);
    assert.equal(two.keptUntranslated.length, 0);

    const chapter = readZipMap(new Uint8Array(fs.readFileSync(out))).get(CHAPTER_PATH)!.text();
    // The part that was missing takes this run's answer...
    assert.match(chapter, /<li[^>]*>DRITTENS DIE ORDNUNG DES BERUFSSTANDES\. \[2\]<\/li>/);
    // ...and the three that were banked keep the answers they were banked with,
    // even though a perfectly good new one came back in the same reply.
    assert.match(chapter, /<li[^>]*>ERSTENS DIE AUFHEBUNG DER VERTRAEGE\.<\/li>/);
    assert.match(chapter, /<li[^>]*>VIERTENS DIE <em>FRAGE<\/em> DES BODENS\.<\/li>/);
  } finally {
    clean();
  }
});

test('a paragraph that appears twice in a book is asked once', async () => {
  /*
   * One request in flight, deliberately. Nothing can look inside a request that
   * has not landed, so two duplicates that go out TOGETHER are asked twice —
   * which costs one request and nothing else, since the same key gets the same
   * answer written over it. Serially it is what the key promises.
   */
  const { epub, out, clean } = scratch(paragraphs(P1, P2, P1));
  const { bankPath } = bankIn(out);
  try {
    const server = fakeOllama();
    const report = await translateEpub({
      epubPath: epub, outPath: out, to: 'en', transport: server, bankPath, concurrency: 1, log: quiet,
    });
    assert.deepEqual(server.asked, [P1, P2]);
    assert.equal(report.fromBank, 1);
    assert.equal(bankLines(bankPath).length, 2);
  } finally {
    clean();
  }
});

// ── concurrency: several requests at once, and the same book out of it ────────

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * The fake server, answering after a delay of its own choosing and counting how
 * many requests are open while it does.
 *
 * The delay is what makes the answers arrive in an order that is not the order
 * they were sent in, which is the whole thing being tested: the book must not
 * depend on it.
 */
interface SlowServer extends FakeServer {
  /** The most requests that were open at one moment. */
  maxOpen: () => number;
  /** How many are open right now. Zero after a run that waited for them. */
  open: () => number;
  /** Each request's send position, in the order the answers came back. */
  answeredOrder: number[];
}

function slowOllama(base: FakeServer, delayMs: (user: string, order: number) => number): SlowServer {
  let open = 0;
  let maxOpen = 0;
  let sent = 0;
  const answeredOrder: number[] = [];
  return {
    asked: base.asked,
    answeredOrder,
    maxOpen: () => maxOpen,
    open: () => open,
    get: base.get,
    post: async (url: string, body: string): Promise<HttpResponse> => {
      open += 1;
      maxOpen = Math.max(maxOpen, open);
      const parsed = JSON.parse(body) as { messages: { content: string }[] };
      const user = parsed.messages[parsed.messages.length - 1]!.content;
      sent += 1;
      const order = sent;
      try {
        await sleep(delayMs(user, order));
        const response = await base.post(url, body);
        answeredOrder.push(order);
        return response;
      } finally {
        open -= 1;
      }
    },
  };
}

test('answers arriving in a scrambled order produce the identical book', async () => {
  /*
   * The proof that completion order is irrelevant: every block is spliced by
   * its own offset in its own document, so what comes back when changes only
   * the log. Two runs over the same book — one serial, one with six requests in
   * flight answering in a deliberately jumbled order — and the zip writer is
   * deterministic, so "the same book" means the same bytes.
   */
  const { epub, out, clean } = scratch();
  const serial = path.join(path.dirname(out), 'Serial.epub');
  try {
    await translateEpub({
      epubPath: epub, outPath: serial, to: 'en', transport: fakeOllama(), concurrency: 1, log: quiet,
    });

    // A delay with no relation to the order the chunks were sent in.
    const scrambled = slowOllama(fakeOllama(), (_user, order) => ((order * 37) % 11) * 3);
    const report = await translateEpub({
      epubPath: epub, outPath: out, to: 'en', transport: scrambled, concurrency: 6, log: quiet,
    });

    assert.equal(report.chunks, 16);
    assert.equal(scrambled.asked.length, 16);
    // The test is only worth anything if the answers really did come back out
    // of order, so that is asserted rather than assumed.
    assert.notDeepEqual(
      scrambled.answeredOrder,
      [...scrambled.answeredOrder].sort((a, b) => a - b),
      'the answers came back in the order they were sent — nothing was scrambled',
    );
    assert.deepEqual([...fs.readFileSync(out)], [...fs.readFileSync(serial)]);
  } finally {
    clean();
  }
});

test('concurrency actually overlaps, and one means one', async () => {
  const { epub, out, clean } = scratch();
  try {
    const many = slowOllama(fakeOllama(), () => 5);
    await translateEpub({
      epubPath: epub, outPath: out, to: 'en', transport: many, concurrency: 6, log: quiet,
    });
    assert.equal(many.maxOpen(), 6, 'six requests were open at the same moment');

    const one = slowOllama(fakeOllama(), () => 1);
    await translateEpub({
      epubPath: epub, outPath: out, to: 'en', transport: one, concurrency: 1, log: quiet,
    });
    assert.equal(one.maxOpen(), 1, 'and with one worker there is never a second request open');
  } finally {
    clean();
  }
});

test('the counts stay honest out of order: nothing they report ever goes backwards', async () => {
  /*
   * The app draws its progress bar from `translate: block N/M`
   * (`app/electron/engine.ts`), so N is a COUNT of blocks finished and not a
   * block's position — a position would send the bar backwards several times a
   * minute. The same rule applies to the requests line.
   */
  const { epub, out, clean } = scratch();
  try {
    const logged: string[] = [];
    const server = slowOllama(fakeOllama(), (_user, order) => ((order * 17) % 7) * 4);
    await translateEpub({
      epubPath: epub, outPath: out, to: 'en', transport: server, concurrency: 5, log: (m) => logged.push(m),
    });

    const rising = (lines: readonly string[], pattern: RegExp, last: number): void => {
      let previous = 0;
      let seen = 0;
      for (const line of lines) {
        const hit = pattern.exec(line);
        if (hit === null) continue;
        seen += 1;
        assert.ok(Number(hit[1]) > previous, `${line} — after ${previous}`);
        previous = Number(hit[1]);
        assert.equal(Number(hit[2]), last);
      }
      assert.ok(seen > 1, 'there were lines to check');
      assert.equal(previous, last, 'and the last one names the whole book');
    };

    // Thirty blocks, sixteen requests: both lines end on the whole book, and
    // neither of them ever names a number smaller than the one before it.
    rising(logged, /^translate: block (\d+)\/(\d+) \(/, 30);
    rising(logged, /^translate: (\d+)\/(\d+) requests done/, 16);
  } finally {
    clean();
  }
});

test('a server error ends the run at once, and the error is the FIRST one', async () => {
  /*
   * With N in flight, two chunks can fail before either is reported, and the
   * one that surfaces must be the one that happened FIRST — the failure that
   * ended the run, not whichever rejection the runtime settled last. The 503
   * here answers in 5ms and the 500 in 40ms; the 500 was issued first.
   *
   * And nothing is left dangling: the run waits for the requests that were
   * already out rather than returning while they are in flight and leaving
   * their rejections to land in a run that has finished.
   */
  const { epub, out, clean } = scratch();
  try {
    const base = fakeOllama();
    let open = 0;
    let slowFinished = false;
    const dying: Transport = {
      get: base.get,
      post: async (url: string, body: string): Promise<HttpResponse> => {
        open += 1;
        try {
          const parsed = JSON.parse(body) as { messages: { content: string }[] };
          const user = parsed.messages[parsed.messages.length - 1]!.content;
          if (user.includes('voelkischer')) {
            await sleep(40);
            slowFinished = true;
            return { status: 500, body: 'the slow failure' };
          }
          if (user.includes('Die Ordnung')) {
            await sleep(5);
            return { status: 503, body: 'the quick failure' };
          }
          return await base.post(url, body);
        } finally {
          open -= 1;
        }
      },
    };

    await assert.rejects(
      translateEpub({
        epubPath: epub, outPath: out, to: 'en', transport: dying, concurrency: 4, log: quiet,
      }),
      (error: Error) => {
        assert.match(error.message, /answered 503/);
        assert.match(error.message, /the quick failure/);
        assert.doesNotMatch(error.message, /the slow failure/);
        return true;
      },
    );
    assert.equal(open, 0, 'nothing was left in flight when the run threw');
    assert.ok(slowFinished, 'and it waited for the slow request rather than walking away from it');
    assert.equal(fs.existsSync(out), false);
  } finally {
    clean();
  }
});

test('the wholesale-failure guard still fires, and says truthfully what is left', async () => {
  /*
   * Twenty-five refusals is not twenty-five bad paragraphs; it is the wrong
   * model or a prompt it will not follow, and the rest of the book would cost
   * hours to prove it again. The message used to work the remainder out from
   * the refused block's ORDINAL, which read it as a high-water mark — true when
   * the blocks were done in order and false the moment several are in flight.
   * It now counts the blocks that have no verdict of any kind, the ones beside
   * this refusal included.
   */
  const many = Array.from({ length: 30 }, (_, i) => `Ein hinreichend langer Absatz mit der Nummer ${i + 1}.`);
  const { epub, out, clean } = scratch(paragraphs(...many));
  try {
    const server = fakeOllama(() => 'x');
    await assert.rejects(
      translateEpub({
        epubPath: epub, outPath: out, to: 'en', transport: server, concurrency: 4, log: quiet,
      }),
      (error: Error) => {
        assert.ok(error instanceof TranslateError);
        assert.match(error.message, /^25 blocks could not be translated/);
        assert.match(error.message, /5 block\(s\) this run has not finished would cost hours/);
        assert.match(error.message, /NOTHING WAS WRITTEN\./);
        return true;
      },
    );
    assert.equal(fs.existsSync(out), false);
  } finally {
    clean();
  }
});

test('a concurrency that is not a count of requests is refused before the book is read', async () => {
  const { epub, out, clean } = scratch();
  try {
    for (const bad of [0, -1, 2.5]) {
      await assert.rejects(
        translateEpub({
          epubPath: epub, outPath: out, to: 'en', transport: fakeOllama(), concurrency: bad, log: quiet,
        }),
        (error: Error) => error instanceof TranslateError && /at least 1/.test(error.message),
        `concurrency ${bad}`,
      );
    }
  } finally {
    clean();
  }
});
