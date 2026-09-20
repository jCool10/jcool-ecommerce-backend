# Built from the repository root, like every service: docker build -f infra/prometheus/Dockerfile .
FROM prom/prometheus:v2.55.1
# Railway mounts a volume owned by root; the base image runs as nobody and could not write /prometheus.
USER root
COPY infra/prometheus/prometheus.railway.yml /etc/prometheus/prometheus.railway.yml
COPY infra/prometheus/rules /etc/prometheus/rules
COPY infra/prometheus/railway-entrypoint.sh /usr/local/bin/prometheus-entrypoint.sh
ENTRYPOINT ["/bin/sh", "/usr/local/bin/prometheus-entrypoint.sh"]
# Setting ENTRYPOINT clears the CMD inherited from the base image.
CMD []
