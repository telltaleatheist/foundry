/**
 * click-reporter — the ONE script allowed to run inside a book.
 *
 * The rendered chapter sits in an <iframe sandbox="allow-scripts"> with an
 * opaque origin: no IPC, no storage, no same-origin anything. The only channel
 * out is postMessage, and this script is the only thing that uses it — it says
 * which block was clicked, so the split editor can jump to that block's source,
 * the way Calibre's editor does, and (since select mode) it draws the boxes a
 * curator clicks and reports what they did to them.
 *
 * ── Why SELECT MODE lives in here, of all places ─────────────────────────────
 *
 * Because there is nowhere else it can live. The frame's origin is opaque, so
 * the parent cannot read `contentDocument`, cannot measure a rectangle and
 * cannot hit-test a paragraph; an overlay of app DOM would have to re-derive
 * every box from coordinates it cannot see. (That re-derivation, in several
 * places, is a named defect of the picker this replaces.) Key events are the
 * same story from the other end: a Delete pressed inside a sandboxed frame is
 * never delivered to the parent window, so the key handler has to be here too.
 *
 * WHAT THE FRAME DOES NOT OWN IS THE TRUTH. A cut is `data-bf-cut="1"` on the
 * element in the working copy and nowhere else — not a Set in a service, not a
 * sidecar, not the manifest. This script paints from the ATTRIBUTE (a CSS
 * selector, not a list it keeps), so a reload repaints whatever the file says;
 * it paints optimistically and lets the write land behind it, because a round
 * trip per keystroke is a mode that feels broken; and when a write is refused
 * the parent reloads the frame, which is how a lie gets corrected.
 *
 * WITH THE MODE OFF THIS FILE BEHAVES EXACTLY AS IT DID BEFORE IT: the mode
 * starts off, every handler below returns immediately while it is off, the
 * stylesheet is not in the document at all, and the original click listener is
 * untouched — first registered, never suppressed, still reporting every click.
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

/**
 * The markup an edit made IN PLACE is allowed to leave standing inside a block:
 * the emitter's inline vocabulary (src/vlm/dialect.ts's INLINE_TAGS) plus the
 * anchors and typographic tags a book can carry.
 *
 * ONE COPY, READ BY BOTH ENDS. The frame uses it to refuse a block that holds
 * anything else before a word is typed; `epub-reader.ts` imports it and refuses
 * the same thing again when the words come back. Two lists would be one edit
 * away from a mode that lets you type into a table and then throws the result
 * away — so this module, which imports nothing, owns it, and main's validator
 * reads it from here.
 */
export const INLINE_TAGS: ReadonlySet<string> = new Set([
  'em', 'strong', 'i', 'b', 'a', 'sup', 'sub', 'span', 'br', 'code', 'cite', 'q', 'small', 'u',
]);

/**
 * Select mode's whole appearance, as ONE stylesheet added when the mode opens
 * and removed when it closes.
 *
 * A stylesheet rather than inline styles walked onto every block, because the
 * rules are then SELECTORS: `[data-bf-cut]` draws the cut, so the paint follows
 * the attribute and a reload of the frame repaints whatever the file now says.
 * Anything the frame kept in a list of its own would have to be reconciled with
 * the document after every gesture, which is exactly the machinery — and the
 * data-loss bug — this design exists to not have.
 *
 * `style-src foundry-file: 'unsafe-inline'` is already in EPUB_CSP (main.ts),
 * so an injected <style> is authorized; nothing here loads anything.
 *
 * The X over a cut block is two linear-gradients, so it is drawn by the layout
 * engine at whatever size the block turns out to be — no measuring, no
 * coordinates, nothing to re-derive when the window is resized.
 */
