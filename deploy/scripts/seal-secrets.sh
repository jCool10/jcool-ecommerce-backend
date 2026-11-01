#!/usr/bin/env bash
# Usage: deploy/scripts/seal-secrets.sh <local|vps> init|seal
#   init  writes ${JCOOL_CONFIG_DIR:-~/.config/jcool}/<overlay>.secrets.env with generated values,
#         leaving blank what only you can fill in.
#   seal  encrypts that file into overlays/<overlay>/data/secrets/*.sealed.yaml with the cluster's
#         certificate ($SEALED_SECRETS_CERT if set, else fetched through $KUBE_CONTEXT).
# The values file never enters the repo; only the SealedSecrets do.
set -euo pipefail

usage() {
  echo "usage: $0 <local|vps> init|seal" >&2
  exit 2
}
[ $# -eq 2 ] || usage
overlay=$1 command=$2
case $overlay in
  local) context=${KUBE_CONTEXT:-k3d-jcool} ;;
  vps) context=${KUBE_CONTEXT:-jcool-vps} ;;
  *) usage ;;
esac

deploy_dir=$(cd "$(dirname "$0")/.." && pwd)
config_dir=${JCOOL_CONFIG_DIR:-$HOME/.config/jcool}
values_file=$config_dir/$overlay.secrets.env
secrets_dir=$deploy_dir/overlays/$overlay/data/secrets
apps_kustomization=$deploy_dir/overlays/$overlay/apps/kustomization.yaml

# One Secret per line: name, then its keys. Keys ending in _PREVIOUS are optional rotation slots.
secrets=(
  "postgres-credentials POSTGRES_PASSWORD API_DB_PASSWORD USERS_DB_PASSWORD INVENTORY_DB_PASSWORD PAYMENT_DB_PASSWORD ORDER_DB_PASSWORD TEMPORAL_DB_PASSWORD"
  "redis REDIS_PASSWORD"
  "internal-tokens API_TO_USER API_TO_USER_PREVIOUS INVENTORY_TO_USER INVENTORY_TO_USER_PREVIOUS ORDER_TO_USER ORDER_TO_USER_PREVIOUS ORDER_TO_API ORDER_TO_API_PREVIOUS ORDER_TO_INVENTORY ORDER_TO_INVENTORY_PREVIOUS ORDER_TO_PAYMENT ORDER_TO_PAYMENT_PREVIOUS"
  "metrics-token METRICS_TOKEN"
  "user-service-keys JWT_ES256_ACTIVE_KID JWT_ES256_PRIVATE_KEYS CSRF_SECRET"
  "stripe STRIPE_SECRET_KEY PAYMENT_WEBHOOK_SECRET"
  "object-storage STORAGE_ACCESS_KEY_ID STORAGE_SECRET_ACCESS_KEY"
  "smtp SMTP_URL"
)

initial_value() {
  case $1 in
    *_PREVIOUS | STRIPE_SECRET_KEY | PAYMENT_WEBHOOK_SECRET) ;;
    JWT_ES256_ACTIVE_KID) printf '%s-1' "$overlay" ;;
    # kid:pem with literal \n, the format user-service parses.
    JWT_ES256_PRIVATE_KEYS)
      printf '%s-1:' "$overlay"
      openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 | awk '{printf "%s\\n", $0}'
      ;;
    # MinIO and mailpit run in the local cluster; vps points at R2 and a real SMTP account.
    STORAGE_ACCESS_KEY_ID) if [ "$overlay" = local ]; then openssl rand -hex 10; fi ;;
    STORAGE_SECRET_ACCESS_KEY) if [ "$overlay" = local ]; then openssl rand -hex 32; fi ;;
    SMTP_URL) if [ "$overlay" = local ]; then printf 'smtp://mailpit:1025'; fi ;;
    *) openssl rand -hex 32 ;;
  esac
}

value_of() {
  awk -v key="$1" 'index($0, key "=") == 1 { value = substr($0, length(key) + 2) } END { printf "%s", value }' "$values_file"
}

blank_required_keys() {
  local entry key
  for entry in "${secrets[@]}"; do
    for key in ${entry#* }; do
      case $key in *_PREVIOUS) continue ;; esac
      [ -n "$(value_of "$key")" ] || printf '%s ' "$key"
    done
  done
}

init() {
  if [ -e "$values_file" ]; then
    echo "$values_file already exists; edit it, or move it away to start over" >&2
    exit 1
  fi
  umask 077
  mkdir -p "$config_dir"
  local entry key value
  tmp=$(mktemp "$config_dir/.secrets.XXXXXX")
  trap 'rm -f "$tmp"' EXIT
  for entry in "${secrets[@]}"; do
    echo "# ${entry%% *}"
    for key in ${entry#* }; do
      value=$(initial_value "$key")
      printf '%s=%s\n' "$key" "$value"
    done
  done >"$tmp"
  mv "$tmp" "$values_file"
  echo "wrote $values_file"
  local blanks
  blanks=$(blank_required_keys)
  if [ -n "$blanks" ]; then echo "fill in before sealing: $blanks"; fi
}

secret_manifest() { # secret_manifest <name> <key>...
  local name=$1 key value
  shift
  printf 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: %s\n  namespace: jcool\ntype: Opaque\ndata:\n' "$name"
  for key in "$@"; do
    value=$(value_of "$key")
    # An empty rotation slot is left out: the apps reject an empty token, and the reference is optional.
    [ -n "$value" ] || continue
    printf '  %s: "%s"\n' "$key" "$(printf '%s' "$value" | base64 | tr -d '\n')"
  done
}

seal() {
  [ -f "$values_file" ] || { echo "$values_file not found; run '$0 $overlay init' first" >&2; exit 1; }
  local blanks
  blanks=$(blank_required_keys)
  if [ -n "$blanks" ]; then
    echo "$values_file: fill in $blanks" >&2
    exit 1
  fi

  local cert entry name file sha
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  cert=${SEALED_SECRETS_CERT:-}
  if [ -z "$cert" ]; then
    cert=$work/cert.pem
    kubeseal --context "$context" --controller-namespace kube-system \
      --controller-name sealed-secrets-controller --fetch-cert >"$cert"
  fi

  # Seal everything first, so a failure halfway leaves the committed set as it was.
  for entry in "${secrets[@]}"; do
    name=${entry%% *}
    # shellcheck disable=SC2086 # the key list is meant to split
    secret_manifest "$name" ${entry#* } | kubeseal --format yaml --cert "$cert" >"$work/$name.sealed.yaml"
  done

  mkdir -p "$secrets_dir"
  rm -f "$secrets_dir"/*.sealed.yaml
  mv "$work"/*.sealed.yaml "$secrets_dir/"
  {
    echo "# Written by deploy/scripts/seal-secrets.sh $overlay seal."
    printf 'apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources:\n'
    for file in "$secrets_dir"/*.sealed.yaml; do echo "  - $(basename "$file")"; done
  } >"$secrets_dir/kustomization.yaml"

  # A SealedSecret update restarts nothing; this rolls the apps. Data stores keep their credential (RUNBOOK).
  sha=$(cat "$secrets_dir"/*.sealed.yaml | shasum -a 256 | cut -c1-64)
  SHA=$sha yq -i '.commonAnnotations["jcool.dev/sealed-secrets-sha"] = strenv(SHA)' "$apps_kustomization"
  echo "sealed ${#secrets[@]} secrets into ${secrets_dir#"$deploy_dir"/}"
}

case $command in
  init) init ;;
  seal) seal ;;
  *) usage ;;
esac
