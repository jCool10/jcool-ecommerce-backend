# Built from the repository root, like every service: docker build -f infra/grafana/Dockerfile .
#
# No volume on Railway: datasources and dashboards are provisioned from these files on every start,
# so the only state lost on redeploy is ad-hoc UI edits.
FROM grafana/grafana:11.3.0
COPY infra/grafana/provisioning /etc/grafana/provisioning
COPY infra/grafana/railway/datasources.yml /etc/grafana/provisioning/datasources/datasources.yml
