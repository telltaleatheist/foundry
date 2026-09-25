# Deploying foundry

**The engine is part of the app (2026-09-24).** It used to be a separate
`bun build --compile` executable per platform, published as its own release and
downloaded by BookForge as its `foundry-cli` add-on. Owen: *"i dont think it
needs to be an exe anymore. it can be an engine but maybe we should explode it
out into normal code that moves along with the app."* Now:

- `node tools/build-engine.mjs` bundles `src/` into **`app/engine/`**
  (`foundry-engine.cjs` plus the four DejaVu faces), which is **committed**.
- The app runs it with its own Electron as Node (`ELECTRON_RUN_AS_NODE=1`,
  `app/electron/engine.ts`) — a child process, as before, with no runtime of
  its own to ship.
- `test/engine-bundle.test.ts` fails when `app/engine/` is not what `src/`
  builds to, so **an engine change is: edit `src/`, run the build, commit both.**
- `foundry --version` reports `foundry X.Y.Z (src <digest>)` — a digest of the
  sources the bundle was built from (a commit cannot contain its own hash).

## Getting a change to BookForge

BookForge hosts Foundry from a vendored copy of `app/` (`foundry-app/` there;
its `VENDORED.md` is the runbook), and `app/engine/` is inside `app/`. So
**re-vendoring IS deploying the engine** — there is no release to cut, no pin
to bump and nothing downloaded at startup. The version gates BookForge kept
against the downloaded engine (`FOUNDRY_VERSION_FOR_*`) went with it: the
engine and the app that drives it are one copy now and cannot disagree.

## Releasing the Foundry desktop app

```bash
tools/deploy.sh               # patch bump, publish both installers, verify, promote
tools/deploy.sh --minor       # 2.0.2 → 2.1.0
tools/deploy.sh 3.0.0         # exactly that version
tools/deploy.sh --notes "…"   # release title (default: commit subject)
```

It refuses a dirty tree, an unpushed HEAD, a stale `app/engine/`, and versions
that disagree: the root `package.json` (the engine's) and `app/package.json`
must both equal the version being published. Both installers must already be
built into `app/release/`:

- Windows: `npm --prefix app run package:win-x64` (or, from `app/`,
  `npm run build && npx electron-builder --win --x64 --publish never`).
- macOS: on an Apple Silicon Mac, `npm --prefix app run package:mac`.
  Public macOS builds use `npm --prefix app run package:mac:signed`, which
  requires Developer ID signing and Apple notarization; missing credentials or
  signing failure aborts the build. The wrapper reads credentials from the
  environment or the shared login-keychain item `BOOKFORGE_NOTARIZE_ASP`,
  without printing them. Verify with `codesign --verify --deep --strict` and
  `spctl --assess --type execute` before promotion.

The engine reaches an installer through the `files` list in `app/package.json`
(`engine/**`), inside the app archive — not `extraResources`, and never a
`file:..` dependency, which bundled the development repository into older
installers.

No signing identity is configured in Foundry's committed build settings.
Electron-builder may discover credentials from the build machine; absence means
an unsigned package and must be reported in release notes. Build success does
not imply signing/notarization or a clean-machine install test. Coordinate
installation acceptance before running the publishing command.

## Requirements

- `node` (the build script and the bundle check), `bun` (the test suite).
- `gh`, authenticated against `telltaleatheist/foundry`.

## The Python environments — a different release, a different runbook

**`env-v1` is not the app's release and `tools/deploy.sh` never touches it.**
The installers ship under `vX.Y.Z`; the prebuilt Pythons the Electron
app downloads live under a single, **prerelease-flagged** tag, `env-v1`, kept out
of `/releases/latest` on purpose so BookForge's engine updater never sees them.
Bumping the app's version does not republish an environment, and rebuilding an
environment does not make a release.

Two targets today (`app/electron/env-catalog.ts`; `wsl-x64` is still a
`build-env.sh` target but no longer a catalog entry, docs/SLOTS.md §6):

| target | what it is for | built on |
| --- | --- | --- |
| `windows-x64` | PyMuPDF, the rasteriser every tier needs | any bash on Windows |
| `mac-arm64` | mlx-vlm + PyMuPDF | an Apple-silicon Mac |

The `nli-windows-x64` / `nli-mac-arm64` pair (torch, transformers and the
DeBERTa weights for the entailment ranker) was removed on 2026-09-25 with the
ranker; analysis ranks on a Crucible's decide door now (docs/ANALYSIS.md §4).

**Each target must be built on a machine that can EXECUTE its interpreter.** The
build downloads a python-build-standalone tarball and then runs it to install
wheels; there is no cross-build.

```
# 1. build — prints bytes + sha256
tools/env/build-env.sh windows-x64 /tmp/env

# 2. upload — the .tar.gz (or its .partN slices) plus the .json testimony
tools/env/upload-env.sh windows-x64 /tmp/env

# 3. THE STEP NOTHING AUTOMATES: copy the numbers from
#    /tmp/env/foundry-env-<target>-v1.json into ENV_ASSETS
#    (app/electron/env-catalog.ts) and commit.
```

Three things about step 3 that are worth stating rather than remembering:

- **A published asset whose hash is not in the catalog is an environment the app
  refuses to install.** That is the right failure and it is still a failure —
  `requirePublished` throws before a byte moves.
- **A rebuilt asset uploaded without updating the catalog is worse**: the bytes
  change and the old sha256 stays, so every user's download verifies against
  nothing it can match, deletes itself, and names two hashes. `upload-env.sh`
  passes `--clobber`, so the old bytes really are gone.
- **A split archive has no whole file on the release.** GitHub caps an asset at
  2 GiB; anything larger goes up as `.partN` slices which `envSources()` fetches
  in catalog order and concatenates. The order is the catalog's and nothing sorts
  it — `part10` before `part2` is exactly the bug that produces an archive that
  downloads, verifies against nothing, and fails to unpack.

## Platform notes for the VLM conversion

`vlm-convert` is the one mode with a dependency outside the engine, because
vision-model runtimes are Python-only:

- **macOS (Apple Silicon)**: local reading via MLX. Needs a Python with
  `mlx-vlm` and `pymupdf`. Point at it with `--python` or `FOUNDRY_VLM_PYTHON`.
- **Windows / Linux / Intel Mac**: no local route. Read pages from an
  OpenAI-compatible server instead:
  `--vlm-endpoint http://host:8000/v1`. Python is then used **only to
  rasterize pages**, so `pip install pymupdf` is the whole requirement — no
  MLX, no CUDA, no model download on the client.

The helper script itself (`src/vlm/vlm_page.py`) ships **inside** the engine
bundle and is written out on first use; only the Python *environment* is yours
to provide. (It did not always: the old compiled binary handed python a path
inside its own executable — `/$bunfs/root/vlm_page.py` — and every packaged
conversion failed. Embedded as text since.)
