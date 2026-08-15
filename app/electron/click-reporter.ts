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
 * THE MARQUEE is the sharpest case of all: a drag rectangle hit-tested against
 * three hundred paragraphs is nothing but coordinates, and every one of them is
 * behind that origin.
 *
 * THE SELECTION IS A SET. Click one block, shift or ctrl/cmd-click to extend,
 * or drag a rectangle over empty space and take everything it touches. Delete
 * strikes the whole set and the inspector relabels the whole set, each as ONE
 * batch with one read and one write behind it — so thirty cuts made in one
 * gesture are ONE action in the parent's undo ledger rather than thirty, and
 * one Ctrl+Z reverses all thirty.
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
 * The script itself is written to do nothing else: no fetch, no network of any
 * kind, and nothing it can say that is not a fact about this document — which
 * block was clicked, what the curator did to the ones they picked, and how far
 * down the chapter the reader is (the scroll channel, near the bottom). That
 * last one is here for the same reason everything else is: the origin is opaque,
 * so nobody outside can read a scroll offset any more than they can measure a
 * paragraph.
 */

import { BLOCK_CATEGORIES, UNKNOWN_CATEGORY_COLOUR, categoryRgb } from '../shared/categories';

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
 * away — so this module, which imports nothing of main's, owns it, and main's
 * validator reads it from here. (The one import above is `shared/categories`,
 * which is a leaf both TypeScript programs compile and cannot cycle back.)
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
  /*
   * THE CATEGORY IS THE COLOUR, and it is carried as a custom property rather
   * than written into eleven copies of the outline rule. One `--bf-ink` per
   * category, one rule that reads it: the outline, the hover and the tint are
   * then written ONCE, and a colour that has to change changes in the table in
   * shared/categories.ts, which is the same table the inspector draws its
   * swatches from. Two lists of eleven colours would be one edit away from an
   * inspector saying a paragraph is green while the page outlines it in amber.
   *
   * OUTLINE AND TINT, NEVER TEXT COLOUR. This is a book, and recolouring its
   * words is unreadable — an outline sits beside the type, a background tint
   * sits behind it, and both leave the ink the colour the book printed it.
   *
   * A category this app has never heard of keeps the fallback grey it always
   * had, because the emitter is allowed to grow a category before this table
   * does and a book from the future must still be readable.
   */
  `[data-bf-cat]{--bf-ink:${categoryRgb(UNKNOWN_CATEGORY_COLOUR)};`
  + 'outline:1px dashed rgba(var(--bf-ink),.75);outline-offset:2px;cursor:pointer}',
  ...BLOCK_CATEGORIES.map((one) => `[data-bf-cat="${one.id}"]{--bf-ink:${categoryRgb(one.colour)}}`),
  /*
   * `background-color` AND NEVER THE `background` SHORTHAND, in this rule and
   * in the two below it. The shorthand resets every background property it does
   * not mention, and `[data-bf-cut]` draws its X as a pair of `background-image`
   * gradients — so a tint written as `background` on a rule with more
   * specificity (and hover, selection and editing all have more) silently
   * erased the cross out of a struck block the moment the pointer touched it.
   * Naming the one property leaves the X standing under the tint, which is what
   * a block that is both struck and selected has to look like.
   */
  '[data-bf-cat]:hover{outline-style:solid;outline-width:2px;'
  + 'outline-color:rgb(var(--bf-ink));background-color:rgba(var(--bf-ink),.10)}',
  /*
   * SELECTION BEATS HOVER, which needs the doubled attribute to say: `:hover`
   * is specificity 0-2-0 and a bare `[data-bf-sel]` is 0-1-0, so the pointer
   * resting on a selected block would otherwise repaint it as merely hovered
   * and the blocks the keyboard acts on would stop looking different from the
   * ten around them.
   *
   * THE COLOUR IS BOOKFORGE'S, TO THE BYTE, because Owen asked for the one he
   * already knows: `#06b6d4` is that app's `--accent` (cyan-500), and the fill
   * is its own `rgba(6, 182, 212, 0.18)` — both read out of
   * `src/app/features/pdf-picker/components/epub-viewer/quire-frame-scripts.ts`,
   * where the same job is done in the same place, an injected stylesheet over a
   * rendered book. It is deliberately NOT in the category table: selection is a
   * STATE, not a kind, and a curator must never read it as one more label.
   *
   * AND IT IS FILLED, not merely outlined — 18% of one colour, which is the
   * whole of what "fill it in a little bit when its highlighted" can mean for a
   * book. Anything heavier and the words underneath stop being words; an
   * outline alone leaves a marquee's worth of selection reading as a grid of
   * empty boxes rather than as thirty blocks that are about to be struck.
   *
   * SINGLE AND MULTIPLE LOOK THE SAME, which is also BookForge's answer: there
   * is one `.bf-selected` there and there is one rule here. A second colour for
   * "one of many" would be a distinction the user cannot act on — every gesture
   * in this mode applies to the whole set.
   */
  '[data-bf-cat][data-bf-sel]{outline:2px solid #06b6d4;outline-offset:2px;'
  + 'background-color:rgba(6,182,212,.18)}',
  /*
   * THE MARQUEE, drawn in the document's own coordinates.
   *
   * `pointer-events:none` so the rectangle the user is dragging can never
   * become the thing under the pointer, and a z-index at the top of the stack
   * because a book is free to raise its own figures. Its colours are
   * BookForge's marquee again — `--accent-subtle`, `rgba(6,182,212,0.12)`, over
   * a 2px `#06b6d4` border — so the box and what it catches are visibly one
   * gesture.
   */
  '[data-bf-marquee]{position:absolute;z-index:2147483647;pointer-events:none;'
  + 'background:rgba(6,182,212,.12);border:2px solid #06b6d4;box-sizing:border-box}',
  /*
   * NATIVE TEXT SELECTION IS OFF WHILE THE MODE IS ON, and that is what stops
   * the marquee fighting the browser. A drag across a page is otherwise TWO
   * gestures at once: ours, and Chromium's own sweep of blue over the prose —
   * which also drags the caret through the book and leaves the page looking
   * broken after the rectangle has gone. `preventDefault` on mousedown handles
   * the drag that starts on empty space; this handles the one that starts
   * inside a paragraph, where the press is a click and preventing it would
   * break the click.
   *
   * A BLOCK BEING EDITED IS EXEMPT, and has to be: `contenteditable` without a
   * selection is a box you cannot put a caret in. 0-1-0 beats `body`'s 0-0-1,
   * so the exemption wins wherever it applies without an `!important` anywhere
   * near somebody's book.
   */
  'body,[data-bf-cat]{-webkit-user-select:none;user-select:none}',
  '[data-bf-edit]{-webkit-user-select:text;user-select:text}',
  '[data-bf-cut]{opacity:.42;text-decoration:line-through;'
  + 'background-image:'
  + 'linear-gradient(to top right,transparent 49.5%,rgba(178,54,38,.8) 49.5%,'
  + 'rgba(178,54,38,.8) 50.5%,transparent 50.5%),'
  + 'linear-gradient(to bottom right,transparent 49.5%,rgba(178,54,38,.8) 49.5%,'
  + 'rgba(178,54,38,.8) 50.5%,transparent 50.5%)}',
  // Doubled and LAST for the same reason the selection rule is doubled: the
  // block being typed into is also selected and also under the pointer, and it
  // has to keep saying "your caret is here" over both of them.
  '[data-bf-cat][data-bf-edit]{outline:2px solid #2f7d4f;outline-offset:2px;'
  + 'background-color:rgba(47,125,79,.09);cursor:text}',
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
    window.parent.postMessage({
      type: 'foundry:block-click',
      bf: !!bf,
      tag: tag,
      index: index,
      // Where the words came from, for the same reason every other message in
      // this mode now carries it — see SRC below. Null for an element the cast
      // book did not stamp, which is every block of a book foundry did not make.
      src: target.getAttribute ? target.getAttribute('data-bf-src') : null,
    }, '*');
  }, true);

  // ═══ select mode ═══════════════════════════════════════════════════════════
  //
  // Everything past this line is dead until the parent says otherwise. Nothing
  // is added to the document, no attribute is written and every listener below
  // returns on its first line while MODE is false — which is the state a frame
  // loads in, every time, including after the reload an edit elsewhere causes.

  var CAT = 'data-bf-cat';
  var ID = 'data-bf-id';
  /*
   * data-bf-src — THE ONE ATTRIBUTE THAT NAMES SOMETHING OUTSIDE THIS BOOK.
   *
   * data-bf-id names an element of a chapter file: p47-3 is the third element
   * the emitter wrote for page 47, and it is the name every write in this mode
   * uses because that is what main's setters address. It says nothing about the
   * blocks the MODEL answered, and the whole ledger — every strike, every
   * relabel, every chapter mark this program keeps — is keyed to those, as
   * page:order, or page:order:part for one piece of an answer element.
   *
   * So a person striking a footnote here changed their chapter file and nothing
   * else: the decision was invisible to the ledger, invisible to the export, and
   * gone the next time the book was cast. The emitter now writes both names on
   * every stamped element (src/vlm/dots-book.ts, stampSrc), and this file
   * carries the second one out with every id it reports. The parent is what
   * turns it into a decision; the frame's job is only to say, of the block the
   * user actually pointed at, which banked answers it was made of.
   *
   * NULL AND NOT AN OMISSION when the attribute is absent. A book cast before
   * provenance existed, and any EPUB foundry did not make, is exactly this case:
   * the gesture still lands in the chapter, and the parent skips the half it
   * cannot record rather than guessing at a block.
   */
  var SRC = 'data-bf-src';
  var CUT = 'data-bf-cut';
  var SEL = 'data-bf-sel';
  var EDIT = 'data-bf-edit';
  var INLINE = /^(${[...INLINE_TAGS].join('|')})$/i;

  var mode = false;
  // The stylesheet is held by reference rather than found by id: an XHTML
  // document is XML, and looking an element up by id in one is a question with
  // more history than it is worth when the node is right here.
  var sheet = null;
  /*
   * THE SELECTION IS A SET — an array of elements, in the order they joined it.
   *
   * It was one element until the marquee existed, and every gesture in this
   * file now reads this list instead: Delete strikes all of them, the
   * inspector's relabel relabels all of them, and both leave as ONE batch with
   * one write behind it. An array rather than a Set object because this script
   * is written in the dialect a book's own document can parse without
   * surprises, and because order is worth keeping — the block that was clicked
   * first is the one an editing gesture means.
   */
  var picked = [];
  var editing = null;
  var editedFrom = '';
  /*
   * The marquee in flight: where it started, in DOCUMENT coordinates, and every
   * block's box measured ONCE at that moment.
   *
   * PAGE COORDINATES AND NOT VIEWPORT ONES, so a wheel scroll in the middle of a
   * drag does not shear the rectangle away from what it is over. And measured
   * once, because getBoundingClientRect on three hundred blocks is three
   * hundred forced layouts, and a mousemove handler that does that sixty times a
   * second is a drag that stutters — nothing in the document moves while a
   * rectangle is being dragged over it, so the measurement cannot go stale.
   */
  var marquee = null;
  var box = null;
  /*
   * A finished marquee eats the click that follows it.
   *
   * A mouseup on empty space is followed by a click on whatever ancestor both
   * ends share, and select mode's click handler reads a click outside every
   * block as "put the selection down" — so without this, every marquee would
   * select thirty blocks and then immediately deselect them. BookForge guards
   * the same collision with a 100 ms timestamp; a flag is the same idea without
   * a clock in it, and it is cleared on the next mousedown so a click that never
   * arrives cannot eat a later one.
   */
  var dropClick = false;

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

  /**
   * Make this list the selection — paint it, and say so.
   *
   * The selection is the one piece of state the frame owns, because it is the
   * only one that is not a fact about the book: it dies with the frame, nothing
   * on disk records it, and — unlike everything else in this mode — it is NOT
   * in the parent's undo ledger. BookForge put its selection in its history and
   * has to special-case it in three places for the privilege.
   *
   * A NO-OP IS SILENT, and that is what makes the live marquee affordable: the
   * rectangle is redrawn on every mousemove, but the set it catches changes
   * only when it crosses a block's edge, so the message below is posted a
   * handful of times per drag rather than sixty times a second.
   */
  function applySelection(next) {
    if (sameSelection(picked, next)) return;
    for (var i = 0; i < picked.length; i += 1) {
      if (next.indexOf(picked[i]) < 0) picked[i].removeAttribute(SEL);
    }
    for (var j = 0; j < next.length; j += 1) next[j].setAttribute(SEL, '1');
    picked = next;
    announce();
  }

  function sameSelection(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
    return true;
  }

  /**
   * What is selected, on its way to the inspector.
   *
   * THE CATEGORY RIDES ALONG, because the inspector is a pane away in the shell
   * and has no way to read this document. Without it the Category section could
   * offer to relabel the selection but could not show which label it already
   * carries — the one thing a person needs to see before they change it. With
   * more than one block selected it is the category they SHARE, and null the
   * moment two of them disagree: a marked row over a mixed selection would be
   * the panel asserting something about blocks it is wrong about.
   *
   * A BLOCK WITH NO data-bf-id IS PAINTED BUT NOT NAMED. It is selectable —
   * refusing to outline it would leave a curator clicking a paragraph that
   * never lights up, with nothing on screen saying why — and every gesture that
   * would WRITE it refuses by name (see named). A stamped book, which is what
   * turning the mode on guarantees, has none of these.
   */
  function announce() {
    var ids = [];
    var srcs = [];
    var cat = null;
    var mixed = false;
    for (var i = 0; i < picked.length; i += 1) {
      var id = picked[i].getAttribute(ID);
      // PUSHED TOGETHER OR NOT AT ALL. The two arrays are read by index — the
      // src of ids[n] is srcs[n] — so a block that contributes no id must
      // contribute no src either, or every name after it would be reported
      // against the wrong block's provenance.
      if (id) {
        ids.push(id);
        srcs.push(picked[i].getAttribute(SRC));
      }
      var mine = picked[i].getAttribute(CAT);
      if (i === 0) cat = mine;
      else if (mine !== cat) mixed = true;
    }
    post({ type: 'foundry:block-selected', ids: ids, srcs: srcs, cat: mixed ? null : cat });
  }

  /**
   * A click on a block, with or without a modifier held.
   *
   * SHIFT OR CTRL/CMD EXTENDS, a plain click REPLACES — the rule every list in
   * every application has, and the one Owen is already using in BookForge's
   * picker. Extending TOGGLES, so the same modified click takes a block back out
   * of the selection; there is otherwise no way to correct a marquee that caught
   * one paragraph too many except starting the whole drag again.
   *
   * A plain click on the block that is ALREADY the whole selection puts it down.
   * That is the gesture that makes a selection feel like a toggle rather than a
   * trap, and it is kept from before the selection was a set — but only for a
   * selection of one, because clicking one block out of thirty means "just this
   * one now", not "none of them".
   */
  function clickSelect(target, extend) {
    var at = picked.indexOf(target);
    if (extend) {
      var next = picked.slice();
      if (at >= 0) next.splice(at, 1);
      else next.push(target);
      applySelection(next);
      return;
    }
    applySelection(picked.length === 1 && at === 0 ? [] : [target]);
  }

  // ── The marquee ────────────────────────────────────────────────────────────
  //
  // Drag a rectangle over empty space and everything it touches is selected. It
  // is the gesture the whole of multi-select exists for: striking the four
  // flyleaf stamps at the top of a scan is one sweep rather than four clicks and
  // four writes.
  //
  // IT CANNOT START ON A BLOCK — a press inside a paragraph is a click, and a
  // marquee that began there would make every click a zero-sized drag with a
  // suppression rule to unpick afterwards. BookForge's block marquee does start
  // on blocks and pays for it with a 5-pixel threshold AND a 100 ms clock to eat
  // the click that follows; starting only on the gaps costs a closest() and
  // removes both.

  /** As far as the pointer may move before a press stops being a click. */
  var MARQUEE_SLOP = 4;

  function scrollLeft() {
    return window.pageXOffset || document.documentElement.scrollLeft || 0;
  }

  function scrollTop() {
    return window.pageYOffset || document.documentElement.scrollTop || 0;
  }

  /**
   * Every block's box, in document coordinates, as it stands right now.
   *
   * Zero-sized boxes are dropped: a block inside display:none front matter has
   * no area, and a rectangle dragged anywhere on the page would "intersect" a
   * point at the origin.
   */
  function measureBlocks() {
    var all = document.querySelectorAll('[' + CAT + ']');
    var ox = scrollLeft();
    var oy = scrollTop();
    var out = [];
    for (var i = 0; i < all.length; i += 1) {
      var r = all[i].getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      out.push({
        el: all[i],
        left: r.left + ox,
        top: r.top + oy,
        right: r.right + ox,
        bottom: r.bottom + oy,
      });
    }
    return out;
  }

  /**
   * The feedback rectangle, and the one measurement that makes it land where the
   * pointer is.
   *
   * position:absolute resolves against the nearest POSITIONED ancestor, and a
   * book whose own stylesheet says body{position:relative} — or which sets a
   * transform on it — would otherwise draw the box a page margin away from the
   * hand dragging it. So the element's own origin is MEASURED once, by asking
   * where it lands at 0,0, rather than assumed to be the document's.
   */
  function openBox() {
    if (!box) {
      box = document.createElement('div');
      box.setAttribute('data-bf-marquee', '1');
      (document.body || document.documentElement).appendChild(box);
    }
    box.style.left = '0px';
    box.style.top = '0px';
    box.style.width = '0px';
    box.style.height = '0px';
    var origin = box.getBoundingClientRect();
    marquee.originX = origin.left + scrollLeft();
    marquee.originY = origin.top + scrollTop();
  }

  function closeBox() {
    if (box && box.parentNode) box.parentNode.removeChild(box);
    box = null;
  }

  function marqueeDown(event) {
    if (!mode || editing) return;
    // Left button only. A right-click is the context menu's and a middle click
    // is the platform's scroll gesture; hijacking either would be this script
    // taking something the browser already owns.
    if (event.button !== 0) return;
    dropClick = false;
    var start = event.target instanceof Element ? event.target : null;
    if (!start) return;
    if (start.closest('[' + CAT + ']')) return;
    var x = event.clientX + scrollLeft();
    var y = event.clientY + scrollTop();
    marquee = {
      x: x,
      y: y,
      moved: false,
      originX: 0,
      originY: 0,
      // What the selection was when the drag began. A modified drag ADDS to it;
      // an unmodified one replaces it — and either way the base has to be
      // remembered, because the live repaint recomputes the whole set on every
      // move rather than accumulating one.
      base: (event.shiftKey || event.ctrlKey || event.metaKey) ? picked.slice() : [],
      boxes: measureBlocks(),
    };
    openBox();
    // This is what stops Chromium starting its own text sweep under ours. The
    // stylesheet's user-select:none covers a drag that begins inside a
    // paragraph, where preventing the default would break the click.
    event.preventDefault();
  }

  function marqueeMove(event) {
    if (!marquee) return;
    /*
     * THE BUTTON CAME BACK UP SOMEWHERE THIS FRAME CANNOT HEAR.
     *
     * The book fills its pane, so a drag that ends over the toolbar, the
     * inspector or another column releases outside this document and the
     * mouseup is delivered to the shell instead. Without this the rectangle
     * would stay stuck to the pointer, still selecting, until the next click.
     * event.buttons is the live state rather than the event's own button, so the
     * first move back inside finishes the drag that already ended.
     */
    if (event.buttons === 0) { marqueeUp(); return; }
    var x = event.clientX + scrollLeft();
    var y = event.clientY + scrollTop();
    var left = Math.min(marquee.x, x);
    var top = Math.min(marquee.y, y);
    var width = Math.abs(x - marquee.x);
    var height = Math.abs(y - marquee.y);
    if (!marquee.moved && (width > MARQUEE_SLOP || height > MARQUEE_SLOP)) marquee.moved = true;
    if (!marquee.moved) return;
    if (box) {
      box.style.left = (left - marquee.originX) + 'px';
      box.style.top = (top - marquee.originY) + 'px';
      box.style.width = width + 'px';
      box.style.height = height + 'px';
    }
    applySelection(caught(left, top, left + width, top + height, marquee.base, marquee.boxes));
  }

  /**
   * Which blocks a rectangle has caught.
   *
   * ANY OVERLAP, never containment, and the difference is the whole usability of
   * the gesture: a paragraph is routinely taller than the drag somebody makes
   * over it, so a containment test would mean sweeping a column of prose and
   * catching nothing. It is the test BookForge's picker uses too — two boxes
   * overlap when they overlap on BOTH axes — with strict comparisons, so a
   * rectangle that merely touches an edge does not count.
   */
  function caught(left, top, right, bottom, base, boxes) {
    var next = base.slice();
    for (var i = 0; i < boxes.length; i += 1) {
      var b = boxes[i];
      if (b.left >= right || b.right <= left) continue;
      if (b.top >= bottom || b.bottom <= top) continue;
      if (next.indexOf(b.el) < 0) next.push(b.el);
    }
    return next;
  }

  function marqueeUp() {
    if (!marquee) return;
    var moved = marquee.moved;
    marquee = null;
    closeBox();
    // Only a real drag eats the click. A press and release that never moved IS a
    // click on empty space, and clearing the selection is exactly what it means.
    if (moved) dropClick = true;
  }

  /**
   * How many blocks of each category this chapter holds, and how many of them
   * are already struck.
   *
   * COUNTED IN THE FRAME rather than read off the file by main, for the reason
   * everything else in here is: the frame is the only thing that can see the
   * document. Counting it in main would be a second reading of the same chapter
   * that could disagree with the one on screen — and the numbers are about what
   * the user is looking at, which is exactly what this DOM is.
   *
   * Posted after every gesture that can change one of them, so the inspector's
   * legend never says nine while the page shows eight.
   */
  function countCategories() {
    if (!mode) return;
    var all = document.querySelectorAll('[' + CAT + ']');
    var counts = {};
    var struck = {};
    for (var i = 0; i < all.length; i += 1) {
      var name = all[i].getAttribute(CAT) || '';
      counts[name] = (counts[name] || 0) + 1;
      if (all[i].hasAttribute(CUT)) struck[name] = (struck[name] || 0) + 1;
    }
    post({ type: 'foundry:category-counts', counts: counts, struck: struck });
  }

  /**
   * Give EVERY selected block a different category.
   *
   * THE WHOLE SELECTION, because that is what a selection is for: thirty
   * paragraphs the model called body text and a curator can see are footnotes
   * are one marquee and one click on a row, not thirty of each.
   *
   * IT CHANGES THE LABEL AND NOT THE SHAPE. A paragraph relabelled "footnote"
   * is still a <p> in the prose, in the place the page printed it; it does not
   * become an <aside> and it does not move into the footnotes section. That
   * re-shaping is foundry epub-final's job and is not in this app at all —
   * somebody reading this function will otherwise assume the two go together.
   *
   * NAMED FIRST, WRITTEN SECOND, like every batch in this file: one block
   * without a data-bf-id refuses the whole gesture rather than relabelling
   * the others and reporting a number that describes neither half.
   *
   * The colour repaints itself: the stylesheet keys off the attribute, so
   * setting it here IS the paint, and there is no second list to reconcile.
   */
  function relabel(category) {
    if (picked.length === 0) {
      refuse('Nothing is selected, so there is no block to relabel. Click one first, or drag a '
        + 'rectangle over several.');
      return;
    }
    var ids = [];
    var srcs = [];
    for (var i = 0; i < picked.length; i += 1) {
      var id = named(picked[i]);
      if (id === null) return;
      ids.push(id);
      srcs.push(picked[i].getAttribute(SRC));
    }
    if (editing) commitEdit();
    for (var j = 0; j < picked.length; j += 1) picked[j].setAttribute(CAT, category);
    post({ type: 'foundry:blocks-relabelled', ids: ids, srcs: srcs, cat: category });
    // The selection has not moved but what it IS has, and the inspector marks
    // the row the selection already carries. Without this it would go on
    // pointing at the category those blocks were before the click.
    announce();
    countCategories();
  }

  /**
   * Strike every block of one category in this chapter — or bring them all back.
   *
   * ONE GESTURE, and it is written to behave like one: the ids are collected and
   * checked BEFORE a single attribute moves, so a chapter holding one block
   * without a name refuses the whole batch rather than striking half of it and
   * reporting a number that is not what happened.
   *
   * It TOGGLES on what is there. If anything of that category is still standing
   * the batch strikes; if all of them are already struck it brings them back —
   * which is what makes it feel undoable with the tool that did it, and is the
   * same rule Delete follows on one block.
   */
  function cutCategory(category) {
    var all = document.querySelectorAll('[' + CAT + ']');
    var mine = [];
    for (var i = 0; i < all.length; i += 1) {
      if (all[i].getAttribute(CAT) === category) mine.push(all[i]);
    }
    if (mine.length === 0) {
      refuse('No block in this chapter carries data-bf-cat="' + category + '", so there is '
        + 'nothing here to strike.');
      return;
    }
    var ids = [];
    var srcs = [];
    var cut = false;
    for (var j = 0; j < mine.length; j += 1) {
      var id = mine[j].getAttribute(ID);
      if (!id) {
        refuse('One of the ' + mine.length + ' blocks carries no data-bf-id, so this chapter '
          + 'cannot be struck by category without losing track of which block was which. '
          + 'Close select mode and open it again to stamp this book.');
        return;
      }
      ids.push(id);
      srcs.push(mine[j].getAttribute(SRC));
      if (!mine[j].hasAttribute(CUT)) cut = true;
    }
    if (editing) commitEdit();
    for (var k = 0; k < mine.length; k += 1) {
      if (cut) mine[k].setAttribute(CUT, '1');
      else mine[k].removeAttribute(CUT);
    }
    // THE SAME MESSAGE A SELECTION'S DELETE SENDS, carrying the category only so
    // the parent can name it in the notice. One message means one write door
    // and one undo entry shape for every strike this mode can make.
    post({ type: 'foundry:blocks-cut', ids: ids, srcs: srcs, cut: cut, cat: category });
    countCategories();
  }

  /**
   * Strike — or bring back — everything that is selected.
   *
   * IT TOGGLES ON WHAT IS THERE, the same rule select-all-by-category follows:
   * if anything in the selection is still standing the whole set is struck, and
   * only when every one of them is already struck does the gesture bring them
   * back. Delete on a mixed selection that un-struck half of it and struck the
   * other half would be a keypress nobody could predict.
   */
  function cutSelection() {
    if (picked.length === 0) return;
    var ids = [];
    var srcs = [];
    for (var i = 0; i < picked.length; i += 1) {
      var id = named(picked[i]);
      if (id === null) return;
      ids.push(id);
      srcs.push(picked[i].getAttribute(SRC));
    }
    var cut = false;
    for (var j = 0; j < picked.length; j += 1) {
      if (!picked[j].hasAttribute(CUT)) { cut = true; break; }
    }
    if (editing) commitEdit();
    for (var k = 0; k < picked.length; k += 1) {
      if (cut) picked[k].setAttribute(CUT, '1');
      else picked[k].removeAttribute(CUT);
    }
    post({ type: 'foundry:blocks-cut', ids: ids, srcs: srcs, cut: cut, cat: null });
    countCategories();
  }

  function named(element) {
    var id = element.getAttribute(ID);
    if (id) return id;
    refuse('That block carries no data-bf-id, so there is no name to record a change against. '
      + 'Close select mode and open it again to stamp this book.');
    return null;
  }

  /*
   * EVERY MARK IN THIS MODE IS PAINTED IN THE FRAME FIRST and the write is
   * posted behind it, which is the whole feel of select mode: at a cut a second
   * the user is holding Delete down a row of blocks, and a mode that waited for
   * a disk round trip before each one would feel broken. If main refuses, the
   * parent reloads this frame and the file repaints the truth over the guess —
   * which works because the cut lives in the document rather than in anything
   * this script remembers.
   */

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
    // An edit is about ONE block, so it narrows the selection to that block —
    // otherwise the next Delete would strike the thirty a marquee had caught
    // while the caret sat in one of them.
    applySelection([element]);
    editing = element;
    // The parent needs to know a caret is in the page: Ctrl+Z means "undo my
    // typing" while this is true and "undo the last thing I did to the book"
    // the rest of the time, and there is no way to tell from out there.
    post({ type: 'foundry:block-editing', on: true });
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
    post({ type: 'foundry:block-editing', on: false });
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
    /*
     * "was" IS WHAT MAKES CANCEL POSSIBLE. Deleting a footnote's reference
     * number is a legal edit, and the parent then has to ask whether the
     * footnote itself should go — with a third answer, "put the number back",
     * which is only answerable if somebody still holds the markup that had it.
     * Main does not: it wrote the new text and the old text is gone. So the
     * frame — which captured it at beginEdit to know whether anything changed
     * at all — hands it over, and the parent writes it back if the user says so.
     */
    post({ type: 'foundry:block-edited', id: id, html: html, was: editedFrom });
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
    if (on) { addStyles(); countCategories(); return; }
    commitEdit();
    applySelection([]);
    // A drag in flight when the mode is switched off would leave its rectangle
    // on the page with nothing left to listen for the mouseup that removes it.
    marquee = null;
    closeBox();
    removeStyles();
  }

  window.addEventListener('message', function (event) {
    // The mirror image of the parent's own gate: it checks that a message came
    // from this frame's window, and this checks that one came from the window
    // holding this frame. A sandboxed origin is opaque, so SOURCE is the only
    // identity either side has to check against.
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data) return;
    if (data.type === 'foundry:select-mode') { setMode(data.on === true); return; }
    /*
     * PUT THE READER BACK, and it is deliberately ABOVE the mode gate below.
     *
     * The frame is re-served for an edit whether or not anybody is curating —
     * an editor flush writes a chapter and the <iframe> is pointed at a new
     * revision of it — so a restore that needed select mode would leave the
     * ordinary reading case exactly as broken as it was. Nothing about putting
     * a document back where it already was is a power select mode confers.
     */
    if (data.type === 'foundry:scroll-restore') {
      restoreScroll(data.x, data.y);
      return;
    }
    /*
     * EVERYTHING ELSE THE PARENT CAN ASK FOR NEEDS THE MODE ON. These are the
     * inspector's gestures — relabel the selected block, strike a whole
     * category — and with the mode off there is no selection, no stylesheet and
     * no reason for the parent to be asking. A command that acted anyway would
     * be select mode's power available to a book nobody put in select mode.
     */
    if (!mode) return;
    if (data.type === 'foundry:relabel') {
      if (typeof data.cat === 'string') relabel(data.cat);
      return;
    }
    if (data.type === 'foundry:cut-category') {
      if (typeof data.cat === 'string') cutCategory(data.cat);
      return;
    }
    if (data.type === 'foundry:mark-note') {
      if (typeof data.noteId === 'string') markNote(data.noteId, data.cut === true);
      return;
    }
    /*
     * AN UNDO REPAINTING ITSELF.
     *
     * The parent's ledger replays the ORIGINAL setter with the old value, so
     * what lands on disk is one attribute on one start tag — exactly what a cut
     * or a relabel writes. The page therefore repaints the way a cut does: the
     * attribute is flipped here and the CSS follows it, with no reload and no
     * reader thrown back to the top of the chapter. (A word edit is the
     * exception and does reload, because there is no attribute that would put
     * the sentence back.)
     *
     * A ROW FOR A CHAPTER THIS FRAME IS NOT SHOWING IS SILENTLY SKIPPED, and
     * that is right rather than lax: the write landed in the file either way,
     * and when the user navigates there the document repaints from the truth.
     */
    if (data.type === 'foundry:mark-blocks') {
      if (Array.isArray(data.ids)) markBlocks(data.ids, data.cut === true);
      return;
    }
    if (data.type === 'foundry:mark-labels') {
      if (Array.isArray(data.ids) && typeof data.cat === 'string') {
        markLabels(data.ids, data.cat);
      }
      return;
    }
    /*
     * CTRL+Z WHILE A CARET IS IN THE PAGE MEANS THE TYPING, not the book.
     *
     * The chord is a menu accelerator, so main swallows the keypress and the
     * frame never sees it — the parent has to hand it back. It only ever sends
     * this while the frame has told it a block is being edited, and what it
     * asks for is the browser's own undo of a contenteditable, which is the
     * only thing in this frame that has a text history at all.
     */
    if (data.type === 'foundry:undo-typing') {
      if (editing) document.execCommand(data.redo === true ? 'redo' : 'undo');
      return;
    }
    if (data.type === 'foundry:recount') countCategories();
  });

  /**
   * Paint the strike on a footnote the parent has just marked in the file.
   *
   * THE ONLY MARK IN THIS MODE THAT IS PAINTED AFTER ITS WRITE, and it is the
   * only one whose write was not started by a gesture in here: a dialog asked,
   * the user answered, main wrote, and this catches the page up. The note is
   * usually far below whatever the reader is looking at, so a frame reload to
   * show it would move the page for something nobody can see.
   *
   * Found with an ATTRIBUTE SELECTOR rather than getElementById, because these
   * documents are XHTML — XML, where "which attribute is the id" is a question
   * with more history than it is worth when [id=…] simply answers it. The id
   * came out of an href foundry itself wrote, so it needs escaping only against
   * quotes, and a note whose id carries one is not a book this app produced.
   */
  /**
   * The element carrying one data-bf-id, or null.
   *
   * An ATTRIBUTE SELECTOR for the reason markNote uses one: these documents are
   * XHTML, where "which attribute is the id" has more history than it is worth,
   * and data-bf-id is not the XML id anyway. The value is checked for quoting
   * before it is put in a selector — it arrives from the parent, which got it
   * from this frame, but a name that could close the selector is not a name
   * foundry ever wrote.
   */
  function byBlockId(blockId) {
    if (typeof blockId !== 'string') return null;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(blockId)) return null;
    return document.querySelector('[' + ID + '="' + blockId + '"]');
  }

  function markBlocks(ids, cut) {
    for (var i = 0; i < ids.length; i += 1) {
      var element = byBlockId(ids[i]);
      if (!element) continue;
      if (cut) element.setAttribute(CUT, '1');
      else element.removeAttribute(CUT);
    }
    countCategories();
  }

  function markLabels(ids, category) {
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(category)) return;
    for (var i = 0; i < ids.length; i += 1) {
      var element = byBlockId(ids[i]);
      if (element) element.setAttribute(CAT, category);
    }
    // The selection has not moved but what it IS may have, and the inspector
    // marks the row the selection carries.
    announce();
    countCategories();
  }

  function markNote(noteId, cut) {
    if (noteId.indexOf('"') >= 0 || noteId.indexOf('\\\\') >= 0) return;
    var note = document.querySelector('[id="' + noteId + '"]');
    if (!note) return;
    if (cut) note.setAttribute(CUT, '1');
    else note.removeAttribute(CUT);
    countCategories();
  }

  // The marquee's three, on the DOCUMENT rather than on any element: the drag
  // has to keep tracking after the pointer has left whatever it started over,
  // and a book's own markup is not a place to hang a listener.
  document.addEventListener('mousedown', marqueeDown, true);
  document.addEventListener('mousemove', marqueeMove, true);
  document.addEventListener('mouseup', marqueeUp, true);

  document.addEventListener('click', function (event) {
    if (!mode) return;
    // The click that follows a real marquee drag. Eaten here and nowhere else,
    // because the reporter's own click-to-source listener below is allowed to
    // see it — a drag over a paragraph is still a place in the source.
    if (dropClick) { dropClick = false; return; }
    var start = event.target instanceof Element ? event.target : null;
    if (!start) return;
    // A click INSIDE the block being edited is a caret being placed. Anything
    // else here would fight the thing the user is doing.
    if (editing && editing.contains(start)) return;
    var target = start.closest('[' + CAT + ']');
    if (!target) { applySelection([]); return; }
    clickSelect(target, event.shiftKey || event.ctrlKey || event.metaKey);
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
    if (picked.length === 0) return;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      cutSelection();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      // EDITING IS A ONE-BLOCK GESTURE and says so rather than picking one of
      // thirty. A contenteditable can only hold one caret, and guessing which
      // of a marquee's blocks was meant is exactly the kind of quiet choice
      // this app does not make (ARCHITECTURE section 8).
      if (picked.length > 1) {
        refuse(picked.length + ' blocks are selected, and words are edited one block at a time. '
          + 'Click the one you mean, then press Enter.');
        return;
      }
      beginEdit(picked[0], true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      applySelection([]);
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

  // ═══ where the reader is ═══════════════════════════════════════════════════
  //
  // THE FRAME IS RELOADED FOR THINGS THE READER NEVER ASKED FOR. A word edit has
  // no attribute to flip, so the chapter is written and re-served; a refused
  // write is corrected by re-serving the truth over the guess; the stamping pass
  // re-serves the whole document. Every one of those lands the page at offset
  // zero, and somebody who struck a footnote two hundred lines down is suddenly
  // reading the chapter heading — which is the complaint in the user's own
  // words. The cost is not cosmetic: a curation pass over a long chapter becomes
  // a scroll back to the place after every single gesture.
  //
  // THE POSITION CANNOT BE READ FROM OUT THERE. The origin is opaque, so the
  // shell can no more touch this document's scrollTop than it can hit-test a
  // paragraph — the same wall the marquee, the key handler and the selection are
  // all on the wrong side of. So the frame SAYS where it is, and the shell says
  // where to go back to after the reload it caused.
  //
  // IT REPORTS WITH THE MODE OFF, deliberately. A reload after an editor flush
  // moves the page whether or not anybody is curating, and a channel that only
  // worked in select mode would fix half of one complaint and leave the other
  // half to be rediscovered.

  /** Trailing edge, so what is reported is where the reader STOPPED, not passed. */
  var SCROLL_REPORT_MS = 150;
  var scrollTimer = null;

  function reportScroll() {
    scrollTimer = null;
    post({ type: 'foundry:scroll-report', x: scrollLeft(), y: scrollTop() });
  }

  window.addEventListener('scroll', function () {
    // Throttled and not debounced: a message per scroll event is sixty a second
    // through postMessage for a gesture whose answer only has to be roughly
    // right, and the shell only ever reads the LAST one anyway.
    if (scrollTimer !== null) return;
    scrollTimer = setTimeout(reportScroll, SCROLL_REPORT_MS);
  }, true);

  /**
   * Go back to where the reader was — after the layout has settled, not before.
   *
   * A CHAPTER'S HEIGHT IS NOT SETTLED WHEN THIS SCRIPT RUNS. The reporter is
   * appended at the end of <body>, so it executes with the images above it still
   * arriving, and a scrollTo issued at that moment is CLAMPED against a document
   * that has not finished growing — the reader lands somewhere above where they
   * were, which looks exactly like the bug this exists to fix. So the scroll is
   * applied once the document says it is complete, and again on the following
   * frame: a late image is a second growth spurt, and the second call costs
   * nothing at all when nothing moved.
   *
   * The numbers are checked here as well as in the shell. They arrive over the
   * same channel as everything else, and a NaN would scroll this book to the top
   * as surely as no message at all.
   */
  function restoreScroll(x, y) {
    if (typeof x !== 'number' || typeof y !== 'number') return;
    if (!isFinite(x) || !isFinite(y) || x < 0 || y < 0) return;
    var apply = function () {
      window.scrollTo(x, y);
      requestAnimationFrame(function () { window.scrollTo(x, y); });
    };
    if (document.readyState === 'complete') requestAnimationFrame(apply);
    else window.addEventListener('load', function () { requestAnimationFrame(apply); }, { once: true });
  }

  // The frame is going away — a chapter change, a reload after an edit
  // elsewhere. Best effort, and the only chance a half-typed edit gets.
  //
  // AND THE LAST CHANCE TO SAY WHERE THE READER WAS. A throttled report is up to
  // 150 ms behind the scrollbar, which is a paragraph or two on a fast flick;
  // the pending one is cancelled and sent now so the position the shell restores
  // is the one the page actually had when it went away. Best effort in the
  // honest sense — a document being torn down may not get its message out — and
  // the throttled reports are what makes that acceptable rather than fatal.
  window.addEventListener('pagehide', function () {
    commitEdit();
    if (scrollTimer !== null) clearTimeout(scrollTimer);
    reportScroll();
  });

  // The handshake. A frame reloads for reasons the parent did not ask for, and
  // it comes back with the mode off; saying so is what lets the parent turn it
  // straight back on without watching for load events it cannot always trust.
  // It is also the shell's cue to hand back the scroll position: this message is
  // the one moment both sides agree a new document exists.
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
