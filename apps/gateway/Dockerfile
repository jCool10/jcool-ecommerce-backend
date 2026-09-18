FROM caddy:2.11.4-alpine
COPY Caddyfile /etc/caddy/Caddyfile
# A config that does not parse fails the build, not the deploy.
RUN caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
