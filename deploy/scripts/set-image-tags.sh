#!/usr/bin/env bash
# Usage: deploy/scripts/set-image-tags.sh <commit>
# Points deploy/images at the tags images.yml publishes for <commit>: sha-<sha12> for the seven apps,
# tree-<hash12 of infra/<x>> for the infra images. Rewrites the whole file, so a rerun changes nothing.
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "usage: $0 <commit>" >&2
  exit 2
fi
repo_root=$(cd "$(dirname "$0")/../.." && pwd)
if ! sha=$(git -C "$repo_root" rev-parse --verify --quiet "$1^{commit}"); then
  echo "$1 is not a commit in this repository" >&2
  exit 1
fi

apps=(api gateway id-service user-service inventory-service payment-service order-service)
infra=(temporal elasticsearch prometheus loki grafana)
target=$repo_root/deploy/images/kustomization.yaml

{
  echo "# Written by deploy/scripts/set-image-tags.sh; edit through it, not by hand."
  echo "apiVersion: kustomize.config.k8s.io/v1alpha1"
  echo "kind: Component"
  echo "images:"
  for app in "${apps[@]}"; do
    printf '  - name: ghcr.io/jcool10/jcool-%s\n    newTag: sha-%s\n' "$app" "${sha:0:12}"
  done
  for image in "${infra[@]}"; do
    tree=$(git -C "$repo_root" rev-parse "$sha:infra/$image")
    printf '  - name: ghcr.io/jcool10/jcool-%s\n    newTag: tree-%s\n' "$image" "${tree:0:12}"
  done
} >"$target.tmp"
mv "$target.tmp" "$target"
echo "deploy/images set to the images of ${sha:0:12}"
