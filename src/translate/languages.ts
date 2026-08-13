/**
 * translate/languages — the difference between a tag and a language.
 *
 * TWO CONSUMERS WANT DIFFERENT THINGS FROM `--to`, and this file is where they
 * stop fighting. The EPUB's `dc:language` is a BCP-47 tag and nothing else: a
 * package that says `<dc:language>English</dc:language>` is invalid, and a
 * reading system that picks hyphenation and speech synthesis off that field
 * gets neither. The MODEL wants the opposite — "translate into en" is a prompt
 * with a code in it where a language should be, and it measurably produced
 * worse output than "translate into English" on the same paragraph, including
 * one instance of a model asking what `en` meant.
 *
 * So `--to` takes a tag, the tag goes into the package, and this table turns it
 * into a name for the prompt.
 *
 * A TAG WHOSE LANGUAGE IS NOT IN THE TABLE IS REFUSED. Passing the raw tag
 * through to the prompt would be the fallback, and it is the bad kind: the run
 * would take hours, cost real GPU time, and produce a book that is either
 * untranslated or translated into whatever the model guessed `sq` meant, with
 * nothing anywhere saying a guess happened. Refusing costs the person one
 * lookup and a flag; the alternative costs them an evening and a book they
 * cannot trust. Adding a language is one line here.
 *
 * THE REGION SUBTAG SURVIVES INTO THE PACKAGE AND INTO THE PROMPT. `--to pt-BR`
 * is a real instruction — Brazilian Portuguese is not European Portuguese, and
 * a translator told only "Portuguese" will produce the wrong one about half the
 * time — so the lookup is on the primary subtag while the prompt is told the
 * whole tag: "Brazilian Portuguese" comes out of the table when the region is
 * known, and "Portuguese (pt-AO)" when it is not. `dc:language` gets the tag
 * exactly as it was typed, because that is the caller's statement about their
 * own book.
 */

/** Something wrong with a language tag. Always quotes what was typed. */
export class LanguageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LanguageError';
  }
}

/**
 * Primary subtag → the English name of the language.
 *
 * English names because the system prompt is in English; a model asked in
 * English to translate into "Deutsch" answers as reliably, but the instructions
 * around it would then be in two languages.
 */
const LANGUAGES: ReadonlyMap<string, string> = new Map(Object.entries({
  ar: 'Arabic', bg: 'Bulgarian', bn: 'Bengali', ca: 'Catalan', cs: 'Czech',
  da: 'Danish', de: 'German', el: 'Greek', en: 'English', es: 'Spanish',
  et: 'Estonian', fa: 'Persian', fi: 'Finnish', fr: 'French', he: 'Hebrew',
  hi: 'Hindi', hr: 'Croatian', hu: 'Hungarian', id: 'Indonesian', is: 'Icelandic',
  it: 'Italian', ja: 'Japanese', ko: 'Korean', la: 'Latin', lt: 'Lithuanian',
  lv: 'Latvian', ms: 'Malay', nl: 'Dutch', no: 'Norwegian', pl: 'Polish',
  pt: 'Portuguese', ro: 'Romanian', ru: 'Russian', sk: 'Slovak', sl: 'Slovenian',
  sr: 'Serbian', sv: 'Swedish', th: 'Thai', tr: 'Turkish', uk: 'Ukrainian',
  ur: 'Urdu', vi: 'Vietnamese', yi: 'Yiddish', zh: 'Chinese',
}));

/**
 * The handful of region pairs that are genuinely different written languages,
 * where naming the region is worth more than naming the language.
 *
 * Kept deliberately short. Every entry here is a case where a translator given
 * only the bare language name produces text a reader of that region would call
 * wrong — not merely a spelling preference, which the model handles from the
 * tag in parentheses.
 */
const REGIONAL: ReadonlyMap<string, string> = new Map(Object.entries({
  'pt-br': 'Brazilian Portuguese',
  'pt-pt': 'European Portuguese',
  'zh-hans': 'Simplified Chinese',
  'zh-hant': 'Traditional Chinese',
  'zh-cn': 'Simplified Chinese',
  'zh-tw': 'Traditional Chinese',
  'zh-hk': 'Traditional Chinese (Hong Kong)',
  'en-gb': 'British English',
  'en-us': 'American English',
  'es-419': 'Latin American Spanish',
  'nb-no': 'Norwegian Bokmål',
  'sr-latn': 'Serbian (Latin script)',
}));

/** A well-formed language tag, loosely: the shape BCP-47 allows, not the registry. */
const TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export interface NamedLanguage {
  /** Exactly what the caller typed. This is what `dc:language` gets. */
  tag: string;
  /** What the prompt calls it. */
  name: string;
}

/**
 * Read a language tag, or refuse it by name.
 *
 * `what` is the flag being validated (`--to`, `--from`), so the message points
 * at the thing the person typed rather than at the concept.
 */
export function readLanguage(tag: string, what: string): NamedLanguage {
  const trimmed = tag.trim();
  if (trimmed.length === 0) {
    throw new LanguageError(`${what} is empty — it takes a language tag such as en, de or pt-BR`);
  }
  if (!TAG.test(trimmed)) {
    throw new LanguageError(
      `${what} "${trimmed}" is not a language tag. It takes BCP-47: en, de, pt-BR, zh-Hant.`,
    );
  }

  const regional = REGIONAL.get(trimmed.toLowerCase());
  if (regional !== undefined) return { tag: trimmed, name: regional };

  const primary = trimmed.split('-')[0].toLowerCase();
  const language = LANGUAGES.get(primary);
  if (language === undefined) {
    throw new LanguageError(
      `${what} "${trimmed}": foundry has no name for the language "${primary}", and it will not `
      + 'send a model a code where a language should be — a run that guesses costs hours and '
      + `produces a book nobody can trust. Known: ${[...LANGUAGES.keys()].join(' ')}. `
      + 'Adding one is a line in src/translate/languages.ts.',
    );
  }
  // The region is kept in the prompt even when it is not one of the pairs
  // above: a model told "Spanish (es-MX)" spells the way Mexico spells, and a
  // model told nothing spells the way its training data leaned.
  const name = trimmed.includes('-') ? `${language} (${trimmed})` : language;
  return { tag: trimmed, name };
}
