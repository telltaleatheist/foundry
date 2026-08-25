/**
 * analyze/plan — the categories, the hypotheses, and what each stage asks.
 *
 * ── PORTED, NOT INVENTED ────────────────────────────────────────────────────
 *
 * Every tuned hypothesis below is briefcase's
 * (`backend/src/analysis/nli-ranker.service.ts`), carried over with ONE
 * systematic rewrite: they phrase the AUTHOR rather than the speaker, because a
 * book is not a transcript. Nothing else about them moves. The measurements
 * quoted in the comments were made THERE, against briefcase's two reference
 * videos, and they are attributed as such every time — nothing in this
 * repository has measured any of these numbers, and a number that changed
 * owners without saying so would be a lie the next person builds on.
 *
 * ── WHAT A HYPOTHESIS IS, AND THE TWO WRONG SHAPES ──────────────────────────
 *
 * A hypothesis is a PROPOSITION THE SENTENCE CAN ENTAIL. It is not a category
 * description (those are instructions written for an LLM — "ANY use of slurs —
 * flag even if quoted" — and an entailment model scores an instruction as a
 * claim about the text, which is meaningless), and it is not a noun-matcher.
 * briefcase measured both wrong shapes and the losses are quoted beside
 * `dehumanization`, where they are worst. The port carries the LESSON and not
 * the corpse: the rejected forms are named so nobody re-derives them, and only
 * the surviving propositions are ever sent.
 *
 * A category may carry SEVERAL hypotheses and scores as the MAX across them,
 * because entailment is a per-proposition question and one category can be
 * argued in genuinely different propositions. `christian-nationalism` is the
 * case that proved it (see its comment).
 *
 * ── TWO KINDS OF QUESTION, TWO SHAPES OF STRING ─────────────────────────────
 *
 * `hypotheses` are what the NLI model scores, and they describe the author
 * doing something ("The author asserts that…"), which is the right shape for
 * entailment. `proposition` is what the VERIFIER is shown, and it is the CLAIM
 * itself, so the prompt can ask whether the author is asserting it or reporting
 * somebody else asserting it. Same category, different job, and neither string
 * is usable in the other's place.
 */
import { createHash } from 'node:crypto';

/** Something is wrong with the categories this run was asked for. */
export class AnalysisPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AnalysisPlanError';
  }
}

/** One category's plan for a run: what to rank with, what to verify with. */
export interface RankPlan {
  category: string;
  /** One or more stance hypotheses; a category scores as the MAX across them. */
  hypotheses: string[];
  /** The claim the verifier tests, phrased as the thing the author would assert. */
  proposition: string;
  /**
   * True where the hypotheses were tuned against reference material. False for
   * the description-backed ones — the numbers in this file were not calibrated
   * for them, so their candidate counts may be high or low, and the report says
   * so by name in its header rather than leaving a reader to assume otherwise.
   */
  tuned: boolean;
}

/**
 * Stance hypotheses, one entry per built-in category, tuned in briefcase
 * against its reference videos (`calibrate-nli.py`).
 *
 * `misinformation` IS ABSENT ON PURPOSE — see `MISINFORMATION_EXCLUSION`.
 */
