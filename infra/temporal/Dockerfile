FROM temporalio/admin-tools:1.32.1 AS admin

FROM temporalio/server:1.32.1
COPY --from=admin /usr/local/bin/temporal /usr/local/bin/temporal
COPY --from=admin /usr/local/bin/temporal-sql-tool /usr/local/bin/temporal-sql-tool
COPY --from=admin /etc/temporal/schema/postgresql/v12 /etc/temporal/schema/postgresql/v12
COPY infra/temporal/entrypoint.sh /etc/temporal/jcool-entrypoint.sh
COPY infra/temporal/dynamicconfig/production.yaml /etc/temporal/dynamicconfig/production.yaml
ENV DYNAMIC_CONFIG_FILE_PATH=/etc/temporal/dynamicconfig/production.yaml
ENTRYPOINT ["/etc/temporal/jcool-entrypoint.sh"]
