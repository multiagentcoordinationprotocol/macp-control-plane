#!/usr/bin/env bash
# Boots a token-authenticated macp-runtime container for the live integration specs
# (describeWithAuthedRuntime: decision-receipt-live, what-if-replay-live). Used by CI's
# `live-runtime` job and runnable locally:
#
#   test/scripts/start-live-runtime.sh <signed|unsigned> [port] [config-dir]
#
# then run the specs with
#   INTEGRATION_RUNTIME=remote RUNTIME_ADDRESS=127.0.0.1:<port> \
#   MACP_RUNTIME_AUTH_TOKENS_FILE=<config-dir>/tokens.json EXPECT_DECISION_RECEIPTS=<leg> ...
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

args=(-e MACP_ALLOW_INSECURE=1 -e MACP_MEMORY_ONLY=1 -e MACP_AUTH_TOKENS_FILE=/cfg/tokens.json
  -e MACP_COMPACT_TERMINAL_LOGS=0
  -e "MACP_RUNTIME_ID=cp-live-$LEG")
if [ "$LEG" = signed ]; then
  openssl genpkey -algorithm ed25519 -out "$DIR/signing.pem"
  args+=(-e MACP_RECEIPT_SIGNING_KEY_PATH=/cfg/signing.pem -e MACP_RECEIPT_SIGNING_KID=cp-live-1)
fi
# The image runs as an unprivileged user; let it read the mounted config.
chmod 755 "$DIR" && chmod 644 "$DIR"/*

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" -p "127.0.0.1:$PORT:50051" -v "$DIR:/cfg:ro" "${args[@]}" "$IMAGE" >/dev/null

for _ in $(seq 1 60); do
  if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
    sleep 1
    if [ "$(docker inspect -f '{{.State.Running}}' "$NAME")" = true ]; then
      echo "macp-runtime ($IMAGE, $LEG) on 127.0.0.1:$PORT, config in $DIR"
      exit 0
    fi
  fi
  sleep 1
done
echo "macp-runtime did not come up" >&2
docker logs "$NAME" >&2 || true
exit 1