const HYPOTHESES: Record<string, string | string[]> = {
  'political-demonization':
    'The author asserts that political opponents are communists, Marxists, or enemies of the country.',
  hate: 'The author expresses hostility or mockery toward a group based on race, religion, or identity.',
  conspiracy: 'The author promotes a conspiracy theory as true.',
  /*
   * MEASURED IN BRIEFCASE, `dh-probe.js` on both reference videos. The single
   * hypothesis below scored a MAXIMUM of 0.172 over the 12-minute political
   * video and 0.016 over the 60-minute one — including 0.150 on "With a whole
   * army of commies, zombies behind him", a sentence containing the literal
   * word 'zombies'. It is phrased as a DESCRIPTION OF THE ACT ("describes
   * people as subhuman"), which is what an analyst would write in a report; it
   * is not how the thing is ever said out loud. So, as with
   * christian-nationalism, the category carries several propositions and takes
   * the max.
   *
   * WHAT WAS TRIED AND REJECTED IN BRIEFCASE, because a loose proposition here
   * costs precision on ordinary political insult:
   *
   *   'compares a group of people to zombies, animals, or insects'  — scored
   *     0.958 on "That's 323 death rattlers there here in San Diego" (a Marine
   *     squadron nickname) and 0.908 on "we need those wildcatters out there"
   *     (oil drilling). It matched animal NOUNS, not the dehumanizing move.
   *   'refers to a group as a horde, a swarm, or a mindless mass'  — scored
   *     0.999 on "They have pack of fools" and 0.780 on the neutral sentence
   *     "The communists have proven they can win in coastal cities".
   *   'attributes opponents' politics to psychological damage, guilt,
   *     resentment, or family problems'  — scored 0.973 on "Do you blame the
   *     parents?" in a passage about the fentanyl crisis. Naming POLITICAL
   *     BELIEF explicitly (the surviving form below) drops that to 0.062.
   *
   * All five kept propositions together score, on the reference video with no
   * dehumanizing content at all, ZERO sentences above 0.5 and ZERO windows
   * above 0.7.
   */
  dehumanization: [
    'The author describes people as subhuman, as vermin, disease, or zombies, or as mentally ill because of their politics.',
    'The author describes a group of people as an infestation, a plague, a fever, or something spreading through the country.',
    'The author calls a crowd of political supporters zombies or mindless followers.',
    "The author explains opponents' politics as mental illness, derangement, or personal damage rather than sincere belief.",
    'The author says opponents hold their political beliefs because of psychological damage, guilt, or resentment rather than reason.',
  ],
  violence: 'The author calls for, threatens, or glorifies violence.',
  'false-prophecy': 'The author claims to receive communication or prophecy from God.',
  /*
   * MEASURED IN BRIEFCASE, `cn-probe.js` on the 60-minute reference video: the
   * single hypothesis "Christianity should control politics or government"
   * scored a MAXIMUM of 0.457 over 801 sentences — zero candidates at any
   * sensitivity — on a video whose subject is prayer ministries operating
   * inside the White House and God-ordained regime change. It reads as a claim
   * about doctrine, and nobody says it that way out loud; what they say is
   * "there are Christians in the White House" and "God is determined to see
   * this happen".
   *
   * A category may therefore carry SEVERAL hypotheses and takes the MAX across
   * them. These three were picked against the reference videos: on the
   * 60-minute video they lift the category from 0 to real candidates (0.961
   * sentence / 0.989 window), and on the 12-minute political video, which has
   * no Christian-nationalist content at all, they score 0.025 and 0.089 max —
   * so they do not leak into unrelated material.
   */
  'christian-nationalism': [
    'The author argues that Christianity should control politics or government.',
    'The author says Christians or the church should take authority in government or public life.',
    'The author says God is directing the nation, its government, or its leaders.',
  ],
  'prosperity-gospel': 'The author asks followers for money as a religious duty.',
  extremism: 'The author defends oppression, supremacy, or authoritarian rule.',
  'political-violence': 'The author defends or downplays political violence.',
};

/**
 * The propositions the VERIFIER tests, phrased as the thing the author would be
 * asserting. See this file's header for why these are a different shape from
 * the hypotheses above.
 */
const PROPOSITIONS: Record<string, string> = {
  hate: 'a group of people deserves hostility, contempt, or mockery because of their race, ethnicity, religion, national origin, immigration status, gender, or sexuality',
  conspiracy:
    'a conspiracy theory is true — a secret coordinated plot by a hidden group (election fraud, deep state, globalists, New World Order, and the like)',
  'false-prophecy':
    'God has spoken to the author or to someone they cite, or a divine revelation or prophecy has been received',
  violence: 'violence against people is justified, deserved, or something to look forward to',
  'christian-nationalism': 'Christianity should direct government, law, or politics',
  'prosperity-gospel':
    'followers should give money to a religious leader or ministry in order to receive blessing or wealth',
  extremism: 'oppression, supremacy, ethnic cleansing, or authoritarian rule is justified',
  'political-violence':
    'a political attack, riot, or insurrection was justified, was staged, or was not a serious wrong',
  'political-demonization':
    'political opponents are communists, Marxists, socialists, or enemies within — a label applied to the people themselves rather than a critique of a specific policy',
  dehumanization:
    "a group of people is vermin, disease, infestation, zombies, animals, or otherwise less than human — or that opponents' politics are the product of mental illness or personal damage rather than sincere belief",
};

