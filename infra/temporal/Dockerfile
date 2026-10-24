# Built from the repository root, like every service: docker build -f infra/temporal/Dockerfile .
# temporalio/server only runs the server; the schema tool, the CLI and the Postgres schema come
# from admin-tools, so the one container bootstraps its own databases, namespace and search
# attributes (entrypoint.sh). auto-setup is deprecated and not used.
FROM temporalio/admin-tools:1.32.1 AS tools

FROM temporalio/server:1.32.1
COPY --from=tools /usr/local/bin/temporal /usr/local/bin/temporal-sql-tool /usr/local/bin/
COPY --from=tools /etc/temporal/schema/postgresql /etc/temporal/schema/postgresql
COPY infra/temporal/config/config_template.yaml /etc/temporal/config/config_template.yaml
COPY infra/temporal/dynamicconfig/production.yaml /etc/temporal/config/dynamicconfig/production.yaml
COPY --chmod=0755 infra/temporal/entrypoint.sh /etc/temporal/bootstrap.sh
# The server's own template would open the HTTP API on 7243; this one only serves gRPC on 7233.
ENV DB=postgres12 \
    TEMPORAL_SERVER_CONFIG_FILE_PATH=/etc/temporal/config/config_template.yaml \
    DYNAMIC_CONFIG_FILE_PATH=/etc/temporal/config/dynamicconfig/production.yaml
EXPOSE 7233
ENTRYPOINT ["/etc/temporal/bootstrap.sh"]
