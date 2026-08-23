#!/usr/bin/env bash
# Manage git worktrees so several agents can work in parallel without sharing a
# working directory. See docs/PARALLEL.md.
#
#   ./scripts/worktree.sh add lane-a-compress
#   ./scripts/worktree.sh list
#   ./scripts/worktree.sh remove lane-a-compress
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$(pwd)
REPO=$(basename "$ROOT")

usage() {
  cat <<EOF
usage: $0 <add|list|remove> [name]

  add <name>     create ../${REPO}-<name> on a new branch <name> off main
  list           show existing worktrees
  remove <name>  remove the worktree (the branch is kept)
EOF
}

case "${1:-}" in
  add)
    name=${2:-}
    [ -n "$name" ] || { usage; exit 2; }
    dir="$ROOT/../${REPO}-${name}"

    if [ -e "$dir" ]; then
      echo "error: $dir already exists" >&2
      exit 1
    fi

    # Reuse the branch if it already exists, so re-adding a removed worktree
    # picks up where it left off instead of erroring.
    if git show-ref --verify --quiet "refs/heads/$name"; then
      git worktree add "$dir" "$name"
    else
      git worktree add -b "$name" "$dir" main
    fi

    echo
    echo "worktree ready: $dir"
    echo
    echo "next steps in that directory:"
    echo "  cd $dir"
    echo "  ./scripts/build-wasm.sh      # the wasm artifact is gitignored and per-worktree"
    echo "  (cd web && npm install)      # node_modules is not shared either"
    ;;

  list)
    git worktree list
    ;;

  remove)
    name=${2:-}
    [ -n "$name" ] || { usage; exit 2; }
    dir="$ROOT/../${REPO}-${name}"

    git worktree remove "$dir"
    echo "removed $dir (branch '$name' kept — delete with: git branch -d $name)"
    ;;

  *)
    usage
    exit 2
    ;;
esac
