<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# General rules

Write README.md, documentation, MRs and UI text in Russian.
Target production-ready quality: no quick hacks, temporary workarounds, or fragile solutions unless explicitly requested.
Never commit secrets or .env files; never print secrets to logs, error messages, events, or API responses.
YAGNI: Do not add infrastructure or integrations nobody asked for (monitoring, metrics, tracing, admin panels). Propose first; add only after explicit approval.
Whenever you identify a workaround, defect, or reliability risk, please highlight it and suggest a proper fix.

## Commits and branches

- Please make git atomic commits by yourself when a task or phase is finished. Follow the repository's existing commit conventions and contribution guidelines, if present (for example, CONTRIBUTING.md, AGENTS.md, or conventions evident from recent commit history). If the repository does not define its own commit-message convention, use Conventional Commits. 
- Run the relevant linters, formatters, and checks for the files being committed (for example, Ruff for Python) and fix any issues before committing.  
- Before every commit, run the project's lint, type-check, and test commands.
  Defaults when none are configured: Python — `uv run ruff check . && uv run pyright`
  (plus `uv run pytest` if tests exist); TypeScript — `npm run check`, otherwise the
  project's lint/type-check scripts plus relevant tests. Fix all errors caused by your changes.
- Commit messages and MR titles follow Git Atomic Conventional Commits: keep the type and scope in English (`feat(auth):`, `fix(db):`), write the description after the colon in Russian — e.g. `feat(consent): интегрировать Яндекс.Метрику`.
- Maintain .gitignore yourself: add generated, local, temporary, cache, build, and environment files as they appear.
- In the Bash tool, pass multi-line commit messages via `-m` with a regular double-quoted string (or heredoc), NOT PowerShell `@'...'@` syntax — the `@` leaks into the message text.
- Do not create new branches without explicit user confirmation. Work in the current branch; сreate a branch only on explicit request.

## Tests and completion

- Add or update tests for changed behavior: happy path, failure path, and boundary cases; table-driven where one rule has many inputs.
- Run the relevant test scope when a change could affect behavior; run the full suite for broad, cross-cutting, risky, or release-level changes. Trivial non-behavioral edits (docs, comments, formatting, isolated constants) may skip tests.
- A bug fix starts with a test that reproduces the bug.
- No filler tests: no test without a meaningful assertion, no test whose only assertion is "the mock was called", no test that restates the implementation. Deleting a worthless test is an improvement.
- A task is "Done" only when tests pass and the change is verified end-to-end and committed.

## Error handling

- Error handling is mandatory, not optional: every operation that can fail at runtime (network calls, external APIs, DB, filesystem, subprocesses) must handle failure explicitly — never leave a bare call whose error crashes the app or disappears silently.
- Retry transient failures (network, 5xx, 429, timeouts) with bounded exponential backoff; no retries for deterministic 4xx/logic errors.
- Keep it proportional — don't wrap every line in try/catch; handle errors at the boundary where you can actually act on them.

# Implementation plans

- Implementation plans live in `docs/agents/plans/` — create them via the `make-plan` skill, implement via `implement-plan`; those skills define the file format and `Status:` line rules.

# Gotchas and observations

Record important observations from your work (results of long test runs, API behavior, environment quirks, etc.) as `docs/agents/<topic>.md` files, each listed in `docs/agents/README.md` with a short two-sentence description.

AGENTS.md gotchas are for CRITICAL facts only — the kind that break production or silently corrupt work. Everything less important lives in `docs/agents/`. Add one only if both are true:
1. Without it, the next agent will make a concrete mistake.
2. It cannot be learned from the code the agent will read anyway. 

One fact per bullet, max two lines; details go to `docs/agents/<topic>.md` with a link. 
Never add bullets to AGENTS.md on your own — propose the wording and get the user's explicit approval first; if you hesitate whether it's important enough, it isn't.

## Gotchas:
- `generator-data/ops-backups` растёт ~409 МБ на пакетную операцию и попадает в tar деплойного бэкапа генератора — перед деплоем чистить с удержанием последних партий, иначе ENOSPC на VPS (см. docs/agents/zelenograd-labels-2026-10-05.md).
- Delete Gotchas that are no longer true or are now covered by a test.
