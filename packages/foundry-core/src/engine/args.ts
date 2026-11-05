/**
 * args — a small hand-rolled argument parser.
 *
 * Deliberately dependency-free. Foundry compiles to a single self-contained
 * executable, and every dependency is one more thing that has to work inside
 * `bun build --compile` on three platforms. An argv parser is fifty lines.
 *
 * Rules:
 *   --flag value      long option with a value
 *   --flag=value      same
 *   --bool            boolean option (declared with type 'boolean')
 *   -o value          short alias
 *   --                everything after is positional, verbatim
 *
 * An unknown option is an ERROR that names the option. It is never ignored and
 * never silently swallowed as a positional — a typo'd flag that quietly does
 * nothing is exactly the class of failure this project refuses to ship.
 */

export type OptionType = 'string' | 'boolean';

export interface OptionSpec {
  /** Long name, without the leading dashes. */
  name: string;
  /** Single-character alias, without the leading dash. */
  short?: string;
  type: OptionType;
  /** Placeholder shown in help for string options, e.g. `<path>`. */
  placeholder?: string;
  /** One-line help text. */
  describe: string;
  /**
   * Repeatable: every occurrence is COLLECTED, and the option's value is a
   * string array rather than a string.
   *
   * `--exclude footnote --exclude caption` has to mean both, not the last one.
   * With the default last-wins rule a user who names two categories silently
   * gets one of them and a book that still contains the other — a quiet
   * half-obeyed instruction, which is the shape of failure this program exists
   * to refuse. So repetition is declared per option, and a repeat of an option
   * that did NOT declare it is an error rather than a silent overwrite.
   */
  multiple?: boolean;
}

export type OptionValue = string | boolean | string[];

export interface ParsedArgs {
  positional: string[];
  options: Record<string, OptionValue>;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export function parseArgs(argv: readonly string[], specs: readonly OptionSpec[]): ParsedArgs {
  const byLong = new Map<string, OptionSpec>();
  const byShort = new Map<string, OptionSpec>();
  for (const spec of specs) {
    byLong.set(spec.name, spec);
    if (spec.short) byShort.set(spec.short, spec);
  }

  const positional: string[] = [];
  const options: Record<string, OptionValue> = {};

  /**
   * Record a string value, collecting repeats for `multiple` options and
   * REFUSING them for the rest. A second `--run` is not a correction, it is a
   * command that means two different things at once.
   */
  const setString = (spec: OptionSpec, value: string): void => {
    if (spec.multiple) {
      const prior = options[spec.name];
      options[spec.name] = Array.isArray(prior) ? [...prior, value] : [value];
      return;
    }
    if (options[spec.name] !== undefined) {
      throw new UsageError(
        `option --${spec.name} was given more than once, and it takes a single value`,
      );
    }
    options[spec.name] = value;
  };

  let i = 0;
  for (; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }

    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);
      const spec = byLong.get(name);
      if (!spec) throw new UsageError(`unknown option --${name}`);

      if (spec.type === 'boolean') {
        if (inlineValue !== undefined) {
          throw new UsageError(`option --${name} is a flag and takes no value`);
        }
        options[spec.name] = true;
        continue;
      }

      const value = inlineValue ?? argv[++i];
      if (value === undefined) throw new UsageError(`option --${name} needs a value`);
      setString(spec, value);
      continue;
    }

    if (arg.startsWith('-') && arg.length > 1) {
      const short = arg.slice(1);
      const spec = byShort.get(short);
      if (!spec) throw new UsageError(`unknown option -${short}`);

      if (spec.type === 'boolean') {
        options[spec.name] = true;
        continue;
      }

      const value = argv[++i];
      if (value === undefined) throw new UsageError(`option -${short} needs a value`);
      setString(spec, value);
      continue;
    }

    positional.push(arg);
  }

  return { positional, options };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading values back out
//
// Typed accessors rather than reaching into `options` directly, so a command
// cannot quietly treat a missing option as an empty string. `requireString` is
// the one that matters: it throws a UsageError naming the option AND what it is
// for, because "missing --run" is a question about which run directory, and the
// answer belongs in the error rather than in the help page the reader now has
// to go find.
// ─────────────────────────────────────────────────────────────────────────────

export function optionalString(args: ParsedArgs, name: string): string | undefined {
  const value = args.options[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new UsageError(`option --${name} takes a single value`);
  }
  return value;
}

export function requireString(args: ParsedArgs, name: string, what: string): string {
  const value = optionalString(args, name);
  if (value === undefined || value.trim() === '') {
    throw new UsageError(`--${name} is required: ${what}`);
  }
  return value;
}

export function stringList(args: ParsedArgs, name: string): string[] {
  const value = args.options[name];
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return [value];
  throw new UsageError(`option --${name} takes values, not a bare flag`);
}

export function flag(args: ParsedArgs, name: string): boolean {
  return args.options[name] === true;
}

/** Render one option as a help line: `  -o, --out <path>    description`. */
export function formatOption(spec: OptionSpec, pad: number): string {
  const left = [
    spec.short ? `-${spec.short},` : '   ',
    `--${spec.name}`,
    spec.type === 'string' ? (spec.placeholder ?? '<value>') : '',
  ]
    .filter(Boolean)
    .join(' ');
  return `  ${left.padEnd(pad)}  ${spec.describe}`;
}

export function formatOptions(specs: readonly OptionSpec[]): string {
  if (specs.length === 0) return '';
  const widths = specs.map(
    (s) =>
      (s.short ? 4 : 3) +
      1 +
      s.name.length +
      2 +
      (s.type === 'string' ? (s.placeholder ?? '<value>').length + 1 : 0),
  );
  const pad = Math.max(...widths);
  return specs.map((s) => formatOption(s, pad)).join('\n');
}
