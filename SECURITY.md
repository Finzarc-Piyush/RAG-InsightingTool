# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in this project, please report it
privately. **Do not open a public issue for security problems.**

- Use GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
  ("Report a vulnerability" under the repository's **Security** tab), or
- Email the maintainers (see `.github/CODEOWNERS`).

Please include: affected service (`server`, `client`, `python-service`), a
description, reproduction steps, and the impact you observed. We aim to
acknowledge reports within 3 business days.

## Supported scope

This is a multi-tenant analytical chat tool handling user-uploaded datasets.
Areas of particular interest:

- Tenant isolation (a user reading/writing another tenant's session, dataset,
  RAG chunks, or dashboards).
- Injection into DuckDB / Snowflake / Azure Search queries.
- Prompt injection that causes the agent to take unintended tool actions, or
  exfiltrates data via web-search / LLM providers.
- Authentication / authorization bypass (Azure AD JWT handling, `DISABLE_AUTH`).

## Handling

- Dependency vulnerabilities are tracked via Dependabot (`.github/dependabot.yml`)
  and the `npm audit` step in CI.
- Server and client CI enforce `typecheck`; security-relevant lint rules run
  via ESLint.

## Secrets in git history

- The Azure AD **tenant id** and **client (application) id** appear in git
  history (a `client/client.env` was committed before `3b97ffcd` untracked it
  and added the `*.env` gitignore). These are **public, non-secret** values by
  design — an Azure AD app's tenant/client id are exposed to every browser that
  authenticates and are not credentials. No rotation is required (CFG-5).
- No **secrets** (Cosmos keys, Azure OpenAI keys, storage keys, JWT signing
  material) are committed. `*.env` files (except `*.env.example`) are gitignored.
- **Policy:** committing any `*.env` other than a `*.example` requires a history
  purge (BFG / `git filter-repo`) and rotation of anything exposed. The
  pre-commit gate + `.gitignore` are the first line of defence.

## Disclosure

We follow coordinated disclosure. Please give us reasonable time to release a
fix before any public disclosure.
