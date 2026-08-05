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
 *
 * ## THE SOFT HYPHEN (U+00AD) IS THE SAME BREAK AND IT IS NOT AMBIGUOUS
 *
 * Everything above is about ASCII hyphen-minus, and everything above is needed
 * BECAUSE that character is ambiguous: `well-` at a line end might be a real
 * compound, and only the book can say. U+00AD cannot be ambiguous. It is by
 * definition a typesetter's DISCRETIONARY hyphenation point — a mark that is
 * invisible unless the line happens to break there — so a line ending in one
 * is a word cut in half and nothing else. It therefore joins UNCONDITIONALLY:
 * no attestation lookup, no hyphen kept, no verdict to prove.
 *
 * Measured 2026-08-04 on Kershaw, *Working Towards The Fuhrer*, in the archive
 * PDF's own text layer:
 *
 *     line 51: …traditional views on 'totali<U+00AD>
 *     line 52: tarianism' and to views of Stalin…
 *
 * `WRAP_HYPHEN_END` saw no hyphen there, so the join inserted a space and the
 * finished book said `totali tarianism`, which a TTS engine then mispronounces.
 * It was all over that book.
 *
 * And a soft hyphen ANYWHERE ELSE — mid-line, mid-word — is invisible
 * formatting. It carries no sound, no meaning and no break, so it must never
 * reach a narrator: it is stripped, not preserved.
 *
 * The consequence for THIS file is that the attestation has to see the healed
 * word. `totali<U+00AD>\ntarianism` masked the way an ASCII split is masked
 * would teach the book neither half; healed, it teaches `totalitarianism`,
 * which is the word the book actually contains.
 */

const WRAP_HYPHEN_END = /[A-Za-zÀ-ÿ]-[ \t]*$/;
const WRAP_HYPHEN_CONT = /^[ \t]*[A-Za-zÀ-ÿ]/;

/** U+00AD SOFT HYPHEN — the discretionary break, invisible unless it is used. */
export const SOFT_HYPHEN = '\u00AD';

const SOFT_HYPHEN_END = /\u00AD[ \t]*$/;

/**
 * A soft hyphen that a line break actually landed on: the mark, the break, and
 * whatever indent the next line was laid out with. Removing the WHOLE match
 * welds the two halves back into one word.
 */
const SOFT_HYPHEN_SPLIT = /\u00AD[ \t]*\r?\n[ \t]*/g;

/**
 * Does this line end at a soft hyphen?
 *
 * Trailing spaces and tabs are allowed for the same reason `WRAP_HYPHEN_END`
 * allows them: a laid-out line's trailing whitespace is an artefact of the
 * crop, not of the text.
 */
export function endsWithSoftHyphen(line: string): boolean {
  return SOFT_HYPHEN_END.test(line);
}

/** Remove every soft hyphen. Invisible formatting is not text. */
export function stripSoftHyphens(text: string): string {
  return text.replace(/\u00AD/g, '');
}

/**
 * Resolve every soft hyphen in a run of laid-out lines: a break that landed on
 * one is closed up, and the strays that did not break are removed.
 *
 * Both cases produce the same thing — the word, whole — which is why one
 * function does both. The line-break case has to run FIRST, because it is the
 * only one that also has to consume the newline and the next line's indent.
 */
export function healSoftHyphens(text: string): string {
  return stripSoftHyphens(text.replace(SOFT_HYPHEN_SPLIT, ''));
}

/**
 * Does the break between these two laid-out lines split a hyphenated word?
 *
 * The soft-hyphen case is decided by the PREVIOUS line alone — the mark says
 * the word is cut, and there is nothing for the continuation to add to that.
 * The ASCII case still needs both lines: `page 3 -` followed by a digit is
 * punctuation, not a wrapped word.
 */
export function isWrapHyphenBreak(prevLine: string, nextLine: string): boolean {
  if (endsWithSoftHyphen(prevLine)) return true;
  return WRAP_HYPHEN_END.test(prevLine) && WRAP_HYPHEN_CONT.test(nextLine);
}

/**
 * The two halves of an ASCII wrap-hyphenated word, or null if this is not one.
 *
 * A soft-hyphen break returns null DELIBERATELY, and callers must handle it
 * before asking: there are no halves to weigh because there is no verdict to
 * prove. Handing one to `proveHyphenVerdict` would put a decided join back into
 * the undecided pile, where an unattested pair keeps a hyphen the book never
 * printed.
 */
export function wrapHyphenHalves(prevLine: string, nextLine: string): { head: string; tail: string } | null {
  if (endsWithSoftHyphen(prevLine)) return null;
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
 *
 * Soft hyphens are HEALED before any of that, and the difference from masking is
 * the point. An ASCII split is undecided, so neither half may be believed; a
 * soft-hyphen split is already decided, so the book genuinely contains the
 * joined word and the vocabulary should hold it. Healing also stops the two
 * halves entering `words` separately, which is the same self-attestation trap
 * masking exists to close — `\u00AD` is not in `[A-Za-zÀ-ÿ]`, so an unhealed
 * `totali\u00ADtarianism` would tokenize as `totali` and `tarianism`.
 */
export function addTextToHyphenAttestation(att: HyphenAttestation, text: string): void {
  const masked = healSoftHyphens(text).replace(HYPHEN_SPLIT, '\n');
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
