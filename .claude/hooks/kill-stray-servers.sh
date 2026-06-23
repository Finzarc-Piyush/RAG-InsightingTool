#!/usr/bin/env bash
# Stop / SessionEnd hook: reap dev/test processes that were started by CODE
# EXECUTION (the agent's Bash tool) and leaked — never the user's own terminal
# servers.
#
# WHY THIS EXISTS
#   `node --import tsx --test <file>` runs (single-file and the full `npm test`
#   suite) leak when a test wedges: a sync infinite loop pegs a core, or an open
#   handle (timer/socket/duckdb) leaves node:test waiting on a non-empty event
#   loop. The wedged process is a DETACHED grandchild of the Bash tool, so it
#   outlives the turn AND the session, reparents to launchd, and accumulates for
#   days. One such client test once ran at 96.9% CPU for ~63 hours. SIGTERM does
#   not help (a CPU-bound loop never yields to its signal handler) and the Bash
#   tool's sandbox cannot even signal cross-session orphans (EPERM) — but a HOOK
#   runs outside that sandbox, so it can. See docs/conventions/managed-dev-processes.md.
#
# HOW WE TELL "CODE-STARTED" FROM "TERMINAL-STARTED" (the user's distinction)
#   A process the user launches in one of their three dev terminals has a
#   controlling TTY (e.g. ttys003). A process spawned by the agent's Bash tool
#   has TTY "??" (no controlling terminal). We ONLY ever touch TTY=="??"
#   processes, so a server you started by hand in a terminal is always spared.
#   This survives reparenting (orphans keep TTY "??"), unlike ppid-ancestry.
#
# MODES
#   (no arg) / --tests-only : kill leaked node:test / vitest runners + workers.
#                             Wired to the Stop hook → runs at the END OF EVERY
#                             TURN. Tests must never outlive a turn, and this
#                             leaves dev servers alone so cross-turn verification
#                             still works.
#   --all                   : also kill leaked dev servers (server tsx-watch,
#                             client vite, python uvicorn/main.py) and any
#                             TTY=="??" listener on 3000/3002/8001. Wired to the
#                             SessionEnd hook → guarantees nothing survives the
#                             session.
#
# Always exits 0 (advisory; never blocks the chat). Logs one line to
# .claude/hooks/.kill-stray.log (gitignored via the root *.log rule).

set -u

MODE="${1:-}"
HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG="$HOOK_DIR/.kill-stray.log"

# Short-lived tsx tooling we must NEVER kill (orient pack, invariant firewall,
# registry/symbol generators, domain-pack build, RAG/seed scripts, this hook).
EXCL='generate-bootstrap|check-invariants|check-type-escapes|check-doc-refs|generate-registries|generate-symbols|build-domain-packs|create-rag|create-past|seed-golden|cleanup-past|llm-golden|rag-smoke|backfill-analysis|kill-stray-servers'

SELF_PID=$$
SELF_PGID="$(ps -o pgid= -p "$SELF_PID" 2>/dev/null | tr -d ' ')"

# ps columns: $1 pid, $2 ppid, $3 tty, $4..NF command.
snapshot() { ps -axo pid=,ppid=,tty=,command= 2>/dev/null; }

# Leaked node:test / vitest runners and their tsx loader workers.
test_pids() {
  snapshot | awk -v e="$EXCL" '
    $3=="??" && /--import tsx/ &&
    ($0 ~ /[ ]--test([ =]|$)/ || $0 ~ /\.test\.ts/ || $0 ~ /\/tests\// || /vitest/) &&
    $0 !~ e { print $1 }'
}

# Leaked dev servers (repo/service scoped) + no-tty port listeners.
server_pids() {
  snapshot | awk -v e="$EXCL" '
    $3=="??" &&
    (/tsx watch/ || $0 ~ /[ ]index\.ts/ || /[v]ite/ || /uvicorn/ || /python-service\/main\.py/ || $0 ~ /[ ]main\.py/) &&
    $0 !~ e { print $1 }'
  local p pid t
  for p in 3000 3002 8001; do
    for pid in $(lsof -ti tcp:"$p" 2>/dev/null); do
      t="$(ps -o tty= -p "$pid" 2>/dev/null | tr -d ' ')"
      [ "$t" = "??" ] && echo "$pid"
    done
  done
}

# SIGKILL each pid + its process group (nukes tsx loader grandchildren too).
# Straight to -9: CPU-bound loops ignore SIGTERM. Refuses to touch self/pgid/init.
kill_set() {
  local pids="$1" n=0 pid pgid
  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    [ "$pid" = "$SELF_PID" ] && continue
    [ "$pid" = "1" ] && continue
    pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')"
    if kill -9 "$pid" 2>/dev/null; then n=$((n+1)); fi
    if [ -n "$pgid" ] && [ "$pgid" != "$SELF_PGID" ] && [ "$pgid" != "1" ]; then
      kill -9 "-$pgid" 2>/dev/null || true
    fi
  done <<< "$pids"
  echo "$n"
}

TP="$(test_pids | sort -un)"
KT=0
[ -n "$TP" ] && KT="$(kill_set "$TP")"

KS=0
if [ "$MODE" = "--all" ]; then
  SP="$(server_pids | sort -un)"
  [ -n "$SP" ] && KS="$(kill_set "$SP")"
fi

if [ $((KT + KS)) -gt 0 ]; then
  printf '%s mode=%s killed tests=%s servers=%s\n' \
    "$(date '+%Y-%m-%dT%H:%M:%S')" "${MODE:-tests-only}" "$KT" "$KS" >> "$LOG" 2>/dev/null || true
  if [ "$MODE" = "--all" ]; then
    printf '🧹 kill-stray: reaped %s stray test proc(s), %s dev-server proc(s)\n' "$KT" "$KS" >&2
  else
    printf '🧹 kill-stray: reaped %s stray test proc(s)\n' "$KT" >&2
  fi
fi

exit 0
