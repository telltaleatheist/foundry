/**
 * click-reporter — the ONE script allowed to run inside a book.
 *
 * The rendered chapter sits in an <iframe sandbox="allow-scripts"> with an
 * opaque origin: no IPC, no storage, no same-origin anything. The only channel
 * out is postMessage, and this script is the only thing that uses it — it says
 * which block was clicked, so the split editor can jump to that block's source,
 * the way Calibre's editor does.
 *
 * WHY THIS IS THE ONLY SCRIPT THAT RUNS — the load-bearing lock is
 * SANITIZATION AT SERVE TIME, and that choice was measured, not guessed:
 *
 *   Two obvious locks were tested against a book shipping `evil.js` plus a
 *   `<script src>` for it, and BOTH failed to hold on this scheme:
 *
 *   - MIME: octet-stream + `X-Content-Type-Options: nosniff` did not stop the
 *     script — Chromium's block-by-MIME lives in the HTTP stack, and
 *     `foundry-file:` responses never pass through it.
 *   - CSP: a `script-src 'nonce-…'` response header did not stop it either,
 *     and `eval()` ran in the frame — response-header CSP is simply not
 *     enforced for documents on a custom scheme in this Electron.
 *
 *   So the served markup itself is made script-free: `sanitizeChapter` strips
 *   script/iframe/object/embed elements, every `on*` handler attribute and
 *   every `javascript:` URL from a chapter ON ITS WAY OUT, and then exactly
 *   one script tag — this reporter — is appended. What cannot be expressed in
 *   the document cannot execute, whatever the scheme's enforcement gaps. The
 *   nonce'd CSP and nosniff STAY on the response: they cost nothing and become
 *   real locks again the day Electron enforces them here.
 *
 *   The disk copy, read-member and every repack see none of this: a book's own
 *   markup — scripts and all — round-trips through open/edit/save untouched.
 *
 * The script itself is written to do nothing else: no fetch, no DOM mutation,
 * no capability beyond naming an element by its position in document order.
 */

/** The id segment the protocol handler reserves for app-owned support files. */
export const REPORTER_ID = '__foundry__';
export const REPORTER_MEMBER = 'click-reporter.js';
export const REPORTER_URL = `foundry-file://epub/${REPORTER_ID}/${REPORTER_MEMBER}`;

/**
 * Block-level elements worth jumping to when the click landed outside any
 * `data-bf-page` block — a foreign EPUB, or foundry front matter the model
 * never paginated. Mirrored by the editor's fallback regex; the two sides must
 * count the same things or the jump lands one block off.
 */
const BLOCK_TAGS = 'p|h1|h2|h3|h4|h5|h6|li|blockquote|pre|dt|dd|figcaption|td|th';

export const REPORTER_SOURCE = `(function () {
  'use strict';
  var BLOCK = /^(${BLOCK_TAGS})$/i;
  document.addEventListener('click', function (event) {
    var start = event.target instanceof Element ? event.target : null;
    if (!start) return;
    // The nearest foundry block wins: data-bf-page is on every block the model
    // read, and its index in document order equals its index in the source.
    var bf = start.closest('[data-bf-page]');
    var target = bf;
    if (!target) {
      for (var node = start; node && node !== document.documentElement; node = node.parentElement) {
        if (BLOCK.test(node.tagName)) { target = node; break; }
      }
    }
    if (!target) return;
    var tag = target.tagName.toLowerCase();
    var index = bf
      ? Array.prototype.indexOf.call(document.querySelectorAll('[data-bf-page]'), target)
      : Array.prototype.indexOf.call(document.getElementsByTagName(tag), target);
    if (index < 0) return;
    // targetOrigin must be '*': a sandboxed frame's origin is opaque, so there
    // is no origin string that names the parent. The parent checks the SOURCE.
    window.parent.postMessage({ type: 'foundry:block-click', bf: !!bf, tag: tag, index: index }, '*');
  }, true);
})();
`;

/**
 * Make a chapter script-free before it is served.
 *
 * The blast radius is honest: foundry's own books (src/vlm/epub.ts) contain
 * none of what this removes, so their rendering is byte-identical either way —
 * the stripping only ever bites a foreign EPUB that shipped active content,
 * and what it costs that book is scripts in a reader, which no EPUB is owed.
 * Chapters are XHTML parsed strictly, which is what keeps regex stripping
 * sound: a tag the parser would honour is a tag these patterns see.
 *
 * Elements are removed whole (script/iframe/object/embed, paired or
 * self-closing); `on*` handler attributes and `javascript:` URLs are dropped
 * where they sit. A final pass removes any REMAINING open or close tag of
 * those elements: an UNCLOSED `<script src=…>` matches neither the paired nor
 * the self-closing pattern, and while strict XHTML would refuse the whole
 * document over it, a `.html` chapter is parsed leniently and would have run
 * it. Stripping the stray tag leaves its inner text visible as text — inert,
 * and only ever in a book that shipped broken active content.
 */
export function sanitizeChapter(markup: string): string {
  return markup
    .replace(/<(script|iframe|object|embed)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<\/?(?:script|iframe|object|embed)\b[^>]*>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s+(href|src|xlink:href|action|formaction|data)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '');
}

/**
 * Splice the reporter into a chapter on its way to the iframe.
 *
 * SERVE-TIME ONLY: the disk copy, epub:read-member and every repack see the
 * chapter exactly as written — the editor must never show, and a save must
 * never contain, a tag the app injected. An explicit closing tag because these
 * documents are XHTML and `<script/>` is not a script element there. A chapter
 * with no `</body>` is served untouched: better a chapter without click-to-jump
 * than a guess at where its body ends.
 *
 * `nonce` is the response's own — the caller mints one per serve and puts the
 * same value in the CSP header, which is the whole authorization story above.
 */
export function injectReporter(markup: string, nonce: string): string {
  const at = markup.lastIndexOf('</body>');
  if (at < 0) return markup;
  return `${markup.slice(0, at)}<script nonce="${nonce}" src="${REPORTER_URL}"></script>${markup.slice(at)}`;
}
