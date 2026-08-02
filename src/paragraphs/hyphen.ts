/**
 * hyphen — the wrap-hyphen contract, ported from BookForgeApp's
 * `shared/text/line-join.ts` and `electron/ai-cleanup-prepass.ts`.
 *
 * A "line" out of the band pipeline is where the PAGE broke the text, not where
 * the author did, so lines join into flowing prose. The one break that carries
 * information is a WRAP HYPHEN — `ques-` / `tion` — and this module is the
 * whole of what Foundry is allowed to do about it.
 *
 * **The rule that must not be relaxed: a wrap hyphen is JOIN EVIDENCE, never a
 * completion.** The tempting shortcut — "the next character is lowercase, so
 * dehyphenate" — was measured on a real book (Hanebrink, *A Specter Haunting
 * Europe*): all 37 provable pairs there were genuine compounds followed by a
 * lowercase letter, so the shortcut would have welded `far-right` into
 * `farright`, `self-defense` into `selfdefense`, `anti-Communist` into
 * `antiCommunist`. And it is one-way: once the hyphen is gone the word cannot
 * be recovered from the output.
 *
 * So the pair is decided from THE BOOK'S OWN TEXT and nothing else:
 *
 *   join   — `question` appears elsewhere as a free-standing word AND
 *            `ques-tion` never appears as a single-line compound
 *   hyphen — `non-Aryan` appears elsewhere as a single-line compound AND
 *            `nonAryan` never appears as a word
 *   null   — neither is attested, or both are. KEEP THE HYPHEN.
 *
 * Only POSITIVE evidence on one side plus its ABSENCE on the other counts. An
 * absence-only rule ("the tail never appears alone, so it must be a fragment")
 * was measured and rejected in BookForge: on a short book it fires on genuine
 * compounds. Foundry has no model arbitration for the `null` case and does not
 * want one — generation is how a scan becomes fiction (ARCHITECTURE §7).
 */

const WRAP_HYPHEN_END = /[A-Za-zÀ-ÿ]-[ \t]*$/;
const WRAP_HYPHEN_CONT = /^[ \t]*[A-Za-zÀ-ÿ]/;

/** Does the break between these two laid-out lines split a hyphenated word? */
export function isWrapHyphenBreak(prevLine: string, nextLine: string): boolean {
  return WRAP_HYPHEN_END.test(prevLine) && WRAP_HYPHEN_CONT.test(nextLine);
}

/** The two halves of a wrap-hyphenated word, or null if this is not one. */
export function wrapHyphenHalves(prevLine: string, nextLine: string): { head: string; tail: string } | null {
  if (!isWrapHyphenBreak(prevLine, nextLine)) return null;
  const head = /([A-Za-zÀ-ÿ]+)-[ \t]*$/.exec(prevLine);
  const tail = /^[ \t]*([A-Za-zÀ-ÿ]+)/.exec(nextLine);
  if (!head || !tail) return null;
  return { head: head[1], tail: tail[1] };
}

// A word, a hyphen, a line break (optionally padded), a word — walked over the
// whole book. Global + multiline, exactly as in the BookForge pre-pass.
const HYPHEN_SPLIT = /([A-Za-zÀ-ÿ]+)-[ \t]*\n[ \t]*([A-Za-zÀ-ÿ]+)/g;

// A standalone alphabetic token. `-` is excluded from BOTH boundaries so a
// genuine compound (`non-Aryan`) contributes neither `non` nor `Aryan` to the
// word set — otherwise every compound would "attest" its own halves.
const STANDALONE_WORD = /(?<![\w-])([A-Za-zÀ-ÿ]+)(?![\w-])/g;

// A single-line `word-word` compound. Same boundary rule, so a three-part chain
// (`Judeo-Christian-Jewish`) contributes nothing rather than a wrong two-part slice.
const SINGLE_LINE_COMPOUND = /(?<![\w-])([A-Za-zÀ-ÿ]+)-([A-Za-zÀ-ÿ]+)(?![\w-])/g;

export type HyphenVerdict = 'join' | 'hyphen';

/** Token sets harvested from the whole book, used to PROVE hyphen verdicts. */
export interface HyphenAttestation {
  /** Lowercased standalone words, e.g. `question` (never a compound's halves). */
  words: Set<string>;
  /** Lowercased single-line compounds keyed `a-b`, e.g. `non-aryan`. */
  hyphenated: Set<string>;
}

export function createHyphenAttestation(): HyphenAttestation {
  return { words: new Set<string>(), hyphenated: new Set<string>() };
}

/**
 * Fold text into the attestation sets.
 *
 * The HYPHEN_SPLIT occurrences are MASKED OUT first. Without that, a split's own
 * second fragment (`ques-\ntion` → `tion`) enters `words` as a standalone token
 * and attests itself, which silently breaks every proof that reads `words`.
 * Masking with a newline keeps the surrounding tokens' boundaries intact.
 */
export function addTextToHyphenAttestation(att: HyphenAttestation, text: string): void {
  const masked = text.replace(HYPHEN_SPLIT, '\n');
  for (const m of masked.matchAll(STANDALONE_WORD)) att.words.add(m[1].toLowerCase());
  for (const m of masked.matchAll(SINGLE_LINE_COMPOUND)) {
    att.hyphenated.add(`${m[1]}-${m[2]}`.toLowerCase());
  }
}

/**
 * Build the book's vocabulary from its own lines.
 *
 * The lines are joined with `\n` — NOT with spaces — because that is the shape
 * HYPHEN_SPLIT masks: joining with spaces would hide every split from the
 * masker and let the fragments attest themselves.
 */
export function attestationFromLines(lines: Iterable<string>): HyphenAttestation {
  const att = createHyphenAttestation();
  addTextToHyphenAttestation(att, [...lines].join('\n'));
  return att;
}

/**
 * Decide a hyphen pair from the book's own evidence. `null` means unproven, and
 * an unproven pair KEEPS ITS HYPHEN — see the header.
 */
export function proveHyphenVerdict(a: string, b: string, att: HyphenAttestation): HyphenVerdict | null {
  const joinedAttested = att.words.has(`${a}${b}`.toLowerCase());
  const hyphenAttested = att.hyphenated.has(`${a}-${b}`.toLowerCase());
  if (joinedAttested && !hyphenAttested) return 'join';
  if (hyphenAttested && !joinedAttested) return 'hyphen';
  return null;
}
