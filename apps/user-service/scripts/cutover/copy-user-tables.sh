#!/bin/sh
# Moves the five user tables between the api's database and this service's, data only.
#
#   API_DATABASE_URL=… USER_DATABASE_URL=… copy-user-tables.sh [--reverse]
#
# Forward (api → user-service) is the cutover; --reverse is the rollback. Both directions run the
# same code, so the rollback is not a path first taken during an incident. Writes to /auth must be
# frozen and drained first: this copies a moment, not a stream.
#
# Rows land in a temp directory that holds password and token hashes until the script exits.
set -eu

usage() {
  echo "usage: API_DATABASE_URL=… USER_DATABASE_URL=… $0 [--reverse]" >&2
  exit 64
}

reverse=false
case "${1:-}" in
  '') ;;
  --reverse) reverse=true ;;
  *) usage ;;
esac

: "${API_DATABASE_URL:?API_DATABASE_URL is required}"
: "${USER_DATABASE_URL:?USER_DATABASE_URL is required}"
if [ "$API_DATABASE_URL" = "$USER_DATABASE_URL" ]; then
  echo "refusing to copy a database onto itself" >&2
  exit 1
fi

if [ "$reverse" = true ]; then
  source_url=$USER_DATABASE_URL
  target_url=$API_DATABASE_URL
else
  source_url=$API_DATABASE_URL
  target_url=$USER_DATABASE_URL
fi

# Parents before children; identity_key_pin stands alone.
TABLES='users email_verification_tokens password_reset_tokens refresh_tokens identity_key_pin'

# Spelled out because production added email_verified_at and token_epoch by ALTER: the physical
# column order there is not the order of the baseline this service was generated from, and a
# positional COPY would load the right values into the wrong columns.
columns_of() {
  case "$1" in
    users) echo 'id, email, password_hash, role, email_verified_at, token_epoch, created_at, updated_at' ;;
    email_verification_tokens | password_reset_tokens) echo 'id, user_id, token_hash, expires_at, consumed_at, created_at' ;;
    refresh_tokens) echo 'id, user_id, token_hash, family_id, replaced_by_token_id, expires_at, revoked_at, created_at' ;;
    identity_key_pin) echo 'id, fingerprint, pinned_at' ;;
    *)
      echo "no column list for $1" >&2
      exit 1
      ;;
  esac
}

work=$(mktemp -d)
chmod 700 "$work"
trap 'rm -rf "$work"' EXIT INT TERM

run_psql() {
  url=$1
  shift
  psql "$url" --no-psqlrc --quiet --pset=pager=off -v ON_ERROR_STOP=1 "$@"
}

for table in $TABLES; do
  run_psql "$source_url" -c "\\copy (SELECT $(columns_of "$table") FROM $table ORDER BY id) TO '$work/$table.tsv'"
done

load="$work/load.sql"
: > "$load"
if [ "$reverse" = true ]; then
  # CASCADE reaches the three token tables and stops: nothing else in the api references users.
  printf 'TRUNCATE %s CASCADE;\n' "$(echo "$TABLES" | tr ' ' ',')" >> "$load"
else
  # A dark boot may have pinned a key here; the api's pin is the one the ids were minted under.
  printf 'DELETE FROM identity_key_pin;\n' >> "$load"
fi
for table in $TABLES; do
  printf "\\\\copy %s (%s) FROM '%s'\n" "$table" "$(columns_of "$table")" "$work/$table.tsv" >> "$load"
done

# One transaction: a target left half-copied has no owner of the user data at all.
run_psql "$target_url" --single-transaction -f "$load"

for table in $TABLES; do
  printf '%s: %s rows\n' "$table" "$(wc -l < "$work/$table.tsv" | tr -d ' ')"
done
echo 'copy done — verify before opening writes'
