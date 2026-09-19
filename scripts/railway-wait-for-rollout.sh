#!/usr/bin/env bash
# Usage: railway-wait-for-rollout.sh <service>
# Blocks until the service's newest deployment is live, and fails if it ends any other way.
# `railway up --ci` returns once the image is built; the pre-deploy step and the healthcheck gate
# both run after that, so only this wait says a deploy landed.
set -euo pipefail

service=${1:?usage: railway-wait-for-rollout.sh <service>}
environment=${RAILWAY_ENVIRONMENT:-production}
deadline=$(( $(date +%s) + ${ROLLOUT_TIMEOUT_SECONDS:-900} ))
watched=""

while :; do
  raw=$(railway deployment list --json --limit 1 --service "$service" --environment "$environment")
  entry=$(printf '%s' "$raw" \
    | jq -r '(if type == "array" then .[0] else (.deployments // .data // [])[0] end)
             | "\(.id // .deploymentId // empty)\t\(.status // empty)"')
  id=${entry%%$'\t'*}
  status=${entry##*$'\t'}

  # An unreadable payload must fail loudly: treating "no status" as "not yet" would let a CLI output
  # change turn every deploy green on a timeout instead.
  if [ -z "$status" ]; then
    echo "::error::$service: cannot read deployment status from the CLI response"
    printf '%s\n' "$raw"
    exit 1
  fi

  # Latch the first deployment seen: a rollout triggered while this one is in flight must not be
  # reported as this one's result.
  if [ -z "$watched" ]; then
    watched=$id
    echo "$service: watching deployment ${watched:-<unknown id>} (status $status)"
  elif [ "$id" != "$watched" ]; then
    echo "::error::$service: deployment $watched was superseded by $id — this run cannot report on it"
    exit 1
  fi

  case "$status" in
    SUCCESS)
      echo "$service: deployment is live"
      exit 0
      ;;
    FAILED|CRASHED|REMOVED|SKIPPED)
      echo "::error::$service: deployment ended as $status — traffic stays on the previous version"
      echo "logs: railway logs --deployment --service $service"
      exit 1
      ;;
  esac

  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "::error::$service: timed out, last status was $status"
    exit 1
  fi
  sleep 10
done
