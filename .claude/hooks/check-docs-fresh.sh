#!/usr/bin/env bash
# Stop hook: nudge (never block) when a Wave commit lands without paired doc updates.
#
# Fires on every Stop event. Quietly exits 0 unless:
#   1. We're inside a git repo
#   2. HEAD commit subject starts with "Wave W<n>"
#   3. Neither docs/STATE.md nor docs/WAVES.md were touched in HEAD or HEAD~1
#
# In that case prints a one-line reminder. Never blocks the chat.

set -u

# Resolve repo root from this script's location. Allows the hook to work
# regardless of where Claude Code's CWD happens to be.
HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HOOK_DIR/../.." && pwd)"

cd "$REPO_ROOT" 2>/dev/null || exit 0

# Bail silently if not a git repo.
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

# Bail silently if we can't read HEAD (e.g. fresh repo, no commits yet).
SUBJECT="$(git log -1 --format='%s' 2>/dev/null)" || exit 0
[ -n "$SUBJECT" ] || exit 0

# Only nudge for Wave commits. Other commits (docs, chore, fix, refactor, etc.)
# don't trigger the doc-update contract.
case "$SUBJECT" in
  "Wave W"*) : ;;   # continue
  *) exit 0 ;;
esac

# Check if docs/STATE.md or docs/WAVES.md was touched in either HEAD or HEAD~1
# (so an immediate follow-up commit also counts as "documented").
TOUCHED_DOCS="$(git diff --name-only HEAD~2..HEAD 2>/dev/null | grep -E '^docs/(STATE|WAVES)\.md$' | head -1)"

if [ -n "$TOUCHED_DOCS" ]; then
  exit 0   # docs were touched, all good
fi

# Nudge — never block.
cat <<'NUDGE' >&2

⚠️  Wave commit on HEAD but docs/STATE.md / docs/WAVES.md weren't touched in the last 2 commits.
   Run /wave-commit before your next chat (or before pushing) to keep the routing index in sync.

NUDGE

exit 0
