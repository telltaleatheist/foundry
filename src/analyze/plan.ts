/**
 * analyze/plan — the categories, and what each stage asks about them.
 *
 * ── PORTED, NOT INVENTED ────────────────────────────────────────────────────
 *
 * The ranker is briefcase's snap flag ranker (src/analyze/snap.ts), and the
 * scorer's line for every tuned category below is briefcase's
 * (`backend/src/scorer/flags/flag-options.ts`, `SNAP_OPTION_TEXTS`, main
 * d80cc71), carried over VERBATIM: each is a description of an act with no
 * subject in it ("Calls political opponents communists…"), so it reads as true
 * of an author exactly as it read of a speaker, and there is nothing to
 * rewrite. The propositions are briefcase's `FLAG_PROPOSITIONS` with the one
 * systematic rewrite this port has always made — the AUTHOR rather than the
 * speaker. Nothing in this repository has measured any of them.
 *
 * ── TWO STRINGS PER CATEGORY, FOR TWO DIFFERENT READERS ─────────────────────
 *
 * `option` is what the SCORER reads: one short, discriminating line naming the
 * act, offered as one letter of a choice over the categories and "none". It is
 * never a category's description — those are written as instructions to an LLM
 * ("flag even if quoted"), and a scorer reads an instruction as content.
 *
 * `proposition` is what the VERIFIER is shown: the CLAIM itself, so the prompt
 * can ask whether the author asserts it or reports somebody else asserting it.
 * Same category, different job, and neither string is usable in the other's
 * place.
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
  /** The display name — `CategoryRequest.label`, a built-in's mirrored name, or the id. */
  label: string;
  /** The one line the scorer reads for this category — see this file's header. */
  option: string;
  /** The claim the verifier tests, phrased as the thing the author would assert. */
  proposition: string;
  /**
   * True where the option line is briefcase's measured one. False for the book
   * categories and every described one — nothing calibrated how hot their line
   * runs, so their counts may be high or low, and the report says so by name in
   * its header rather than leaving a reader to assume otherwise.
   */
  tuned: boolean;
}

/**
 * The scorer's line for each built-in category — briefcase's `SNAP_OPTION_TEXTS`
 * (flag-options.ts at d80cc71), verbatim. briefcase derived them from the tuned
 * hypotheses of the entailment ranker they replaced, collapsing a category's
 * several hypotheses into one disjunction because a choice option holds one line.
 *
 * In the order a default run has always planned them, which is also the order
 * of their letters in every question.
 *
 * `misinformation` IS ABSENT ON PURPOSE — see `MISINFORMATION_EXCLUSION`.
 */
const OPTION_TEXTS: Record<string, string> = {
  'political-demonization': 'Calls political opponents communists, Marxists, or enemies of the country',
  hate: 'Shows hostility or mockery toward a group because of race, religion, ethnicity, sexuality, or identity',
  conspiracy: 'Presents a conspiracy theory (stolen election, deep state, a hidden plot) as true',
  dehumanization:
    "Describes people as vermin, disease, zombies, or less than human, or calls opponents' politics a mental illness",
  violence: 'Calls for, threatens, or glorifies violence',
  'false-prophecy': 'Claims God spoke to them or someone they cite, or announces a prophecy or revelation',
  'christian-nationalism':
    'Says Christianity or the church should run government, or that God is directing the nation or its leaders',
  'prosperity-gospel': 'Asks followers for money as a religious duty, or promises blessing in return for giving',
  extremism: 'Defends oppression, supremacy, ethnic cleansing, or authoritarian rule',
  'political-violence': 'Defends or downplays a political attack, riot, or insurrection',
};

/**
 * The propositions the VERIFIER tests, phrased as the thing the author would be
 * asserting. See this file's header for why these are a different shape from
 * the option lines above.
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
 * two have no measured line anywhere and are not going to acquire one by being
 * written confidently, so they are `tuned: false` and named as untuned in the
 * report header (docs/ANALYSIS.md §5).
 *
 * Their option lines were written for the snap port (Owen, 2026-09-25: *"write
 * one line for each in briefcase's style"*) — an act, verb first, no subject,
 * one disjunction — rather than taken from the first sentence of a description,
 * which is the rule a user's own category runs on (`customOptionText`) and the
 * weaker shape, because a description is written to an LLM and a line is written
 * to a scorer.
 *
 * NO SCORE IS CLAIMED FOR EITHER. Nothing here has been run against a reference
 * book; until it has, these two may produce too many candidates or too few.
 * That is why the untuned flag exists and why it reaches the report.
 */
