/**
 * tag/ask — the two questions, and the shapes their answers must take.
 *
 * Both go through `analyze/verify.ts`'s `askConstrained`, which owns the
 * envelope: the JSON schema rather than the string 'json', temperature 0, the
 * `think` rule, and the thinking-model trap that makes a constrained answer
 * arrive in `thinking` with `response` empty. Nothing about that is re-decided
 * here; what is here is the two prompts and the two readings.
 *
 * ── ABOUTNESS IS NOT ANALYZE'S QUESTION, AND THE DIFFERENCE IS THE POINT ────
 *
 * `analyze` asks about STANCE: is the author asserting this claim as their own
 * position, or reporting, quoting, questioning or arguing against it? That
 * question is what keeps a history of propaganda from being flagged as
 * propaganda, and it is the WRONG question here. A court opinion striking a ban
 * down is about "ban" and about "free speech"; a brief attacking a doctrine is
 * about that doctrine. A tag is a subject heading, not an accusation, so the
 * question asked is whether the document genuinely concerns the tag — either
 * side of it, at any length.
 *
 * ── AND NEITHER CALL EXPLAINS ITSELF ────────────────────────────────────────
 *
 * No reasons, no confidences, no quotations back. The tag set IS the answer
 * (docs/ANALYSIS.md §1's ruling, which holds here for the same reason it holds
 * there): a rationale a model invents for a label it has just chosen is a
 * fabrication that reads like evidence.
 */
import { askConstrained } from '../analyze/verify.js';
import type { Transport } from '../translate/ollama.js';
import { normalTag } from './input.js';

/** Two tokens, one of two values — analyze's `VERDICT_SCHEMA` in this key. */
export const ABOUTNESS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    applies: { type: 'string', enum: ['yes', 'no'] },
  },
  required: ['applies'],
  additionalProperties: false,
};

/** A list of strings and nothing else. */
export const SUGGEST_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['tags'],
  additionalProperties: false,
};

/**
 * How much answer each call may generate.
 *
 * The aboutness budget is analyze's 128 for its reason: the answer is
 * `{"applies":"yes"}` and the headroom is there so a ceiling is never the thing
 * that ends a call. The suggestion budget is larger because the answer really is
 * a list — ten short phrases, their quotes and their commas — and an answer cut
 * off mid-array is a degradation rather than a shorter list.
 */
const ABOUTNESS_PREDICT_TOKENS = 128;
const SUGGEST_PREDICT_TOKENS = 512;

/** The most new tags one document may be given. */
export const MAX_SUGGESTIONS = 10;

/**
 * The most words a suggestion may be.
 *
 * A tag is a subject heading — "christian nationalism", "free speech", "ban".
 * A model asked for tags will occasionally answer with a clause ("the court's
 * analysis of the statute's severability"), and a clause is a sentence about the
 * document rather than a name for it: it will never match a second document,
 * which is the whole use of a vocabulary. Six is generous for a noun phrase and
 * short of a clause.
 */
const MAX_SUGGESTION_WORDS = 6;

/**
 * The aboutness question, for one tag.
 *
 * Prompt hygiene is briefcase's, kept: both answers are defined POSITIVELY —
 * what earns yes, what earns no — rather than illustrated with a wrong answer
 * the model might copy, and there is no ban list.
 */
export function buildAboutnessPrompt(tag: string, passages: readonly string[]): string {
  return `Passages from one document.

${passages.join('\n\n')}

TAG: ${tag}

Question: is this document about that tag — does it genuinely concern that subject?
Answer "yes" if the document deals with the subject, whichever side it takes: a ruling striking a ban down is still about bans, and an argument against a movement is still about that movement.
Answer "no" if the tag's words only appear in passing, or if these passages are about something else.

Respond with JSON only: {"applies":"yes"} or {"applies":"no"}`;
}

/**
 * The suggestion question, once for the document.
 *
 * HER LIST IS IN THE PROMPT and it is doing two jobs: it says what not to
 * repeat, and it is the STYLE GUIDE — a vocabulary is a person's own idiom, and
 * a suggestion that does not sound like the rest of her list is a suggestion she
 * will not use. With an empty list there is nothing to imitate, so the shape is
 * stated instead; that is the only difference between the two forms.
 */
export function buildSuggestPrompt(
  vocabulary: readonly string[],
  passages: readonly string[],
): string {
  const existing = vocabulary.length > 0
    ? `EXISTING TAGS, which are already recorded and must NOT be repeated:\n${vocabulary.map((tag) => `- ${tag}`).join('\n')}\n\n`
      + `Task: name up to ${MAX_SUGGESTIONS} ADDITIONAL tags for this document, written in the style of the list above — short lowercase noun phrases.`
    : `Task: name up to ${MAX_SUGGESTIONS} tags for this document — short lowercase noun phrases of one to four words, the way a subject index is written.`;

  return `Passages from one document.

${passages.join('\n\n')}

${existing}
Each tag must name a subject the document genuinely concerns, not a word that merely appears in it.
Name only tags these passages support. Fewer is better than filling the list.

Respond with JSON only: {"tags":["…"]}`;
}