const SELECT_CSS = [
  '[data-bf-cat]{outline:1px dashed rgba(140,140,140,.55);outline-offset:2px;cursor:pointer}',
  '[data-bf-cat]:hover{outline-color:rgba(200,105,35,.8)}',
  '[data-bf-sel]{outline:2px solid #c86923;outline-offset:2px;background:rgba(200,105,35,.10)}',
  '[data-bf-cut]{opacity:.42;text-decoration:line-through;'
  + 'background-image:'
  + 'linear-gradient(to top right,transparent 49.5%,rgba(178,54,38,.8) 49.5%,'
  + 'rgba(178,54,38,.8) 50.5%,transparent 50.5%),'
  + 'linear-gradient(to bottom right,transparent 49.5%,rgba(178,54,38,.8) 49.5%,'
  + 'rgba(178,54,38,.8) 50.5%,transparent 50.5%)}',
  '[data-bf-edit]{outline:2px solid #2f7d4f;outline-offset:2px;'
  + 'background:rgba(47,125,79,.09);cursor:text}',
].join('\n');

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

  // ═══ select mode ═══════════════════════════════════════════════════════════
  //
  // Everything past this line is dead until the parent says otherwise. Nothing
  // is added to the document, no attribute is written and every listener below
  // returns on its first line while MODE is false — which is the state a frame
  // loads in, every time, including after the reload an edit elsewhere causes.

  var CAT = 'data-bf-cat';
  var ID = 'data-bf-id';
  var CUT = 'data-bf-cut';
  var SEL = 'data-bf-sel';
  var EDIT = 'data-bf-edit';
  var INLINE = /^(${[...INLINE_TAGS].join('|')})$/i;

  var mode = false;
  // The stylesheet is held by reference rather than found by id: an XHTML
  // document is XML, and looking an element up by id in one is a question with
  // more history than it is worth when the node is right here.
  var sheet = null;
  var selected = null;
  var editing = null;
  var editedFrom = '';

  function post(message) { window.parent.postMessage(message, '*'); }

  // Every refusal is a SENTENCE the parent puts in the notice strip. A gesture
  // that quietly does nothing is indistinguishable from a broken mode, and this
  // frame has no other way to speak (ARCHITECTURE section 8).
  function refuse(reason) { post({ type: 'foundry:select-refused', reason: reason }); }

  // createElement puts this in the HTML namespace for an application/xhtml+xml
  // document as well as a text/html one, which is what makes an injected style
  // element take effect in a book served as XHTML.
  function addStyles() {
    if (sheet) return;
    sheet = document.createElement('style');
    sheet.textContent = ${JSON.stringify(SELECT_CSS)};
    (document.head || document.documentElement).appendChild(sheet);
  }

  function removeStyles() {
    if (sheet && sheet.parentNode) sheet.parentNode.removeChild(sheet);
    sheet = null;
  }

  // The selection is the one piece of state the frame owns, because it is the
  // only one that is not a fact about the book: it dies with the frame and
  // nothing on disk records it.
  function select(element) {
    if (selected === element) return;
    if (selected) selected.removeAttribute(SEL);
    selected = element;
    if (selected) selected.setAttribute(SEL, '1');
    post({ type: 'foundry:block-selected', id: selected ? selected.getAttribute(ID) : null });
  }

  function named(element) {
    var id = element.getAttribute(ID);
    if (id) return id;
    refuse('That block carries no data-bf-id, so there is no name to record a change against. '
      + 'Close select mode and open it again to stamp this book.');
    return null;
  }

  /**
   * Mark or unmark, IN THE FRAME FIRST.
   *
   * The write is posted behind the paint on purpose: at a cut a second the user
   * is holding Delete down a row of blocks, and a mode that waited for a disk
   * round trip before each one would feel broken. If main refuses, the parent
   * reloads this frame and the file repaints the truth over the guess.
   */
  function toggleCut(element) {
    var id = named(element);
    if (id === null) return;
    if (editing === element) commitEdit();
    var cut = !element.hasAttribute(CUT);
    if (cut) element.setAttribute(CUT, '1');
    else element.removeAttribute(CUT);
    post({ type: 'foundry:block-cut', id: id, cut: cut });
  }

  /**
   * Make a block's words editable in place.
   *
   * PLAIN contenteditable, never plaintext-only, and that is the opposite of
   * the obvious choice. plaintext-only does not PROTECT the em and the
   * epub:type="noteref" anchor inside a paragraph — it ERASES them, replacing
   * the element's content with a text node the moment it is edited, and the
   * footnote reference and the page marker go with them. So the block is edited
   * as markup, the frame sends its inner HTML, and MAIN decides whether what
   * came back was a word change (see refuseUnlessWordEdit in epub-reader.ts:
   * every tag inline, and the multiset of start tags with their attributes
   * unchanged).
   *
   * A block holding anything that is not INLINE markup is refused here rather
   * than in main, and it is the same test main applies: a blockquote holds its
   * own paragraph, a list holds its items and a table holds the model's own
   * rows, so editing the container would send markup whose tags main is bound
   * to refuse — and being told after typing three sentences is worse than being
   * told before. Structural editing is the HTML editor pane's job and always
   * was. The two lists must say the same thing; this one exists only to say it
   * sooner.
   */
  function beginEdit(element, caretAtEnd) {
    if (editing === element) return;
    if (editing) commitEdit();
    var inside = element.getElementsByTagName('*');
    for (var i = 0; i < inside.length; i += 1) {
      var name = inside[i].tagName.toLowerCase();
      if (INLINE.test(name)) continue;
      refuse('That block holds a <' + name + '>, which is not inline markup, so its words cannot '
        + 'be edited in place. Open Edit HTML for it.');
      return;
    }
    if (element.hasAttribute(CUT)) {
      refuse('That block is marked to be cut. Press Delete to bring it back before editing it.');
      return;
    }
    if (named(element) === null) return;
    select(element);
    editing = element;
    editedFrom = element.innerHTML;
    element.setAttribute('contenteditable', 'true');
    element.setAttribute(EDIT, '1');
    element.focus();
    if (caretAtEnd) {
      var range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      var selection = window.getSelection();
      if (selection) { selection.removeAllRanges(); selection.addRange(range); }
    }
  }

  function endEdit(element) {
    element.removeAttribute('contenteditable');
    element.removeAttribute(EDIT);
  }

  /**
   * What the block now says, with the mode's own attributes taken back off.
   *
   * They are never on a descendant by construction — only a stamped block can
   * be selected, and a block with a stamped descendant cannot be edited — but
   * this is what is being WRITTEN INTO A BOOK, and a defence that costs four
   * lines against an attribute leaking into somebody's chapter is worth having.
   */
  function editedHtml(element) {
    var clone = element.cloneNode(true);
    var marked = clone.querySelectorAll('[' + SEL + '],[' + EDIT + '],[contenteditable]');
    for (var i = 0; i < marked.length; i += 1) {
      marked[i].removeAttribute(SEL);
      marked[i].removeAttribute(EDIT);
      marked[i].removeAttribute('contenteditable');
    }
    return clone.innerHTML;
  }

  function commitEdit() {
    var element = editing;
    if (!element) return;
    editing = null;
    var id = element.getAttribute(ID);
    var html = editedHtml(element);
    endEdit(element);
    // Unchanged words are not a write. A click into a block and back out again
    // must not mark the book edited, and must not queue a member write behind
    // whatever the user does next.
    if (id === null || html === editedFrom) return;
    post({ type: 'foundry:block-edited', id: id, html: html });
  }

  function cancelEdit() {
    var element = editing;
    if (!element) return;
    editing = null;
    element.innerHTML = editedFrom;
    endEdit(element);
  }

  /**
   * The mode itself, as the parent sets it.
   *
   * Turning it OFF commits whatever was being typed rather than dropping it:
   * pressing the rail button is not an instruction to throw away a sentence.
   * It also puts the selection down and takes the stylesheet out, so the book
   * is left exactly as an unselected reader sees it.
   */
  function setMode(on) {
    if (on === mode) return;
    mode = on;
    if (on) { addStyles(); return; }
    commitEdit();
    select(null);
    removeStyles();
  }

  window.addEventListener('message', function (event) {
    // The mirror image of the parent's own gate: it checks that a message came
    // from this frame's window, and this checks that one came from the window
    // holding this frame. A sandboxed origin is opaque, so SOURCE is the only
    // identity either side has to check against.
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.type !== 'foundry:select-mode') return;
    setMode(data.on === true);
  });

  document.addEventListener('click', function (event) {
    if (!mode) return;
    var start = event.target instanceof Element ? event.target : null;
    if (!start) return;
    // A click INSIDE the block being edited is a caret being placed. Anything
    // else here would fight the thing the user is doing.
    if (editing && editing.contains(start)) return;
    var target = start.closest('[' + CAT + ']');
    if (!target) { select(null); return; }
    // Pressing the selected block again puts it down — the gesture that makes
    // a selection feel like a toggle rather than a trap.
    select(selected === target ? null : target);
    // NO preventDefault and NO stopPropagation, deliberately: the reporter's
    // original listener is registered first and still has to see every click,
    // because click-to-source keeps working while the mode is on.
  }, true);

  document.addEventListener('dblclick', function (event) {
    if (!mode) return;
    var start = event.target instanceof Element ? event.target : null;
    if (!start) return;
    var target = start.closest('[' + CAT + ']');
    if (!target) return;
    event.preventDefault();
    beginEdit(target, false);
  }, true);

  document.addEventListener('keydown', function (event) {
    if (!mode) return;
    if (editing) {
      if (event.key === 'Escape') { event.preventDefault(); cancelEdit(); }
      // Enter COMMITS instead of inserting a line: a block is a block, and a
      // contenteditable left to itself would put a <div> or a <br> in the
      // middle of somebody's paragraph. Shift+Enter is left alone so a genuine
      // <br> is still typeable in a book that uses them.
      else if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); commitEdit(); }
      return;
    }
    if (!selected) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      toggleCut(selected);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      beginEdit(selected, true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      select(null);
    }
  }, true);

  // focusout and not blur: blur does not bubble, and the block being edited is
  // wherever in the document it is. Clicking anywhere else fires this before
  // the click lands, so the edit is committed and the next block selects
  // cleanly in one gesture.
  document.addEventListener('focusout', function (event) {
    if (!mode || !editing || event.target !== editing) return;
    commitEdit();
  }, true);

  // A paste is the commonest way to break the one rule main enforces — the
  // clipboard carries markup, and markup is exactly what an edit may not
  // invent. It goes in as text with its whitespace collapsed, which is what
  // pasting INTO one block of a book means.
  document.addEventListener('paste', function (event) {
    if (!mode || !editing) return;
    event.preventDefault();
    var text = event.clipboardData ? event.clipboardData.getData('text/plain') : '';
    if (text) document.execCommand('insertText', false, text.replace(/\\s+/g, ' '));
  }, true);

  // The frame is going away — a chapter change, a reload after an edit
  // elsewhere. Best effort, and the only chance a half-typed edit gets.
  window.addEventListener('pagehide', function () { commitEdit(); });

  // The handshake. A frame reloads for reasons the parent did not ask for, and
  // it comes back with the mode off; saying so is what lets the parent turn it
  // straight back on without watching for load events it cannot always trust.
  post({ type: 'foundry:reporter-ready' });
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