const UNTUNED_BOOK_CATEGORIES: readonly RankPlan[] = [
  {
    category: 'anti-evolution',
    label: 'Anti-evolution and science denial',
    option:
      'Says evolution is false or a deception, or that life was created in its present forms on a young earth',
    proposition:
      'evolution is false and living things were created in their present forms — that the scientific '
      + 'account of origins is a lie, a deception, or satanic, and that a young earth or a special '
      + 'creation is the fact',
    tuned: false,
  },
  {
    category: 'authoritarian-blueprint',
    label: 'Authoritarian blueprint',
    option:
      'Argues for replacing civil servants with loyalists, or for the executive to control the agencies, courts, or prosecutions unchecked',
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
 * Whether an assertion is FALSE is a world-knowledge question, and a ranker
 * that reads a book for what it SAYS can only see "the author makes a factual
 * assertion", which is most of any book. briefcase measured it under the
 * entailment ranker this port replaced (`final-score.txt`):
 *
 *   * long video (60 min): 169 of 205 candidates were misinformation, and 19 of
 *     the 20 verified false positives were misinformation — ordinary true
 *     statements about ejection seats, oil production and engineering.
 *   * short video (12 min): 2 of the 3 extras were misinformation, and in the
 *     unconstrained arm misinformation ATE two real flags by outranking their
 *     true category on the same sentence.
 *
 * The snap ranker keeps it out by default for the same reason (briefcase's
 * `buildFlagPlan`, "parity with NLI"); it runs there only as an eval arm, and
 * Foundry has no eval arm. So this category is refused outright and the
 * sentence below says why.
 */
const MISINFORMATION_EXCLUSION =
  'misinformation is not ranked — whether an assertion is false is world knowledge, and a ranker that '
  + 'reads for what a book says sees only "makes a factual assertion". Measured in briefcase against '
  + 'its reference videos: 169 of 205 candidates and 19 of 20 verified false positives were this one '
  + 'category.';

/** The category name that is refused rather than ranked. See above. */
export const EXCLUDED_CATEGORY = 'misinformation';

/** The option key for "none of these" — briefcase's `NONE_KEY`. No category may be called it. */
export const NONE_KEY = 'none';

/**
 * At most this many categories: the door's letters run A..Z, and one of the
 * twenty-six is "none". briefcase's `MAX_FLAG_CATEGORIES`.
 */
export const MAX_CATEGORIES = 25;

/** A custom category's line: the first sentence of its description, clipped to this. */
const CUSTOM_OPTION_MAX_CHARS = 140;

/**
 * The line a described category is ranked by — briefcase's `customOptionText`:
 * the first sentence of the description, clipped. A description is usually
 * written as an instruction to an LLM, and its first sentence is the closest
 * thing to a description of an act it carries. The report names the category
 * untuned so nobody reads its counts as calibrated.
 */
export function customOptionText(description: string, maxChars = CUSTOM_OPTION_MAX_CHARS): string {
  const text = description.replace(/\s+/g, ' ').trim();
  const m = /^.*?[.!?](?=\s|$)/.exec(text);
  let first = (m ? m[0] : text).trim();
  if (first.length > maxChars) first = first.slice(0, maxChars - 1).trimEnd() + '…';
  return first;
}

/** One category as a caller may ask for it — the `--categories` file's shape. */
export interface CategoryRequest {
  name: string;
  /** False turns a built-in off. Absent means on. */
  enabled?: boolean;
  /**
   * Required for a name this program has no line for. It becomes the
   * proposition the verifier tests, and its first sentence the line the scorer
   * reads (`customOptionText`).
   */
  description?: string;
  /**
   * The words a person reads for this category — carried into the report's
   * `names` header so every device shows the label the asker chose, exactly.
   * Absent, a built-in gets its mirrored display name and anything else is
   * shown as its id. Display only: it is deliberately OUTSIDE
   * `optionSetVersion`, because relabelling a category does not change the
   * question a single answer answered.
   */
  label?: string;
}

/** Every built-in category name, in the order a default run plans them. */
export function builtInCategories(): string[] {
  return [...Object.keys(OPTION_TEXTS), ...UNTUNED_BOOK_CATEGORIES.map((c) => c.category)];
}

/** A JS object lists integer-like keys first — briefcase's `integerLike`, for the door's reason. */
function integerLike(key: string): boolean {
  return /^(0|[1-9]\d*)$/.test(key) && Number(key) < 4294967295;
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
      log(`analyze: the category "${EXCLUDED_CATEGORY}" is not ranked — ${MISINFORMATION_EXCLUSION}`);
      continue;
    }
    /*
     * THE NAME IS AN ANSWER KEY ON THE WIRE, and two names cannot be. "none" is
     * the letter every question keeps for "none of these"; an integer-like name
     * would be moved to the front of the options object by any JSON reader, and
     * the letters would silently stop meaning what the question listed.
     */
    if (name.toLowerCase() === NONE_KEY) {
      throw new AnalysisPlanError(
        `a category cannot be called "${name}": every question the ranker asks keeps that name for `
        + '"none of these", and a category under it would be read as the absence of every category.',
      );
    }
    if (integerLike(name)) {
      throw new AnalysisPlanError(
        `a category cannot be called "${name}": the ranker's options travel as a JSON object, and a key `
        + 'that looks like a number is moved to the front of it — its letter would stop being the '
        + 'category the question listed.',
      );
    }

    const tuned = OPTION_TEXTS[name];
    const untunedBuiltIn = UNTUNED_BOOK_CATEGORIES.find((one) => one.category === name);
    const description = (request.description ?? '').replace(/\s+/g, ' ').trim();
    const label = (request.label ?? '').trim() || CATEGORY_NAMES[name] || name;

    if (tuned !== undefined) {
      plan.push({ category: name, label, option: tuned, proposition: PROPOSITIONS[name]!, tuned: true });
      continue;
    }

    if (untunedBuiltIn !== undefined) {
      plan.push({ ...untunedBuiltIn, label });
      continue;
    }

    if (description.length === 0) {
      throw new AnalysisPlanError(
        `the category "${name}" is not one this program has a line for, and it was given no `
        + 'description. There is nothing to rank a sentence against, and a category that scored '
        + 'nothing would sit in the report reading as "nothing in this book matched it".',
      );
    }
    const option = customOptionText(description);
    log(
      `analyze: "${name}" has no measured line, so the ranker reads the first sentence of its `
      + `description (${JSON.stringify(option)}) and the report names it untuned.`,
    );
    // The whole description is the proposition, as it always was, so the
    // verifier tests the claim the person wrote rather than its first sentence.
    plan.push({ category: name, label, option, proposition: description, tuned: false });
  }

  if (plan.length === 0) {
    throw new AnalysisPlanError(
      'no category is enabled, so this run has nothing to look for. A report with no categories in it '
      + 'would say the book is clean, which is a claim nothing measured.',
    );
  }
  if (plan.length > MAX_CATEGORIES) {
    throw new AnalysisPlanError(
      `${plan.length} categories are enabled and the ranker can ask about at most ${MAX_CATEGORIES}: `
      + 'every question is one letter per category, the letters run A to Z, and one of them is '
      + '"none of these". Turn some off.',
    );
  }

  /*
   * TWO CATEGORIES CANNOT SHARE A LINE. The scorer is shown both as two letters
   * of one question with the same words beside them, and it splits its belief
   * between them however it likes — the two would share the evidence and one of
   * them would be reported for the other's. Caught here, where the sentence can
   * name both categories.
   */
  const owner = new Map<string, string>();
  for (const entry of plan) {
    const already = owner.get(entry.option);
    if (already !== undefined) {
      throw new AnalysisPlanError(
        `the categories "${already}" and "${entry.category}" are asking the same question, word for `
        + `word: "${entry.option}". The ranker would offer them as two letters with one meaning, and `
        + 'one of them would be reported for the other\'s evidence.',
      );
    }
    owner.set(entry.option, entry.category);
  }

  return plan;
}

