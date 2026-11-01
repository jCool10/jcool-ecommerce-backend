#!/usr/bin/env bash
# Usage: scripts/changed-images.sh <base> <head>   (run from a checkout of <head> with root deps installed)
# Prints the docker-bake.hcl targets whose image inputs changed in base..head as a JSON array of
# {"image","dockerfile"}, sorted by image. An empty or unknown base, or one that is not an ancestor
# of head, selects every target.
set -euo pipefail

base=${1-}
head=${2:?usage: changed-images.sh <base> <head>}

targets=$(docker buildx bake -f docker-bake.hcl --print all 2>/dev/null |
  jq -c '[.target | to_entries[] | {image: .key, dockerfile: .value.dockerfile}] | sort_by(.image)')

if [ -z "$base" ] || ! git rev-parse -q --verify "$base^{commit}" >/dev/null ||
  ! git merge-base --is-ancestor "$base" "$head"; then
  echo "$targets"
  exit 0
fi

changed=$(git diff --name-only --no-renames "$base" "$head")
affected=$(TURBO_SCM_BASE=$base TURBO_SCM_HEAD=$head pnpm exec turbo ls --affected --output=json |
  jq -r '.packages.items[].name')

changed_exactly() { grep -qxF -e "$1" <<<"$changed"; }
changed_under() { awk -v dir="$1/" 'index($0, dir) == 1 { found = 1 } END { exit !found }' <<<"$changed"; }
root_manifest_changed() {
  changed_exactly package.json || changed_exactly pnpm-lock.yaml || changed_exactly pnpm-workspace.yaml
}

selected=()
while IFS=$'\t' read -r image dockerfile; do
  dir=$(dirname "$dockerfile")
  if changed_exactly .dockerignore || changed_exactly docker-bake.hcl ||
    changed_exactly "$dockerfile" ||
    { [ "$dir" != . ] && changed_under "$dir"; } ||
    grep -qxF -e "@jcool/$image" <<<"$affected" ||
    # turbo maps lockfile edits to packages, not to images that install the whole lockfile.
    { grep -q 'pnpm-lock.yaml' "$dockerfile" && root_manifest_changed; }; then
    selected+=("$image")
  fi
done < <(jq -r '.[] | [.image, .dockerfile] | @tsv' <<<"$targets")

jq -c '[.[] | select(.image as $i | $ARGS.positional | index($i))]' --args ${selected[@]+"${selected[@]}"} <<<"$targets"
