# Crucible integration audit — 2026-09-16

Scope: Foundry desktop source in `app/`, its CLI boundary, and the mechanically vendored `bookforge/foundry-app` copy. The standalone repository remains authoritative. No deployment, release publication, GPU model loading, or service restart was performed by this audit agent.

## Confirmed defects repaired

- A cancellation while Crucible was resolving/loading could be overwritten by a later placement result. Cancelled work could spawn, be requeued or become failed, and a late lease could escape cleanup. Placement now has a cancellation signal, releases late leases, preserves cancellation across awaited preparation, and calls Crucible's cancellation endpoint for the active model-load job.
- An expired lease reacquired during cancellation could survive the run. Heartbeats are serialized and a replacement arriving after release is itself released. Normal release remains idempotent.
- Once an orchestrator and its engine were deduplicated to one slot, existing jobs pinned to the hidden alias could wait indefinitely. The dispatcher resolves queue and row choices to the same canonical lane before comparing them.
- Windows local connection discovery required a WSL distro and shell-parsed TOML even for a native engine. It now consumes the SDK pairing publication. The separate TOML parser, hardcoded WSL discovery and startup executable paths were removed from these paths.
- Refreshing a registered server appended it to the end and enabled it, contradicting the documented contract. The central writer now preserves position, spelling and enabled state while updating URL/token. Local discovery reuses the existing address's user-chosen name.
- The standalone startup path guessed port 7100 and collapsed failed discovery into absence. It now consumes Crucible's published installation/lifecycle contract. Broken records, wrong services and authentication failures remain problems with an explanation, instead of invitations to install or start another engine. Hosted Foundry does not control the local service.
- The install UI was disabled permanently and told Windows users Linux/WSL was mandatory. It now invokes Crucible's native Windows installer or the shared POSIX bootstrap flow, streams progress, rejects concurrent requests, verifies readiness, registers the published connection and refreshes coordination. WSL remains an optional Crucible-managed upgrade.

- Uninstall now derives its runtime, arguments, environment and working directory from the same published installation record. The shared SDK constructs the command; existing dry-run confirmation and explicit purge/WSL choices are retained. No hardcoded host or guest executable path remains in Foundry uninstall.
- The embedded renderer had drifted from standalone source: its server-row constructor lacked the required shared-engine field, causing its production build to fail after the current shared types were copied. The authoritative app bootstrap and server card were mechanically refreshed.

## Existing seams inspected

Working calls resolve an orchestrator to its verified engine through `engineClientFor`/`resolveEngine`. Dispatch uses that resolved URL for both OpenAI endpoint and bearer headers. A Crucible page-reading placement bypasses Foundry's legacy local reader. The CLI runs locally, retaining file paths/artifacts locally while text/images cross the HTTP endpoint; it does not send Windows paths for a remote process to open. Secrets pass in `FOUNDRY_ENDPOINT_HEADERS`, not argv. The queue's settlement owns lease release for successful, failed and cancelled work. Operator-console windows deliberately use the registered controller address and stay isolated from the application's preload/session.

## Verification

- `bun test`: 847 passing tests, zero failures (includes eleven new lifecycle/race regressions).
- `npm --prefix app run typecheck`: passed.
- `npm --prefix app run build`: Electron and Angular production builds passed. Existing Angular initial-bundle budget warning remains (about 1.02 MB versus 500 kB).
- New tests cover late placement go/wait/refuse after cancellation, model-load cancellation, lease replacement/release race, collapsed-slot alias, native installer routing and concurrency, lifecycle states, hosted no-op, and registry refresh semantics.
- BookForge hosted-Crucible seam keeper: 32 checks passed. The BookForge audit owner renamed three colliding shared channel families; its IPC collision keeper now passes all 6 checks.
- Changes are mechanically copied to `bookforge/foundry-app`; its runtime bundles are rebuilt separately because BookForge does not rebuild them automatically.
- Final 0.6.1 recheck: 847 Foundry tests passed, both standalone and embedded Electron/Angular production builds passed, BookForge TypeScript check passed, and BookForge install/module keepers passed 41/7 checks. All 19 changed/new app files were SHA256-matched byte for byte after restoring the embedded lockfile; two older renderer files were restored from the authoritative baseline, and IPC documentation was copied separately.
- Both app copies now vendor client/bootstrap 0.6.1, with updated lockfiles and regenerated module manifests. Crucible SDK validation passed 310 client tests and 269 bootstrap tests, including four real Git-Bash activation/rollback fixtures. Source wheel/sdist built successfully; no runtime pack or model environment was built by this agent.

## Limits and remaining acceptance work

Unit tests simulate the remote engine and installer; they do not prove CUDA/Metal inference or a complete book conversion. The parent audit coordinates live engine checks. Clean-machine Windows install/reboot/upgrade/uninstall and macOS menu bar/service behavior still need acceptance on those machines. **0.6.1 is an unpublished source candidate.** Fresh installs explicitly request 0.6.1; they fail until its corrected installer/runtime packs are published, rather than downloading the older 0.6.0 runtime. Release gating/reuse instructions live in Crucible's `docs/PATCH-RELEASE-READINESS-2026-09-16.md`. If the remote cancellation request itself cannot reach Crucible, the row remains cancelled but its completion waits for the remote event stream to end; the failed cancellation is logged. Long-running network operations still depend on the SDK's stream behavior.
