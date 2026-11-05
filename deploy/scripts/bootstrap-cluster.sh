#!/usr/bin/env bash
# Usage: deploy/scripts/bootstrap-cluster.sh
# Takes a fresh k3s to a serving jcool: Argo CD, the Secrets, jcool-infra, the api's search user,
# jcool-apps, then the demo catalog, its stock and the search index. Each step waits for the one before
# it, and every step is safe to rerun. Run from a checkout with `pnpm install` done, the API tunnelled
# (ssh -N -L 6443:127.0.0.1:6443 ubuntu@<vm>) and KUBECONFIG pointing at it.
set -euo pipefail

deploy_dir=$(cd "$(dirname "$0")/.." && pwd)
repo_root=$(dirname "$deploy_dir")
secrets_dir=${JCOOL_SECRETS_DIR:-$HOME/.config/jcool/prod}
seed_port=15432
timings=()
port_forward=""
trap '[ -z "$port_forward" ] || kill "$port_forward" 2>/dev/null || true' EXIT

timed() {
  local label=$1 started=$SECONDS
  shift
  echo "== $label"
  "$@"
  timings+=("$(printf '%-12s %5ss' "$label" $((SECONDS - started)))")
}

create_namespaces() {
  for namespace in argocd jcool; do
    kubectl create namespace "$namespace" --dry-run=client -o yaml | kubectl apply -f -
  done
}

install_argocd() {
  # Server-side: the Application CRD is too large for the last-applied annotation.
  kubectl apply --server-side --force-conflicts -k "$deploy_dir/argocd"
  kubectl -n argocd rollout status statefulset/argocd-application-controller --timeout=5m
  for deployment in argocd-redis argocd-repo-server argocd-server; do
    kubectl -n argocd rollout status "deployment/$deployment" --timeout=5m
  done
}

sync_application() {
  local app=$1 timeout=$2
  kubectl apply -f "$deploy_dir/argocd/applications.yaml" -l "jcool.dev/application=$app"
  kubectl -n argocd wait "application/jcool-$app" --for=jsonpath='{.status.sync.status}'=Synced --timeout="$timeout"
  kubectl -n argocd wait "application/jcool-$app" --for=jsonpath='{.status.health.status}'=Healthy --timeout="$timeout"
}

sync_infra() {
  sync_application infra 20m
  for statefulset in $(kubectl -n jcool get statefulsets -o name); do
    kubectl -n jcool rollout status "$statefulset" --timeout=15m
  done
}

# Before the apps: the api provisions its index at boot and carries on without it when it cannot sign in.
# Both PUTs overwrite, and both passwords come from the pod's own env through stdin.
search_user() {
  kubectl -n jcool exec -i elasticsearch-0 -c elasticsearch -- bash -s <<'EOF'
set -euo pipefail
es() { curl -fsS -o /dev/null -K <(printf 'user = "elastic:%s"\n' "$ELASTIC_PASSWORD") -H 'content-type: application/json' "$@"; }
for ((attempt = 0; attempt < 60; attempt++)); do
  if es localhost:9200/_security/_authenticate 2>/dev/null; then break; fi
  sleep 2
done
es -X PUT localhost:9200/_security/role/jcool_api_search --data-binary @- <<'ROLE'
{"cluster": ["monitor"], "indices": [{"names": ["products*"], "privileges": ["read", "write", "create_index", "delete_index", "manage", "view_index_metadata"]}]}
ROLE
printf '{"password":"%s","roles":["jcool_api_search"]}' "$API_SEARCH_PASSWORD" |
  es -X PUT localhost:9200/_security/user/jcool_api --data-binary @-
echo "jcool_api and jcool_api_search are in place"
EOF
}

port_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# The demo catalog, from this checkout: the seed is a tsx script, which the api image does not ship.
# It skips rows that exist, and mints its ids in-process, so it needs only the database.
seed_catalog() {
  local password
  if port_open "$seed_port"; then
    echo "127.0.0.1:$seed_port is taken; stop its owner (lsof -i :$seed_port) and rerun" >&2
    return 1
  fi
  password=$(awk 'index($0, "API_DB_PASSWORD=") == 1 { print substr($0, 17) }' "$secrets_dir/postgres-credentials.env")
  kubectl -n jcool port-forward svc/postgres "$seed_port:5432" >/dev/null &
  port_forward=$!
  for _ in $(seq 30); do
    if port_open "$seed_port"; then break; fi
    sleep 1
  done
  (cd "$repo_root" && DATABASE_URL="postgresql://jcool:$password@127.0.0.1:$seed_port/jcool_ecommerce" \
    pnpm --filter @jcool/api db:seed)
  kill "$port_forward"
  port_forward=""
}

# Strict, not the PostSync hook's best effort: right after the seed the gateway's catalog cache can answer
# an empty page for up to CATALOG_CACHE_TTL_SEC + CACHE_STALE_WINDOW_SEC (90 s by default).
seed_stock() {
  local deadline=$((SECONDS + 300))
  until kubectl -n jcool exec deploy/inventory-service -- node dist/database/seed-stock.js; do
    if [ "$SECONDS" -ge "$deadline" ]; then return 1; fi
    sleep 15
  done
}

reindex() {
  kubectl -n jcool exec deploy/api -- node dist/modules/product/infrastructure/catalog/search/reindex.js
}

echo "context: $(kubectl config current-context), nodes: $(kubectl get nodes -o name | tr '\n' ' ')"
timed namespaces create_namespaces
timed argocd install_argocd
timed secrets "$deploy_dir/scripts/apply-secrets.sh"
timed project kubectl apply -f "$deploy_dir/argocd/project.yaml"
timed jcool-infra sync_infra
timed search-user search_user
# The first sync waits a lease TTL in id-floors and pulls every image.
timed jcool-apps sync_application apps 30m
timed catalog seed_catalog
timed stock seed_stock
timed reindex reindex

echo
printf '%s\n' "${timings[@]}"