/**
 * OWEN'S TWO BOOK CATEGORIES, UNTUNED AND SAYING SO.
 *
 * The feature exists for material the reference videos never contained:
 * *"jehovahs witness anti evolution material, christian nationalist books,
 * project 2025, etc."* Christian nationalism is tuned already, above. The other
 * two have no calibrated hypothesis anywhere and are not going to acquire one
 * by being written confidently, so they enter through the SAME door a
 * user-supplied category enters by: description-backed, `tuned: false`, and
 * named as untuned in the report header (docs/ANALYSIS.md §5).
 *
 * They carry first-draft hypotheses rather than only a description, because the
 * description fallback ("The author's statement matches this description: …")
 * is measurably the weaker shape — it is the very form briefcase found scores
 * an instruction rather than a claim — and a first draft in the propositional
 * form is a better starting point for the tuning pass than a wrapper is.
 *
 * NO SCORE IS CLAIMED FOR ANY OF THEM. Nothing here has been run against a
 * reference book; tuning against real ones is the follow-up work indexed in
 * PLAN.md, and until it happens these two may produce too many candidates or
 * too few. That is why the untuned flag exists and why it reaches the report.
 */
const UNTUNED_BOOK_CATEGORIES: readonly RankPlan[] = [
  {
    category: 'anti-evolution',
    hypotheses: [
      'The author asserts that evolution is false, a lie, or a deception.',
      'The author asserts that living things were created in their present forms rather than evolving from earlier ones.',
      'The author asserts that the earth or life on it is only a few thousand years old.',
      'The author says that the teaching of evolution comes from Satan or leads people away from God.',
      'The author says that scientists who accept evolution are dishonest, deceived, or serving an agenda.',
    ],
    proposition:
      'evolution is false and living things were created in their present forms — that the scientific '
      + 'account of origins is a lie, a deception, or satanic, and that a young earth or a special '
      + 'creation is the fact',
    tuned: false,
  },
  {
    category: 'authoritarian-blueprint',
    hypotheses: [
      'The author argues that career civil servants should be removed and replaced with people loyal to the leader.',
      'The author argues that the executive should take direct control of the agencies, the courts, or criminal prosecutions.',
      'The author argues that the checks and limits on executive power should be dismantled, ignored, or overridden.',
      'The author says a new administration should seize control of the government immediately and remove those who resist it.',
    ],
    proposition:
      'the executive should be staffed with loyalists in place of career civil servants, should hold '
      + 'direct control over the agencies and prosecutions, and should not be restrained by the checks '
      + 'that limit it',
    tuned: false,
  },
];

/**
 * WHY `misinformation` IS NOT RANKED — measured in briefcase, not a preference.
 *
 * Every stance hypothesis for this category degenerates to "the author makes a
 * factual assertion", because that is the only part of it an entailment model
 * can see. Whether an assertion is FALSE is a world-knowledge question, and NLI
 * has no world knowledge. briefcase's result on the reference runs
 * (`final-score.txt`):
 *
 *   * long video (60 min): 169 of 205 candidates were misinformation, and 19 of
 *     the 20 verified false positives were misinformation — ordinary true
 *     statements about ejection seats, oil production and engineering.
 *   * short video (12 min): 2 of the 3 extras were misinformation, and in the
 *     unconstrained arm misinformation ATE two real flags by outranking their
 *     true category on the same sentence.
 *
 * So ranking it costs a verifier call on most sentences in the book and buys
 * false positives. briefcase kept an escape hatch to an LLM discovery pass that
 * CAN bring world knowledge to bear; Foundry has no such pass and is not
 * growing one (docs/ANALYSIS.md §9), so this category is refused outright and
 * the sentence below says why.
 */
const MISINFORMATION_EXCLUSION =
  'misinformation is not rankable by entailment — it degenerates to "makes a factual assertion", and '
  + 'whether an assertion is false is world knowledge an entailment model does not have. Measured in '
  + 'briefcase against its reference videos: 169 of 205 candidates and 19 of 20 verified false '
  + 'positives were this one category.';

/** The category name that is refused rather than ranked. See above. */
export const EXCLUDED_CATEGORY = 'misinformation';

/**
 * The wrapper an untuned, description-only category is ranked through.
 *
 * It is briefcase's fallback with the author rewrite, and it is the WEAK shape
 * on purpose: it exists so that a category somebody added by hand still gets
 * scored rather than silently dropped, and the report names it untuned so
 * nobody reads its counts as calibrated.
 */
export function describedHypothesis(description: string): string {
  return `The author's statement matches this description: ${description}`;
}

/** One category as a caller may ask for it — the `--categories` file's shape. */
export interface CategoryRequest {
  name: string;
  /** False turns a built-in off. Absent means on. */
  enabled?: boolean;
  /** Required for a name with no tuned hypotheses, unless `hypotheses` is given. */
  description?: string;
  /** Overrides the built-in hypotheses, or supplies them for a new category. */
  hypotheses?: string[];
}

