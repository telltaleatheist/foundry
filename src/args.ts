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
}

export interface ParsedArgs {
  positional: string[];
  options: Record<string, string | boolean>;
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
  const options: Record<string, string | boolean> = {};

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
      options[spec.name] = value;
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
      options[spec.name] = value;
      continue;
    }

    positional.push(arg);
  }

  return { positional, options };
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
