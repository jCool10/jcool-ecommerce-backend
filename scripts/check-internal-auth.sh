#!/usr/bin/env bash
# Usage: scripts/check-internal-auth.sh <base-url> <redis-cli command...>
#   scripts/check-internal-auth.sh http://127.0.0.1:8080 docker compose exec -T redis redis-cli
# Proves the api and the order-service can each read a session epoch from the user-service's internal
# API. Registering caches the epoch in Redis, so a token mismatch stays invisible until the key is gone:
# drop it, and the guard has to ask the user-service, answering 503 if the user-service refuses. One
# fresh user per route, since a refused lookup leaves no key behind for the next route to drop.
set -euo pipefail

if [ $# -lt 2 ]; then
  echo "usage: $0 <base-url> <redis-cli command...>" >&2
  exit 2
fi
base=$1
shift
redis=("$@")

# check_route <path> <caller>. Runs under `||`, where set -e is off, so every step checks itself.
check_route() {
  local email body token sub deleted status
  email="internal-auth-$(date +%s)-$RANDOM@${LOAD_EMAIL_DOMAIN:-loadtest.jcool.local}"
  body=$(jq -nc --arg e "$email" --arg p "${LOAD_PASSWORD:-load-test-not-a-real-secret}" '{email: $e, password: $p}')
  curl -fsS -m 30 -o /dev/null -H 'Content-Type: application/json' -d "$body" "$base/auth/register" ||
    { echo "register failed" >&2; return 1; }
  token=$(curl -fsS -m 30 -H 'Content-Type: application/json' -d "$body" "$base/auth/login" | jq -er .accessToken) ||
    { echo "login failed" >&2; return 1; }
  sub=$(node -e 'console.log(JSON.parse(Buffer.from(process.argv[1].split(".")[1], "base64url")).sub)' "$token") ||
    { echo "access token has no readable sub" >&2; return 1; }
  # Zero would mean the key name is wrong and the guard still hits the cache: a false pass.
  deleted=$("${redis[@]}" DEL "auth:epoch:$sub" | tr -d '[:space:]')
  if [ "$deleted" != 1 ]; then
    echo "no session epoch at auth:epoch:$sub after register (DEL returned '$deleted')" >&2
    return 1
  fi
  status=$(curl -sS -m 30 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" "$base$1")
  if [ "$status" != 200 ]; then
    echo "GET $1 without a cached session epoch returned $status: $2 -> user-service internal auth is broken" >&2
    return 1
  fi
  echo "GET $1 without a cached session epoch: 200 ($2 -> user-service)"
}

failed=0
check_route /cart api || failed=1
check_route /orders order-service || failed=1
exit "$failed"
