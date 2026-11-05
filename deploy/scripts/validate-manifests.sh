#!/usr/bin/env bash
# Usage: deploy/scripts/validate-manifests.sh   (needs kustomize, kubeconform and mikefarah yq v4)
# Renders deploy/infra, deploy/apps and deploy/argocd, and refuses the tree when kubeconform finds a schema
# error, a jcool image carries another tag than deploy/images sets, a third-party image is not pinned by
# digest, a ConfigMap reference has nothing behind it, a Secret reference names a key no
# deploy/secrets catalog lists, or a Job is not an Argo CD hook.
set -euo pipefail

for tool in kustomize kubeconform yq; do
  command -v "$tool" >/dev/null || {
    echo "$tool is required" >&2
    exit 2
  }
done

deploy_dir=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
failed=0

yq -r '.images[] | .name + ":" + .newTag' "$deploy_dir/images/kustomization.yaml" | sort -u >"$work/tags"
for example in "$deploy_dir"/secrets/*.env.example; do
  name=$(basename "$example" .env.example)
  grep -E '^[A-Z][A-Z0-9_]*=' "$example" | cut -d= -f1 | sed "s/^/$name /"
done | sort -u >"$work/catalog"
cut -d' ' -f1 "$work/catalog" | sort -u >"$work/secrets"

# yq over a render; -N keeps document separators out of the output.
query() { yq -N -r "$1" "$2" | sort -u; }

check() {
  local dir=$1 rendered=$work/$1.yaml problems=$work/$1.problems name ref
  : >"$problems"
  if ! kustomize build "$deploy_dir/$dir" >"$rendered"; then
    echo "deploy/$dir: kustomize build failed" >&2
    return 1
  fi
  # Upstream's install.yaml, patched: built to prove the patches still apply, not linted.
  if [ "$dir" = argocd ]; then
    echo "ok deploy/$dir"
    return 0
  fi

  kubeconform -strict -summary -kubernetes-version 1.36.0 -ignore-missing-schemas "$rendered" ||
    echo "kubeconform rejected the render" >>"$problems"

  query '.. | select(tag == "!!map" and has("image")) | .image' "$rendered" >"$work/images"
  grep -E '^ghcr\.io/jcool10/jcool-' "$work/images" | grep -vE ':(sha|tree)-[0-9a-f]{12}$' |
    sed 's/^/image tag is not sha-<12 hex> or tree-<12 hex>: /' >>"$problems" || true
  grep -E '^ghcr\.io/jcool10/jcool-' "$work/images" | grep -vxF -f "$work/tags" |
    sed 's|^|image tag is not the one deploy/images sets: |' >>"$problems" || true
  grep -vE '^ghcr\.io/jcool10/jcool-' "$work/images" | grep -vE ':[^:/@]+@sha256:[0-9a-f]{64}$' |
    sed 's/^/third-party image is not pinned by tag and digest: /' >>"$problems" || true

  query 'select(.kind == "ConfigMap") | .metadata.name' "$rendered" >"$work/configmaps"
  query '.. | select(tag == "!!map") | (.configMapRef, .configMapKeyRef, .configMap) | select(. != null) | .name' \
    "$rendered" | while read -r name; do
    grep -qxF "$name" "$work/configmaps" || echo "ConfigMap $name is not in this render" >>"$problems"
  done

  # Optional references too: a _PREVIOUS slot must still be a key the catalog lists.
  {
    query '.. | .secretRef? | select(. != null) | .name' "$rendered"
    query '.. | .secret? | select(. != null) | .secretName' "$rendered"
    query '.. | .secretKeyRef? | select(. != null) | .name' "$rendered"
  } | sort -u | while read -r name; do
    grep -qxF "$name" "$work/secrets" || echo "Secret $name has no deploy/secrets/$name.env.example" >>"$problems"
  done
  {
    query '.. | .secretKeyRef? | select(. != null) | .name + " " + .key' "$rendered"
    query '.. | .secret? | select(. != null and has("items")) | .secretName + " " + .items[].key' "$rendered"
  } | sort -u | while read -r ref; do
    grep -qxF "$ref" "$work/catalog" || echo "Secret ${ref% *} has no key ${ref#* } in its catalog" >>"$problems"
  done

  # Jobs are immutable: a plain Job would fail the sync on its first change.
  query 'select(.kind == "Job" and .metadata.annotations["argocd.argoproj.io/hook"] == null) | .metadata.name' \
    "$rendered" | sed 's/^/Job is not an Argo CD hook: /' >>"$problems"

  if [ -s "$problems" ]; then
    sed "s|^|deploy/$dir: |" "$problems" >&2
    return 1
  fi
  echo "ok deploy/$dir"
}

for dir in infra apps argocd; do
  check "$dir" || failed=1
done
exit "$failed"
