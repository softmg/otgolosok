---
name: production-readiness
description: Review a project for production readiness. Invoked manually by the user via /production-readiness before deploying or preparing a release.
disable-model-invocation: true
---

Review the project against the checklist below. Every item comes from a real production incident: code that worked perfectly in dev broke the moment it ran behind a real domain, TLS terminator, and reverse proxy. The recurring root cause is **assuming the dev environment instead of treating the deployed environment as configuration** — keep that lens on while reviewing.

Work through each section, inspect the actual files (compose files, Dockerfiles, nginx configs, dependency manifests, deploy scripts), and report findings as: **Blocker** (will break production), **Risk** (will break under a plausible condition), **OK**. Do not fix anything until the user asks — the deliverable of the review is the report.

## 1. Behind-proxy and public-origin correctness

The app almost never terminates TLS itself. Assume: browser → external TLS terminator → frontend nginx → API.

- Every absolute URL the app emits must work behind the proxy chain: OAuth/OIDC redirect URIs, post-login and error redirects, links in emails/notifications, `Secure` cookie flags, HSTS. Localhost defaults are fine for dev only if they are overridden per-request or per-env in production.
- Never assume `X-Forwarded-Proto` arrives from upstream — an external TLS terminator may not send it. The public scheme is **explicit deployment config** (e.g. `PUBLIC_SCHEME=https` env var injected into the nginx template), not a guess from client headers.
- OAuth redirect_uri used in the token exchange must be the same one used at login — store it in the auth state, don't re-derive it at callback time.
- Trust `X-Forwarded-*` only from declared proxy CIDRs (trusted-proxies setting); otherwise rate limiting and client-IP logic key on the proxy's IP and every client shares one bucket.

## 2. Runtime dependencies

- Everything imported at runtime must be a declared runtime dependency — not a dev dependency, not a transitive one that happens to be present locally. A package can work in the local venv and be absent from the production image.
- Verify by starting the service in a clean production image, not the dev environment.
- Guard with a manifest test: a test that imports the runtime modules (or asserts the manifest contains known runtime imports) so a missing dependency fails CI, not production.

## 3. Docker and Compose

- A production-ready service ships as a container: a `Dockerfile` (plus `.dockerignore`) is a prerequisite, not an optional extra. Running `node`/`npm`/`python` directly on the server is a **Blocker**. Verify the image actually builds and starts (framework standalone/production output, non-root user, writable data dirs `chown`-ed to that user).
- Know which config is baked at build time vs read at runtime: client-visible vars (`NEXT_PUBLIC_*` and friends) are build `ARG`s frozen into the image; server config and persistent volumes are runtime-only. Changing a build-time var requires a rebuild — flag any that are wired as runtime env.
- The build step must never open the production database or persistent volume. Parallel build workers initializing a real SQLite/data dir will lock or corrupt it — during build, use an in-memory or throwaway store, and attach the persistent volume only at runtime.
- Use `npm ci` (lockfile-driven), not `npm install`. Pin base image tags (`nginx:1.27-alpine`, not `nginx:latest`). No dev servers (`npm run dev`, `--reload`) in production images — dev mode lives only in the compose dev override.
- Use multi-stage builds only when the runtime image is actually lighter than the builder; otherwise use a single stage.
- Do not hardcode ports — take them from env with a default (`"${API_PORT:-8000}:${BACKEND_PORT:-8000}"`), including internal ports (CMD, healthchecks).
- Prefix volumes and networks with the project name so ownership is obvious and collisions are impossible.
- Configuration comes from env files, without duplicating variables across `args` and `environment`. Scope secrets per service: a container gets only its own variables, never the whole `.env`.
- Bind addresses are env-driven (`${API_BIND_ADDRESS:-127.0.0.1}`): internal services stay on loopback; only the ingress-facing service binds `0.0.0.0`.

## 4. Compose topology and startup ordering — test it

Compose files are code; a local `docker compose up` on one machine proves nothing about the full override stack on the server.

