#!/usr/bin/env bash
# Stop hook: nudge (never block) when work lands without paired doc updates.
#
# Fires on every Stop event and ALWAYS exits 0 — advisory only, never blocks the
# chat. Two independent triggers, either of which prints a one-line reminder to
# stderr (Claude Code surfaces it; the user sees it):
#
#   A) Post-commit pairing — a "Wave …" commit is on HEAD but docs/STATE.md /
#      docs/WAVES.md were NOT touched in the last two commits. (original behaviour)
#
#   B) Working-tree freshness — the tree has RECENT uncommitted changes to product
#      source (server/ client/ python-service/ api/ shared/) while neither
#      docs/STATE.md nor docs/WAVES.md is among the changed files. "Recent" =
#      modified in the last ${DOC_NUDGE_FRESH_MIN:-45} minutes, so days-old WIP and
#      pure read-only / conversational turns stay silent, but code edited this
#      session triggers the reminder. This is the case the Wave-only trigger missed:
#      most work is left uncommitted, where (A) never fires. (added 2026-06-15)
#
# Tunables (env): DOC_NUDGE_FRESH_MIN — freshness window in minutes (default 45).

set -u

FRESH_MIN="${DOC_NUDGE_FRESH_MIN:-45}"

# Resolve repo root from this script's location, so the hook works regardless of
# Claude Code's CWD.
HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HOOK_DIR/../.." && pwd)"
cd "$REPO_ROOT" 2>/dev/null || exit 0

# Bail silently if not a git repo.
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

NUDGED=0

# ── Trigger A: a Wave commit landed without a paired STATE/WAVES update ───────
SUBJECT="$(git log -1 --format='%s' 2>/dev/null || true)"
case "$SUBJECT" in
  "Wave "*)   # any wave prefix: W, CS, Dup, R, Rt, WG…
    if ! git diff --name-only HEAD~2..HEAD 2>/dev/null \
         | grep -qE '^docs/(STATE|WAVES)\.md$'; then
      cat <<'NUDGE' >&2

⚠️  Wave commit on HEAD but docs/STATE.md / docs/WAVES.md weren't touched in the last 2 commits.
   Run /wave-commit before your next chat (or before pushing) to keep the routing index in sync.

NUDGE
      NUDGED=1
    fi
    ;;
esac

# ── Trigger B: recent uncommitted source work without a doc update ───────────
# Changed = staged + unstaged + untracked. Strip the 3-char "XY " status prefix.
CHANGED="$(git status --porcelain 2>/dev/null | cut -c4-)"

if [ "$NUDGED" -eq 0 ] && [ -n "$CHANGED" ]; then
  # Were the narrative docs themselves updated in the working tree? If so, the
  # contract is being honoured — stay silent.
  if ! printf '%s\n' "$CHANGED" | grep -qE '^docs/(STATE|WAVES)\.md$'; then
    # Product source among the changes (exclude docs, generated indexes, plans,
    # and the .claude harness itself — editing this hook shouldn't self-trigger).
    SRC="$(printf '%s\n' "$CHANGED" \
      | grep -E '^(server|client|python-service|api|shared)/' \
      | grep -vE '^docs/' || true)"

    if [ -n "$SRC" ]; then
      # Freshness gate: at least one changed source file modified within the
      # window. Excludes stale WIP from prior sessions and read-only turns.
      RECENT=""
      while IFS= read -r f; do
        [ -n "$f" ] && [ -f "$f" ] || continue
        if [ -n "$(find "$f" -mmin "-${FRESH_MIN}" 2>/dev/null)" ]; then
          RECENT="$f"; break
        fi
      done <<EOF
$SRC
EOF

      if [ -n "$RECENT" ]; then
        cat <<'NUDGE' >&2

⚠️  Product source changed this session but docs/STATE.md / docs/WAVES.md aren't updated.
   Before ending: update the doc(s) your change touched (docs/architecture/<sub>.md, docs/lessons.md,
   docs/STATE.md) or run /wave-commit — so the routing index doesn't drift behind the code.

NUDGE
      fi
    fi
  fi
fi

exit 0
