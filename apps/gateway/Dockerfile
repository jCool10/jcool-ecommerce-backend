# Built from the repository root, like every service: docker build -f apps/gateway/Dockerfile .
FROM caddy:2.11.4-alpine
COPY apps/gateway/Caddyfile /etc/caddy/Caddyfile
COPY apps/gateway/entrypoint.sh /usr/local/bin/gateway-entrypoint.sh
# A config that does not parse fails the build, not the deploy. The upstreams only need a value here.
RUN API_UPSTREAM=api:3000 AUTH_UPSTREAM=api:3000 caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
ENTRYPOINT ["/bin/sh", "/usr/local/bin/gateway-entrypoint.sh"]
# Setting ENTRYPOINT clears the CMD inherited from the base image.
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
