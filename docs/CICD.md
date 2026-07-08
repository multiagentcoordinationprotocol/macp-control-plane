# MACP Control Plane — CI/CD Reference

## Workflows

| Workflow | Trigger | What it does |
|---|---|---|
| [ci.yml](../.github/workflows/ci.yml) | push/PR → `main` | lint, typecheck, unit tests (+coverage summary), integration tests, `npm audit` gate, secret scan, convention sweeps, build, Docker build (push + Trivy on `main` only) |
| [release.yml](../.github/workflows/release.yml) | tag `v*.*.*` | Trivy-gated semver image push to GHCR + GitHub Release |
| [codeql.yml](../.github/workflows/codeql.yml) | push/PR → `main`, weekly | CodeQL static analysis (javascript-typescript) |
| [integration-tests.yml](../.github/workflows/integration-tests.yml) | manual | integration tests against `mock` / `docker` / `remote` runtime, optional Python agent E2E |
| [deploy.yml](../.github/workflows/deploy.yml) | manual (`tag` input) | SSH deploy to the production VM — dormant until `DEPLOY_SSH_*` secrets exist |
| [notify-website.yml](../.github/workflows/notify-website.yml) | push → `main` (docs paths) | repository-dispatch to the website repo |

## CI pipeline (ci.yml)

```
lint ─┐
typecheck ─┤
test (unit + coverage) ─┼→ build → docker (every PR: build-only; main: push to GHCR + Trivy CRITICAL gate)
audit (npm audit, prod deps, high+) ─┤
check-env-secrets ─┤
conventions (CLAUDE.md grep sweeps) ─┘
test → integration-test (postgres:16 service on 5433, mock runtime)
```

- **Concurrency**: superseded PR runs are cancelled; `main` pushes never are (a killed docker job could leave a partial `latest` tag).
- **Node version** comes from `.nvmrc` everywhere (`node-version-file`) — one place to bump.
- **Coverage** is reported in the job step-summary and uploaded as an artifact; there is deliberately no blocking threshold.
- **PR Docker builds** run without pushing, so a broken Dockerfile fails the PR, not the merge to `main`.
- The private `@multiagentcoordinationprotocol/proto` package installs via `NODE_AUTH_TOKEN=${{ secrets.GITHUB_TOKEN }}` (Actions) and a BuildKit secret `npm_token` (Docker builds).

## Releases

1. Bump `version` in `package.json` (the release workflow warns on tag/package.json drift).
2. `git tag v0.6.0 && git push origin v0.6.0`
3. The workflow builds the image, scans it with Trivy (`CRITICAL`, `ignore-unfixed`) **before** anything reaches the registry, then pushes `v0.6.0`, `v0.6`, and `latest` (pre-release tags like `v0.6.0-rc.1` skip `latest` and are marked pre-release), and creates a GitHub Release with generated notes.

## Security & dependency automation

- **npm audit** (`ci.yml` `audit` job): checks high/critical advisories in production dependencies. **Currently report-only** (`continue-on-error`) — the dependency tree has high/critical advisories with no non-breaking fix (e.g. multer / path-to-regexp via `@nestjs`, protobufjs via otel), so a hard gate would block every build. Flip it to blocking (remove `continue-on-error` and add `audit` back to `build`'s `needs`) once those are upgraded.
- **Trivy**: image CVE scan on `main` (post-push, **report-only**) and on release (pre-push, **hard gate** — blocks the tag push). CRITICAL only, unfixed CVEs ignored.
- **CodeQL**: JS/TS analysis on PRs plus a Monday-morning schedule. Requires GitHub Advanced Security on private repos.
- **Dependabot**: weekly npm (minor+patch grouped, `@multiagentcoordinationprotocol/proto` excluded — proto upgrades are deliberate absorptions) and weekly github-actions updates. Requires the `DEPENDABOT_GHPR_TOKEN` Dependabot secret (classic PAT, `read:packages`) so lockfile regeneration can resolve the private registry — **without it every npm update PR fails**.

## Required secrets

| Secret | Where | Purpose |
|---|---|---|
| `GITHUB_TOKEN` | built-in | GHCR push, private package install, release creation |
| `DEPENDABOT_GHPR_TOKEN` | Dependabot secrets | private-registry resolution for Dependabot npm updates |
| `DEPLOY_SSH_HOST` / `DEPLOY_SSH_USER` / `DEPLOY_SSH_KEY` | Actions secrets | optional remote deploy (deploy.yml stays dormant without them) |
| `WEBSITE_SYNC_TOKEN` | Actions secrets | notify-website dispatch (pre-existing) |

## Deployment

Single-VM Docker Compose — see [deploy/README.md](../deploy/README.md) for the runbook (`deploy.sh deploy <tag>` / `rollback` / `status`, `.env.prod` setup, backup notes). Images are pinned by explicit tag (`TAG=vX.Y.Z`); `deploy.sh` records `.current_tag`/`.previous_tag` and verifies `/healthz` before declaring success. Rollback swaps the app image only — migrations are forward-only.