/**
 * Read a `--categories` file into requests, refusing anything it cannot use.
 *
 * EVERY REFUSAL NAMES THE ENTRY. A categories file is written by hand, and the
 * failure it is going to have is a typo in a field name — which, accepted
 * silently, means a hand-written line that never reached the model and a run
 * that cost an hour and looked fine. So an unknown field is an error, not a
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
  const known = new Set(['name', 'enabled', 'description', 'label']);
  const out: CategoryRequest[] = [];
  for (const [index, raw] of parsed.entries()) {
    const at = `${where}, category ${index + 1}`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new AnalysisPlanError(`${at} is not an object`);
    }
    const entry = raw as Record<string, unknown>;
    for (const key of Object.keys(entry)) {
      if (key === 'hypotheses') {
        // Its own sentence, because it was a real field until 2026-09-25 and a
        // file written for the entailment ranker is the one that will carry it.
        throw new AnalysisPlanError(
          `${at} carries "hypotheses", which the entailment ranker read and the snap ranker that replaced `
          + 'it does not. Give the category a "description": its first sentence is what the ranker reads '
          + 'and the whole of it is what the verifier tests.',
        );
      }
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
    if (entry['label'] !== undefined && typeof entry['label'] !== 'string') {
      throw new AnalysisPlanError(`${at}: "label" is a string — the display name a reader sees`);
    }
    out.push({
      name: entry['name'],
      ...(entry['enabled'] !== undefined ? { enabled: entry['enabled'] as boolean } : {}),
      ...(entry['description'] !== undefined ? { description: entry['description'] as string } : {}),
      ...(entry['label'] !== undefined ? { label: entry['label'] as string } : {}),
    });
  }
  return out;
}

/**
 * The plan's questions, as one short hex string — what the rank file and the
 * report header say this run asked.
 *
 * A rank file is the scorer's answers to "which of THESE does this passage do",
 * and the question includes every line that was a letter in it. Change one word
 * of one line and every stored answer is an answer to a question nobody is
 * asking any more. So the set is hashed, the hash is stamped into the rank file
 * and the report, and `analyze` refuses a rank file whose set is not the one it
 * is about to verify.
 *
 * The category NAME, the tuned flag and the proposition are in the digest as
 * well as the line: two plans with the same lines under different names produce
 * different reports, so they are different questions. Sixteen hex — eight bytes
 * — for `bankSha`'s reason.
 */
