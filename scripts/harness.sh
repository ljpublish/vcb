#!/usr/bin/env bash
# INTEGRATOR-OWNED — build an isolated, runnable copy of the game for testing while other modules
# are being rewritten in parallel in the shared tree.
#
# The copy = pristine skeleton (/home/claude/vcb-skeleton: frozen contracts, stubs and the naive
# reference world/terrain/mesher/mesh-manager) + the LIVE versions of the paths you list.
#
# Usage:  bash /home/claude/vcb/scripts/harness.sh <fresh-dest-dir> [live-path ...]
#   e.g.  bash /home/claude/vcb/scripts/harness.sh /my/scratchpad/h1 src/build src/sim
# Then:   node /home/claude/vcb/node_modules/vite/bin/vite.js <dest> --port <port> --strictPort > log 2>&1 &
#         (kill it when done) and/or  (cd <dest> && npx tsc --noEmit)
# You may add private test pages/files inside <dest> (e.g. <dest>/gallery.html + <dest>/src/gallery.ts);
# never inside the repo. Use a NEW dest dir each time (stale files are not deleted).
set -euo pipefail
DEST="${1:?usage: harness.sh <dest-dir> [live-path ...]}"
shift
SKEL=/home/claude/vcb-skeleton
LIVE=/home/claude/vcb
case "$(realpath -m "$DEST")" in
  "$LIVE"|"$LIVE"/*) echo "harness: refusing to write inside the repo ($LIVE)" >&2; exit 1 ;;
esac
[ -d "$SKEL" ] || { echo "harness: skeleton snapshot $SKEL is missing" >&2; exit 1; }
mkdir -p "$DEST"
cp -R "$SKEL"/. "$DEST"/
chmod -R u+w "$DEST"
for p in "$@"; do
  if [ -d "$LIVE/$p" ]; then
    mkdir -p "$DEST/$p"
    cp -R "$LIVE/$p"/. "$DEST/$p"/
  elif [ -f "$LIVE/$p" ]; then
    mkdir -p "$(dirname "$DEST/$p")"
    cp "$LIVE/$p" "$DEST/$p"
  else
    echo "harness: no such live path: $p" >&2
    exit 1
  fi
done
# Real node_modules dir with per-package symlinks, so this copy gets its own Vite cache (.vite).
mkdir -p "$DEST/node_modules"
for pkg in "$LIVE"/node_modules/* "$LIVE"/node_modules/.bin; do
  ln -sfn "$pkg" "$DEST/node_modules/$(basename "$pkg")"
done
echo "harness ready: $DEST"
