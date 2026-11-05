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

## After step 1 (the four Electron edges cut)

| Check | Result |
| --- | --- |
| IPC channel names | `--check`: unchanged (handle 158, invoke 159, listen 20, push 19) |
| `bun test` | **1335 tests across 70 files: 1331 pass, the same 4 fail** (by name, as above). The +4 tests / +1 file is the new keeper `app/test/lib-no-electron.test.ts`; 1327 + 4 = 1331. The `error:` lines printed by passing tests are the same set as before. |
| Typecheck | the same one error, `app/shared/types.ts(14,1) TS6133 LlmServerKind` |
| App build | exit 0, same template / surface keeper lines, same budget warning |
| Engine bundle | `--check` current (src b004a63d2ce7); `src/` untouched, bundle not rebuilt |
| Load smoke | `node app/tools/checks/lib-loads-without-electron.cjs`: all 40 compiled library modules in `dist/electron` load with `electron` unresolvable; `readAppSettings()` before `setPlatform` refuses by name; `window.js` (control) is refused |

19 of the 20 `app/test` files that mocked `electron` no longer do — they call
`useTestPlatform` (app/test/platform-fixture.ts) with the directories their mock's `getPath`
returned. `hosted-runner.test.ts` keeps its mock because it imports `mount.ts` (app-side).

## After step 2 (ipc.ts, mount.ts and documents.ts thinned; six renderer modules moved)

| Check | Result |
| --- | --- |
| IPC channel names | handle 158, invoke 159, listen 20, push 19 — every name and every handle/invoke/listen row unchanged. **One row's FILE column moved**, and it is the one push whose body left ipc.ts: `push acts:gates-changed` is now `electron/doors-crucible.ts` (`gatesChanged`, which broadcasts through platform's `broadcast` — the same function mount hands over). `--check` showed exactly that `-`/`+` pair and nothing else; the baseline was re-written with `--write` to record it. Every other push stayed in ipc.ts because its `broadcast(...)` is a wiring line that stayed. |
| `bun test` | **1336 tests across 70 files: 1332 pass, the same 4 fail** (by name, as above). +1 test: `lib-no-electron.test.ts` now also holds `app/browser/` to importing only `browser/` and `shared/`. |
| Typecheck | the same one error, `app/shared/types.ts(14,1) TS6133 LlmServerKind` |
| App build | exit 0, same template keeper line (106 literals), same surface keeper line (12 files, 6 checked), same budget warning (initial 1.11 MB) |
| Engine bundle | `--check` current (src b004a63d2ce7); `src/` untouched |
| Load smoke | `lib-loads-without-electron.cjs`: **50** library modules load with electron unresolvable (40 + `doors-*.ts` ×8, `mount-work`, `document-intake`); refusal before `setPlatform` and the `window.js` control as before |
| Exported surface | mount.js, ipc.js, documents.js: identical runtime keys (`typeof`, arity) with a stub electron, and identical names + checker type strings from the TS program, before vs after |
| suite-order.sh | 3 shuffled orders: every order 1332 pass / the same 4 fail, nothing order-dependent (the script reports "failed" because it counts the 4 pre-existing failures) |

## After step 3 (the package: `packages/foundry-core`, `@owen/foundry-core` 0.1.0)

Every command now runs against the moved tree: `node app/tools/ipc-channels.js --check`,
`bun test` (root), `npm run typecheck` (root: the package's three programs, then the root
tools program), `npm --prefix app run build` (which now builds the package and syncs it into
`app/node_modules` first), `node packages/foundry-core/tools/build-engine.mjs --check`.

