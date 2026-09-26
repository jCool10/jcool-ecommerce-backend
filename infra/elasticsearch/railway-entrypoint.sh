#!/bin/sh
# Railway mounts the volume owned by root, and Elasticsearch refuses to run as root. The image has no
# setpriv or gosu, so coreutils' chroot into / does the switch to the base image's own user.
set -eu

chown -R 1000:0 /usr/share/elasticsearch/data
exec chroot --userspec=1000:0 --skip-chdir / /usr/local/bin/docker-entrypoint.sh "$@"
