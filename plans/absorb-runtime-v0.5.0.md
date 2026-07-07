# Absorb macp-runtime v0.5.0 + macp-proto 0.1.6

Status: **implemented** (T1–T10 landed with unit coverage; T11 live pass pending — see Implementation note)
Owner: control-plane maintainers
Upstream inputs: `macp-runtime` v0.5.0 (CHANGELOG.md `[0.5.0] — 2026-07-05`, `docs/change-review-phases-a-e.md`), `@multiagentcoordinationprotocol/proto` 0.1.4 → 0.1.6 (published on GitHub Packages; verified `npm view` lists `0.1.6`), and the spec-repo RFC updates that ride along.

---

## 1. Context

### What this repo is

`macp-control-plane` is a NestJS **observer-only** service. It never calls `Send`
(invariant guarded by `src/runtime/observer-invariant.spec.ts`); agents emit
their own envelopes directly against the runtime. The control-plane:

- creates run records and pre-allocates session IDs (`POST /runs` →
  `RunExecutorService.launch`, `src/runs/run-executor.service.ts:132-143`),
- polls `GetSession` until the initiator agent opens the session
  (`src/runs/run-executor.service.ts:388-427`),
- subscribes read-only to `StreamSession` with a single passive-subscribe frame
  `{subscribeSessionId, afterSequence}` and **keeps the write side open**
  (`src/runtime/rust-runtime.provider.ts:263-283`),
- watches `WatchSessions` for session discovery
  (`src/runs/session-discovery.service.ts`) and `WatchSignals` for ambient
  signals / token usage (`src/runs/signal-consumer.service.ts`),
- normalizes envelopes → canonical events → projections → SSE
  (`src/events/event-normalizer.service.ts`, `src/projection/projection.service.ts`),
- issues control-plane RPCs `CancelSession` / `SuspendSession` / `ResumeSession`
  (`src/runs/run-executor.service.ts:154-264`) and the policy-registry RPCs
  (`src/controllers/runtime.controller.ts`).

### How it links to the upstream artifacts

| Surface | Where | Current state |
|---|---|---|
| Proto package | `package.json:26` → `"@multiagentcoordinationprotocol/proto": "^0.1.3"`; lockfile resolves **0.1.3** from `https://npm.pkg.github.com` (package-lock.json, `node_modules/@multiagentcoordinationprotocol/proto` package.json `version: 0.1.3`) | Needs bump to `^0.1.6` |
| gRPC service load | `src/runtime/rust-runtime.provider.ts:106-124` — `protoLoader.loadSync([core.proto, envelope.proto, policy.proto])` from the package's `protoDir` | Picks up 0.1.6 automatically on bump |
| Payload decode | `src/runtime/proto-registry.service.ts:55-66` loads core/envelope + 5 mode protos; `MESSAGE_TYPE_MAP` at `:5-48` | Missing `multi_round.proto`; `Contribute` mapped to `__json__` (`:45-47`) |
| Runtime binary (tests) | `docker-compose.test.yml:19-34` builds `../macp-runtime` from source with `MACP_ALLOW_INSECURE=1` + `MACP_ALLOW_DEV_SENDER_HEADER=1`; started by `test/setup/global-setup.ts:14-19` when `INTEGRATION_RUNTIME=docker` | Builds whatever is checked out next door; `MACP_ALLOW_DEV_SENDER_HEADER` is a dead env var in v0.5.0 |
| Runtime auth | `src/runtime/runtime-credential-resolver.service.ts:32-57` — JWT mint → static bearer → **dev header `x-macp-agent-id`** fallback; config in `src/config/app-config.service.ts:50-84` | Dev-header fallback is rejected by runtime v0.5.0 (see item 6/9) |
| Version claims in docs | `CLAUDE.md`, `README.md:101` (dev auth instructions), `docs/INTEGRATION.md:11-17` (provider surface semantics) | Several statements stale vs v0.5.0 |

There is **no version pin on the runtime itself** anywhere in this repo — the
only coupling is the proto package, the gRPC wire behavior, and the
docker-compose test runtime built from `../macp-runtime`.

### Verified upstream facts this plan relies on

- Runtime v0.5.0 `authenticate_metadata` has **no `x-macp-agent-id` path at
  all** — bearer-only, and dev-mode (no auth configured + `MACP_ALLOW_INSECURE=1`)
  accepts *any* bearer as a fully-privileged identity
  (`macp-runtime/crates/macp-auth/src/security.rs` — `dev_authenticate` at
  `:104-116`, test `dev_mode_rejects_dev_sender_header` at `:463-469`).
  `MACP_ALLOW_DEV_SENDER_HEADER` is read nowhere in the runtime source.
- Passive subscribe: `after_sequence` is the 1-based accepted-envelope ordinal,
  **exclusive**; resume below the compacted base returns `FAILED_PRECONDITION`
  with message `"session history before ordinal {base} was compacted; resume
  with after_sequence >= {base} or re-read state via GetSession"`
  (`macp-runtime/src/server.rs:505-518`, `src/runtime.rs:193-207`,
  `crates/macp-storage/src/log_store.rs:114-130`).
- `StreamSession` **also** terminates with `RESOURCE_EXHAUSTED` when the
  receiver lags (`macp-runtime/src/server.rs:670-674`), same as
  `WatchSignals`/`WatchSessions` (`:1242-1310`).
- 0.1.6 `SessionMetadata` fields: `context_id = 12`, `extension_keys = 13`;
  it does **not** expose the resolved `max_suspend_ms`.
- The npm proto package 0.1.3 (installed today) **already contains**
  `SessionStartPayload.context_id/extensions`, `SessionMetadata.context_id(12)/
  extension_keys(13)`, and the six-state `SessionLifecycleEvent.EventType`
  (verified in `node_modules/@multiagentcoordinationprotocol/proto/proto/macp/v1/core.proto:114,120,204,207,411-419`).
  What 0.1.3 lacks vs 0.1.6: `max_suspend_ms`, `HandoffAcceptPayload.implicit`,
  `ListSessions` pagination fields, and `macp/modes/multi_round/v1/multi_round.proto`.

---

## 2. Impact matrix

Legend: **IMPACT** = code/config/doc change required here; **NO IMPACT** = verified no change needed (with evidence); **FWD** = no change needed now, action queued behind an upstream implementation.

