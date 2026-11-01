#!/usr/bin/env bash
# Usage: deploy/scripts/validate-manifests.sh [deploy/overlays/<overlay>/<group>...]
# Renders each group (every group of every overlay by default) and refuses it when kubeconform finds a
# schema error, an image is not pinned by digest (or a repo image by another digest than deploy/images
# pins), or a ConfigMap/Secret reference has nothing behind it.
# Secret references are checked against the SealedSecrets of the same overlay, whichever group holds them.
set -euo pipefail

deploy_dir=$(cd "$(dirname "$0")/.." && pwd)
repo_root=$(dirname "$deploy_dir")
if [ $# -gt 0 ]; then
  groups=("$@")
else
  cd "$repo_root"
  groups=()
  for dir in "$(basename "$deploy_dir")"/overlays/*/*/; do groups+=("$dir"); done
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
failed=0
yq -r '.images[] | select(.digest) | .name + "@" + .digest' "$deploy_dir/images/kustomization.yaml" >"$work/pinned"

# yq over a render; -N keeps document separators out of the output.
query() { yq -N -r "$1" "$2" | sort -u; }

# Renders every group of an overlay once and lists its SealedSecrets as "name key" lines.
sealed_keys_of() {
  local overlay=$1 dir
  if [ ! -f "$work/$overlay.sealed" ]; then
    for dir in "$deploy_dir/overlays/$overlay"/*/; do
      kustomize build "$dir"
      echo "---"
    done >"$work/$overlay.all.yaml"
    query 'select(.kind == "SealedSecret") | .metadata.name + " " + (.spec.encryptedData | keys | .[])' \
      "$work/$overlay.all.yaml" >"$work/$overlay.sealed"
  fi
  cat "$work/$overlay.sealed"
}

check_group() {
  local group=${1%/} rendered problems overlay sealed ref name
  rendered=$work/render.yaml
  problems=$work/problems
  : >"$problems"
  if ! kustomize build "$group" >"$rendered"; then
    echo "$group: kustomize build failed" >&2
    return 1
  fi

  kubeconform -strict -summary -kubernetes-version 1.37.1 \
    -schema-location "$deploy_dir/schemas/{{.ResourceKind}}{{.KindSuffix}}.json" "$rendered" ||
    echo "kubeconform rejected the render" >>"$problems"

  query '.. | select(tag == "!!map" and has("image")) | .image' "$rendered" |
    grep -vE '@sha256:[0-9a-f]{64}$' | sed 's/^/image not pinned by digest: /' >>"$problems" || true
  # Only deploy/images is attestation-checked, so a digest set in an overlay or a patch must not get through.
  query '.. | select(tag == "!!map" and has("image")) | .image' "$rendered" |
    grep -E '^ghcr\.io/jcool10/jcool-[a-z0-9-]+@sha256:' | grep -vxF -f "$work/pinned" |
    sed 's|^|image is not the digest deploy/images pins: |' >>"$problems" || true

  query 'select(.kind == "ConfigMap") | .metadata.name' "$rendered" >"$work/configmaps"
  query '.. | select(tag == "!!map") | (.configMapRef, .configMapKeyRef, .configMap) | select(. != null and .optional != true) | .name' \
    "$rendered" | while read -r name; do
    grep -qxF "$name" "$work/configmaps" || echo "ConfigMap $name is not in this group's render" >>"$problems"
  done

  overlay=$(basename "$(dirname "$group")")
  sealed=$(sealed_keys_of "$overlay")
  if [ -z "$sealed" ]; then
    if [ ! -f "$work/$overlay.noticed" ]; then
      echo "$overlay: no SealedSecret yet, secret references not checked"
      touch "$work/$overlay.noticed"
    fi
  else
    {
      query '.. | .secretRef? | select(. != null and .optional != true) | .name' "$rendered"
      query '.. | .secret? | select(. != null and .optional != true) | .secretName' "$rendered"
    } | while read -r name; do
      cut -d' ' -f1 <<<"$sealed" | grep -qxF "$name" || echo "Secret $name is not sealed in $overlay" >>"$problems"
    done
    {
      query '.. | .secretKeyRef? | select(. != null and .optional != true) | .name + " " + .key' "$rendered"
      query '.. | .secret? | select(. != null and .optional != true) | .secretName + " " + .items[].key' "$rendered"
    } | while read -r ref; do
      grep -qxF "$ref" <<<"$sealed" || echo "Secret ${ref% *} has no key ${ref#* } sealed in $overlay" >>"$problems"
    done
  fi

  if [ -s "$problems" ]; then
    sed "s|^|$group: |" "$problems" >&2
    return 1
  fi
  echo "ok $group"
}

for group in "${groups[@]}"; do
  check_group "$group" || failed=1
done
exit "$failed"
