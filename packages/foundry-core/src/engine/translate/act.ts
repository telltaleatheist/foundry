/**
 * translate/act — the name of the job that is running, and nothing else.
 *
 * Owen, 2026-09-13: *"translate, simplify, and analysis are separate acts.
 * They're very similar and can be under the same umbrella but they can't lie to
 * the user and say a translate job is running when it's actually a simplify
 * job. It must accurately represent the job that's running."* Before this,
 * everything the `translate` command logged was prefixed `translate:` whether
 * the run was a translation or a `--rewrite` — forty-three lines, every one of
 * them wrong for a simplify, and the app's progress bar was reading the prefix.
 *
 * So the act is a VALUE derived once from the one fact that decides it, and
 * every sentence the run prints starts with it. Analysis has its own command
 * and its own prefix already; the two that shared a command are the two here.
 */

import type { RewriteMode } from './run.js';

export type TextAct = 'translate' | 'simplify';

/** Which act a run is, from the flag that makes it a rewrite. */
export function textActOf(rewrite: RewriteMode | undefined): TextAct {
  return rewrite === undefined ? 'translate' : 'simplify';
}
