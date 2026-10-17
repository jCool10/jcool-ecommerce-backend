#!/bin/sh
# Railway mounts the volume owned by root, and the broker runs as the image's appuser (1000). The image's
# setpriv and su are BusyBox, so coreutils' chroot into / does the switch, as for Elasticsearch. chroot
# keeps the environment, so every KAFKA_* setting still reaches the image's own entrypoint, and exec
# leaves the JVM to receive SIGTERM itself.
set -eu

chown -R 1000:1000 /var/lib/kafka/data
export HOME=/home/appuser
exec chroot --userspec=1000:1000 --skip-chdir / /__cacert_entrypoint.sh "$@"
