#!/usr/bin/env bash
# Boots a token-authenticated macp-runtime container for the live integration specs
# (describeWithAuthedRuntime: decision-receipt-live, what-if-replay-live). Used by CI's
# `live-runtime` job and runnable locally:
#
#   test/scripts/start-live-runtime.sh <signed|unsigned> [port] [config-dir]
#
# It prints the env the live specs need (and appends it to $GITHUB_ENV under Actions, so the CI
# job never restates the runtime id or kid): `export` those lines, then run the specs with
#   INTEGRATION_RUNTIME=remote RUNTIME_ADDRESS=127.0.0.1:<port> npx jest -c test/jest.integration.config.ts \
#     test/integration/decision-receipt-live test/integration/what-if-replay-live
# Clean up locally with `docker rm -f macp-live-runtime-<leg>` and remove <config-dir>.
#
# The signed leg generates a throwaway Ed25519 key in <config-dir>: a test fixture, never a deploy
# key. MACP_RUNTIME_ID is set on both legs (required with a key; names the receipt issuer).
# MACP_COMPACT_TERMINAL_LOGS=0 keeps resolved histories, so run what-if-replay-live with the same
# MACP_COMPACT_TERMINAL_LOGS=0 to expect its diff.
set -euo pipefail

LEG="${1:?usage: start-live-runtime.sh <signed|unsigned> [port] [config-dir]}"
PORT="${2:-50051}"
DIR="${3:-$(mktemp -d)}"
IMAGE="${MACP_RUNTIME_IMAGE:-ghcr.io/multiagentcoordinationprotocol/macp-runtime:0.11.0}"
NAME="${MACP_RUNTIME_CONTAINER:-macp-live-runtime-$LEG}"
case "$LEG" in signed | unsigned) ;; *) echo "leg must be signed or unsigned" >&2; exit 2 ;; esac

mkdir -p "$DIR"
cat >"$DIR/tokens.json" <<'TOKENS'
[
  {"token":"cp-observer-token","sender":"macp-control-plane","is_observer":true},
  {"token":"agent-alpha-token","sender":"agent-alpha","can_start_sessions":true},
  {"token":"agent-beta-token","sender":"agent-beta"}
]
TOKENS

RUNTIME_ID="cp-live-$LEG"
KID=cp-live-1
args=(-e MACP_ALLOW_INSECURE=1 -e MACP_MEMORY_ONLY=1 -e MACP_AUTH_TOKENS_FILE=/cfg/tokens.json
  -e MACP_COMPACT_TERMINAL_LOGS=0 -e "MACP_RUNTIME_ID=$RUNTIME_ID")
files=("$DIR/tokens.json")
if [ "$LEG" = signed ]; then
  rm -f "$DIR/signing.pem"
  openssl genpkey -algorithm ed25519 -out "$DIR/signing.pem"
  files+=("$DIR/signing.pem")
  args+=(-e MACP_RECEIPT_SIGNING_KEY_PATH=/cfg/signing.pem -e "MACP_RECEIPT_SIGNING_KID=$KID")
fi
# The image runs as an unprivileged user; let it read the mounted config.
chmod 755 "$DIR" && chmod 644 "${files[@]}"

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -p "127.0.0.1:$PORT:50051" -v "$DIR:/cfg:ro" "${args[@]}" "$IMAGE" >/dev/null

# Docker's port forwarder accepts TCP before the runtime binds, so wait for the runtime's own
# "listening" line (logged after keys and auth load), then make sure it is still up.
for _ in $(seq 1 60); do
  if docker logs "$NAME" 2>&1 | grep -q ' listening'; then
    sleep 1
    if [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" = true ]; then
      echo "macp-runtime ($IMAGE, $LEG) on 127.0.0.1:$PORT, config in $DIR" >&2
      env_lines=("MACP_RUNTIME_AUTH_TOKENS_FILE=$DIR/tokens.json" "EXPECT_DECISION_RECEIPTS=$LEG"
        "MACP_RUNTIME_ID=$RUNTIME_ID" "MACP_COMPACT_TERMINAL_LOGS=0")
      [ "$LEG" = signed ] && env_lines+=("MACP_RECEIPT_SIGNING_KID=$KID")
      printf '%s\n' "${env_lines[@]}"
      if [ -n "${GITHUB_ENV:-}" ]; then printf '%s\n' "${env_lines[@]}" >>"$GITHUB_ENV"; fi
      exit 0
    fi
    break
  fi
  sleep 1
done
echo "macp-runtime did not come up" >&2
docker logs "$NAME" >&2 || true
exit 1