- Every service must actually reach every service it calls: shared networks, external networks, and every compose override file combined. Background/reconciler services are the classic miss — they talk to workers on external networks nobody connected them to.
- Startup order via healthchecks: `depends_on: { api: { condition: service_healthy } }`, not bare `depends_on`.
- Encode the topology in a test (e.g. `test_compose_network_policy.py`: parse the compose files, assert which services share which networks and which ports are exposed). Extend the test when adding a service or network — that is what catches the regression, not memory.

### Integration and end-to-end coverage

Unit tests are necessary but do not prove that independently correct components work together. A production-readiness review must inspect integration and E2E coverage and report missing coverage proportionally to the failure impact.

- Integration tests are required for critical boundaries: API and persistence, migrations, authentication and authorization, queues/background jobs, filesystem or object storage, serialization contracts, and adapters to external services. Exercise the real internal components whenever practical; mock only the external boundary that is paid, destructive, nondeterministic, or unavailable in CI.
- E2E tests are required for the small set of critical user journeys that must survive a release: sign-in and access control, the primary create/read/update flow, the product's core value path, important exports/imports, and destructive actions. Before the first production deploy, at least one smoke journey must cross the real frontend, backend, and data store.
- Do not demand E2E coverage for every validation branch or edge case. Keep detailed permutations in unit and integration tests; use E2E to prove wiring, contracts, permissions, routing, and the highest-value journeys.
- Production-like means the same build artifacts, migrations, service topology, and configuration shape — never production credentials, production data, or calls that create real external side effects.
- For every potentially long-running operation (LLM calls, external scoring, imports/exports, background jobs), inventory the effective default timeouts at every layer: HTTP connect/read/write/pool, provider polling, worker/job deadline, reverse proxy, ingress/load balancer, and client. Verify them with a production-sized payload and a deliberately slow successful response; no shorter per-request default may abort healthy work before the operation's overall deadline. Report such a mismatch as a **Risk**, and require timeout errors to be distinguishable from generic network failures.
- Tests must be deterministic and isolated: create their own data, clean it up, wait for observable state instead of fixed sleeps, and avoid order dependence. On failure, retain useful diagnostics such as service logs, browser traces, screenshots, and request/response context without secrets.
- Missing integration coverage for a critical cross-component contract is a **Risk**. Missing any E2E smoke path for the product's primary journey before the first deploy is a **Blocker**. Flaky tests that are routinely retried or ignored do not count as coverage.

### REST/GraphQL API contract: OpenAPI + Schemathesis

Hand-written tests exercise the inputs the author imagined. A public API is called by clients who send everything else — and by generated SDKs that trust the schema literally.

- If the service exposes a REST API, a machine-readable schema (`openapi.json` / `openapi.yaml`) is a deliverable, not an extra. Frameworks that generate it (FastAPI, NestJS, drf-spectacular, go-swagger) still need the generated document checked against reality: undocumented endpoints, missing error responses, and `additionalProperties` drift are the usual gaps. No schema for a REST API that other code calls is a **Risk**.
- Run property-based conformance against a running instance: `uvx schemathesis run http://localhost:8000/openapi.json --checks all`. It derives requests from the schema (unusual strings, boundary numbers, missing/extra fields, wrong types) and asserts every response against the documented contract. GraphQL schemas are supported the same way.
- Typical findings: 500 on an odd string, a response body that violates its own schema, an unhandled exception on a missing field, an oversized number breaking a handler, a broken `create → update → delete` sequence (stateful mode follows OpenAPI `links`).
- **Run it only against a disposable environment with throwaway data.** Generated requests include `DELETE`/`PUT` against real paths — pointing it at staging with real data or at anything shared is an incident, not a review. Pass auth via `-H "Authorization: Bearer ..."` (an unauthenticated run only covers public endpoints), and exclude endpoints with external side effects (payments, outgoing email) by path or method rather than skipping the run.
- Severity: an unhandled 5xx from a generated request is a **Risk**, a **Blocker** when the endpoint is publicly reachable without auth or when the request corrupts data. A response that contradicts its own schema is a **Risk** — generated clients and consumers break on it. A schema so stale that most generated requests get rejected before reaching handlers is itself the finding.
- If the project has no schema-based testing, **propose** it in the report (a pytest integration for the critical endpoints, run in CI against an ephemeral instance); do not wire it in yourself.

