# Built from the repository root, like every service: docker build -f infra/loki/Dockerfile .
FROM grafana/loki:3.7.8
# Railway mounts a volume owned by root; the base image runs as loki (10001) and could not write /loki.
USER root
COPY infra/loki/config.yaml /etc/loki/config.yaml
CMD ["-config.file=/etc/loki/config.yaml", "-config.expand-env=true"]