export function optionSetVersion(plan: readonly RankPlan[]): string {
  const NUL = String.fromCharCode(0);
  const fields: string[] = ['foundry-analysis-options-1'];
  for (const entry of plan) {
    fields.push(entry.category, entry.tuned ? 'tuned' : 'untuned', entry.option, entry.proposition);
  }
  return createHash('sha256').update(fields.join(NUL), 'utf8').digest('hex').slice(0, 16);
}

/** The categories of a plan that nothing has calibrated. The report names them. */
export function untunedNames(plan: readonly RankPlan[]): string[] {
  return plan.filter((entry) => !entry.tuned).map((entry) => entry.category);
}

/**
 * THE HUE EACH CATEGORY IS DRAWN IN, carried in the report so the artifact
 * owns its own colours.
 *
 * The values are `app/shared/analysis-categories.ts`'s, MIRRORED — that file
 * names this one and this one names it, the same discipline the category ids
 * already keep — and the report's `hues` header field exists because a reader
 * with no access to either table (BookForge's bookshelf player was the ask,
 * 2026-08-26: *"the player draws a category by colour and I won't keep a
 * second hue table"*) must still draw a category the same colour the desktop
 * drew it. A category outside the table (a described one, or one from a
 * newer build's list) hashes to its hue: FNV-1a, 32-bit, spelled out rather
 * than imported — the identical four lines the app's copy spells, because a
 * hash whose exact arithmetic decides a colour is a thing to be able to read
 * at the point of use, and two implementations that could drift would be two
 * answers about one category's colour.
 */
/**
 * The words a reader sees for each built-in, MIRRORED from
 * `app/shared/analysis-categories.ts` exactly as the hues below are — and
 * stamped into every report's `names` header for the hues' own reason: a
 * device that carries neither table (BookForge's player) must show
 * "Anti-evolution and science denial" where the desktop shows it, not a
 * re-humanised id that happens to be shorter. A custom category's label is the
 * asker's (`CategoryRequest.label`), so the phone shows the words the person
 * actually typed.
 */
const CATEGORY_NAMES: Record<string, string> = {
  'political-demonization': 'Political demonization',
  'hate': 'Hate',
  'conspiracy': 'Conspiracy',
  'dehumanization': 'Dehumanization',
  'violence': 'Violence',
  'false-prophecy': 'False prophecy',
  'christian-nationalism': 'Christian nationalism',
  'prosperity-gospel': 'Prosperity gospel',
  'extremism': 'Extremism',
  'political-violence': 'Political violence',
  'anti-evolution': 'Anti-evolution and science denial',
  'authoritarian-blueprint': 'Authoritarian blueprint',
};

const CATEGORY_HUES: Record<string, number> = {
  'political-demonization': 352,
  'hate': 130,
  'conspiracy': 264,
  'dehumanization': 68,
  'violence': 210,
  'false-prophecy': 20,
  'christian-nationalism': 158,
  'prosperity-gospel': 300,
  'extremism': 96,
  'political-violence': 236,
  'anti-evolution': 44,
  'authoritarian-blueprint': 186,
};

export function categoryHue(category: string): number {
  const known = CATEGORY_HUES[category];
  if (known !== undefined) return known;
  let hash = 0x811c9dc5;
  for (let i = 0; i < category.length; i += 1) {
    hash ^= category.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 360;
}

/** Every plan category's hue, in plan order — the report header's `hues`. */
export function planHues(plan: readonly RankPlan[]): Record<string, number> {
  const hues: Record<string, number> = {};
  for (const entry of plan) hues[entry.category] = categoryHue(entry.category);
  return hues;
}

/** Every plan category's display name, in plan order — the header's `names`. */
export function planNames(plan: readonly RankPlan[]): Record<string, string> {
  const names: Record<string, string> = {};
  for (const entry of plan) names[entry.category] = entry.label;
  return names;
}
