#!/usr/bin/env bash
# Sync proto files from the Buf Schema Registry (BSR) or local runtime.
#
# Usage:
#   npm run proto:sync            # Sync from BSR (default)
#   npm run proto:sync:runtime    # Sync from local runtime sibling
#
# Prerequisites:
#   - buf CLI: brew install bufbuild/buf/buf
#   - BUF_TOKEN env var (for authenticated BSR access, optional for public modules)

set -euo pipefail
cd "$(dirname "$0")/.."

MODULE="buf.build/multiagentcoordinationprotocol/macp"
DEST="proto"
SOURCE="${1:-bsr}"

case "$SOURCE" in
  bsr)
    if ! command -v buf &> /dev/null; then
      echo "ERROR: buf CLI not found. Install with: brew install bufbuild/buf/buf"
      exit 1
    fi

    echo "Syncing protos from BSR: $MODULE"
    echo ""

    # Export from BSR to a temp dir first, then replace
    TMPDIR=$(mktemp -d)
    trap 'rm -rf "$TMPDIR"' EXIT

    buf export "$MODULE" --output "$TMPDIR"

    # Replace local protos with BSR version
    rm -rf "$DEST/macp"
    cp -r "$TMPDIR/macp" "$DEST/macp"

    echo ""
    echo "Proto files synced from BSR."
    echo "Module: $MODULE"
    echo "Destination: $DEST/macp/"
    ;;

  runtime)
    # Fallback: sync from local runtime sibling (for offline development)
    SRC="${RUNTIME_PROTO_DIR:-../runtime/proto}"
    if [ ! -d "$SRC/macp" ]; then
      echo "ERROR: Runtime proto dir not found at $SRC"
      echo "Set RUNTIME_PROTO_DIR or place the runtime repo at ../runtime"
      exit 1
    fi

    echo "Syncing protos from runtime: $SRC"
    rsync -av --delete "$SRC/macp/" "$DEST/macp/"
    echo ""
    echo "Proto files synced from runtime."
    ;;

  *)
    echo "Usage: $0 [bsr|runtime]"
    echo ""
    echo "  bsr     - Sync from Buf Schema Registry (default)"
    echo "  runtime - Sync from local runtime sibling directory"
    exit 1
    ;;
esac
