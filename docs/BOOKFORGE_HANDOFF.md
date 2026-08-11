# Handoff: foundry changed under you — rework BookForge's integration

You are working in the BookForge repo. Foundry (`telltaleatheist/foundry`, checked out at
`~/Projects/foundry` on the Windows machine and `/Volumes/Callisto/Projects/foundry` on the Mac)
was restructured on 2026-08-11. This document is the authoritative summary of what changed and
what BookForge must do about it. Verify claims against the foundry repo where convenient — it is
on disk beside you.

## The one-sentence version

Foundry is now a **single-route engine**: one command (`vlm-convert`) that reads PDF pages with a
document vision model and writes an EPUB, plus a diagnostic (`doctor`). The entire Tesseract +
stage-model pipeline — every run-directory stage BookForge used to drive — is **gone from main**,
preserved at git tag **`pre-vlm-strip`**.

## Commands: what exists now, what is gone

EXISTS:
- `foundry vlm-convert --pdf <in.pdf> --out <book.epub> [--vlm-endpoint <url>] [--vlm-endpoint-model <name>]
  [--python <path>] [--readings <bank.jsonl>] [--fresh-readings | --reuse-readings]
  [--skip-pages 3,17,19-24] [--chapters <file.json>] [--strip-note-markers] [--language <bcp47>]
  [--vlm-model <id>] [--renders <dir>] [--vlm-concurrency <n>]`
  Unchanged in contract from the vlm-convert BookForge already drives in `electron/vlm-convert.ts`:
  same flags, same exit codes (0 ok / 1 run failed / 2 usage), same stderr progress lines — your
  `parseVlmProgressLine`'s three shapes (`page N/T: rendered`, `… page P (N/T)`, `… page N/T`)
  are all still emitted. The readings-bank semantics (completed.json marker, archive-and-reread,
  `--reuse-readings`/`--fresh-readings`) are unchanged.
- `foundry doctor [--json] [--endpoint <url>]` — NEW. Probes where a run would read right now and
  prints a versioned JSON report: `{version:1, platform, rasteriser:{available,python,detail},
  wsl:{available,distros[]}, tiers:[{id: endpoint|wsl-vllm|mlx|native, available, detail}], chosen}`.
  Fields are added, never renamed, without a version bump.

GONE (each was a BookForge integration surface — find and rework every call site):
- `convert`, `scan`, `blocks`, `ocr`, `footnotes`, `export`, `reflow`, `models` — the whole
  run-directory pipeline. No more `--run <dir>` anywhere, no `scan/pages.json`, no
  `blocks/blocks.json` for pdf-picker's category layer, no `--exclude-ids`, no `footnotes --epub`
  (the edit-an-existing-EPUB mode), no epub `correct` mode, no `models pull`/catalog, no vendored
  Tesseract, no `--llama-server` flag (BookForge no longer lends its llama.cpp binary — foundry
  does not use one).
- docs/PIPELINE.md, docs/DOCUMENT_MODES.md, docs/MIGRATION.md are deleted; docs/ARCHITECTURE.md is
  rewritten for the one-route engine. Anything BookForge documentation says about run directories
  or stage artifacts is describing the `pre-vlm-strip` tag, not current foundry.

## ⚠️ The update-coupling hazard (read this before anything else)

BookForge's foundry-cli component treats its pinned version as a FLOOR and follows
`/releases/latest` upward at startup (`chooseTargetVersion`). The CURRENT latest is still `v0.9.1`,
whose binaries predate the strip — so nothing is broken today. **The moment foundry publishes its
next version release, every BookForge install follows it and the stage commands vanish out from
under any un-reworked call site.** Sequence the work accordingly: either land BookForge's rework
first, or pin/cap the foundry version BookForge will accept until the rework ships. (Non-version
tags like `env-v1` are flagged prerelease and invisible to `/releases/latest`; your
`versionFromTag` ignores them anyway.)

## New engine behaviours worth knowing

- **Settings file (engine-owned):** `%APPDATA%\foundry\settings.json` (`FOUNDRY_CONFIG_DIR`
  overrides; mac `~/Library/Application Support/foundry/`), schema under one `backend` key:
  `mode: auto|endpoint|mlx`, `endpointUrl`, `endpointModel`, `wslDistro`, `vllmPython`, `python`.
  `vlm-convert` fills ABSENT flags from it (endpoint only under `mode:"endpoint"`), logging any
  value it takes. **Explicit flags always win**, so BookForge's existing practice — pass
  everything explicitly — keeps BookForge fully in control and immune to whatever the user's
  foundry desktop app writes there. Recommendation: keep passing `--vlm-endpoint`, `--python`
  etc. explicitly; do NOT start depending on the settings file.
