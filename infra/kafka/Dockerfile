# Built from the repository root, like every service: docker build -f infra/kafka/Dockerfile .
FROM apache/kafka:4.3.1
# Starts as root only to hand Railway's root-owned volume to appuser; the entrypoint then drops to it.
USER root
COPY infra/kafka/railway-entrypoint.sh /usr/local/bin/railway-entrypoint.sh
ENTRYPOINT ["/bin/sh", "/usr/local/bin/railway-entrypoint.sh"]
# Setting ENTRYPOINT clears the CMD inherited from the base image.
CMD ["/etc/kafka/docker/run"]
