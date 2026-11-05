#!/usr/bin/env bash
# Usage: deploy/scripts/init-secrets.sh
# Writes each $JCOOL_SECRETS_DIR/<name>.env (default ~/.config/jcool/prod) that does not exist yet, one per
# deploy/secrets/<name>.env.example: random values for the Secrets the cluster owns, empty keys for the
# ones an outside service issues. Never overwrites a file and never prints a value.
set -euo pipefail

deploy_dir=$(cd "$(dirname "$0")/.." && pwd)
secrets_dir=${JCOOL_SECRETS_DIR:-$HOME/.config/jcool/prod}
generated=" postgres-credentials redis internal-tokens metrics-token user-service-keys search grafana "
kid=prod-$(date +%Y%m%d)

umask 077
mkdir -p "$secrets_dir"
chmod 700 "$secrets_dir"

keys_of() { grep -E '^[A-Z][A-Z0-9_]*=' "$1" | cut -d= -f1; }

value_for() {
  case $1 in
    *_PREVIOUS) ;;
    JWT_ES256_ACTIVE_KID) printf '%s' "$kid" ;;
    # kid:pem on one line with literal \n, the format the user-service parses.
    JWT_ES256_PRIVATE_KEYS)
      printf '%s:' "$kid"
      openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 | awk '{ printf "%s\\n", $0 }'
      ;;
    *) openssl rand -hex 32 ;;
  esac
}

to_fill=""
for example in "$deploy_dir"/secrets/*.env.example; do
  name=$(basename "$example" .env.example)
  file=$secrets_dir/$name.env
  if [ -e "$file" ]; then
    echo "kept      $name"
    continue
  fi
  if [[ $generated == *" $name "* ]]; then
    keys_of "$example" | while read -r key; do
      printf '%s=%s\n' "$key" "$(value_for "$key")"
    done >"$file.tmp"
    echo "generated $name"
  else
    keys_of "$example" | sed 's/$/=/' >"$file.tmp"
    to_fill="$to_fill $name"
    echo "empty     $name"
  fi
  mv "$file.tmp" "$file"
done

if [ -n "$to_fill" ]; then
  echo
  echo "Fill these in by hand; their .env.example says where each value comes from:"
  for name in $to_fill; do
    echo "  $secrets_dir/$name.env"
  done
fi
echo "Then back the directory up in the password manager: $secrets_dir"
