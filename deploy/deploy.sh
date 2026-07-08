#!/usr/bin/env bash
# Production deploy for the MACP control plane on a single VM.
#
#   ./deploy.sh deploy <tag>   pull <tag>, run migrations, start, verify health
#   ./deploy.sh rollback       re-deploy the previous tag (migrations are NOT reverted)
#   ./deploy.sh status         compose ps + current/previous tag
#
# Prerequisites: docker + compose v2, `docker login ghcr.io` with a
# read:packages PAT, and a filled-in .env.prod next to this script.
set -euo pipefail

cd "$(dirname "$0")"

COMPOSE=(docker compose -f docker-compose.prod.yml --env-file .env.prod)
CURRENT_TAG_FILE=.current_tag
PREVIOUS_TAG_FILE=.previous_tag
HEALTH_URL="http://localhost:3001/healthz"
HEALTH_ATTEMPTS=60

usage() {
  sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

require_env() {
  if [ ! -f .env.prod ]; then
    echo "ERROR: .env.prod not found. Copy .env.prod.example and fill it in." >&2
    exit 1
  fi
}

health_check() {
  echo "Waiting for $HEALTH_URL ..."
  for i in $(seq 1 "$HEALTH_ATTEMPTS"); do
    if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
      echo "Healthy after ${i}s."
      return 0
    fi
    sleep 1
  done
  return 1
}

deploy() {
  local tag="${1:?usage: ./deploy.sh deploy <tag>}"
  require_env

  if [ -f "$CURRENT_TAG_FILE" ]; then
    cp "$CURRENT_TAG_FILE" "$PREVIOUS_TAG_FILE"
    echo "Previous tag saved: $(cat "$PREVIOUS_TAG_FILE")"
  fi

  echo "==> Pulling images for $tag"
  TAG="$tag" "${COMPOSE[@]}" pull

  echo "==> Running migrations"
  TAG="$tag" "${COMPOSE[@]}" run --rm migrate

  echo "==> Starting services"
  TAG="$tag" "${COMPOSE[@]}" up -d

  if health_check; then
    echo "$tag" > "$CURRENT_TAG_FILE"
    echo "==> Deploy of $tag succeeded."
  else
    echo "ERROR: app did not become healthy within ${HEALTH_ATTEMPTS}s." >&2
    echo "Logs:    TAG=$tag ${COMPOSE[*]} logs app" >&2
    if [ -f "$PREVIOUS_TAG_FILE" ]; then
      echo "Rollback: ./deploy.sh rollback   (previous tag: $(cat "$PREVIOUS_TAG_FILE"))" >&2
    fi
    # No silent auto-rollback: migrations may not be reversible — rolling back
    # is an explicit human decision.
    exit 1
  fi
}

rollback() {
  require_env
  if [ ! -f "$PREVIOUS_TAG_FILE" ]; then
    echo "ERROR: no $PREVIOUS_TAG_FILE — nothing to roll back to." >&2
    exit 1
  fi
  local prev
  prev="$(cat "$PREVIOUS_TAG_FILE")"
  echo "WARNING: rolling back the APP IMAGE to $prev." >&2
  echo "WARNING: database migrations are forward-only and are NOT reverted." >&2
  echo "         Rollback is only safe across releases without schema changes." >&2
  deploy "$prev"
}

status() {
  require_env
  local tag="latest"
  [ -f "$CURRENT_TAG_FILE" ] && tag="$(cat "$CURRENT_TAG_FILE")"
  echo "Current tag:  $([ -f "$CURRENT_TAG_FILE" ] && cat "$CURRENT_TAG_FILE" || echo '<none>')"
  echo "Previous tag: $([ -f "$PREVIOUS_TAG_FILE" ] && cat "$PREVIOUS_TAG_FILE" || echo '<none>')"
  TAG="$tag" "${COMPOSE[@]}" ps
}

case "${1:-}" in
  deploy)   shift; deploy "$@" ;;
  rollback) rollback ;;
  status)   status ;;
  *)        usage ;;
esac
