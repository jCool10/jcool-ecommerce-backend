#!/usr/bin/env bash
# Usage: deploy/scripts/apply-secrets.sh
# Creates or updates one Secret per deploy/secrets/<name>.env.example from $JCOOL_SECRETS_DIR/<name>.env
# (default ~/.config/jcool/prod). Every file is checked before the cluster is touched. Only Secret and key
# names are printed. A changed Secret restarts the workloads that read it, except the data-plane ones,
# whose engines keep the old value until the RUNBOOK's rotation steps run.
set -euo pipefail

deploy_dir=$(cd "$(dirname "$0")/.." && pwd)
secrets_dir=${JCOOL_SECRETS_DIR:-$HOME/.config/jcool/prod}
namespace=jcool
data_plane=" postgres-credentials redis search grafana "

work=$(mktemp -d)
chmod 700 "$work"
trap 'rm -rf "$work"' EXIT

keys_of() { grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$1" | cut -d= -f1 || true; }
lines_of() { awk -v key="$1" 'index($0, key "=") == 1' "$2"; }

problems=0
fail() {
  echo "$1" >&2
  problems=1
}

names=()
for example in "$deploy_dir"/secrets/*.env.example; do
  name=$(basename "$example" .env.example)
  names+=("$name")
  file=$secrets_dir/$name.env
  if [ ! -f "$file" ]; then
    fail "$name: $file is missing"
    continue
  fi
  if grep -q $'\r' "$file"; then
    fail "$name: $file has CRLF line endings"
    continue
  fi
  if [ -n "$(find "$file" \( -perm -040 -o -perm -004 \))" ]; then
    echo "warning: $file is readable by other users; chmod 600 it" >&2
  fi

  out=$work/$name.env
  : >"$out"
  for key in $(keys_of "$example"); do
    count=$(lines_of "$key" "$file" | wc -l | tr -d ' ')
    case $count in
      0)
        # A rotation slot outside a rotation.
        case $key in *_PREVIOUS) continue ;; esac
        fail "$name: $key is missing"
        continue
        ;;
      1) ;;
      *)
        fail "$name: $key is set $count times"
        continue
        ;;
    esac
    line=$(lines_of "$key" "$file")
    value=${line#*=}
    if [ -z "$value" ]; then
      # Left out, not set empty: the services validate an empty _PREVIOUS as a too-short token.
      case $key in *_PREVIOUS) continue ;; esac
      fail "$name: $key is empty"
      continue
    fi
    case $value in
      \"* | \'*)
        fail "$name: $key is quoted; kubectl keeps the quotes, so write the value bare"
        continue
        ;;
    esac
    printf '%s\n' "$line" >>"$out"
  done
  for key in $(keys_of "$file"); do
    grep -qE "^$key=" "$example" || echo "warning: $name: $key is not in deploy/secrets/$name.env.example; left out" >&2
  done
done
unset line value
[ "$problems" -eq 0 ] || exit 1

kubectl get namespace "$namespace" >/dev/null

data_hash() { jq -S '.data // {}' | shasum -a 256 | cut -d' ' -f1; }

# Workloads whose pod template reads the Secret, as kind/name.
readers_of() {
  kubectl -n "$namespace" get deployments,statefulsets -o json | jq -r --arg secret "$1" '
    .items[]
    | select(
        any(.spec.template.spec | .. | objects | (.secretKeyRef?, .secretRef?) | objects; .name == $secret)
        or any(.spec.template.spec.volumes[]?; .secret?.secretName == $secret)
      )
    | (.kind | ascii_downcase) + "/" + .metadata.name'
}

for name in "${names[@]}"; do
  kubectl -n "$namespace" create secret generic "$name" --from-env-file="$work/$name.env" --dry-run=client -o json \
    >"$work/$name.json"
  existing=$(kubectl -n "$namespace" get secret "$name" -o name --ignore-not-found)
  if [ -n "$existing" ] &&
    [ "$(kubectl -n "$namespace" get secret "$name" -o json | data_hash)" = "$(data_hash <"$work/$name.json")" ]; then
    echo "unchanged $name"
    continue
  fi
  # Server-side: a client-side apply would copy every value into the last-applied annotation, which
  # kubectl describe prints. Keys dropped from the file (an ended rotation) are removed.
  kubectl apply --server-side --force-conflicts --field-manager=apply-secrets -f "$work/$name.json" >/dev/null
  if [ -z "$existing" ]; then
    echo "created $name"
    continue
  fi
  echo "changed $name"
  if [[ $data_plane == *" $name "* ]]; then
    echo "  $name is read by a stateful engine: nothing restarted, follow RUNBOOK \"Rotate a password\"" >&2
    continue
  fi
  for workload in $(readers_of "$name"); do
    kubectl -n "$namespace" rollout restart "$workload"
  done
done
