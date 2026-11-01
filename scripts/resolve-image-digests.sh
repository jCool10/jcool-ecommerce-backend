#!/usr/bin/env bash
# Usage: scripts/resolve-image-digests.sh <registry-prefix> <sha> <targets-json>
# Prints `<image>=<prefix>/jcool-<image>@<digest>` for every bake target. Images in <targets-json>
# (the delivery `changes` output) resolve from sha-<sha>; the rest from `main`, which only moves after
# a green rehearsal. Prints nothing and exits 1 if any tag is missing.
set -euo pipefail

if [ $# -ne 3 ]; then
  echo "usage: $0 <registry-prefix> <sha> <targets-json>" >&2
  exit 2
fi
prefix=$1 sha=$2 targets=$3

cd "$(dirname "$0")/.."
images=$(docker buildx bake -f docker-bake.hcl --print all | jq -r '.target | keys[]')
if ! changed=$(jq -r '.[] | .image // error("entry without an image")' <<<"$targets" 2>/dev/null); then
  echo "targets is not a JSON array of {image}: $targets" >&2
  exit 1
fi

for image in $changed; do
  if ! grep -qx "$image" <<<"$images"; then
    echo "$image is not a docker-bake.hcl target" >&2
    exit 1
  fi
done

err=$(mktemp)
trap 'rm -f "$err"' EXIT
lines=() failed=0
for image in $images; do
  tag=main
  grep -qx "$image" <<<"$changed" && tag="sha-$sha"
  ref="$prefix/jcool-$image:$tag"
  digest=$(docker buildx imagetools inspect "$ref" --format '{{json .Manifest}}' 2>"$err" | jq -r '.digest // empty' || true)
  if [[ ! $digest =~ ^sha256:[0-9a-f]{64}$ ]]; then
    echo "cannot resolve $ref: $(head -1 "$err")" >&2
    failed=1
    continue
  fi
  lines+=("$image=$prefix/jcool-$image@$digest")
done

[ "$failed" -eq 0 ] || exit 1
printf '%s\n' "${lines[@]}"