/** Every built-in category name, in the order a default run plans them. */
export function builtInCategories(): string[] {
  return [...Object.keys(HYPOTHESES), ...UNTUNED_BOOK_CATEGORIES.map((c) => c.category)];
}

/**
 * The plan for a run.
 *
 * With no request, every built-in category is planned — the tuned ten and the
 * two untuned book ones. A request LIST REPLACES that default entirely, which
 * is the only reading of `--categories` that lets a person say "only these
 * two": a merge would make turning something off impossible to express without
 * a second flag.
 *
 * `enabled: false` is still honoured inside a list, because the app's checklist
 * (docs/ANALYSIS.md §7) sends the whole set with the unchecked ones marked
 * rather than composing a shorter array — and a door that accepts both
 * spellings of "not this one" cannot be got wrong from either side.
 */
export function buildPlan(requested: readonly CategoryRequest[] | null, log: (line: string) => void): RankPlan[] {
  const requests: CategoryRequest[] = requested === null
    ? builtInCategories().map((name) => ({ name }))
    : [...requested];

  const plan: RankPlan[] = [];
  const seen = new Set<string>();
  for (const request of requests) {
    const name = request.name.trim();
    if (seen.has(name)) {
      throw new AnalysisPlanError(
        `the category "${name}" was asked for twice. Two plans for one name would score it twice and `
        + 'put it in the report twice, and there is no rule here for which of the two wins.',
      );
    }
    seen.add(name);
    if (request.enabled === false) continue;

    if (name === EXCLUDED_CATEGORY) {
      log(`vlm-analyze: the category "${EXCLUDED_CATEGORY}" is not ranked — ${MISINFORMATION_EXCLUSION}`);
      continue;
    }

    const asked = request.hypotheses?.map((one) => one.trim()).filter((one) => one.length > 0);
    const tunedHypotheses = HYPOTHESES[name];
    const untunedBuiltIn = UNTUNED_BOOK_CATEGORIES.find((one) => one.category === name);
    const description = (request.description ?? '').replace(/\s+/g, ' ').trim();

    if (asked !== undefined && asked.length > 0) {
      /*
       * HAND-WRITTEN HYPOTHESES WIN AND ARE NEVER CALLED TUNED. They may be
       * better than the built-in ones — that is what the tuning pass will
       * produce — but nothing has measured them, and the report's untuned list
       * is the only place a reader learns which counts to trust.
       */
      plan.push({
        category: name,
        hypotheses: asked,
        proposition: description.length > 0
          ? description
          : untunedBuiltIn?.proposition ?? PROPOSITIONS[name] ?? describedHypothesis(name),
        tuned: false,
      });
      continue;
    }

    if (tunedHypotheses !== undefined) {
      plan.push({
        category: name,
        hypotheses: Array.isArray(tunedHypotheses) ? tunedHypotheses : [tunedHypotheses],
        proposition: PROPOSITIONS[name]!,
        tuned: true,
      });
      continue;
    }

    if (untunedBuiltIn !== undefined) {
      plan.push({ ...untunedBuiltIn, hypotheses: [...untunedBuiltIn.hypotheses] });
      continue;
    }

    if (description.length === 0) {
      throw new AnalysisPlanError(
        `the category "${name}" is not one this program has hypotheses for, and it was given neither `
        + 'a description nor hypotheses of its own. There is nothing to score a sentence against, and '
        + 'a category that scored nothing would sit in the report reading as "nothing in this book '
        + 'matched it".',
      );
    }
    plan.push({
      category: name,
      hypotheses: [describedHypothesis(description)],
      proposition: description,
      tuned: false,
    });
  }

  if (plan.length === 0) {
    throw new AnalysisPlanError(
      'no category is enabled, so this run has nothing to look for. A report with no categories in it '
      + 'would say the book is clean, which is a claim nothing measured.',
    );
  }

  /*
   * TWO CATEGORIES CANNOT SHARE A HYPOTHESIS STRING, and this is the check that
   * keeps the worker honest. The NLI worker maps the pipeline's score-sorted
   * labels back to input order BY THE LABEL TEXT (`nli_worker.py`), so two
   * identical hypotheses are one label with one score, and the second category
   * would silently inherit the first's number for the whole book. Caught here,
   * where the sentence can name both categories, rather than in Python where it
   * can only name a string.
   */
  const owner = new Map<string, string>();
  for (const entry of plan) {
    for (const hypothesis of entry.hypotheses) {
      const already = owner.get(hypothesis);
      if (already !== undefined) {
        throw new AnalysisPlanError(
          `the categories "${already}" and "${entry.category}" are asking the same question, word for `
          + `word: "${hypothesis}". The scorer answers one question once, so the two would share a `
          + 'score and one of them would be reported for the other\'s evidence.',
        );
      }
      owner.set(hypothesis, entry.category);
    }
  }

  return plan;
}

