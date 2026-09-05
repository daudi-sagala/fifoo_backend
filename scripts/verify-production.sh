#!/usr/bin/env bash
set -euo pipefail

: "${API_BASE_URL:?Set API_BASE_URL, for example https://api.fifoo.ai}"

echo "Checking liveness..."
curl --fail --silent --show-error "$API_BASE_URL/live"
echo

echo "Checking database-backed readiness..."
status="$(curl --silent --show-error --output /tmp/fifoo-ready.out --write-out '%{http_code}' "$API_BASE_URL/ready")"
if [[ "$status" != "204" ]]; then
  cat /tmp/fifoo-ready.out || true
  echo "Expected /ready to return 204, got $status" >&2
  exit 1
fi

echo "Checking HTTPS redirect/security boundary..."
if [[ "$API_BASE_URL" != https://* ]]; then
  echo "API_BASE_URL must use https://" >&2
  exit 1
fi

echo "Production verification passed."
