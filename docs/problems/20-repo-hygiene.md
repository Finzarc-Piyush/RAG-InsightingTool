# 20 — Repo hygiene & governance

Wave 0 (P-040 is foundational) + Wave 5 (P-041).

P-042, P-066, P-067, P-068 live in areas 1 and 11.

---

### P-040 — Root `.gitignore` is 3 lines

- **Severity:** medium
- **Category:** repo hygiene
- **Location:** root `.gitignore`
- **Evidence:** Entire file: `.DS_Store`, `dist/`, `node_modules/`. Missing: `.env`, `.env.local`, `.env.*.local`, `*.log`, `.venv/`, `venv/`, `__pycache__/`, `*.pyc`, `.pytest_cache/`, `.coverage`, `.cursor/dev-logs/`.
- **Fix:** Expand to a comprehensive ignore set. Remove redundant entries from child `.gitignore`s (`server/.gitignore`, `client/.gitignore`, `python-service/.gitignore`) once root covers them. Do this in the same PR as P-001 / P-042 / P-066 / P-067 so nothing slips back in.
- **Status:** todo

### P-041 — No `README.md`, `LICENSE`, `CODEOWNERS`, PR template at repo root

- **Severity:** medium
- **Category:** governance / onboarding
- **Location:** repo root; `.github/`
- **Evidence:** First-time contributors have no entry point. No licensing stance. PRs have no structure.
- **Fix:** Minimum viable set:
  - `README.md` — project one-liner, 3-service architecture diagram, quick start (the commands from `CLAUDE.md`'s Dev loop), link to `docs/agents-architecture-inventory.md` and `docs/DEPLOY.md` (P-039), link to this file.
  - `LICENSE` — pick one (MIT/Apache-2.0/proprietary) and commit.
  - `.github/CODEOWNERS` — one-line `* @team-or-user` default, plus per-directory overrides for `python-service/`, `client/`, `server/`.
  - `.github/pull_request_template.md` — 4 sections (Summary / Type of change / Test plan / Breaking-change notes).
- **Status:** todo
