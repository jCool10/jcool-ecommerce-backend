#!/usr/bin/env bash
# Usage: deploy/scripts/set-images.sh <images.env>
# Pins deploy/images to the digests in an images.env (scripts/resolve-image-digests.sh, or a run's
# images-<sha> artifact): one `<target>=ghcr.io/<owner>/jcool-<target>@sha256:<digest>` per line. Lines
# for images not listed are left alone. Every line is checked before anything is written.
set -euo pipefail

if [ $# -ne 1 ] || [ ! -f "$1" ]; then
  echo "usage: $0 <images.env>" >&2
  exit 2
fi
env_file=$1
component_dir=$(cd "$(dirname "$0")/../images" && pwd)
known=$(yq -r '.images[].name' "$component_dir/kustomization.yaml")

refs=()
while IFS='=' read -r target ref || [ -n "$target" ]; do
  [ -n "$target" ] || continue
  if ! [[ $ref =~ ^([a-z0-9./-]+/jcool-([a-z0-9-]+))@sha256:[0-9a-f]{64}$ ]]; then
    echo "$env_file: '$target=$ref' is not <target>=<image>@sha256:<digest>" >&2
    exit 1
  fi
  if [ "${BASH_REMATCH[2]}" != "$target" ]; then
    echo "$env_file: $target points at ${BASH_REMATCH[1]}" >&2
    exit 1
  fi
  if ! grep -qxF "${BASH_REMATCH[1]}" <<<"$known"; then
    echo "$env_file: ${BASH_REMATCH[1]} is not in deploy/images/kustomization.yaml" >&2
    exit 1
  fi
  refs+=("$ref")
done <"$env_file"
if [ ${#refs[@]} -eq 0 ]; then
  echo "$env_file: no images in it" >&2
  exit 1
fi

cd "$component_dir"
for ref in "${refs[@]}"; do
  kustomize edit set image "$ref"
done
echo "pinned ${#refs[@]} image(s) in deploy/images/kustomization.yaml"