- **Off macOS, no endpoint = immediate refusal.** `vlm-convert` without `--vlm-endpoint` (or an
  endpoint-mode settings file) now refuses up front on win32/linux with a message naming the fix,
  instead of failing later with "no Python with MLX". BookForge always passes an endpoint or runs
  the MLX path on Macs, so this should be invisible — but your error-surface tests may match on
  the old message.
- **Python discovery got wider, in BookForge's favour:** foundry's rasteriser-interpreter
  candidates now include BookForge's own shipped envs (`%APPDATA%\bookforge\runtime\e2a-env` and
  the e2a checkout `python_env`) on top of the conda `vlmtest` spellings. Your `--python` flag
  still overrides everything, so nothing changes for you; it just means foundry-without-BookForge
  also works on machines where BookForge exists.
- **Windows reliability fix:** Bun's `mkdirSync(recursive)` throws EEXIST on ReadOnly-attribute
  shell folders (Downloads/Documents/Desktop); foundry now tolerates that everywhere it makes
  directories. If BookForge ever wrote output-path workarounds for that class of failure, they
  can go.

## New release layout on telltaleatheist/foundry

- `vX.Y.Z` — engine binaries + checksums, exactly as your updater expects. Future ones will ALSO
  carry the foundry desktop app's installers (`Foundry Setup x.y.z.exe`, `Foundry-x.y.z-arm64.dmg`)
  as extra assets; you select by asset name, so this is inert for you.
- `env-v1` (prerelease-flagged) — three pinned relocatable Python environments with sha256s:
  `foundry-env-wsl-x64-v1` (CPython 3.12.13 + vllm 0.11.0 + pymupdf, split .part0..2),
  `foundry-env-windows-x64-v1` (3.12.13 + pymupdf 1.28.0),
  `foundry-env-mac-arm64-v1` (3.11.15 + mlx-vlm 0.6.10 + pymupdf 1.28.0).
  OPTIONAL for BookForge: your `vlm-page-server` currently depends on a hand-built conda env
  (`dots`); adopting `foundry-env-wsl-x64-v1` would make that dependency installable/reproducible
  through your component-manager like everything else. Invocation note: these envs have no conda —
  launch via `<env>/python/bin/python3 -m vllm.entrypoints.openai.api_server …` or the `vllm`
  console entry point invoked through that python (`python -m vllm.entrypoints.cli.main serve …`),
  not `conda run`.
- There is also a foundry **desktop app** now (`foundry/app`, Electron+Angular) that manages its
  own vLLM server in WSL **on port 8000, kills scoped to 8000** — deliberately clear of
  BookForge's 8077. The two coexist; neither should touch the other's server.

## What to actually do in BookForge (suggested order)

1. Inventory call sites: grep for the dead commands and artifacts —
   `foundry scan|blocks|ocr|footnotes|export|reflow|models`, `--run `, `blocks.json`,
   `--llama-server`, `--exclude-ids`, `pages.json` — across `electron/`, `shared/`, docs, and
   tests. `electron/vlm-convert.ts` and `foundry-release-check.ts` should be the survivors.
2. Decide per feature: anything that only the stage pipeline provided (pdf-picker category layers
   from blocks.json, footnote-marker editing of existing EPUBs, ocr-correct of existing EPUBs)
   either gets rebuilt on vlm-convert's outputs (`data-bf-page`/`data-bf-cat` attributes and the
   `--chapters` proposals file carry most of the same information), gets retired, or pins foundry
   at `pre-vlm-strip`-era binaries for that feature alone (not recommended — two engines).
3. Only after those call sites are gone: allow the foundry version floor to advance past the next
   release.
4. Optional: migrate vlm-page-server's env to `foundry-env-wsl-x64-v1` via component-manager.

Everything above is verifiable in the foundry repo: `src/commands.ts` (the whole surface),
`src/backend/` (doctor/settings/probes), `docs/ARCHITECTURE.md` (the rewritten decisions, §7 for
what happened to edit contracts), and `git show pre-vlm-strip` for anything the strip removed.
