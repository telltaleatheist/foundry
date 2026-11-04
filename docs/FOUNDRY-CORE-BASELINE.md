# @owen/foundry-core — step-0 baseline

What "unchanged" means for every step of `docs/FOUNDRY-CORE-PLAN.md`. Recorded 2026-11-04 at
`f2a6fa5` (plus the plan doc), Windows, before any code moved. Each later step re-runs all of
this and must match it.

| Check | Command | Result at f2a6fa5 |
| --- | --- | --- |
| IPC channel names | `node app/tools/ipc-channels.js --check` | unchanged vs `app/tools/ipc-channels.baseline.txt`: **handle 158, invoke 159, listen 20, push 19** (158 distinct `ipcMain.handle`, all in ipc.ts; no `ipcMain.on`; mount.ts registers none — its one `.handle` is `protocol.handle('foundry-file')`, not IPC) |
| Engine + app tests | `bun test` (root; picks up `test/**` 38 files and `app/test/**` 31 = **69 files**) | **1331 tests: 1327 pass, 4 fail**, 2312 expect() calls, ~14 s |
| Typecheck | `bun run typecheck` | exit 2, ONE error: `app/shared/types.ts(14,1): error TS6133: 'LlmServerKind' is declared but its value is never read.` |
| App build | `npm --prefix app run build` | exit 0 (build:electron, test:templates *"no stray backticks in 106 inline template/styles literals"*, ng build — one budget WARNING, initial 1.11 MB vs 500 kB, test:surface *"no forbidden setup-surface strings in 12 built renderer file(s) (6 checked)"*) |
| Engine bundle drift | `node tools/build-engine.mjs --check` (also `test/engine-bundle.test.ts`, inside `bun test`) | *"app/engine/ is current (src b004a63d2ce7)"*, test passes |

## The four pre-existing failures, by name

They fail the same way when their two files run alone (`bun test app/test/crucible-http.test.ts
app/test/crucible-lifecycle.test.ts` → 29 pass, 4 fail), so they are not test-order leaks.

- `app/test/crucible-http.test.ts` — *real HTTP module readiness does not prepare an unselected uninstalled larger variant*
- `app/test/crucible-http.test.ts` — *after following another app task, preparation checks and installs its own remaining demand*
  (both throw `fixture-…: 1 required model or runtime item(s) are still missing. Retry preparation.` from `prepareFoundryForUse`, crucible-coordinate.ts:441)
- `app/test/crucible-lifecycle.test.ts` — *native Windows setup restores the engine even when all model weights survived reinstall*
- `app/test/crucible-lifecycle.test.ts` — *upstream-only Foundry work does not install an unused native engine or weights*

Not investigated — out of scope for a no-change move; a step that turns one green or red is a
change to report, either way.
