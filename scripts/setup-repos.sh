#!/usr/bin/env bash
# Clone the reference repos coding agents (and the `writing-effect` skill)
# read for grounding. Idempotent — if the target already exists, fast-forward
# its default branch instead of re-cloning. Output lands under `.repos/`,
# which is gitignored.
#
# Add new references by appending to REFS below. Pattern mirrors Effect's
# own `scripts/worktree-setup.sh` in effect-ts/effect-smol.

set -euo pipefail

# repo_url|target_dir|branch
REFS=(
	"https://github.com/effect-ts/effect-smol.git|.repos/effect-v4|main"
)

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

for ref in "${REFS[@]}"; do
	url="${ref%%|*}"
	rest="${ref#*|}"
	dir="${rest%%|*}"
	branch="${rest##*|}"

	if [ -d "$dir/.git" ]; then
		echo "==> $dir: fetch $branch"
		git -C "$dir" fetch --depth 1 origin "$branch"
		git -C "$dir" checkout -q "$branch"
		git -C "$dir" reset --hard "origin/$branch"
	else
		echo "==> $dir: clone $url ($branch)"
		mkdir -p "$(dirname "$dir")"
		git clone --depth 1 --branch "$branch" "$url" "$dir"
	fi
done

echo "Done. Reference repos are under .repos/."
