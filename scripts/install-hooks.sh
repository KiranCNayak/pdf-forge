#!/usr/bin/env bash
# One-time setup: point Git at the repo's tracked hooks in .githooks/ instead of the
# untracked, per-clone .git/hooks/ directory. Run once after cloning.
set -euo pipefail

cd "$(dirname "$0")/.."
git config core.hooksPath .githooks
echo "Git hooks installed (core.hooksPath = .githooks)."