/**
 * Read a `--categories` file into requests, refusing anything it cannot use.
 *
 * EVERY REFUSAL NAMES THE ENTRY. A categories file is written by hand, and the
 * failure it is going to have is a typo in a field name — which, accepted
 * silently, means a hand-written hypothesis that never reached the model and a
 * run that cost an hour and looked fine. So an unknown field is an error, not a
 * thing that is ignored.
 */
export function parseCategoriesJson(text: string, where: string): CategoryRequest[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new AnalysisPlanError(`${where} is not JSON (${(err as Error).message})`);
  }
  if (!Array.isArray(parsed)) {
    throw new AnalysisPlanError(
      `${where} holds ${parsed === null ? 'null' : typeof parsed} and a categories file is a LIST of `
      + 'categories: [{"name":"hate"}, {"name":"my-topic","description":"…"}]',
    );
  }
  const known = new Set(['name', 'enabled', 'description', 'hypotheses']);
  const out: CategoryRequest[] = [];
  for (const [index, raw] of parsed.entries()) {
    const at = `${where}, category ${index + 1}`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new AnalysisPlanError(`${at} is not an object`);
    }
    const entry = raw as Record<string, unknown>;
    for (const key of Object.keys(entry)) {
      if (!known.has(key)) {
        throw new AnalysisPlanError(
          `${at} carries a field called "${key}", and a category is made of ${[...known].join(', ')}. `
          + 'A field this program does not read would do nothing, silently, for the whole run.',
        );
      }
    }
    if (typeof entry['name'] !== 'string' || entry['name'].trim().length === 0) {
      throw new AnalysisPlanError(`${at} has no name`);
    }
    if (entry['enabled'] !== undefined && typeof entry['enabled'] !== 'boolean') {
      throw new AnalysisPlanError(`${at}: "enabled" is true or false`);
    }
    if (entry['description'] !== undefined && typeof entry['description'] !== 'string') {
      throw new AnalysisPlanError(`${at}: "description" is a string`);
    }
    const hypotheses = entry['hypotheses'];
    if (hypotheses !== undefined) {
      if (!Array.isArray(hypotheses) || hypotheses.some((one) => typeof one !== 'string')) {
        throw new AnalysisPlanError(`${at}: "hypotheses" is a list of strings`);
      }
    }
    out.push({
      name: entry['name'],
      ...(entry['enabled'] !== undefined ? { enabled: entry['enabled'] as boolean } : {}),
      ...(entry['description'] !== undefined ? { description: entry['description'] as string } : {}),
      ...(hypotheses !== undefined ? { hypotheses: hypotheses as string[] } : {}),
    });
  }
  return out;
}

/**
 * The hypothesis set, as one short hex string — the report header's version of
 * what this run asked.
 *
 * ── WHY THE SET NEEDS A NAME AT ALL ─────────────────────────────────────────
 *
 * A cached rank score is the answer to "what does this sentence entail",
 * and the question includes every hypothesis that was in the column list.
 * Change one word of one hypothesis and every stored score is an answer to a
 * question nobody is asking any more. So the set is hashed, the hash goes in
 * every cache key and in the header, and a report from an older set is legible
 * as such rather than quietly reused.
 *
 * The category NAME and the tuned flag are in the digest as well as the
 * strings: two plans with the same hypotheses under different names produce
 * different reports, so they are different questions.
 *
 * Sixteen hex — eight bytes — for `bankSha`'s reason: far past accidental
 * collision for the handful of plans that will ever exist, and short enough to
 * read in a header.
 */
export function hypothesisSetVersion(plan: readonly RankPlan[]): string {
  const NUL = String.fromCharCode(0);
  const fields: string[] = ['foundry-analysis-hypotheses-1'];
  for (const entry of plan) {
    fields.push(entry.category, entry.tuned ? 'tuned' : 'untuned', entry.proposition, ...entry.hypotheses);
  }
  return createHash('sha256').update(fields.join(NUL), 'utf8').digest('hex').slice(0, 16);
}

/** The categories of a plan that nothing has calibrated. The report names them. */
export function untunedNames(plan: readonly RankPlan[]): string[] {
  return plan.filter((entry) => !entry.tuned).map((entry) => entry.category);
}
