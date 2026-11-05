# @owen/foundry-core

Foundry's features without a window: the engine bundle, the main-process logic
(projects, the step ledger, the queue, the host contract, Crucible, Ask, envs,
capture), and the browser-safe shapes and replay a renderer shares. Two apps
consume it: standalone Foundry (this repo's `app/`) and BookForge.

Nothing here imports `electron` — `app/test/lib-no-electron.test.ts` walks the
import graph to keep it that way. The four things a main process used to take
from Electron arrive through **`setPlatform()`** (`node/platform`).

## What it exports

| Subpath | What | Built as |
| --- | --- | --- |
| `@owen/foundry-core/node/<module>` | every main-process module by name: `job-queue`, `projects`, `workspace`, `book`, `host`, `host-ops`, `app-settings`, `crucible-*`, `ask-*`, `env-*`, `doors-*`, `mount-work`, `document-intake`, `openable`, `platform`, `capture`, `engine`, … (`src/node/`) | CommonJS + `.d.ts` (`dist/node`) |
| `@owen/foundry-core/host` | the host contract (`FoundryHost`, `recordHost`, `hosted`, the host queue types) — the same module as `node/host` | CommonJS + `.d.ts` |
| `@owen/foundry-core/engine` | `engineBundlePath()`, `engineCommand()`, `runEngine()` — the same module as `node/engine` | CommonJS + `.d.ts` |
| `@owen/foundry-core/engine/foundry-engine.cjs` | the engine itself (and `engine/assets/*`), committed, run as a child process | esbuild bundle |
| `@owen/foundry-core/shared/<module>` | the wire shapes, the ledger, the op replay, `api.ts` (the renderer↔main contract) … (`src/shared/`) | `import` → ES modules (`dist/esm/shared`), `require` → CommonJS (`dist/shared`), both with `.d.ts` |
| `@owen/foundry-core/shared/<name>.json` | `foundry.module.json`, `model-lineup.json` | copied |
| `@owen/foundry-core/browser/<module>` | renderer-only code that needs a canvas: `geometry`, `rectify` (`src/shared-browser/`) | ES modules + `.d.ts` |

There is no `./node` barrel: `job-queue` imports most of the library, so a
barrel would buy nothing but load-order surprises. Import the module you mean.

The ES build is **for bundlers** (Angular's esbuild, any `moduleResolution:
bundler` consumer): its relative imports are extensionless, as they were when
the renderer compiled these files itself. A Node main process uses the
CommonJS half, which `require` gets by default. A CommonJS consumer on
`moduleResolution: node` gets the types through `typesVersions`.

### The engine path

`engineBundlePath()` answers `<this package>/engine/foundry-engine.cjs`, found
from the package's own `package.json` (`require.resolve('@owen/foundry-core/package.json')`),
so it is right wherever the package is installed — a repo checkout, an app's
`node_modules`, a packaged app's archive. `engineCommand()` is as before:
`FOUNDRY_BIN` first (a command, no arguments, no extra environment), else the
bundle run by the host's own Electron with `ELECTRON_RUN_AS_NODE=1`; a missing
bundle is refused by name.

## `setPlatform` — the one call before anything else

```ts
import { setPlatform } from '@owen/foundry-core/node/platform';

setPlatform({
  userDataDir: () => app.getPath('userData'),
  tempDir: () => app.getPath('temp'),
  broadcast,            // (channel, payload) => void — how a push reaches every window
  image: nativeImage,   // createFromPath / createFromBuffer (capture's thumbnails and decode)
});
```

Anything that reads settings, the registry, the recents or the temp folder
before this refuses by name (*"The Foundry platform was asked for userDataDir
before it was set…"*). Foundry's `app/electron/mount.ts` (`mountFoundry`) makes
this call; a CLI or a test passes its own directories and a no-op broadcast.

## Dependencies

- **Owned:** `pdf-lib`, `libheif-js` (what `node/` uses at runtime). The engine's
  own (`undici`, `diff`, `@pdf-lib/fontkit`) are bundled into the `.cjs`, so they
  are devDependencies.
- **Peers — the app provides them:** `@crucible/client`, `@crucible/bootstrap`,
  `@owen/tool-loop`. A `file:` tarball nested inside this package's tarball does
  not install cleanly, and the library and the app must share ONE copy of each
  (`instanceof CrucibleRefused`, one registry). They are also devDependencies,
  naming `../../app/vendor/*.tgz`, so this package builds and tests on its own;
  `app/test/crucible-pin.test.ts` fails when those drift from the app's pins
  (after `tools/adopt-crucible-release.mjs`, repoint them here too).
- **Never:** `electron`, Angular, rxjs, pdfjs-dist.

## Working on it in this repo

```bash
npm --prefix packages/foundry-core ci       # once
npm --prefix packages/foundry-core run build   # tsc twice -> dist/ (CJS + ESM, .d.ts)
npm run build:engine                        # src/engine -> engine/ (commit it)
npm run typecheck                           # engine, CJS and ESM programs + the root tools
bun test                                    # package tests (test/engine, test/lib) + app/test
```

**How `app/` consumes it.** `app/package.json` depends on
`"@owen/foundry-core": "file:../packages/foundry-core"`, and `app/.npmrc` sets
`install-links=true`, so npm installs a **packed copy** — real files, never a
link. (On Windows a directory link is a junction, and recursive deletes and
`git worktree remove` follow junctions: a link here would let a `rm -rf
node_modules` delete the package's sources.) `app/tools/sync-foundry-core.cjs`
rebuilds the package and refreshes that copy; `build:electron` runs it first, so
`npm --prefix app run build` and `electron:dev` always use the library as it is
on disk — no release step. `--check` says whether the copy is current;
`--reinstall` is for when the package's dependencies or peers changed.

bun's tests do not need a build at all: `app/tsconfig.json` maps the package's
subpaths to `src/` for bun (the Angular build empties that mapping in
`tsconfig.app.json`, and the main process has none), so app-side code under
test and the library tests share one set of module instances.

## Cutting a tarball (how BookForge will take it)

```bash
cd packages/foundry-core
npm run build                                  # the engine bundle is committed; check it: npm run check:engine
npm pack --pack-destination <somewhere>        # -> owen-foundry-core-0.1.0.tgz
```

The tarball holds `dist/` (node, shared CJS + ESM, browser ESM, `.d.ts`), `engine/`
(bundle + assets), this README and `package.json` — no sources, no tests, no
node_modules. A consumer pins it as `file:vendor/owen-foundry-core-<ver>.tgz`
and provides the three peers itself.

**One copy per process.** The library holds process singletons (the host record,
the queue and its listeners, the Crucible registry cache, the host-ops lists).
Every part of one app — its main, its mount, its CLI — must resolve the SAME
installed `@owen/foundry-core` (and the same `@crucible/client`), or it gets two
queues and two host records and nothing errors.