/** What one aboutness call produced: an answer, or the reason there is not one. */
export interface AboutnessOutcome {
  applies: boolean | null;
  /** Set only where `applies` is null — the sentence the run reports. */
  degraded?: string;
}

/**
 * The yes/no in an answer, or null where there is none.
 *
 * The schema makes the first branch the one that always fires; the second is for
 * a model whose template wraps the object in prose, and it is a WORD match
 * rather than a substring one, because "no" is inside "not", "none" and "know".
 * The XOR is the safety of that branch: text carrying both words has answered
 * nothing.
 *
 * NULL IS A REAL ANSWER AND IT IS NOT A YES. An unreadable answer must not be
 * able to put a tag on a document.
 */
export function parseApplies(text: string): boolean | null {
  if (!text) return null;
  const json = /"applies"\s*:\s*"(yes|no)"/i.exec(text);
  if (json) return json[1]!.toLowerCase() === 'yes';

  const lower = text.trim().toLowerCase();
  const hasYes = /\byes\b/.test(lower);
  const hasNo = /\bno\b/.test(lower);
  if (hasYes && !hasNo) return true;
  if (hasNo && !hasYes) return false;
  return null;
}

/** Ask whether the document concerns one tag. */
export async function askAboutness(
  transport: Transport,
  endpoint: string,
  model: string,
  prompt: string,
  numCtx: number,
): Promise<AboutnessOutcome> {
  const answer = await askConstrained(
    transport, endpoint, model, prompt, numCtx, ABOUTNESS_SCHEMA, ABOUTNESS_PREDICT_TOKENS,
  );
  if (answer.text === null) return { applies: null, degraded: answer.degraded ?? 'no answer' };
  const applies = parseApplies(answer.text);
  if (applies === null) {
    return {
      applies: null,
      degraded: `no yes-or-no in the answer: ${answer.text.trim().slice(0, 120) || '(empty)'}`,
    };
  }
  return { applies };
}

/** What the suggestion call produced: a list, or the reason there is not one. */
export interface SuggestOutcome {
  tags: string[] | null;
  /** Set only where `tags` is null — the sentence the run reports. */
  degraded?: string;
}

/** The strings in a `{"tags":[…]}` answer, unfiltered. Null where there is none. */
export function parseSuggestions(text: string): string[] | null {
  if (!text) return null;
  /*
   * The whole object is parsed rather than a regex run over it: a list is
   * structure, and a tag containing a comma or a bracket would be cut in half by
   * anything cheaper. A model that wrapped the object in prose is met by finding
   * the object's own braces — the outermost pair, so a nested one cannot end the
   * slice early.
   */
  const from = text.indexOf('{');
  const to = text.lastIndexOf('}');
  if (from < 0 || to <= from) return null;
  let parsed: { tags?: unknown };
  try {
    parsed = JSON.parse(text.slice(from, to + 1)) as { tags?: unknown };
  } catch {
    return null;
  }
  if (!Array.isArray(parsed.tags)) return null;
  return parsed.tags.filter((tag): tag is string => typeof tag === 'string');
}

/** Ask what else this document would be called. */
export async function askSuggestions(
  transport: Transport,
  endpoint: string,
  model: string,
  prompt: string,
  numCtx: number,
): Promise<SuggestOutcome> {
  const answer = await askConstrained(
    transport, endpoint, model, prompt, numCtx, SUGGEST_SCHEMA, SUGGEST_PREDICT_TOKENS,
  );
  if (answer.text === null) return { tags: null, degraded: answer.degraded ?? 'no answer' };
  const tags = parseSuggestions(answer.text);
  if (tags === null) {
    return {
      tags: null,
      degraded: `no tag list in the answer: ${answer.text.trim().slice(0, 120) || '(empty)'}`,
    };
  }
  return { tags };
}

/**
 * The suggestions as they are written down: short, lowercase, and new.
 *
 * THE MODEL'S ORDER IS KEPT. It answered its best first, and nothing here knows
 * better; the filtering only removes.
 *
 * WHAT IS REMOVED, and why each: a phrase longer than a noun phrase (it is a
 * sentence about the document, not a name for it, and it will never match a
 * second document); anything that is already hers, under the same normal form
 * her own list was deduplicated with, because a suggestion she has already made
 * is not a suggestion; and a repeat of an earlier suggestion, which a model
 * offers as a plural or a recasing of the phrase above it.
 */
export function cleanSuggestions(raw: readonly string[], vocabulary: readonly string[]): string[] {
  const taken = new Set(vocabulary.map(normalTag));
  const out: string[] = [];
  for (const candidate of raw) {
    if (out.length >= MAX_SUGGESTIONS) break;
    const tag = candidate
      .normalize('NFKC')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[^\p{L}\p{N}]+/u, '')
      .replace(/[^\p{L}\p{N})\]]+$/u, '');
    if (tag.length === 0) continue;
    if (tag.split(' ').length > MAX_SUGGESTION_WORDS) continue;
    const key = normalTag(tag);
    if (key.length === 0 || taken.has(key)) continue;
    taken.add(key);
    out.push(tag);
  }
  return out;
}
