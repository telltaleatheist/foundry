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
 */
import type { HyphenAttestation } from '../paragraphs/hyphen.js';
import { proveHyphenVerdict, wrapHyphenHalves } from '../paragraphs/hyphen.js';

export interface JoinedText {
  text: string;
  /** Wrap-hyphenated words rejoined because the book attested the joined form. */
  healed: number;
  /** Wrap hyphens kept, because the join was unproven or the compound was attested. */
  keptHyphens: number;
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
  if (parts.length === 0) return { text: '', healed: 0, keptHyphens: 0 };

  let text = parts[0];
  let healed = 0;
  let keptHyphens = 0;

  for (let i = 1; i < parts.length; i++) {
    const prev = parts[i - 1];
    const cur = parts[i];
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

  return { text, healed, keptHyphens };
}
