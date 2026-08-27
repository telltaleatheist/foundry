#!/usr/bin/env bash
#
# upload-env — put one built environment on the release the catalog names.
#
#   tools/env/upload-env.sh <target> <workdir>
#
# WHAT IT UPLOADS. `foundry-env-<target>-v1.tar.gz` (or its `.partN` slices when
# the build split it) and `foundry-env-<target>-v1.json` — the build's testimony,
# which goes up beside the bytes so anybody can check the catalog's numbers
# against the build's without having the build machine.
#
# WHY THIS EXISTS AS A SCRIPT. It was a remembered `gh` command, and a remembered
# command is one that gets typed slightly differently the fourth time. Three
# things here are not obvious and each has a way of going wrong quietly:
#
#   * THE TAG IS `env-v1` AND IT IS NOT THE ENGINE'S RELEASE. tools/deploy.sh
#     publishes `vX.Y.Z` with the four CLI binaries; this is a separate,
#     PRERELEASE-flagged tag holding Pythons, kept out of `/releases/latest` on
#     purpose so BookForge's engine updater never sees it.
#   * `--clobber` IS DELIBERATE. Re-uploading a rebuilt asset under the same name
#     is the normal case, and without it gh refuses and leaves the old bytes —
#     which the catalog's new sha256 would then fail against, at the user's
#     machine, after a download.
#   * THE PARTS GO UP IN THEIR OWN RIGHT. A split archive has no whole file on
#     the release at all; `envSources()` fetches the slices in catalog order and
#     concatenates. Uploading the reassembled .tar.gz "as well" would put a file
#     over GitHub's 2 GiB cap on the release and fail halfway.
#
# AFTER THIS RUNS, the numbers in <workdir>/foundry-env-<target>-v1.json are
# copied into ENV_ASSETS in app/electron/env-catalog.ts. That copy is the step
# nothing automates and nothing checks: a published asset whose hash is not in
# the catalog is an environment the app refuses to install, which is the right
# failure but is still a failure.
set -euo pipefail

TARGET="${1:?usage: upload-env.sh <target> <workdir>}"
WORKDIR="${2:?usage: upload-env.sh <target> <workdir>}"

REPO="telltaleatheist/foundry"
TAG="env-v1"
NAME="foundry-env-${TARGET}-v1"

cd "$WORKDIR"

if [ ! -f "$NAME.json" ]; then
  echo "upload-env: $WORKDIR/$NAME.json is not there — run build-env.sh first." >&2
  exit 2
fi

FILES=()
if ls "$NAME".tar.gz.part* >/dev/null 2>&1; then
  # Split: the slices are the assets, and the whole archive is not uploaded.
  for p in "$NAME".tar.gz.part*; do FILES+=("$p"); done
else
  FILES+=("$NAME.tar.gz")
fi
FILES+=("$NAME.json")

echo "==> $NAME: uploading ${#FILES[@]} asset(s) to $REPO $TAG"
for f in "${FILES[@]}"; do
  echo "    $f ($(wc -c < "$f" | tr -d ' ') bytes)"
done

gh release upload "$TAG" "${FILES[@]}" --repo "$REPO" --clobber

echo "==> $NAME: uploaded. Now copy these into ENV_ASSETS (app/electron/env-catalog.ts):"
cat "$NAME.json"
