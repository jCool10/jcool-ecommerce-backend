#!/usr/bin/env bash
# Usage: deploy/scripts/local-cluster.sh <command>
#   create [k3d args]  k3d cluster `jcool` with the Sealed Secrets controller (sealing key restored from
#                      the backup, if there is one); extra args go to `k3d cluster create`
#   backup-key         saves the sealing key to ${JCOOL_CONFIG_DIR:-~/.config/jcool}/sealed-secrets-local.key.yaml
#   apply              overlays/local in order: platform, data, migration Jobs, apps, observability
#   seed               demo catalog and stock, as scripts/ephemeral-stack.sh seed does for compose
#   delete             deletes the cluster and every volume in it
set -euo pipefail

cluster=jcool
context=k3d-$cluster
k3s_image=rancher/k3s:v1.37.1-k3s1@sha256:ca7f37d993d82ef0dcdcfecb2e0e2618ea541dbaffc620c8cedebe01a82acd0d
deploy_dir=$(cd "$(dirname "$0")/.." && pwd)
overlay_dir=$deploy_dir/overlays/local
config_dir=${JCOOL_CONFIG_DIR:-$HOME/.config/jcool}
key_backup=$config_dir/sealed-secrets-local.key.yaml
migration_selector=app.kubernetes.io/component=migration

usage() {
  sed -n '2,8s/^# \{0,1\}//p' "$0" >&2
  exit 2
}

# Always name the context: the current one may well be a real cluster.
kc() { kubectl --context "$context" "$@"; }

create() {
  k3d cluster create "$cluster" --image "$k3s_image" -p 80:80@loadbalancer --agents 0 --wait "$@"
  # The controller adopts an existing key instead of generating one, so the restore must come first.
  if [ -f "$key_backup" ]; then
    kc apply -f "$key_backup"
  fi
  kustomize build "$deploy_dir/bootstrap/sealed-secrets" | kc apply -f -
  kc -n kube-system rollout status deployment/sealed-secrets-controller --timeout=180s
}

backup_key() {
  umask 077
  mkdir -p "$config_dir"
  tmp=$(mktemp "$config_dir/.key.XXXXXX")
  trap 'rm -f "$tmp"' EXIT
  kc -n kube-system get secret -l sealedsecrets.bitnami.com/sealed-secrets-key -o yaml >"$tmp"
  if [ "$(yq '.items | length' "$tmp")" -eq 0 ]; then
    rm -f "$tmp"
    echo "no sealing key in the cluster yet; is the controller running?" >&2
    exit 1
  fi
  mv "$tmp" "$key_backup"
  echo "saved $key_backup; keep a copy in your password manager too"
}

rollout() { # rollout <render>: waits for every Deployment and StatefulSet in it
  local workload
  # 10 minutes: a first pull from GHCR plus Temporal's startup budget (its startupProbe allows 10).
  for workload in $(yq -N -r 'select(.kind == "Deployment" or .kind == "StatefulSet") | (.kind | downcase) + "/" + .metadata.name' "$1"); do
    kc -n jcool rollout status "$workload" --timeout=600s
  done
}

wait_for_migrations() {
  local deadline=$((SECONDS + 600)) states failed name
  while :; do
    # One "name Condition,Condition" line per Job, true conditions only.
    states=$(kc -n jcool get jobs -l "$migration_selector" -o json |
      yq -p json -r '.items[] | .metadata.name + " " + ([.status.conditions[]? | select(.status == "True") | .type] | join(","))')
    failed=$(awk '$2 ~ /(^|,)Failed(,|$)/ { print $1 }' <<<"$states")
    if [ -n "$failed" ]; then
      while read -r name; do
        echo "migration $name failed:" >&2
        kc -n jcool logs "job/$name" --tail=50 </dev/null >&2 || true
      done <<<"$failed"
      exit 1
    fi
    [ -n "$(awk '$2 !~ /(^|,)Complete(,|$)/' <<<"$states")" ] || return 0
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "migrations still running after 10 minutes:" >&2
      echo "$states" >&2
      exit 1
    fi
    sleep 5
  done
}

apply() {
  local group unpinned
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  for group in platform data apps observability; do
    kustomize build "$overlay_dir/$group" >"$work/$group.yaml"
  done

  # Before anything reaches the cluster: base manifests name images without a tag, which would pull :latest.
  unpinned=$(cat "$work"/*.yaml | yq -N -r '.. | select(tag == "!!map" and has("image")) | .image' |
    grep -vE '@sha256:[0-9a-f]{64}$' | sort -u || true)
  if [ -n "$unpinned" ]; then
    echo "not pinned by digest (run deploy/scripts/set-images.sh first):" >&2
    echo "$unpinned" >&2
    exit 1
  fi

  kc apply -f "$work/platform.yaml"

  # A Job's pod template is immutable, so a changed Job must be re-created; the data group's are idempotent.
  for job in $(yq -N -r 'select(.kind == "Job") | .metadata.name' "$work/data.yaml"); do
    kc -n jcool delete job "$job" --ignore-not-found --wait=true
  done
  kc apply -f "$work/data.yaml"
  if [ "$(yq -N 'select(.kind == "SealedSecret") | .metadata.name' "$work/data.yaml")" ]; then
    kc -n jcool wait --for=condition=Synced sealedsecret --all --timeout=120s
  else
    echo "warning: no SealedSecret in overlays/local; run deploy/scripts/seal-secrets.sh local init|seal" >&2
  fi
  rollout "$work/data.yaml"

  kc -n jcool delete job -l "$migration_selector" --ignore-not-found --wait=true
  yq 'select(.metadata.labels["app.kubernetes.io/component"] == "migration")' "$work/apps.yaml" >"$work/migrations.yaml"
  yq 'select(.metadata.labels["app.kubernetes.io/component"] != "migration")' "$work/apps.yaml" >"$work/workloads.yaml"
  kc apply -f "$work/migrations.yaml"
  wait_for_migrations

  kc apply -f "$work/workloads.yaml"
  rollout "$work/workloads.yaml"

  kc apply -f "$work/observability.yaml"
  rollout "$work/observability.yaml"
}

seed() {
  local port=15432 password
  # kubectl itself, not kc: `$!` of a backgrounded function is a subshell, and killing it orphans kubectl.
  kubectl --context "$context" -n jcool port-forward svc/postgres "$port:5432" >/dev/null &
  forward=$!
  trap 'kill "$forward" 2>/dev/null || true' EXIT
  for _ in $(seq 30); do
    nc -z 127.0.0.1 "$port" 2>/dev/null && break
    sleep 1
  done
  password=$(kc -n jcool get secret postgres-credentials -o jsonpath='{.data.API_DB_PASSWORD}' | base64 -d)

  cd "$(dirname "$deploy_dir")"
  # The catalog seed is a tsx script left out of the api image, so it runs from the host.
  # tsx resolves workspace packages through their dist exports, so build every api dependency.
  pnpm turbo run build --filter='@jcool/api^...'
  DATABASE_URL="postgresql://jcool:$password@127.0.0.1:$port/jcool_ecommerce" pnpm --filter @jcool/api db:seed
  # Lists the catalog through the gateway, so it has to come after the catalog seed.
  kc -n jcool exec deploy/inventory-service -- node dist/database/seed-stock.js
}

[ $# -ge 1 ] || usage
cmd=$1
shift
case $cmd in
  create) create "$@" ;;
  backup-key) backup_key ;;
  apply) apply ;;
  seed) seed ;;
  delete) k3d cluster delete "$cluster" ;;
  *) usage ;;
esac
