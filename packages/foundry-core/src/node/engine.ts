/**
 * engine — the one place that knows how to run foundry.
 *
 * foundry is a STANDALONE UNIT. This app never imports a line of it; it spawns
 * it, reads its stderr, and believes its exit code (0 ok, 1 the run failed,
 * 2 the command line was wrong). Everything about *which* program that is lives
 * in `engineCommand()` below and nowhere else.
 *
 * Cribbed from BookForge's electron/foundry-bridge.ts: the argument-array spawn
 * (never a shell string — a binary under `C:\Program Files\…` interpolated into
 * a command line becomes the program `C:\Program`), the line-buffered stderr
 * reader (a progress callback fired on half a line is a UI showing half a page
 * number), and returning a nonzero exit rather than throwing on it.
 */
import type { JobProgress, JobUsage } from '../shared/types';

export { engineBundlePath, engineCommand, engineInfo, runEngine, runDoctor } from './engine-run';
export type { EngineCommand, RunHandle } from './engine-run';
export { stampEpub, finalizeEpub } from './engine-stamp';
export type { StampOutcome, FinalOutcome } from './engine-stamp';
export { writeBookFile, writeEpubBook } from './engine-book';
export type { BookOutcome } from './engine-book';
export { readEpubMetadata, writeEpubMetadata, stampMintMetadata, readPdfMetadata, writePdfMetadata } from './engine-meta';

// ─────────────────────────────────────────────────────────────────────────────
// Progress
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One stderr line -> a page count, or null.
 *
 * Cribbed verbatim in shape from BookForge's shared/vlm/conversion.ts
 * `parseVlmProgressLine`, including the ORDER of the three patterns, which is
 * load-bearing:
 *
 *   `page 3/317: rendered`        the rasteriser's own line, forwarded through
 *                                 foundry, with NO `vlm-convert:` prefix — which
 *                                 is why the prefix test cannot come first;
 *   `vlm-convert: … page 12 (5/317)`   the endpoint route, checked before the
 *                                 local pattern because it also contains
 *                                 "page N" and would be read as a count;
 *   `vlm-convert: … page 5/317`   the local route.
 *
 * Two more commands have their own prefixes and their own nouns since —
 * `translate: block n/m` (or `simplify: block n/m`, the same command under its
 * other name) and `analyze: rank|verify n/m` — and both are
 * matched above the prefix gate, with the reason written at each of them.
 */