### Test suite strength: coverage and mutation testing

Review the **whole codebase as it stands at release time**, not the diff since the last release — a release ships all of the code, including whatever nobody cared about before. Coverage and mutation scores are diagnostics for this report, never gates in the commit loop: do not write tests to move a number, and do not set a single project-wide percentage threshold — on legacy glue it only produces filler tests.

Required numbers for a release:

| Scope | Bar | Below the bar |
| --- | --- | --- |
| Whole project | **≥ 85% line coverage** | **Risk** |
| Critical logic | **≥ 95% branch coverage**, and zero uncovered error or boundary branches | **Blocker** |
| Application layer | **≥ 80% branch coverage** | **Risk** |
| Mutation score on critical logic | **≥ 80% of mutants killed** | **Risk** |
| Any tier vs. the previous release | must not drop | **Risk** |

The numbers are a floor, not a target — hitting 85% by testing trivial code while a billing branch stays uncovered is a failed review, not a passed one. Judge each module against its tier, then report the project number:

- **Critical logic** — domain rules, money and billing, authentication and authorization, calculations, parsers and serializers, state machines, migrations. Every branch covered, including error and boundary branches.
- **Application layer** — handlers, services, jobs, adapters. Happy path plus every failure path that is handled explicitly (retries, timeouts, 4xx/5xx mapping).
- **Glue** — code with no decisions of its own: DTOs and models without validation, trivial one-line delegation, getters, config and DI wiring, field-for-field model↔schema mapping, generated code (OpenAPI/protobuf clients, migration stubs, re-export `__init__.py`). Exclude it from measurement (`omit` in `.coveragerc` / `coveragePathIgnorePatterns` / `exclude` in the coverage config) instead of padding it with tests. If the project number only clears 85% because glue is counted, the number is a lie — say so in the report.

How to run it:

- Measure the full suite with branch coverage and read the missing lines, not just the total: `uv run pytest --cov --cov-branch --cov-report=term-missing`, `vitest run --coverage`, `go test ./... -coverprofile=cover.out && go tool cover -func=cover.out`. Report the overall number as context, and list findings per module against the tier bars above.
- Run mutation testing scoped to **one critical module at a time** — never on glue, DTOs, or IO wrappers. An unscoped run over the whole source tree takes hours and saturates the machine, which breaks parallel dev servers and especially Playwright E2E; its mutants mean nothing anyway. TypeScript: Stryker with `mutate` scoped the same way.
- The narrow scope is cheap, not a compromise. Measured on a 465-line Python module with 8 tests: **724 mutants in 16 seconds** at `max_children = 4` (~44 mutations/sec). Budget one module per run and move the scope along.
- `mutmut run` exits 0 even when mutants survive — never judge it by exit code. Read `uv run mutmut results` (lists every non-killed mutant) or `uv run mutmut export-cicd-stats` (writes `mutants/mutmut-cicd-stats.json`). `uv run mutmut show <name>` explains one mutant, but each call spawns its own process — dumping a hundred diffs takes minutes, so loop over them inside the container rather than calling from outside.
- Both tools require a green, deterministic suite — with flaky tests the results are noise, and the flakiness is the finding. If no mutation tool is configured, **propose** adding one in the report; do not add it yourself (YAGNI).

#### mutmut 3 scope config (Python)

Set it in `pyproject.toml`, and always change these two together — `only_mutate` without narrowing `pytest_add_cli_args_test_selection` reruns the entire suite for every mutant:

```toml
[tool.mutmut]
only_mutate = ["app/<module>.py"]
pytest_add_cli_args_test_selection = ["tests/test_<module>.py"]
also_copy = ["pyproject.toml"]
max_children = 4
```

`also_copy` is mandatory: without `pyproject.toml` inside the copy there is no `[tool.pytest.ini_options]` with `pythonpath = ["."]`, and every test fails on importing the app package. (`source_paths` is not the mutmut 3 knob — do not reach for it.)

#### mutmut does not run on native Windows

