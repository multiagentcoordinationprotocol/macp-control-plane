# macp-runtime: Docker publish workflow doesn't trigger on release-plz tags

**Target repo:** `multiagentcoordinationprotocol/macp-runtime`
**Filed from:** `multiagentcoordinationprotocol/macp-control-plane`, `plans/absorb-runtime-v0.8.0.md` Phase 1
**Type:** bug (CI/CD), not a code-behavior bug

## Problem

`.github/workflows/docker.yml:6-8` triggers image publishing on:

```yaml
on:
  push:
    branches: [main]
    tags: ["v*"]
```

But `release-plz` (per `release-plz.toml` / the release workflow already split out in commit `b908458`, "split release into release-plz (version+git) and publish.yml (crates.io)") now creates git tags in the form `macp-runtime-v0.8.0`, not `v0.8.0`. `"macp-runtime-v0.8.0"` does not match the glob `"v*"` (glob patterns anchor at the start of the string), so this trigger's `tags` clause has not fired for a real version tag since the tagging scheme changed. (The `branches: [main]` clause fires independently on every push to the default branch — that's the trigger actually producing the SHA-tagged images in use today; see below. Any suggested-fix change to this `on:` block must keep `branches: [main]`, not just add a corrected `tags` pattern.) Confirmed by direct probe of the GHCR tag list: `0.8.0`/`0.8`/`0.7.x` do not exist; `0.5.0`/`0.5` **do** exist (from before the tagging scheme changed), alongside `latest` (mutable) and commit-SHA tags (via `docker.yml:51`'s `type=sha,prefix=` metadata rule).

**Correction from an earlier draft of this doc:** it previously claimed no `v0.5.0` tag exists either, attributing that to this same bug. That's only half right. `0.5.0`/`0.5` genuinely were published — the actual reason `macp-control-plane/docker-compose.test.yml`'s current pin (`:v0.5.0`, with a leading `v`) 404s is a **separate, local typo**: `docker/metadata-action`'s `type=semver,pattern={{version}}` rule strips the leading `v` from `refs/tags/v0.5.0` before publishing, so the real tag has always been `:0.5.0`, never `:v0.5.0`. Two independent bugs, one in each repo.

## Impact

Any downstream consumer that wants to pin a stable, semver-tagged **v0.8.x** runtime image — which is the norm for a docker-compose-based integration test harness — cannot; that part of the original diagnosis holds. The practical workaround in use today (see the main plan) is pinning to the release commit's SHA tag (e.g. `f97fd15` for the `macp-runtime-v0.8.0` release), which works but is a maintenance liability: SHA tags are more prone to GC, and every absorption has to re-derive the correct SHA by hand instead of just bumping a version string.

## Suggested fix

Two changes are needed, not one — the trigger glob alone is not sufficient:

**1. Fix the trigger** in `.github/workflows/docker.yml` to match the actual tag format — keep the existing `branches: [main]` clause, only change `tags`:

```yaml
on:
  push:
    branches: [main]
    tags: ["macp-runtime-v*"]
```

(or `["v*", "macp-runtime-v*"]` if there's a reason to keep matching a hypothetical bare `v*` tag too — check whether any other release artifact in this repo still uses that scheme before deciding).

**2. Fix the metadata-action extractor.** Even with the trigger firing, whatever `docker/metadata-action` rule currently derives the semver tag (`type=semver,pattern={{version}}`, going by the existing `:0.5.0`/`:0.5` output) cannot parse `macp-runtime-v0.8.0` as a semver string — it will warn and emit no version tag. Add a `type=match` rule instead (or alongside, for whichever tag format is retained):

```yaml
type=match,pattern=macp-runtime-v(\d+\.\d+\.\d+),group=1
type=match,pattern=macp-runtime-v(\d+\.\d+),group=1
```

This will emit `:0.8.0`/`:0.8` (no leading `v` — `metadata-action`'s `group=1` capture excludes the `macp-runtime-v` prefix, consistent with how the existing `0.5.0`/`0.5` tags came out un-prefixed). After both fixes land, re-tag-and-push (or manually dispatch, if the workflow supports `workflow_dispatch`) for the current `macp-runtime-v0.8.0` release so a proper `:0.8.0` image becomes available retroactively — otherwise the fix only takes effect on the *next* release, and consumers stay stuck on SHA pins for one more cycle.

## Acceptance criteria (for whoever picks this up in macp-runtime)

1. Pushing a tag in the `macp-runtime-vX.Y.Z` format triggers `docker.yml` and publishes a correspondingly-tagged image to GHCR.
2. The current `v0.8.0` release gets a matching image tag published (retroactively, via re-dispatch or a patch release), so `macp-control-plane` and other consumers can pin `:0.8.0` (un-prefixed — `metadata-action` will not emit a `v`-prefixed tag under the suggested fix) without a SHA workaround.
3. No regression to the existing `latest` and SHA-tag publishing behavior, or to the existing `0.5.0`/`0.5`-style tags from before the release-plz tag-format change.

## Notes

This is a read of macp-runtime's own CI config, not a request to change any wire/protocol behavior — low risk, CI-only. Not a cross-repo write from control-plane: this file stays in control-plane's own `plans/cross-repo/`, and the corresponding GitHub issue in `macp-runtime` links back here.