export function parseProgressLine(line: string): JobProgress | null {
  const trimmed = line.trim();

  const rendered = /^page\s+(\d+)\/(\d+):\s+rendered$/.exec(trimmed);
  if (rendered) {
    return { phase: 'render', page: Number(rendered[1]), total: Number(rendered[2]) };
  }

  /*
   * `translate: block 412/2081 (EPUB/text/c0003.xhtml)` — or `simplify: block …`,
   * because the engine names the act it is running (Owen, 2026-09-13: a
   * simplify may not say "translate"), and both acts count blocks the same way.
   *
   * Matched before the `vlm-convert:` gate because it is a different command
   * with its own prefix, and matched on `block` specifically so the engine's
   * OTHER lines — the rejected-answer notices, which also carry a fraction
   * (`attempt 2/3`) — cannot be read as progress. A bar that jumped to 67%
   * because an answer was retried would be a bar reporting the wrong quantity
   * entirely. The phase token stays `translate`: it names the SHAPE of the
   * progress (blocks of a text act), and the row's own kind names the act.
   */
  const block = /^(?:translate|simplify):\s+block\s+(\d+)\/(\d+)\b/.exec(trimmed);
  if (block) {
    return { phase: 'translate', page: Number(block[1]), total: Number(block[2]) };
  }

  /*
   * `clean-text: 412/2081`.
   *
   * ── The one pattern in here with no noun to match on ───────────────────────
   *
   * Every other line above names what it is counting — `block`, `rank`, `verify`,
   * `page` — and the naming is what stops a bar reading a retry count or a survivor
   * count as progress. `clean-text` counts blocks and says so only in its FINAL
   * line: `clean-text: 412 blocks, 87 changed, 3 edits refused in 91s`. So the
   * discipline is spelled the other way round — the fraction is anchored to the end
   * of the line (`$`), which the summary cannot satisfy because it goes on to say
   * "blocks, 87 changed". A `\b` here would have read "412 blocks, 87 changed" as
   * 412 of 87 and driven the bar past its own end at the moment the run finished.
   *
   * ABOVE THE `vlm-convert:` GATE for `analyze`'s reason exactly: that gate rejects
   * a prefix it has never heard of, and this is a fourth command with a fourth
   * prefix. Below the two patterns above it, which wear prefixes this command does
   * not — so the placement is free of the ordering hazard and is stated anyway,
   * because the one thing this function's history says is that somebody will add a
   * pattern to it in a hurry.
   */
  const cleaned = /^clean-text:\s+(\d+)\/(\d+)$/.exec(trimmed);
  if (cleaned) {
    return { phase: 'clean', page: Number(cleaned[1]), total: Number(cleaned[2]) };
  }

  /*
   * `clean-triage: 412/2081` — the question before a cleanup, counting positions.
   *
   * `clean-text`'s discipline exactly, one command over and for its reason: the
   * triage names no noun on its counting line, and its OTHER lines carry numbers
   * that are not progress — `clean-triage: 2081 position(s) in 90 group(s), asked
   * of …` at the start and `clean-triage: 312 of 2081 position(s) need cleaning`
   * at the end. Anchored at both ends, neither of them can be read as a count.
   *
   * ITS OWN PHASE, `triage`, and not `clean`'s: the cleanup's bar follows this one
   * on the next row, and a person watching two bars that both say "Cleaning" would
   * be reading the first as the second (`JobProgress.phase`).
   */
  const triaged = /^clean-triage:\s+(\d+)\/(\d+)$/.exec(trimmed);
  if (triaged) {
    return { phase: 'triage', page: Number(triaged[1]), total: Number(triaged[2]) };
  }

  /*
   * `analyze: rank 141/141 sentences` and `analyze: verify 3/20 (hate)`.
   *
   * ── WHERE THIS SITS IN THE ORDER, WHICH IS THE LOAD-BEARING PART ───────────
   *
   * Above the `vlm-read:`/`vlm-convert:` gate below, because that gate would
   * reject these lines outright — a different command, a different prefix — and
   * BELOW the two patterns above it, because those are matched on prefixes this
   * command does not wear and would never see one of these lines. So the
   * placement is free of the hazard the older patterns are ordered around, and it
   * is stated here anyway, because the one thing this function's history says is
   * that somebody will add a pattern to it in a hurry.
   *
   * MATCHED ON THE TWO STAGE WORDS SPECIFICALLY, which is `block`'s own
   * discipline: `analyze` says a great many things with numbers in them —
   * how many answers were reused, how many candidates survived the floor — and a
   * bar that read one of those as progress would report the wrong quantity
   * entirely. Naming `rank` and `verify` means only the engine's own two counting
   * lines are counts.
   *
   * A PHASE EACH, and the stage word is what says which. It was one phase for
   * both — `analyze` — and the bar that drew it filled, reset and filled again,
   * because 141 sentences becoming 20 verify calls is one run measuring two
   * unrelated things. Owen read that as a glitch, which it looks exactly like, so
   * the word the engine already prints is now CAPTURED rather than merely matched
   * on, and the two stages are two members of the phase union
   * (`JobProgress.phase`, where the whole argument lives). The surfaces draw a bar
   * apiece; nothing else about this line changed.
   *
   * The parenthesised category is still deliberately NOT lifted out — it rides on
   * a COUNTING line, and a count clears `Job.note` by construction, which is what
   * makes a note mean "since the count last moved". The row's own log line carries
   * it, in the engine's words.
   */
  const analyzing = /^analyze:\s+(rank|verify)\s+(\d+)\/(\d+)\b/.exec(trimmed);
  if (analyzing) {
    return {
      phase: analyzing[1] === 'rank' ? 'rank' : 'verify',
      page: Number(analyzing[2]),
      total: Number(analyzing[3]),
    };
  }

  /*
   * `vlm-read:` AND `vlm-convert:`, the same shape under two names.
   *
   * Reading the pages left `vlm-convert` and became a command of its own, and the
   * lines it writes are the ones this function was built for — they ARE the page
   * counts; the conversion is what stopped emitting them. Gated on the prefix at
   * all (rather than matching any `page n/m`) for the reason the gate has always
   * existed: the engine says a great many things with numbers in them, and a bar
   * that read `attempt 2/3` as progress would jump to 67% because an answer was
   * retried.
   *
   * `vlm-convert:` stays because a rendering still counts its pages as it writes
   * them, and because dropping it would silently un-bar every conversion the day
   * this file changed.
   */
  if (!trimmed.startsWith('vlm-read:') && !trimmed.startsWith('vlm-convert:')) return null;

  const viaEndpoint = /\bpage\s+\d+\s+\((\d+)\/(\d+)\)/.exec(trimmed);
  if (viaEndpoint) {
    return { phase: 'read', page: Number(viaEndpoint[1]), total: Number(viaEndpoint[2]) };
  }

  const local = /\bpage\s+(\d+)\/(\d+)\b/.exec(trimmed);
  if (local) {
    return { phase: 'read', page: Number(local[1]), total: Number(local[2]) };
  }

  return null;
}