`uv run mutmut run` on Windows exits with "To run mutmut on Windows, please use the WSL" — a deliberate mutmut 3 limitation ([issue #397](https://github.com/boxed/mutmut/issues/397)). A valid config still cannot be executed there. Run it through Docker from the repo root (PowerShell), which also works when the local WSL has no `uv`:

```powershell
docker run --rm -v "${PWD}/backend:/src:ro" --entrypoint sh ghcr.io/astral-sh/uv:python3.12-bookworm-slim -c 'set -e; mkdir -p /work; cp -r /src/app /src/tests /src/pyproject.toml /src/uv.lock /work/; cd /work; export HOME=/work; uv sync --frozen --group dev >/dev/null 2>&1; uv run mutmut run; uv run mutmut results'
```

Sources are mounted **read-only** and the mutated copy lives inside the container. This matters because mutmut 3 generates mutants into a `mutants/` directory next to the code, and several agent sessions often share one worktree — a read-only mount makes it physically impossible to touch the working tree, so development continues during the run. Add `mutants/` and mutmut's state files to `.gitignore` anyway, for runs launched from inside WSL.

#### Triaging survivors — not every survivor is a finding

A surviving mutant in critical logic is a **Risk** only when its effect is observable through the function's public result. Before listing one, check that a test *could* kill it; put the test that would under "Suggested regression tests" with the module and mutated line. Recurring noise to discard instead:

- Mutated string literals in `label=` / f-strings (`"skill"` → `"XXskillXX"`). Meaningful only where the exact text is part of a contract (a warning message an API client parses).
- `setattr`/`getattr` inside a guard whose effect never reaches the returned value — e.g. a normalization pass that repairs fields on a working copy, while the result is rebuilt from a separate list. Such guards are only killable by a unit test against the private function directly; otherwise the mutant is unkillable by construction.
- Equivalent rewrites, such as `local_map.get(key, key)` → `local_map.get(key)` where the default matches the missing-key behavior.

The real signal looks different: it points at guard branches no test ever executed, and at assertions that check presence or count (`assert key in id_map`, `assert len(warnings) >= 3`) but never the values. On one module that took the score from 522/724 killed (~72%) to 644/724 (~89%) — all of it from tests worth keeping, none from chasing the number.

## 5. nginx in front of Docker services

- Never hardcode `proxy_pass http://service:port;` — nginx resolves the name once at startup and caches the container IP forever. After `docker compose up -d` recreates the upstream, the proxy sends traffic to a dead IP. Use a variable upstream with the Docker DNS resolver:

  ```nginx
  resolver 127.0.0.11 valid=10s ipv6=off;
  set $api_upstream api:${BACKEND_PORT};
  proxy_pass http://$api_upstream;
  ```

- nginx templates are testable — assert the rendered config contains the resolver/variable pattern and the expected forwarded headers.

## 6. Line endings

Files edited on Windows/macOS but consumed by Linux containers or server-side shell tooling must be LF. CRLF silently breaks shebangs, env parsing, and shows phantom diffs on the server. Enforce in `.gitattributes`:

```gitattributes
*.sh   text eol=lf
.env*  text eol=lf
*.yml  text eol=lf
*.yaml text eol=lf
*.md   text eol=lf
```

Add an entry whenever a new Linux-consumed file type appears.

## 7. Deploy tooling safety

- Check production-config protection under [OPS-02](../../../docs/instructions/operations.md#ops-02). Inspect scripts and make targets for a missing server file and require an explicit failure path.
- Don't assume tooling exists on the server (`rsync`, `sudo`); verify, and prefer git-push-based deploy when in doubt.
- SSH to hardened servers: use connection multiplexing (`ControlMaster`/`ControlPersist`) instead of many rapid connections — fail2ban-style rate limits ban the port for everyone.

## 8. Secrets and environment profiles

- Secrets and repository hygiene: [ENG-02](../../../docs/instructions/engineering.md#eng-02). Verify `.env.example` documents the environment profile.
- Run gitleaks as part of the review: `gitleaks git .` (full git history) and `gitleaks dir .` (working tree, catches gitignored-but-present files before they leak into images). If gitleaks is not installed, install it first (`winget install gitleaks` / `brew install gitleaks` / release binary from GitHub) and run it. Every finding is a **Blocker** until proven a false positive; a secret already in history stays compromised even after deleting the file — it must be rotated, not just removed.
- Production profile values are validated at startup (e.g. reject unsafe flags like disabled access checks when `APP_ENV=production`); a config validator is cheaper than an incident.
- Env var spelling matters (`production` vs `prod`) — validate enums, don't string-compare loosely in some places and strictly in others.
- Test/staging deployments must be invisible to search engines: an env flag (e.g. `ROBOTS_DISALLOW_ALL=true`) that makes `robots.txt` return `Disallow: /`, covered by a test. A staging clone getting indexed is an SEO incident for the real site.

## 9. Security scanning — run it, then triage it

A security review needs three complementary scans: **SAST** for unsafe code and data flows, **SCA/dependency audit** for known vulnerable packages, and the secret scan from section 8. A linter or type checker does not replace any of them.

1. Detect every language and package manager from manifests and lockfiles. Prefer the project's already configured scanners; record each tool and version in the report.
2. Scan the whole production source tree, not only the release diff. Exclude only generated code, vendored dependencies, caches, build output, test fixtures that intentionally contain attack strings, and other paths with a documented reason.
3. Run one code scanner and the ecosystem's dependency audit for each production language. For an unconfigured polyglot project, use Semgrep as the first SAST pass: `semgrep scan --config auto .`; add the language-specific scanner where the table below recommends one.
4. Read every high/critical result and trace untrusted input to the reported sink. Check whether the vulnerable dependency is shipped and whether the affected API is reachable. A scanner exit code may mean findings or an execution/configuration failure — distinguish them and never report an incomplete scan as clean.
5. Report a confirmed remotely exploitable flaw, authentication/authorization bypass, injection, unsafe deserialization, or exposed secret as a **Blocker**. Report a plausibly reachable high/critical issue, an unscanned production language, or no security scan in CI as a **Risk**. Document false positives and accepted risks with file/line, evidence, owner, and expiry; never add a broad suppression just to make the scan green.
6. Verify CI runs the pinned scanner/rules on every merge request and a full scan on the default branch or schedule. New high/critical findings must fail CI. If scanning is absent, propose the minimal CI job in the report; do not add it until the user asks.

Choose tools by stack; combine the two columns because code scanning and dependency auditing catch different classes of problems:

| Stack | SAST / code security | Vulnerable dependencies (SCA) |
| --- | --- | --- |
| Polyglot / first pass | **Semgrep** (`semgrep scan --config auto .`) | **OSV-Scanner** against supported lockfiles or an SBOM |
| Python | **Bandit** (`bandit -r <source-dir>`) plus Semgrep for framework/data-flow rules | **pip-audit** (`pip-audit`) |
| JavaScript / TypeScript | **Semgrep**; add maintained ESLint security rules for project-specific dangerous APIs | Package-manager audit, e.g. `npm audit --audit-level=high` |
| Go | **gosec** (`gosec ./...`) | **govulncheck** (`govulncheck ./...`) — prefer its reachability-aware result over a raw module-version match |
| Rust | **CodeQL** or **Semgrep** for unsafe application patterns; review `unsafe` boundaries explicitly | **cargo-audit** (`cargo audit`) and, when already configured, `cargo deny check advisories` |
| Java / Kotlin | **SpotBugs + FindSecBugs** or **CodeQL** | **OWASP Dependency-Check** via Maven/Gradle/CLI |
| C / C++ | **CodeQL** plus **Clang Static Analyzer** | **OSV-Scanner** against supported lockfiles or an SBOM; also scan the final image |
| C# / .NET | **CodeQL** plus enabled .NET/Roslyn security analyzers | `dotnet package list --vulnerable --include-transitive` (.NET 10+), or `dotnet list package ...` on older SDKs |
| PHP | **Semgrep**; use Psalm taint analysis when the project already has Psalm | `composer audit` |
| Ruby / Rails | **Brakeman** (`brakeman -q`) plus Semgrep outside Rails | **bundler-audit** (`bundle audit check --update`) |
| Swift | **CodeQL** | GitHub dependency graph/Dependabot alerts for `Package.resolved`; document the gap if the host has no lockfile-aware audit |
| Terraform, Kubernetes, Dockerfiles and images | **Checkov** or `trivy config .` | `trivy fs .` for the repository and `trivy image <image>` for the exact release image |

Do not install every tool in the table. Select only the rows present in the repository, prefer an existing lockfile-aware ecosystem command, and explain any coverage gap. Dynamic scans, penetration tests, and container/runtime scans complement this step but do not make a failed SAST/SCA review pass.

## 10. Infra fixes get regression tests

A deploy-breaking fix is not done until a test pins it. nginx templates, compose files, dependency manifests, and `.gitattributes` are all assertable. If an incident was worth fixing, it is worth a test — and a short incident write-up in the project's agent docs so the next person doesn't rediscover it.

## 11. Deployment docs in the README

The person deploying this six months from now is not you and does not have this conversation. The README must let them go from a fresh clone to a running production instance without reverse-engineering the compose files.

- A README (language per [ENG-01](../../../docs/instructions/engineering.md#eng-01)) with a deployment section is a prerequisite, not a nicety. Missing or dev-only setup instructions is a **Risk** — the service that only you know how to deploy is a single point of failure.
- The deploy section must cover, concretely: prerequisites (Docker/Compose versions, required server tooling), how to create the production `.env` from `.env.example` and which vars are mandatory, the exact build/up commands (including which compose override files to combine), how to run migrations/seed steps, and how to verify the deploy is healthy (healthcheck URL, expected response).
- Commands in the README must be copy-pasteable and match reality — the actual service/compose names, the actual ports, the actual env var names. Stale commands are worse than none. Cross-check them against the compose files and scripts you just reviewed.
- Document rollback and log-inspection: how to view logs, how to roll back to the previous image/commit.

## 12. Error notifications to Confluence (internal projects)

For internal SMG projects, error reports and important events can be sent to the internal Confluence. As part of the review, **propose** to the user wiring notifications there — runtime errors, deploy failures, incidents, other events worth a written trace. This is a suggestion in the report, not something to add yourself: per the YAGNI rule, the integration is added only after the user explicitly approves it.

## 13. Documentation currency — audit every doc, not just the README

Stale documentation is worse than missing documentation: it makes the next person confidently do the wrong thing. A release ships the docs too, so review **all** of them — root `README.md`, per-service READMEs, `docs/**`, `docs/agents/**`, `.env.example`, runbooks, ADRs, and any onboarding or API notes.

For each document, verify against the code as it actually stands: commands run, paths and file names exist, env var names match, ports and service names match the compose files, described flows still exist, screenshots and output samples are not from an older version, links do not 404.

Then resolve every doc into exactly one of these — an unresolved doc is a finding:

- **Update** — the doc is still relevant but drifted. Fix it now.
- **Delete** — it describes something removed, or duplicates a better doc. Remove it, and drop its entry from the index (`docs/agents/README.md`, `docs/README.md`, root README links).
- **Mark as outdated** — only when a doc still carries historical value that nobody can re-derive (incident write-ups, past decisions). Put an explicit note at the top: what it covered, that it no longer reflects the current code, and as of which date.

Check the reverse direction under [ENG-04](../../../docs/instructions/engineering.md#eng-04): compare existing docs with index entries and flag missing or stale entries.

Severity: docs whose commands or env vars are wrong for a deploy or setup path are a **Risk** (a **Blocker** if following them corrupts data, overwrites production config, or leaks secrets). Missing or unindexed docs are a **Risk**. Purely cosmetic drift is a note in the report, not a finding.

## 14. Test suite runtime

Run the full test suite and look at where the time goes: `uv run pytest --durations=0`, `vitest --reporter=verbose`, `go test ./... -v` with timing.

- If a single test takes disproportionately long, fix that test.
- If the time is spread evenly across tests, it is a fixed per-test cost — building a fresh database and running every migration per test, spinning up the app/container/browser per test, real `sleep`s, unmocked network. Do the expensive setup once per session and hand each test a cheap copy where that is possible (e.g. build the schema into a template file in a session-scoped fixture and copy it per test).

## Report format

Conclude with:

```
# Production readiness review
## Blockers
## Risks
## OK / verified
## Suggested regression tests
```

List each finding with the file/line it was found in and the concrete failure scenario in production.
