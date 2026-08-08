# Deploying foundry to BookForge

**One command:**

```bash
tools/deploy.sh
```

That builds all four platforms, packages them, publishes a GitHub release, and
verifies every asset arrived. Every BookForge on every machine picks it up at
its next startup. **There is no version to bump in BookForge.**

---

## Why there is no pin to bump

BookForge's `foundry-cli` component carries a pinned version
(`FOUNDRY_CLI_VERSION` in `electron/components/foundry-cli-components.ts`), and
it is tempting to think a deploy means editing it. It does not. The pin is a
**floor**, not a target:

- At startup BookForge asks GitHub for the newest foundry release
  (`electron/components/foundry-release-check.ts`).
- `chooseTargetVersion` takes whichever is newer — the pin, or the release.
- Hashes for a discovered release are read out of that release's own
  `checksums.txt`, so nothing has to be pasted anywhere by hand.

**Publishing is deploying.** The pin only matters as the version a machine
falls back to when it cannot reach GitHub, and as the floor that stops a
*downgrade* if a release is ever yanked. Bump it when you want that floor to
move; never merely because you shipped.

## The contract you must not break

A program reads these names, not just a person:

```
foundry-darwin-arm64.tar.gz
foundry-darwin-x64.tar.gz
foundry-linux-x64.tar.gz
foundry-windows-x64.tar.gz
checksums.txt              ← sha256 of each, published in the SAME release
```

`tools/release-package.sh` produces exactly that set. An asset published
without its line in `checksums.txt` is **refused by name** at install time
rather than installed unverified — which is correct, and also means a
half-uploaded release breaks installs. `deploy.sh` verifies all five are
present and fails loudly if one is missing, so this cannot happen by accident.

## The developer's own machine is the exception

The Mac this is developed on does **not** download releases. Its BookForge
records the `foundry-cli` component as `external`, pointing straight at
`dist/foundry-<host>` in this repo (see `installed.json` under
`~/Library/Application Support/BookForge/components/`). It therefore sees a
**rebuild** and nothing else — a commit alone never reaches the app, and
neither does a published release.

```bash
tools/deploy.sh --local     # rebuild this machine's binary; no release
```

If the app behaves like older code after you changed foundry, this is the first
thing to check. `foundry --version` prints the commit it was built from.

## Commands

| Command | What it does |
|---|---|
| `tools/deploy.sh` | patch bump (0.6.0 → 0.6.1), build all, publish, verify |
| `tools/deploy.sh --minor` | 0.6.0 → 0.7.0 |
| `tools/deploy.sh 1.0.0` | exactly that version |
| `tools/deploy.sh --local` | build for this machine only; no release |
| `tools/deploy.sh --notes "…"` | set the release title (default: commit subject) |

The version is derived from **the latest published release**, not from
`package.json` — releases are what BookForge orders itself against, and a
`package.json` that drifted would publish something every installed app
considers older than what it already has.

A deploy refuses a dirty tree and refuses an unpushed HEAD: a release tag must
name a commit everyone else can fetch. `--local` allows both, because that is
how you test a build.

## Requirements

- `bun` (on PATH or at `~/.bun/bin/bun`). Cross-compiling downloads each
  target's runtime on first use, so the first full build needs network.
- `gh`, authenticated against `telltaleatheist/foundry`.

## Platform notes for the VLM conversion

`vlm-convert` is the one mode with a dependency outside the binary, because
vision-model runtimes are Python-only:

- **macOS (Apple Silicon)**: local reading via MLX. Needs a Python with
  `mlx-vlm` and `pymupdf`. Point at it with `--python` or `FOUNDRY_VLM_PYTHON`.
- **Windows / Linux / Intel Mac**: no local route. Read pages from an
  OpenAI-compatible server instead:
  `--vlm-endpoint http://host:8000/v1`. Python is then used **only to
  rasterize pages**, so `pip install pymupdf` is the whole requirement — no
  MLX, no CUDA, no model download on the client.

The helper script itself (`src/vlm/vlm_page.py`) ships **inside** the binary
and is written out on first use; only the Python *environment* is yours to
provide. (It did not always: a compiled binary handed python a path inside its
own executable — `/$bunfs/root/vlm_page.py` — and every packaged conversion
failed. Embedded as text since.)