/**
 * One stderr line -> what the run SPENT, or null.
 *
 * ── The contract, and it IS a contract ─────────────────────────────────────
 *
 * `usageLine` (src/translate/transport.ts) prints exactly one of these at the
 * end of every text act that talked to a server which counted:
 *
 *   translate: 412 requests, 1,203,441 tokens in, 388,120 out
 *
 * The act prefix is the act's own (`translate`, `simplify`, `clean-text`,
 * `analyze`), the numbers are `toLocaleString('en-US')` — so they carry commas —
 * and the three nouns are the interface. The prose around them is free to
 * change; those words are not.
 *
 * ── Why it is not a fourth pattern inside `parseProgressLine` ──────────────
 *
 * Because it is not progress, and that function's whole discipline is that
 * everything it returns is a count of work done out of work to do. A usage line
 * would be a fraction-shaped thing (`412 requests`) arriving on a function whose
 * callers set a progress bar from it. Two readers, two questions, and the one
 * caller asks both of the same line.
 *
 * ── Null for every other line, INCLUDING a run that spent nothing ──────────
 *
 * A door that reported no usage prints no line at all (Ollama is that door), so
 * absence here is "nothing counted" and never "zero tokens". The app does not
 * invent the second from the first — see {@link JobUsage} on the row.
 *
 * THE COMMAS ARE STRIPPED AND NOT PARSED AROUND. `Number('1,203,441')` is `NaN`,
 * and a locale that grouped with thin spaces would break this — the engine pins
 * `en-US` for exactly that reason, so the separator is a comma and only a comma.
 */
export function parseUsageLine(line: string): JobUsage | null {
  const spent = /^[a-z-]+:\s+([\d,]+) requests, ([\d,]+) tokens in, ([\d,]+) out$/
    .exec(line.trim());
  if (spent === null) return null;
  const count = (raw: string | undefined): number => Number((raw ?? '').replace(/,/g, ''));
  const requests = count(spent[1]);
  const tokensIn = count(spent[2]);
  const tokensOut = count(spent[3]);
  /*
   * A number this reader could not make sense of is NO usage rather than a row
   * saying NaN. There is no way for the engine to produce one — the groups are
   * digits and commas — and a guard whose cost is one comparison is cheaper than
   * the screenshot of "NaN in / NaN out" it prevents.
   */
  if (!Number.isFinite(requests) || !Number.isFinite(tokensIn) || !Number.isFinite(tokensOut)) {
    return null;
  }
  return { requests, tokensIn, tokensOut };
}
