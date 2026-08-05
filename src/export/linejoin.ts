/**
 * linejoin — laid-out lines become flowing prose.
 *
 * A line out of the band pipeline is where the PAGE broke the text, not where
 * the author did. Carrying those breaks into the EPUB carries page geometry
 * into TTS, which reads the ragged wrap as if it were meant. So lines join with
 * a single space.
 *
 * The exception is a wrap hyphen, and this is the discipline BookForge's
 * `shared/text/line-join.ts` exists to protect. Its comments name the wrong
 * answer explicitly: the naive strip-and-weld — see a hyphen at a line end,
 * delete it, close the gap — turns `far-right` into `farright`, `self-defense`
 * into `selfdefense`, `anti-Communist` into `antiCommunist`. Measured on
 * Hanebrink's *A Specter Haunting Europe*, all 37 provable pairs were genuine
 * compounds followed by a lowercase letter, so the "next character is
 * lowercase" heuristic would have been wrong every single time.
 *
 * What this module does instead: the hyphen is JOIN EVIDENCE, and the pair is
 * decided against **the book's own vocabulary** (`../paragraphs/hyphen.ts`).
 * The word is healed only when the joined form is attested elsewhere in the
 * same book. Unproven keeps the hyphen — which is the recoverable direction,
 * because a reader meeting `inter-national` sees a typographic artefact, while
 * a reader meeting `farright` sees a word that was never written and cannot
 * tell what it replaced.
 *
 * A SOFT HYPHEN (U+00AD) at a line end is the same break with none of the
 * doubt, and it takes the short path: it joins unconditionally, with no
 * attestation lookup and no hyphen left behind. `../paragraphs/hyphen.ts`
 * carries the argument and the measurement; the consequence here is that
 * `totali<U+00AD>` / `tarianism` becomes `totalitarianism` rather than the
 * `totali tarianism` this module used to emit. Soft hyphens that did NOT fall
 * on a break are invisible formatting and leave with them.
 */
import type { HyphenAttestation } from '../paragraphs/hyphen.js';
import {
  endsWithSoftHyphen, proveHyphenVerdict, stripSoftHyphens, wrapHyphenHalves,
} from '../paragraphs/hyphen.js';

export interface JoinedText {
  text: string;
  /** Wrap-hyphenated words rejoined because the book attested the joined form. */
  healed: number;
  /** Wrap hyphens kept, because the join was unproven or the compound was attested. */
  keptHyphens: number;
  /** Line breaks that fell on a soft hyphen and were closed up unconditionally. */
  softJoined: number;
  /**
   * Soft hyphens removed without a break to close: the typesetter's other
   * hyphenation points, invisible on the page and meaningless to a narrator.
   */
  softStripped: number;
}

/**
 * Join laid-out lines into one run of prose.
 *
 * Lines are trimmed and empty ones dropped before joining: leading and trailing
 * whitespace on a recognized line is an artefact of the crop, not of the text,
 * and a blank line inside a block would otherwise produce a double space.
 */
export function joinLines(lines: readonly string[], attestation: HyphenAttestation): JoinedText {
  const parts = lines.map(l => l.trim()).filter(l => l.length > 0);
  if (parts.length === 0) {
    return { text: '', healed: 0, keptHyphens: 0, softJoined: 0, softStripped: 0 };
  }

  let text = parts[0];
  let healed = 0;
  let keptHyphens = 0;
  let softJoined = 0;

  for (let i = 1; i < parts.length; i++) {
    const prev = parts[i - 1];
    const cur = parts[i];

    if (endsWithSoftHyphen(prev)) {
      // A discretionary hyphenation point the line break landed on. The word is
      // cut and nothing else is possible, so close the gap and drop the mark —
      // no lookup, no counter-example to fear. `text` ends with the soft hyphen
      // because `prev` was trimmed and U+00AD is not whitespace.
      text = text.slice(0, -1) + cur;
      softJoined++;
      continue;
    }

    const halves = wrapHyphenHalves(prev, cur);
    if (!halves) {
      text += ` ${cur}`;
      continue;
    }

    if (proveHyphenVerdict(halves.head, halves.tail, attestation) === 'join') {
      // The book attests the joined form: drop the hyphen and close the gap.
      // `text` ends with that hyphen because `prev` was trimmed.
      text = text.slice(0, -1) + cur;
      healed++;
    } else {
      // Unproven, or the compound itself is attested. Keep the hyphen and close
      // the gap — `far-` + `right` is `far-right`, never `far- right`.
      text += cur;
      keptHyphens++;
    }
  }

  // Whatever soft hyphens are left fell inside a line rather than on a break.
  // They are invisible on the page and they must not reach a narrator, so they
  // go — counted, because a silent removal is not a removal anybody can check.
  const stripped = stripSoftHyphens(text);
  const softStripped = text.length - stripped.length;

  return { text: stripped, healed, keptHyphens, softJoined, softStripped };
}
