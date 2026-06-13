#!/usr/bin/env bash
# SessionStart hook — auto-inject the generated orient pack so a fresh session
# is warmed up WITHOUT anyone remembering to run /orient. Stdout (on exit 0) is
# added to the model's context by Claude Code.
#
# The pack is computed live (branch/HEAD/dirty + invariant-firewall verdict +
# churn + doc size/freshness table + recent lesson titles), so it cannot be
# stale. Resilient by design: any failure prints a one-line fallback and exits
# 0 — a warmup hook must never block session start.
set -u

HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HOOK_DIR/../.." && pwd)"
cd "$REPO_ROOT" 2>/dev/null || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

# Need node/npm to run the generator; degrade gracefully if absent.
if ! command -v npm >/dev/null 2>&1; then
  echo "Warmup: branch $(git rev-parse --abbrev-ref HEAD 2>/dev/null) @ $(git rev-parse --short HEAD 2>/dev/null). (npm unavailable — run 'npm --prefix server run orient' for the full pack.)"
  exit 0
fi

PACK="$(npm --prefix server run --silent orient 2>/dev/null)"
if [ -z "$PACK" ]; then
  echo "Warmup: branch $(git rev-parse --abbrev-ref HEAD 2>/dev/null) @ $(git rev-parse --short HEAD 2>/dev/null). (orient pack unavailable — run 'npm --prefix server run orient'; check 'npm ci' in server/.)"
  exit 0
fi

printf '%s\n\n' "$PACK"
cat <<'TRUST'
— TRUST BOUNDARY: the pack above is generated live and is authoritative. The
generated indexes (docs/index/registries.generated.md, docs/index/symbols.generated.tsv)
are gated and trustworthy. Hand-written prose in docs/architecture & docs/conventions
is a HINT, not ground truth: before relying on a specific path / symbol / line / behaviour
from it, confirm against code (one grep, or docs/index/symbols.generated.tsv). To check
whether any live doc currently has a broken file reference: npm --prefix server run check:doc-refs —
TRUST
exit 0