| # | Change | Verdict | Evidence in this repo | Required action |
|---|---|---|---|---|
| 1 | `ContributePayload` proto (0.1.4) | **IMPACT** | `src/runtime/proto-registry.service.ts:45-47` maps `ext.multi_round.v1/Contribute → '__json__'`; `:96-113` `decodeKnown` falls back to `tryDecodeUtf8`, which returns `{text, encoding:'text', payloadBase64}` for non-JSON bytes (`:138-147`). Proto-encoded Contribute bytes from new agents will decode as garbage text. `event-normalizer.service.ts:423` and `projection.service.ts` consume the decoded payload. | Bump proto; add `macp/modes/multi_round/v1/multi_round.proto` to the load list (`proto-registry.service.ts:58-66`); map `Contribute → 'macp.modes.multi_round.v1.ContributePayload'`. Keep JSON acceptance (decodeKnown's UTF-8 fallback) since the runtime accepts legacy JSON permanently. Normalize both paths to a `{value}` shape (JSON fallback currently wraps as `{json:{value}}` — projection helpers like `inferContributionAction` at `projection.service.ts:714-721` read top-level fields). Task T3. |
| 2 | `SessionStartPayload.max_suspend_ms` (0.1.5) | **IMPACT (minor)** | CP never sends `SessionStart` (observer). It *decodes* SessionStart envelopes via `MESSAGE_TYPE_MAP.__core__` (`proto-registry.service.ts:7`) — after the bump, `maxSuspendMs` appears in `message.received` decoded payloads automatically. Behavioral consequence (SUSPENDED→EXPIRED) is already safe: `WatchSessions 'expired'` → `handleSessionTerminal(…, 'failed')` (`session-discovery.service.ts:84-85`), and `suspended → failed` is a valid run transition (`src/storage/run.repository.ts:15`); per-session stream path handles `SESSION_STATE_EXPIRED` (`stream-consumer.service.ts:301-304`, `projection.service.ts:194-197`). `GetSession` cannot surface the resolved cap (not in 0.1.6 `SessionMetadata`). | Task T4: unit test the suspended→expired run path; optionally surface `maxSuspendMs` from the decoded SessionStart into the projection summary. No API change. |
| 3a | `HandoffAcceptPayload.implicit` (0.1.6) | **IMPACT (minor)** | HandoffAccept decode: `proto-registry.service.ts:36`; projection counts HandoffAccept as an `allow` contribution (`projection.service.ts:723-737`); normalizer lists it under `proposal.updated` (`event-normalizer.service.ts:421`). CP never *submits* accepts, so the client-side rejection rule can't bite. | Decode is automatic after the bump. Task T5: pass `implicit` through to the timeline/decision projection so UI can badge synthetic accepts; add a normalizer spec with `implicit: true`. |
| 3b | `ListSessions` pagination (0.1.6) | **FWD → IMPACT** | `rust-runtime.provider.ts:441-445` sends `{}` and maps `response.sessions`, ignoring `next_page_token`. Today `listSessions()` has **no production caller** (only the `RuntimeProvider` contract `src/contracts/runtime.ts:253` and the test mock) — nothing breaks. When the runtime implements capping, any future caller would silently see a truncated list. | Task T6: implement a page loop (`page_token` until `next_page_token` empty) now — harmless against v0.5.0 (returns empty token) and forward-correct. Update `RuntimeProvider` docs. |
| 4 | Passive-subscribe sequence contract | **IMPACT (critical path, mostly opportunity)** | `subscribeSession` writes `afterSequence: req.afterSequence ?? 0` (`rust-runtime.provider.ts:274-277`) and **no caller ever sets it**: `run-executor.service.ts:345` and `session-discovery.service.ts:138-141` omit it; crash recovery deliberately resubscribes `pollOnly: true` (`run-recovery.service.ts:123-131`). The persisted `lastStreamCursor` is the **CP-side canonical event seq**, not the envelope ordinal (`stream-consumer.service.ts:284-292`, `src/db/schema.ts:65`) — it must never be sent as `after_sequence`. On stream error the consumer degrades to a `GetSession` poll loop and never resubscribes (`stream-consumer.service.ts:158-223`), losing all subsequent envelope-level events for the run. There is **no message-id dedup** on ingest — every raw event gets a fresh seq (`run-event.service.ts:114-122`; `event.repository.ts` `onConflictDoNothing` only guards the `(runId, seq)` unique index, `schema.ts:96`), so re-subscribing from 0 would double-ingest the whole history. | The old inclusive/shifting-index semantics never hurt CP because it only ever subscribed from 0 at session-open. The subscribe-window duplicate fix silently *removes* a source of duplicate canonical events CP could not dedup — pure win. The new stable exclusive ordinal makes **true stream resume** implementable for the first time: Task T7 (the riskiest change — see §5): track delivered-envelope ordinals per run, resubscribe with `afterSequence = delivered count` on stream error instead of degrading to poll-only, and handle `FAILED_PRECONDITION` (compacted base) by falling back to poll-only + a `session.stream.gap` control event. |
| 5 | Watch-stream lag → `RESOURCE_EXHAUSTED`; WatchSessions initial-sync dup fix | **NO IMPACT (verify)** | Both watch consumers already reconnect on *any* stream error with a cancellable 5s sleep: `session-discovery.service.ts:53-67`, `signal-consumer.service.ts:57-72`. A previously-silent `end` also re-looped (`while (!this.aborted)`), so termination-instead-of-close only moves reconnection from "immediate" to "after 5s". Initial-sync `Created` duplicates were already tolerated via the `knownSessions` set + `findBySessionId` check (`session-discovery.service.ts:22,103-108`). `RESOURCE_EXHAUSTED` maps to 429 in `grpc-helpers.ts:144` (unary only — stream errors don't route through `mapGrpcError`). | Task T8 (test-only): integration assertion that a killed/`RESOURCE_EXHAUSTED` watch stream reconnects and resumes discovery. StreamSession-lag termination folds into T7. |
| 6 | `WatchSignals` requires authentication | **IMPACT** | `watchSignals` attaches resolver credentials (`rust-runtime.provider.ts:575-578`), but in dev-header mode the resolver sends only `x-macp-agent-id` (`runtime-credential-resolver.service.ts:52-54`) — which runtime v0.5.0 rejects unconditionally (see Context). Result: with `RUNTIME_USE_DEV_HEADER=true` (the dev default, `app-config.service.ts:61`) **every** gRPC call fails against a v0.5.0 runtime, and `SignalConsumerService` hot-loops reconnects every 5s. | Task T1: replace the dev-header fallback with `Authorization: Bearer ${runtimeDevAgentId}` (works with dev-mode any-bearer auth, and the sender identity becomes the token value). Deprecate `RUNTIME_USE_DEV_HEADER` (keep reading it but emit a deprecation warning, or repurpose it to gate the dev-bearer). Update `.env.example`, `README.md:96-108`, `CLAUDE.md` env table, `docker-compose.dev.yml:8-9`. |
| 7 | Six lifecycle states | **IMPACT (one gap)** | All six mapped on the watch path: provider enum translation `rust-runtime.provider.ts:479-490` (names + numeric ordinals matching 0.1.6 `EventType` 1–6, verified against `core.proto:431-439`); discovery routes all six (`session-discovery.service.ts:80-94`); type union `contracts/runtime.ts:214-221`; projection handles SUSPENDED/RESUMED/CANCELLED states (`projection.service.ts:159-216`). **Gap:** `StreamConsumerService` terminal detection checks only `SESSION_STATE_RESOLVED`/`SESSION_STATE_EXPIRED` — both in the poll fallback (`stream-consumer.service.ts:187-194`) and the `session.state.changed` handler (`:294-305`). A `CANCELLED` session leaves the consumer polling until retries exhaust → run marked **failed** instead of **cancelled**. Masked in default deployments because `SessionDiscoveryService` (`SESSION_DISCOVERY_ENABLED=true`) marks it cancelled first; unmasked when discovery is disabled. Pre-existing (cancelled state arrived with proto 0.1.3), but this release's "watchers must handle all six" contract is the right forcing function. | Task T10: handle `SESSION_STATE_CANCELLED` in both StreamConsumer paths (`finalizeRun` needs a `cancelled` variant → `runManager.markCancelled`); spec for each path. |
| 8 | JWT: HS256 removed from default allowlist; JWKS hardening | **NO IMPACT (docs only)** | CP's minted tokens are RS256 via auth-service (`runtime-credential-resolver.service.ts:12-13`, README "Runtime auth" table). CP never configures the runtime's JWT algs. JWKS timeout/stale-grace/kid-selection are runtime-internal. | Doc note in T2: deployments that pointed `MACP_AUTH_JWT_ALGS=HS256` at the runtime must opt in explicitly; no CP change. |
| 9 | Dev mode: runtime refuses to start w/o `MACP_ALLOW_INSECURE=1`; Docker image no longer bakes it | **IMPACT (config/docs)** | `docker-compose.test.yml:26` already sets `MACP_ALLOW_INSECURE: '1'` explicitly — safe. `:27` sets `MACP_ALLOW_DEV_SENDER_HEADER: '1'` — a dead env var in v0.5.0, remove. `README.md:101` tells developers to start the runtime with `MACP_ALLOW_DEV_SENDER_HEADER=1` — stale. `docker-compose.yml`/`docker-compose.dev.yml` don't run the runtime (they point at `host.docker.internal:50051`) — anyone following older habits of running the published image without env will now get a startup refusal; document it. | Task T2 (docs/compose) + T1 (auth fallback). |
| 10 | Commitment `policy_version` empty matches bound policy | **NO IMPACT** | CP never emits `Commitment` (observer invariant, `rust-runtime.provider.ts:52-66`; no `Send` exists). Its cosmetic default `policyVersion \|\| 'policy.default'` for run records (`run-manager.service.ts:158,192`) remains accurate — the runtime still *resolves* empty to the default policy; only the echo requirement was relaxed for agents. | None. Optional doc note for agent authors in `docs/INTEGRATION.md`. |
| 11 | Task mode: external orchestrator allowed | **NO IMPACT** | CP performs no initiator-membership validation: `validate()` checks participants non-empty + mode supported only (`run-executor.service.ts:62-116`); projection adds unseen senders dynamically (`event-normalizer.service.ts:165-177`). An initiator outside `participants` just appears as another participant node. | None. Optional fixture in T10 exercising an orchestrator-not-in-pool task run against the live runtime. |
| 12 | Quorum policy: `threshold` strictly approval bar; `percentage` integer 0–100 | **NO IMPACT (verify docs/tests)** | Policy rules pass through opaque (`runtime.controller.ts:99-107` sends `Buffer.from(JSON.stringify(body.rules))`). CP's semantic pre-checks touch only decision-mode `voting` and `commitment.authority` shapes (`runtime.controller.ts:83-97`) — no quorum threshold/percentage logic. `test/integration/policy.integration.spec.ts:76-78` registers decision-mode rules only. | Sweep `docs/API.md` §policies for any quorum example using fractional percentage (none found; it defers to `macp-runtime/docs/policy.md`). No code change. |
| 13 | Extension-mode hardening (terminal Commitment, PromoteMode namespace, empty mode_version binding) | **NO IMPACT** | CP has no `RegisterExtMode`/`PromoteMode` calls (grep of `src/` — provider surface is `contracts/runtime.ts:229-272`). Session discovery uses `session.modeVersion ?? '1.0.0'` for its local descriptor (`session-discovery.service.ts:198`); with the runtime now binding the registered descriptor version for empty-`mode_version` ext sessions, `GetSession` metadata carries a real version — strictly better data. | None. |
| 14 | `Initialize` capabilities: roots `list_changed:false`; read-only policy registry under `MACP_POLICIES_DIR` | **IMPACT (minor)** | CP already declares `roots: { listRoots: true, listChanged: false }` in its client capabilities (`rust-runtime.provider.ts:154`). It stores the runtime's response capabilities on the session (`run-executor.service.ts:333-342` → `run-manager.service.ts:162`). Against a read-only registry, `POST /runtime/policies` → runtime `FAILED_PRECONDITION` → `mapGrpcError` → HTTP **409 CONFLICT** (`grpc-helpers.ts:138`) — misleading for "registry is read-only". | Task T9: in `runtime.controller.ts` register/unregister paths, detect `capabilities.policyRegistry.registerPolicy === false` (from `Initialize`) or the FAILED_PRECONDITION message and return a clearer 405/`REGISTRY_READ_ONLY` AppException. Low priority. |
| 15 | Prometheus endpoint via `MACP_METRICS_ADDR` | **NO IMPACT (ops opportunity)** | CP has its own prom-client `/metrics` (`src/telemetry/instrumentation.service.ts`, `@Public()` metrics controller). Nothing scrapes the runtime. | T2: document scraping the runtime's `MACP_METRICS_ADDR` next to CP metrics; optionally expose `9464` in `docker-compose.test.yml` for local debugging. |
| 16 | New/changed runtime env vars; graceful shutdown drains streams | **NO IMPACT (verify)** | CP reads no `MACP_*` runtime env vars (its `MACP_AUTH_*` vars are auth-service knobs, `app-config.service.ts:72-84`). Runtime shutdown cutting long-lived watch streams lands in the existing reconnect loops (item 5) and, for per-session streams, in the T7 resubscribe path. The runtime's `Server::builder().timeout(MACP_REQUEST_TIMEOUT_SECS)` (`macp-runtime/src/main.rs:348-356`) is a per-request layer; long-lived streams returning their response stream promptly are not killed at 30s (tonic timeout applies to producing the response, not draining the body) — verify empirically in T11 by holding a WatchSessions stream >30s against the v0.5.0 image. | None beyond T11 verification. |
| 17 | 36-char base64url session IDs containing `-` | **NO IMPACT** | CP's validator is already permissive: `^[A-Za-z0-9_-]{22,}$` (`run-executor.service.ts:22-29`) accepts them; previously the **runtime** rejected such caller-supplied IDs at SessionStart. Now CP-validated IDs and runtime-accepted IDs agree. The mirror comment cites `runtime/src/session.rs:146-177` — stale path (now `crates/macp-core/src/session.rs`). | Fix the comment path; add one `validate()` spec case with a 36-char base64url id containing `-` (T10). |
| 18 | Embedder surface (`MacpServer`, `with_policy_engine`, 7 crates @ 0.5.0) | **NO IMPACT** | CP is TypeScript-over-gRPC; it consumes no Rust crates (no Cargo manifest in repo). | None. |
| 19 | Conformance fixtures single-source (`schemas/conformance/`) | **NO IMPACT** | CP's fixtures are hand-written TS mock scripts (`test/fixtures/*.ts` driving `ScriptedMockRuntimeProvider`), not spec-repo JSON conformance vectors; no transcript replay against fixtures (grep `conformance` → no hits in `src`/`test`). The `payload_type` naming convention (fully-qualified) already matches `MESSAGE_TYPE_MAP` values (`proto-registry.service.ts:12-47`). | None. Optional future work (out of scope): generate mock scripts from the spec vectors. |
| 20 | Upcoming: runtime-emitted synthetic handoff accepts in history | **FWD** | When the runtime ships the RFC-0010 §5.1 timer, `StreamSession` will deliver a HandoffAccept envelope with `sender = target_participant`, `implicit: true`, `message_id = implicit-accept:<handoff_id>`, `timestamp = computed deadline`. CP's pipeline treats it as a normal envelope: `participant.seen` for the sender is correct (target is a real participant); canonical `ts` uses `receivedAt`, not the (possibly past) envelope timestamp (`event-normalizer.service.ts:19`, `grpc-helpers.ts:26`); projection counts it as an `allow` contribution (`projection.service.ts:723-737`). Synthetic accepts are accepted-history entries, so they count toward the T7 envelope ordinal — in-stream counting handles this for free. | T5 covers the rendering side (badge `implicit`); nothing else until the runtime ships the timer. Re-verify with T11 once released. |
| 21 | Docker image at ghcr for v0.5.0; Dockerfile no longer copies dev env | **IMPACT (test infra)** | `docker-compose.test.yml:19-24` builds the runtime from `../macp-runtime` source — CI/dev runs test against whatever is checked out, not the release. `MACP_ALLOW_INSECURE=1` is already explicit (`:26`), which is exactly what the de-baked image requires. Healthcheck expects `/bin/grpc_health_probe` in the image (`:30-34`). | Task T2: pin the test runtime to `ghcr.io/multiagentcoordinationprotocol/macp-runtime:v0.5.0` (keep a `build:` override profile for local runtime hacking); verify `grpc_health_probe` still exists in the published image, else switch the healthcheck. Remove the dead `MACP_ALLOW_DEV_SENDER_HEADER`. |
| 22 | Spec: `SessionStartPayload.context_id` + `extensions`; old `context` bytes gone | **IMPACT (latent gap, not a 0.1.3→0.1.6 delta)** | The installed 0.1.3 proto already has `context_id=8`/`extensions=9` — no wire change from the bump. But the repo has a **dangling consumer**: `projection.service.ts:176-181` reads `event.data.contextId`/`extensionKeys` (typed at `contracts/control-plane.ts:235-236`) and **nothing produces them**: `fromSessionMetadata` drops `SessionMetadata.context_id(12)`/`extension_keys(13)` (`grpc-helpers.ts:78-90`), the `session-snapshot` normalizer emits neither (`event-normalizer.service.ts:39-58`), and `session.bound` data omits them (`run-manager.service.ts:182-196`). No CP reference to a legacy SessionStart `context` bytes field exists (the `HandoffContextPayload.context` bytes field is a different message and unchanged). | Task T4b: map `contextId`/`extensionKeys` through `fromSessionMetadata` → `RuntimeSessionSnapshot` → `session-snapshot`/`session.bound` events so the existing projection fields light up. |

---

## 3. Work plan

Effort scale: S ≤ ½ day, M ≈ 1–2 days, L ≈ 3–5 days. Every task lists a definition of done (DoD) and its test.

### Slice 1 — unbreak dev/test against v0.5.0 (no proto bump needed)

**T1. Replace the dev-header credential fallback with a dev bearer** — **M**
- `src/runtime/runtime-credential-resolver.service.ts:50-54`: when neither JWT
  mint nor `RUNTIME_BEARER_TOKEN` is available and dev fallback is enabled,
  send `authorization: Bearer ${this.config.runtimeDevAgentId}` instead of
  `x-macp-agent-id`. Rationale: runtime v0.5.0 has no dev-header path; its
  dev-mode auth accepts any bearer and uses the token value as the sender, so
  the CP keeps its `macp-control-plane` identity.
- `src/config/app-config.service.ts:61`: keep `RUNTIME_USE_DEV_HEADER` as the
  gate but log a deprecation warning naming the new behavior; update the
  production fail-fast message at `:142-144` (it references the dev header).
- Update `.env.example` (dev-header block), `README.md:96-108`, `CLAUDE.md`
  env table + "Runtime credential chain" bullet, `docs/ARCHITECTURE.md`
  credential-resolution section, `docs/TROUBLESHOOTING.md:57`.
- DoD: with a local v0.5.0 runtime started as `MACP_ALLOW_INSECURE=1 cargo run`
  (no tokens configured), `npm run start:dev` boots and `GET /runtime/health`
  returns `ok: true`; `SignalConsumerService` holds a live WatchSignals stream
  (no 5s reconnect churn in logs).
- Tests: update `runtime-credential-resolver.service.spec.ts` (dev fallback
  emits bearer, not header); the live check is part of T11.
- Risk: any deployment that relied on the runtime *accepting* `x-macp-agent-id`
  was already broken by upstream; this only changes the fallback of last resort.
  Static-bearer and JWT modes are untouched.

**T2. Compose/docs alignment for v0.5.0** — **S**
- `docker-compose.test.yml`: pin `runtime:` to
  `image: ghcr.io/multiagentcoordinationprotocol/macp-runtime:v0.5.0` (retain
  the `build: ../macp-runtime` variant under a distinct profile, e.g.
  `with-runtime-src`, for runtime development); delete
  `MACP_ALLOW_DEV_SENDER_HEADER`; keep `MACP_ALLOW_INSECURE: '1'` (now
  mandatory); verify the image still ships `/bin/grpc_health_probe`, else
  change the healthcheck to a `grpcurl`/TCP probe.
- `README.md:101`: replace the `MACP_ALLOW_DEV_SENDER_HEADER=1` instruction
  with `MACP_ALLOW_INSECURE=1` only + the new dev-bearer story from T1; note
  that the published runtime image no longer bakes `MACP_ALLOW_INSECURE`.
- `docs/INTEGRATION.md:11-13`: document the new `after_sequence` contract
  (1-based, exclusive, stable across compaction; `FAILED_PRECONDITION` below
  compacted base), watch-stream `RESOURCE_EXHAUSTED` lag termination, and the
  WatchSignals auth requirement.
- Add an ops note (README or docs/ARCHITECTURE.md): runtime metrics via
  `MACP_METRICS_ADDR`; HS256 opt-in via `MACP_AUTH_JWT_ALGS` for shared-secret
  deployments.
- DoD: `INTEGRATION_RUNTIME=docker npm run test:integration:docker` passes
  against the pinned v0.5.0 image.
- Test: the integration suite itself; plus `docker compose -f
  docker-compose.test.yml --profile with-runtime config` sanity.
- Risk: ghcr image pull needs network/credentials in CI; keep the source-build
  profile as fallback.

### Slice 2 — proto bump and decode coverage

**T3. Bump `@multiagentcoordinationprotocol/proto` to `^0.1.6` + multi-round proto decode** — **M**
- `package.json:26` → `^0.1.6`; `npm install` refreshes the lockfile (registry
  `npm.pkg.github.com` per `.npmrc`; Dockerfile's `NPM_TOKEN` flow unchanged).
- `src/runtime/proto-registry.service.ts`:
  - add `path.join(protoRoot, 'macp/modes/multi_round/v1/multi_round.proto')`
    to the load list (`:58-66`);
  - change `'ext.multi_round.v1': { Contribute: '__json__' }` (`:45-47`) to
    `Contribute: 'macp.modes.multi_round.v1.ContributePayload'`. `decodeKnown`
    already falls back to UTF-8/JSON when proto decode throws (`:105-113`) —
    the runtime keeps accepting legacy JSON permanently, so both encodings must
    keep working here. Normalize the JSON-fallback shape: unwrap
    `{json: {value}}` → `{value}` for Contribute so downstream projection sees
    one shape (guard: protobufjs `decode` on JSON bytes generally throws, but
    add an explicit sanity check that a decoded Contribute has a string
    `value`, else use the JSON fallback).
- Confirm `rust-runtime.provider.ts:108-122` (`loadSync`) needs no new files
  (service defs live in `core.proto`; mode payloads never pass through
  proto-loader).
- DoD: `npm test` green; a new `proto-registry.service.spec.ts` case decodes a
  protobuf-encoded `ContributePayload` and a legacy JSON `{"value":"..."}` to
  the same `{value}` shape; no `proto types not found` warning at boot
  (`proto-registry.service.ts:91-93`).
- Test: unit specs above + boot the app once against 0.1.6 (proto-loader parse
  errors surface at `onModuleInit`).
- Risk: low. proto3 field additions are wire-compatible; `keepCase: false`
  camelCases new fields consistently with existing handling.

**T4. max_suspend_ms + suspended-expiry behavior coverage** — **S**
- No production code required for safety (see matrix #2). Add:
  - `session-discovery.service.spec.ts`: `suspended` run receiving `expired`
    lifecycle event → `markFailed` (exists? verify; add if missing).
  - Optionally extract `maxSuspendMs` from decoded SessionStart in
    `projection.service.ts` (`message.received`, `messageType === 'SessionStart'`
    branch at `:281+`) into `run` summary for UI.
- DoD: specs green; decision documented in this plan's revision log if the
  projection surfacing is deferred.

**T4b. Wire `contextId` / `extensionKeys` end-to-end** — **S**
*(No proto bump required — the installed 0.1.3 package already carries
`SessionMetadata.context_id/extension_keys`; may land in slice 1 if convenient.)*
- `src/runtime/grpc-helpers.ts:78-90` `fromSessionMetadata`: map
  `metadata.contextId` (field 12) and `metadata.extensionKeys` (field 13) into
  `RuntimeSessionSnapshot` (extend `contracts/runtime.ts:85-95`).
- `event-normalizer.service.ts:39-58` (`session-snapshot`) and
  `run-manager.service.ts:182-196` (`session.bound` data): include both fields
  so `projection.service.ts:176-181` finally receives them.
- DoD: projection spec proving a snapshot with `contextId` populates
  `state.run.contextId`; works against live runtime (agent starts a session
  with `context_id` set — T11 scenario).

**T5. Handoff `implicit` passthrough + synthetic-accept readiness** — **S**
- Decode is automatic post-T3. In `projection.service.ts` handoff contribution
  handling (`:723-737` and the timeline entries), carry
  `decodedPayload.implicit === true` through to the contribution/timeline
  record (e.g. `implicit: true`) so the console can badge runtime-emitted
  accepts; treat `message_id` prefix `implicit-accept:` as corroboration only.
- DoD: normalizer/projection specs for a HandoffAccept with `implicit: true`
  (sender = target participant); no behavioral change for `implicit: false`.
- Risk: none now (runtime timer not shipped); this makes CP forward-ready per
  inventory item 20.

**T6. `listSessions` pagination loop** — **S**
- `rust-runtime.provider.ts:441-445`: loop `ListSessions({pageSize: 0, pageToken})`
  until `next_page_token` is empty; concatenate. Cap iterations (e.g. 50) to
  guard against a buggy server. Update the mock provider signature if needed.
- DoD: provider spec with a stubbed client returning two pages; against
  v0.5.0 (no pagination yet) behavior is identical to today.

### Slice 3 — the stream-resume upgrade (riskiest, see §5)

**T7. Envelope-ordinal tracking + resubscribe-on-error** — **L**
- See §5 for the expanded design, DoD, and tests.

**T8. Watch-stream lag/termination integration tests** — **S**
- Extend `test/integration/observer-mode.integration.spec.ts` (or a new spec)
  with a scripted-mock stream that errors with a `RESOURCE_EXHAUSTED`-shaped
  error mid-stream, asserting SessionDiscovery/SignalConsumer reconnect and
  continue; plus a live-runtime tier (T11) case.
- DoD: specs green in mock mode; documented live behavior.

### Slice 4 — polish

**T9. Read-only policy registry UX** — **S**
- `runtime.controller.ts` register/unregister: when the runtime's `Initialize`
  capabilities carry `policyRegistry.registerPolicy === false` (available via
  `provider.initialize` — cache on first use) or the gRPC error is
  `FAILED_PRECONDITION` with the read-only message, return
  `AppException(ErrorCode.REGISTRY_READ_ONLY, …, 405)` (new error code) instead
  of the generic 409 from `grpc-helpers.ts:138`.
- DoD: controller spec; live check against a runtime started with
  `MACP_POLICIES_DIR` (T11 optional scenario).

**T10. Small correctness sweeps** — **S/M**
- **Handle `SESSION_STATE_CANCELLED` in StreamConsumer** (matrix #7 gap):
  extend `finalizeRun` (`stream-consumer.service.ts:96-119`) with a
  `'cancelled'` outcome → `runManager.markCancelled`, and check the state in
  both the poll fallback (`:187-194`) and the `session.state.changed` handler
  (`:294-305`). Spec: scripted snapshot/state-change with CANCELLED finalizes
  the run as cancelled, not failed.
- `run-executor.service.ts:20-21`: fix the stale mirror-comment path
  (`crates/macp-core/src/session.rs`); add validate() spec for a 36-char
  base64url session id containing `-`.
- Optional live fixture: task-mode session whose initiator is not in
  `participants` (external orchestrator), asserting discovery + projection
  sanity (matrix #11).
- Sweep docs for quorum `percentage` examples (matrix #12) — none found at
  planning time; re-verify at PR time.

**T11. Live-runtime verification pass** — **M** (gates the release of every slice)
- Environment: pinned `ghcr.io/...:v0.5.0` via `docker compose -f
  docker-compose.test.yml --profile with-runtime up`, plus a Python agent from
  `macp-playground` (or the runtime's `src/bin` example clients) to drive real
  sessions, since CP is observer-only and cannot generate traffic itself.
- Checklist:
  1. `INTEGRATION_RUNTIME=docker npm run test:integration:docker` — full suite.
  2. Dev-auth: T1 bearer fallback works (`/runtime/health` ok; WatchSignals
     stays connected; runtime logs show dev-mode warning).
  3. Multi-round: agent emits proto `Contribute`; `GET /runs/:id/events` shows
     decoded `{value}`; repeat with a legacy JSON-emitting agent (older SDK).
  4. Stream resume (T7): start a decision session, kill the CP↔runtime TCP
     connection (e.g. `docker network disconnect`) mid-session, reconnect, and
     assert no duplicate and no missing `message.received` events vs the
     runtime's own history (compare against `GetSession` + a fresh
     subscribe-from-0 in a scratch client).
  5. Lifecycle: suspend → resume → cancel; suspended-until-expiry (short
     `max_suspend_ms` via agent SessionStart) → run marked failed.
  6. Watch streams survive a runtime restart (drain + reconnect) and >30s idle.
  7. Handoff with `implicit_accept_timeout_ms` policy — today the commitment
     path; when the runtime timer ships, re-run to see the synthetic accept
     envelope render with the T5 badge.
- DoD: checklist recorded in the PR description with outcomes.

---

## 4. Sequencing / dependencies

```
now (no upstream deps):        T1, T2, T8, T9, T10
now, no proto bump needed:     T4b (installed 0.1.3 already has SessionMetadata.context_id/extension_keys)
needs proto ^0.1.6 (published; bump in T3):  T3 → T4, T5, T6
after T3, independent of upstream:           T7 (uses only the v0.5.0 sequence contract)
waits on runtime implementations (queued upstream):
  - ListSessions server-side capping   → T6 already forward-correct; nothing further
  - handoff synthetic-accept timer     → T5 renders it when it arrives; re-run T11.7
  - MACP_POLICIES_DIR read-only detect → T9 works today via FAILED_PRECONDITION; capability
                                         detection already possible (v0.5.0 advertises register_policy:false)
```

Mergeable slices, in order:
1. **Slice 1 (T1+T2)** — restores a working dev/test loop against v0.5.0. No
   proto bump. Ship first.
2. **Slice 2 (T3+T4+T4b+T5+T6)** — proto bump + decode coverage. Depends on
   nothing but the published 0.1.6 package.
3. **Slice 3 (T7+T8)** — stream resume. Depends on slice 1 (test env) only;
   logically independent of the proto bump but rebases cleanest after slice 2.
4. **Slice 4 (T9+T10)** — anytime after slice 1.
5. **T11** runs per-slice (subset) and in full before declaring absorption done.

Interim option if the GH-Packages 0.1.6 install is blocked in CI: `npm run
dev:link-protos` (`package.json:23`) links the spec repo's `packages/proto-npm`
(whose proto files already match 0.1.6 content; note its `package.json` still
says `0.1.3` locally — do not rely on the version string).

---

## 5. Riskiest change expanded: T7 stream resume

### Why it's the riskiest
It touches the core read loop that feeds every downstream artifact (events,
projections, metrics, webhooks, SSE), and a wrong ordinal produces silent data
corruption: duplicates (ordinal too low — and CP has **no message-id dedup**,
`run-event.service.ts:114-122`) or gaps (ordinal too high).

### Design
1. **Count, don't reuse `lastStreamCursor`.** Add `lastEnvelopeOrdinal`
   (integer, default 0) to `runtime_sessions` (new drizzle migration; column
   alongside `last_stream_cursor`, `src/db/schema.ts:65`). It counts accepted
   envelopes **delivered on the per-session StreamSession** for this run — the
   1-based ordinal of the last envelope processed. Ambient WatchSignals
   envelopes (`signal-consumer.service.ts`) never increment it (they are not
   session history). Inline errors, stream-status, and session-snapshots don't
   increment it.
2. **Increment in the stream consumer**, not the provider:
   `stream-consumer.service.ts.handleRawEventInner` increments the marker's
   ordinal for `raw.kind === 'stream-envelope'` events *from the session
   handle* (the consumer only ever receives session-stream envelopes there;
   signal ingestion goes through `SignalConsumerService` directly, bypassing
   `StreamConsumerService`). Persist it in the same
   `updateStreamCursor`-style write (`runtime-session.repository.ts:47`,
   extended or a sibling method), transactionally alongside event persistence
   if practical.
3. **Resubscribe instead of poll-degrade.** In `consumeLoop`
   (`stream-consumer.service.ts:151-167`), on stream error/end while the run is
   non-terminal: loop `provider.subscribeSession({runId, runtimeSessionId,
   afterSequence: marker.envelopeOrdinal})` with the existing
   `backoffMs(retries)` jitter and `streamMaxRetries` budget, resetting the
   retry counter on successful reconnect + first event. Keep the poll loop as
   the final fallback once retries are exhausted (preserves today's terminal
   detection).
4. **Handle `FAILED_PRECONDITION` (compacted base).** Surface from the stream
   `error` event (grpc code 9). Do **not** resubscribe from 0 (would
   double-ingest). Emit a `session.stream.gap` control-plane event with
   `{requestedAfter, detail}`, then fall back to poll-only for the run, and
   mark the projection with a `historyGap: true` flag (UI hint). Runtime-side,
   mid-session compaction only occurs when `MACP_CHECKPOINT_INTERVAL > 0`, so
   this is rare.
5. **Recovery path upgrade (optional, same PR or follow-up).**
   `run-recovery.service.ts:121-131` can switch from `pollOnly: true` to
   `afterSequence: session.lastEnvelopeOrdinal` once (2) persists reliably —
   restoring full event flow after CP restarts. Gate behind a config flag
   (`STREAM_RESUME_ENABLED`, default true; false restores current behavior).
6. **Mock parity.** Extend `ScriptedMockRuntimeProvider.subscribeSession`
   (`test/helpers/scripted-mock-runtime.provider.ts:97+`) to honor
   `afterSequence` by skipping the first N scripted envelopes, so integration
   tests can script kill-and-resume.

### Definition of done
- Unit: ordinal increments only for session-stream envelopes; resubscribe uses
  the persisted ordinal; FAILED_PRECONDITION path emits `session.stream.gap`
  and degrades to poll-only; retries budget respected.
- Integration (mock): scripted stream that errors after N envelopes, then
  serves the remainder on resubscribe — canonical events contain each
  message exactly once, in order.
- Integration (live, T11.4): TCP-cut mid-session against the v0.5.0 image; CP
  reconnects and the run's `message.received` set equals the runtime history
  (no dupes/gaps).
- Metrics: reuse `streamReconnectsTotal` (`stream-consumer.service.ts:202`) and
  add a `stream_resume_gap_total` counter via `InstrumentationService`.

### Rollback note
All slices are additive and independently revertible:
- T7 ships behind `STREAM_RESUME_ENABLED`; setting it false restores the
  current poll-degrade behavior without code rollback. The new DB column is
  nullable/default-0 and harmless if unused. Reverting the PR is also safe —
  no data migration is destructive (column stays, ignored).
- T3 (proto bump) rollback = revert `package.json`/lockfile; 0.1.6 is
  wire-compatible with 0.1.3 so a rollback only re-loses the new fields.
- T1 rollback re-enables the dev-header fallback — only affects dev
  environments (production uses JWT/static bearer).
- T2 keeps a source-build compose profile so the pinned image can be bypassed
  instantly.

---

## 6. Open questions / could-not-map-confidently

- **Runtime request-timeout vs long-lived streams** (item 16): tonic's
  `Server::builder().timeout(30s)` should not cut an established stream, and
  CP's own watches ran fine against 0.4.x, but this is asserted from tower/tonic
  semantics, not from a v0.5.0 empirical check. T11.6 verifies.
- **`grpc_health_probe` in the published v0.5.0 image** (T2): not verified
  from this repo; check at implementation time.
- **Whether session-scoped `Progress` envelopes can arrive on both
  `StreamSession` and `WatchSignals`** (affects T7 ordinal correctness only if
  a signal-bus envelope were counted — the design avoids counting them
  entirely, but double-*ingestion* of a session-scoped Progress via both buses
  would create duplicate canonical events today already; pre-existing behavior,
  out of scope here). Flagged for a follow-up audit.

---

## Implementation note (2026-07-06)

All code/config/doc tasks landed; full unit suite green (676 tests, 48 suites),
`nest build` clean, `eslint --max-warnings=0` clean, CI convention greps clean.

Per-task outcomes:
- **T1** dev-bearer fallback + config deprecation/fail-fast + docs (README, ARCHITECTURE, INTEGRATION, TROUBLESHOOTING, CLAUDE.md, .env.example). Specs updated.
- **T2** `docker-compose.test.yml` pinned to `ghcr.io/...:v0.5.0` with a `with-runtime-src` build-from-source profile; dead `MACP_ALLOW_DEV_SENDER_HEADER` removed; INTEGRATION.md `after_sequence` contract + watch-lag + WatchSignals-auth notes; ARCHITECTURE ops section (metrics/HS256/insecure).
- **T3** `package.json` → `^0.1.6`; `multi_round.proto` added to the load list; `Contribute → ContributePayload` with JSON/proto both normalized to `{value}`. New `proto-registry.contribute.spec.ts` (real protobufjs).
- **T4/T4b** suspended→expired spec; `contextId`/`extensionKeys` wired `fromSessionMetadata` → snapshot → `session-snapshot`/`session.bound` → projection; specs.
- **T5** `implicit` HandoffAccept passthrough → `DecisionProposalContribution.implicit`; normalizer + projection specs.
- **T6** `listSessions` pagination loop (`next_page_token`), 50-page cap; provider specs.
- **T7** `runtime_sessions.last_envelope_ordinal` (migration `0016`); ordinal counting in the stream consumer; resubscribe-on-error from the persisted ordinal; `FAILED_PRECONDITION` → `session.stream.gap` + `historyGap` + poll-only; `STREAM_RESUME_ENABLED` flag; `macp_stream_resume_gap_total` metric; mock `afterSequence` parity; 4 unit tests. `run-recovery` kept `pollOnly` per Pass-3 decision.
- **T8** deterministic unit test for RESOURCE_EXHAUSTED watch-stream reconnect in SessionDiscovery (fast-forwards the 5s backoff). A full `test/integration` variant still needs the test DB + a scripted-mock mid-stream error and is left for the live pass.
- **T9** `ErrorCode.REGISTRY_READ_ONLY` (405); provider caches Initialize capabilities; controller short-circuits + translates FAILED_PRECONDITION read-only rejections; specs.
- **T10** `SESSION_STATE_CANCELLED` handled in both StreamConsumer paths (`markCancelled`); stale mirror-comment path fixed; 36-char base64url session-id validate spec; quorum-percentage doc sweep (none found).
- **T11** live-runtime checklist NOT run here — requires the pinned `ghcr.io/...:v0.5.0` image + Postgres (5433) + a Python agent to generate traffic. Must be executed before declaring absorption done.

**Environment caveat (lockfile):** GH Packages returned `401` in this session, so
`npm install` could not refresh `package-lock.json` (still pins 0.1.3) — the
local `packages/proto-npm` 0.1.6-content was linked into `node_modules` for
validation. Before merge, run `npm install` in a GH-Packages-authed environment
(`NODE_AUTH_TOKEN`) to regenerate the lockfile against the published 0.1.6.

## Revision log

### Pass 1 — completeness (inventory re-walk + repo sweep)
Re-walked items 1–22 against the matrix and re-grepped runtime-facing surfaces
(`grep` for gRPC method names, `process.env` reads, docker services, hardcoded
versions, reconnect/sequence logic, auth wiring). Added in this pass:
- **T4b / item 22**: the dangling `contextId`/`extensionKeys` projection
  consumer (`projection.service.ts:176-181`) with no producer — found by
  sweeping `fromSessionMetadata` against the 0.1.6 `SessionMetadata` fields.
- **Item 5 nuance**: previously-silent watch-stream closes re-looped *without*
  the 5s sleep (normal `for await` completion skips the `catch`); the v0.5.0
  error-termination actually adds backoff. Matrix wording updated.
- **T2 addition**: `docs/INTEGRATION.md:11-13` documents the *old*
  `afterSequence` semantics ("default 0 = full replay") — needs the new
  contract text.
- **Mock-parity requirement** in T7 (ScriptedMockRuntimeProvider ignores
  `afterSequence` today — tests would pass vacuously without it).
- Confirmed no additional gRPC calls exist beyond the provider surface
  (`getClientMethod` call sites are all in `rust-runtime.provider.ts`), and no
  `RegisterExtMode`/`PromoteMode`/`WatchModeRegistry`/`WatchRoots` usage —
  those runtime changes are no-impact and are covered by matrix rows 13/14.
- **Matrix row 7 upgraded from NO IMPACT to IMPACT**: sweeping "stream
  reconnect / terminal-state logic" surfaced that `StreamConsumerService`
  finalizes runs only on RESOLVED/EXPIRED (`stream-consumer.service.ts:187-194,
  294-305`) — a CANCELLED session observed without SessionDiscovery ends the
  run as `failed`. Added the fix to T10.
- Verified every inventory item has a matrix row: 1,2,3(a/b),4,5,6,7,8,9,10,
  11,12,13,14,15,16,17,18,19,20,21,22 — none skipped.

### Pass 2 — adversarial verification (every file:line claim re-read)
Corrections made:
- `rust-runtime.provider.ts` lifecycle mapping is at `:479-490` (initially
  cited 483-490; the comment block starts at 479) — fixed.
- `run-event.service.ts` — the no-dedup claim originally cited `:92-133`
  (whole method); narrowed to `:114-122` (seq allocation + insert), and
  cross-checked `event.repository.ts` `onConflictDoNothing` (`:40`, `:67`)
  guards only the `(runId, seq)` unique index (`schema.ts:96`) — claim stands.
- Verified `package.json:26` (`^0.1.3`), lockfile resolution to GH Packages
  0.1.3, and `npm view … versions` listing 0.1.6 — version claims confirmed.
- Verified the runtime-side claims by reading `macp-runtime` source at tag
  v0.5.0-era HEAD: dev-header absence (`crates/macp-auth/src/security.rs`
  `authenticate_metadata`), `MACP_ALLOW_DEV_SENDER_HEADER` read nowhere,
  compaction error text (`src/server.rs:512-518`), StreamSession lag →
  `RESOURCE_EXHAUSTED` (`src/server.rs:670-674`), `SecurityLayer::from_env`
  JWT alg default (RS256/ES256).
- Checked the spec repo's local `packages/proto-npm/package.json` still says
  `0.1.3` while its proto *content* matches 0.1.6 — added the caveat to §4's
  interim `dev:link-protos` note (don't trust the local version string).
- Removed an earlier draft claim that `mapGrpcError` handles stream errors —
  stream `error` events bypass `unary()`/`mapGrpcError`; matrix row 5 and T7
  step 4 now say the FAILED_PRECONDITION must be detected from the raw grpc
  code on the stream error object.
- Re-confirmed EventType ordinals 1–6 identical in installed 0.1.3 and 0.1.6
  protos (`core.proto` enum blocks).
- **T4b de-coupled from the proto bump**: re-reading the *installed* 0.1.3
  `core.proto` showed `SessionMetadata.context_id(12)/extension_keys(13)` are
  already present (`node_modules/.../core.proto:204,207`) — T4b moved to the
  "can land now" group in §4; task header annotated.
- Fixed off-by-a-few line citations found on re-read:
  `projection.service.ts:723-737` (was 724-737, `inferContributionVote` starts
  at 723), `projection.service.ts:194-197` (EXPIRED branch, was 193-196), and
  `run-manager.service.ts:182-196` (`session.bound` event incl. `type:` line
  at 182, was 184-196).

### Pass 3 — executability
- Reordered work into four mergeable slices with an explicit "ship slice 1
  first" call (dev/test loop is broken against v0.5.0 until T1/T2 land — the
  highest operational urgency despite proto work looking more central).
- Gave every task a DoD + named test; T11 turned into a numbered live
  checklist that doubles as the per-slice gate.
- Identified T7 as the single riskiest change and expanded it into a 6-point
  design with duplicate/gap failure-mode analysis, the
  ambient-vs-session-envelope counting hazard, mock parity, and a
  `STREAM_RESUME_ENABLED` kill switch.
- Added the rollback section (per-slice revert story; T7 flag-gated; proto
  bump wire-compatible both ways).
- Moved `run-recovery` resume (T7 step 5) to "optional / may follow up" to keep
  slice 3 reviewable; recovery keeps `pollOnly` until the ordinal column has
  soaked in production.
