/**
 * tag/evidence — which parts of the document a model is shown.
 *
 * The ranker reads everything; the model reads a handful. These are the pure
 * functions that choose that handful, and they exist because the two questions
 * this command asks want different samples:
 *
 *   - ABOUTNESS is asked once per tag, and wants the passages that scored for
 *     THAT tag — the strongest evidence there is that the document concerns it.
 *   - SUGGESTION is asked once for the document, and wants the document's
 *     highest-signal passages whatever they scored for, because a tag she has
 *     not thought of will be sitting beside the ones she has.
 *
 * NOTHING HERE IS A LOCATION. A passage is a string handed to a prompt and
 * thrown away; `foundry tag` reports a set of tags and never where they matched
 * (docs/TAGGING.md — the map is `analyze`'s and is deliberately not built
 * twice).
 */
import type { BookSentence, FlagCandidate } from '../analyze/rank.js';

/**
 * How many passages one aboutness question carries.
 *
 * Five, and the number is about the question rather than about the context
 * window. "Is this document about free speech" is answered by the best evidence
 * there is; a sixth and seventh passage cannot make a no into a yes, and a long
 * prompt of weak passages is how a model is talked into agreeing with everything
 * it is shown.
 */
const PASSAGES_PER_TAG = 5;

/** How many passages the one suggestion question carries. */
const SUGGEST_PASSAGES = 12;

/**
 * ...and the characters they may take, whichever bound bites first.
 *
 * The prompts of a run are sized ONCE into one `num_ctx` (`stageNumCtx`), so the
 * longest one sets the cost of every call. A budget here keeps that ceiling off
 * a document whose paragraphs are pages.
 */
const SUGGEST_CHAR_BUDGET = 6_000;

/** One tag's case: its best score, and the passages that made it. */
export interface TagEvidence {
  /** Her spelling, verbatim. */
  tag: string;
  /** The best score any passage reached for this tag. Ordering only. */
  score: number;
  /** The passages the model is shown, in the document's own order. */
  passages: string[];
}

/** A candidate's span, as a key — two tags firing on one span share a passage. */
function spanKey(candidate: FlagCandidate): string {
  return `${candidate.spanFrom}:${candidate.spanTo}`;
}

/**
 * Take the strongest passages of a list, then put them back in reading order.
 *
 * STRENGTH CHOOSES, ORDER PRESENTS. A prompt whose passages run strongest-first
 * reads as a ranked list and invites the model to weigh them; the same passages
 * in the document's order read as the document, which is what the question is
 * about.
 */
function strongestInOrder(
  candidates: readonly FlagCandidate[],
  limit: number,
  charBudget: number,
): string[] {
  const bySpan = new Map<string, FlagCandidate>();
  for (const candidate of candidates) {
    const key = spanKey(candidate);
    const held = bySpan.get(key);
    if (!held || candidate.score > held.score) bySpan.set(key, candidate);
  }

  const kept: FlagCandidate[] = [];
  const texts = new Set<string>();
  let chars = 0;
  for (const candidate of [...bySpan.values()].sort((a, b) => b.score - a.score)) {
    if (kept.length >= limit) break;
    // A book, a brief and a bundle all repeat sentences; the same words twice in
    // one prompt is a second copy of one piece of evidence, not a second piece.
    if (texts.has(candidate.text)) continue;
    if (chars + candidate.text.length > charBudget && kept.length > 0) break;
    texts.add(candidate.text);
    chars += candidate.text.length;
    kept.push(candidate);
  }
  return kept
    .sort((a, b) => a.spanFrom - b.spanFrom || a.spanTo - b.spanTo)
    .map((candidate) => candidate.text);
}

/**
 * One entry per tag the ranker found anything for, strongest tag first.
 *
 * A TAG WITH NO PASSAGE IS NOT HERE AND COSTS NO CALL. Nothing in the document
 * reached the capture floor for it, and asking a model whether a document it
 * cannot see is about a word would be asking the model to guess.
 */
export function evidenceByTag(candidates: readonly FlagCandidate[]): TagEvidence[] {
  const byTag = new Map<string, FlagCandidate[]>();
  for (const candidate of candidates) {
    const list = byTag.get(candidate.category);
    if (list) list.push(candidate);
    else byTag.set(candidate.category, [candidate]);
  }

  const out: TagEvidence[] = [];
  for (const [tag, list] of byTag) {
    out.push({
      tag,
      score: list.reduce((best, candidate) => Math.max(best, candidate.score), 0),
      passages: strongestInOrder(list, PASSAGES_PER_TAG, SUGGEST_CHAR_BUDGET),
    });
  }
  return out.sort((a, b) => b.score - a.score || a.tag.localeCompare(b.tag));
}

/** The document's highest-signal passages, whatever tag earned them. */
export function topPassages(candidates: readonly FlagCandidate[]): string[] {
  return strongestInOrder(candidates, SUGGEST_PASSAGES, SUGGEST_CHAR_BUDGET);
}

/**
 * The sample used when the ranker found nothing — an empty vocabulary, or a
 * document that matched none of it.
 *
 * A STRIDE ACROSS THE WHOLE DOCUMENT, and that is a decision. With no tags there
 * is no signal to sort by, and the obvious substitutes are worse than they look:
 * a term-frequency pick without a corpus to weigh against finds the most
 * REPETITIVE passage (a letterhead, a case caption, a recurring citation), and
 * the first N sentences find the title page. An even sample is the one choice
 * that cannot systematically miss the middle of a document, and this is the
 * stage where missing the middle would cost the suggestion the whole point.
 *
 * The draws are spaced to COVER the document rather than to avoid touching, so
 * on a short one two neighbouring samples can share a sentence. That costs a
 * repeated line in a prompt; spacing them apart instead would cost the tail of
 * the document, which is not a trade worth making.
 */
export function stridedSample(sentences: readonly BookSentence[]): string[] {
  const size = 3;
  if (sentences.length === 0) return [];
  if (sentences.length <= size) return [sentences.map((s) => s.text).join(' ')];

  const starts = Math.max(1, sentences.length - size + 1);
  const wanted = Math.min(SUGGEST_PASSAGES, Math.ceil(sentences.length / size));
  const stride = wanted === 1 ? 0 : (starts - 1) / (wanted - 1);

  const out: string[] = [];
  let chars = 0;
  let previous = -1;
  for (let n = 0; n < wanted; n += 1) {
    const at = Math.round(n * stride);
    // A short document's stride rounds several draws onto one start; one copy of
    // a passage is the evidence, and the duplicates are nothing.
    if (at === previous) continue;
    previous = at;
    const text = sentences.slice(at, at + size).map((s) => s.text).join(' ');
    if (chars + text.length > SUGGEST_CHAR_BUDGET && out.length > 0) break;
    chars += text.length;
    out.push(text);
  }
  return out;
}
