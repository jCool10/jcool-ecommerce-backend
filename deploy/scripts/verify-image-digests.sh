#!/usr/bin/env bash
# Usage: deploy/scripts/verify-image-digests.sh   (needs gh with a token: `gh auth login`, or GH_TOKEN in CI)
# Every digest pinned in deploy/images must carry a provenance attestation from delivery.yml on main,
# so a digest pushed by hand or built on a branch never reaches a cluster.
set -euo pipefail

repo=jCool10/jcool-ecommerce-backend
component=$(cd "$(dirname "$0")/../images" && pwd)/kustomization.yaml
failed=0

while read -r name digest; do
  if [ -z "$digest" ]; then
    echo "not pinned by digest: $name" >&2
    failed=1
    continue
  fi
  if gh attestation verify "oci://$name@$digest" -R "$repo" \
    --signer-workflow "$repo/.github/workflows/delivery.yml" \
    --source-ref refs/heads/main --deny-self-hosted-runners </dev/null >/dev/null; then
    echo "verified $name@$digest"
  else
    echo "no attestation from delivery.yml on main: $name@$digest" >&2
    failed=1
  fi
done < <(yq -r '.images[] | .name + " " + (.digest // "")' "$component")

exit "$failed"
