#!/usr/bin/env bash
# Check that local proto files are in sync with the Buf Schema Registry (BSR).
# Used in CI to fail PRs that have drifted protos.
#
# Usage:
#   npm run proto:check
#
# Exit codes:
#   0 - Proto files are in sync
#   1 - Proto files have drifted (run npm run proto:sync to fix)

set -euo pipefail
cd "$(dirname "$0")/.."

MODULE="buf.build/multiagentcoordinationprotocol/macp"

if ! command -v buf &> /dev/null; then
  echo "ERROR: buf CLI not found. Install with: brew install bufbuild/buf/buf"
  exit 1
fi

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

echo "Fetching latest protos from BSR: $MODULE"
buf export "$MODULE" --output "$TMPDIR"

echo "Comparing local proto/macp/ against BSR..."
echo ""

if diff -rq proto/macp/ "$TMPDIR/macp/" > /dev/null 2>&1; then
  echo "OK: Proto files are in sync with BSR"
  exit 0
else
  echo "ERROR: Proto files are out of sync with BSR"
  echo ""
  echo "Differences:"
  diff -rq proto/macp/ "$TMPDIR/macp/" 2>/dev/null || true
  echo ""
  echo "To fix, run: npm run proto:sync"
  echo ""
  echo "If you intentionally modified protos, upstream the changes to the"
  echo "RFC spec repo first, then sync back from BSR."
  exit 1
fi