| Check | Result |
| --- | --- |
| IPC channel names | handle 158, invoke 159, listen 20, push 19 — every kind+name row identical, with multiplicity (`cut -f1,2` of both lists diffed). The scanner now also reads `packages/foundry-core/src/node/`, so **four FILE-column rows moved** with their bodies and nothing else changed: `push acts:gates-changed` (`doors-crucible.ts`) and `push host-ops:changed` / `host-ops:offers-changed` / `host-ops:status-changed` (`host-ops.ts`), each from `electron/<file>` to `packages/foundry-core/src/node/<file>`. Baseline re-written with `--write`. |
| `bun test` | **1338 tests across 70 files: 1334 pass, the same 4 fail** (by name, as above). +2 tests: `lib-no-electron.test.ts` *"the package never reaches electron: no source imports it, its package.json does not name it, nothing leaves the package"*, and `crucible-pin.test.ts` *"packages/foundry-core pins the same Crucible SDKs and tool-loop as app/"*. Files: `test/**` → `packages/foundry-core/test/engine/**` (38), 27 library tests + `platform-fixture.ts` → `packages/foundry-core/test/lib/`, and `app/test/` keeps the 3 app-side ones (`hosted-runner` — it imports `mount.ts` —, `crucible-pin`, `lib-no-electron`). |
| suite-order.sh | 3 shuffled orders: every order 1334 pass / the same 4 fail |
| Typecheck | the same one error, now at its new path: `packages/foundry-core/src/shared/types.ts(14,1) TS6133 LlmServerKind` (reached by the root program through `tools/ask-document`, as before). The package's engine program (old root options), CJS program (old `tsconfig.electron.json` options) and ESM program (old renderer options) are clean. |
| App build | exit 0, same template keeper line (106 literals), same surface keeper line (12 files, 6 checked), same budget warning (initial 1.11 MB). The renderer bundles the package's ES build out of `app/node_modules` (`ng build --stats-json`: 33 inputs, all under `node_modules/@owen/foundry-core/dist/esm/`, none from `src/`). |
| Emitted main process | `packages/foundry-core/dist/node/*.js` (50) and `dist/shared/*` (46) are **byte-identical** to the step-2 `app/dist/electron` / `app/dist/shared` output (sourceMappingURL lines aside), except `engine.js`'s `engineBundlePath()`. The 7 app-side `app/dist/electron/*.js` are identical once each `require("./x")` / `require("../shared/x")` is read as `require("@owen/foundry-core/{node,shared}/x")`. |
| Engine bundle | `--check` current, stamp **src 13150cd7758d** (was b004a63d2ce7: the digest keys inputs by repo-relative path, and every path moved). Against the step-2 bundle, with paths folded and esbuild's numeric name suffixes folded, the ONLY differing lines are the inlined repo `package.json` (its scripts and dependencies changed) and the stamp; module order is identical. The package is `"type": "module"` so esbuild still bundles the engine in node mode (`__toESM(x, 1)`), as under the repo root. |
| Load smoke | `lib-loads-without-electron.cjs`: the **50** library modules in `packages/foundry-core/dist/node` (and in the app's installed copy) load with electron unresolvable; refusal before `setPlatform` and the `app/dist/electron/window.js` control as before |
| App start | `app/dist/electron/main.js` under plain Node with a recording electron stub, `whenReady` resolved (so `mountFoundry()`, `buildMenu()`, `openTheWindow()` ran): 158 `ipcMain.handle` registrations, the same 158 names as the step-2 build run the same way, `foundry-file` scheme + protocol handler, one window loading `index.html`, a menu, no errors; 81 modules loaded from `@owen/foundry-core`. |
| npm pack | `owen-foundry-core-0.1.0.tgz`, 3.61 MB (11.88 MB unpacked), 292 files: `dist/node` 100, `dist/shared` 90, `dist/esm/shared` 88, `dist/esm/shared-browser` 4, two `package.json` type stamps, `engine/foundry-engine.cjs` + 5 assets, README, package.json. No sources, tests, maps or node_modules. Installed into an empty consumer with the three peers from `app/vendor`: one `@crucible/client`, `engineBundlePath()` inside the consumer's copy, the bundle answers `foundry 2.0.2 (src 13150cd7758d)`. |

Not run (Owen gates packaging): the plan's step-3 "packaged Foundry runs" check —
`package:win-x64`, open a PDF, run a job. The engine now lives in
`node_modules/@owen/foundry-core/engine/` inside the archive instead of `engine/` beside
`dist/`; that path is the one thing only a packaged run proves.

## After A1 (release tooling) and A2 (no Python)

A1 (`df8a25f`, `da7f7f1`) added tooling only; every check matched "After step 3".

A2 is two commits. A2a moves the engine onto MuPDF and retires the local reader; A2b retires the
environment machinery and its five channels.

| Check | Result |
| --- | --- |
| IPC channel names | `--check` showed exactly ten `-` rows and no `+`: `handle`/`invoke` × `env:cancel`, `env:catalog`, `env:choose-dest`, `env:install`, `listen`/`push` `env:install-progress`. Baseline re-written: **handle 154, invoke 155, listen 19, push 18**. |
| `bun test` | **1336 tests across 69 files: 1332 pass, the same 4 fail** (by name, as above). −2 tests / −1 file: `test/engine/local-python-candidates.test.ts`, which tested the deleted interpreter list. |
| Typecheck | the same one error, `packages/foundry-core/src/shared/types.ts(14,1) TS6133 LlmServerKind` |
| App build | exit 0; template keeper **104** literals (was 106: the deleted env card's template and styles); surface keeper 12 files / 6 checked; budget warning initial 1.10 MB |
| Engine bundle | `--check` current, **src 7070147f2016** (the engine's sources changed) |
| Load smoke | **46** library modules load with electron unresolvable (50 − `env-catalog`, `env-downloader`, `env-install`, `env-provision`); refusal and control as before |

**Rasteriser parity** (`vlm_page.py` run exactly as the bridge spawned it, under the Windows env's
PyMuPDF 1.28.0 = MuPDF 1.29.0, against `raster.ts` on `mupdf` 1.28.1). Inputs: Kershaw (JSTOR OCR,
TimesNewRoman, two page sizes), Flashpoint (GlyphLessFont OCR, jittered sizes), Jehovah's Witnesses
(base-14 Type1), Evans (1,251 pp), the witches capture mint (image-only, jittered), a copy of Kershaw
with every /Rotate and two CropBoxes, and 11 page images (capture PNG/JPEG with ICC profiles, an
alpha PNG, a CMYK PAM, a gray PNG). The page images are the models' input.

| Mode | Result |
| --- | --- |
| render | 118 pages: pixel dimensions exact, **0 differing bytes** of 959 M (PNG samples and the PGM twin); document event (title, author, frame, snap mode) identical in all 7 cases |
| textlayer | **130,810 spans on 1,740 pages, every page identical** |
| crop | 235 crops: every box and pixel size identical; 234 pixel-identical. One 5×4 px Evans crop differs in 10 bytes of its bottom row (max 17): PyMuPDF draws a clip through a display-list *scissor* that culls whole nodes outside the clip, and mupdf.js's `DisplayList.run` takes no scissor. Crops are EPUB figures, never model input. |

What faithfulness took, beyond calling MuPDF:
- mupdf.js's `asPNG` converts ICC-tagged pixels to sRGB. `pngBytes` writes the raw samples with the
  source's own profile in an iCCP chunk, as PyMuPDF did.
- PyMuPDF's C++ span rules (`JM_make_spanlist`) and char-box correction (`JM_char_quad`), in float32.
- A device pass recovers the two facts mupdf.js's walker hides: each font's ascender/descender (read
  back off MuPDF's own quads with the glyph's exact matrix; the size cannot stand in under `Tz`
  scaling) and each character's flags (FILLED/STROKED/CLIPPED/UNICODE_IS_CID, synthetic-large spaces).

**End to end:** the Kershaw bank replayed (`--reuse-readings`) through the old and the new engine
bundles gave an identical EPUB (all 7 entries) and a facsimile PDF identical but for its creation date
and creator stamp, which also differ between two runs of the same bundle.

**Not run (Owen gates packaging):** a packaged Foundry. The engine now imports `mupdf` (and reads
`mupdf-wasm.wasm` with `fs`) from `node_modules` inside the app archive; asar reads under
`ELECTRON_RUN_AS_NODE` are expected to work, and only a packaged run proves it.
