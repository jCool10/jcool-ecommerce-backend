# user-service

Owns users, sessions and every `/auth` route, from its own Postgres, and signs the ES256 access tokens every other service verifies from its JWKS. It is the only writer of the `auth:*` keys in Redis.

The gateway sends `/auth` and `/.well-known/jwks.json` here; the api serves everything else and only verifies what this service signed.

## API

`/auth/*`: routes, DTOs, status codes, error envelope, cookies (`refresh_token`, `csrf_token` on `Path=/auth`) and throttles. The OpenAPI document is at `/auth/docs` when `SWAGGER_ENABLED` is on.

| Route | Answer |
| --- | --- |
| `GET /.well-known/jwks.json` | Public half of every key in `JWT_ES256_PRIVATE_KEYS`, `alg: ES256`, `use: sig`. `Cache-Control: public, max-age=300`. |
| `GET /internal/v1/users/:id/summary` | `{ id, email, role }`, `404` for an unknown id. |
| `GET /internal/v1/sessions/:userId/epoch` | `{ epoch }` from Postgres, after raising `auth:epoch:{userId}` to it. `404` for an unknown user. |
| `GET /health/live`, `GET /health/ready` | As in the api. |

`/internal/*` takes `Authorization: Bearer <INTERNAL_API_TOKEN>` (or `INTERNAL_API_TOKEN_PREVIOUS` while rotating). It is unthrottled, left out of the OpenAPI document, and answered with 404 by the gateway.

### Access tokens

Header `{ alg: "ES256", kid, typ: "JWT" }`, claims `sub`, `role`, `epoch`, `jti`, `iss` (`JWT_ISSUER`), `aud` (`JWT_AUDIENCE`), `iat`, `exp`. `@jcool/auth-verifier` checks the signature, then the denylist, then the epoch. ES256 is its only verification path: any other `alg` is refused before its signature is looked at.

## Published Language: Redis keys

Both keys live in the api's Redis and are read by every verifier. Their names and values are a contract; change them only with every reader.

| Key | Value | Written by | Meaning |
| --- | --- | --- | --- |
| `auth:denylist:{jti}` | `1`, with `PX` = the token's remaining life | logout | That access token is revoked. The key expires with the token. |
| `auth:epoch:{userId}` | Decimal integer, no expiry | every epoch bump, signup, the reconciler, the internal epoch route | Tokens carrying a lower `epoch` are revoked. |

`auth:epoch:*` only ever rises: every write is one Lua `SET`-if-greater, so a read-through fill racing a bump settles on the larger value. A bump updates Postgres first, then Redis, retrying three times; if Redis still fails, the request answers 5xx. Every `SESSION_EPOCH_RECONCILE_INTERVAL_MS` a reconciler re-publishes the epochs of users whose rows changed since its last pass, so a lost epoch write is repaired within one interval.

Nothing repairs `auth:denylist:*`. A failed write fails the logout with 5xx; a write Redis acknowledged and then lost (AOF `everysec` can drop the last second) leaves that one access token valid until it expires, at most `JWT_ACCESS_TTL`. The refresh token is revoked in Postgres, independently of that write.

The service refuses to boot, and so does the api that reads these keys, unless Redis reports `maxmemory_policy:noeviction` and `aof_enabled:1`: an evicted or unpersisted key is a revoked session that comes back. See [RUNBOOK.md, "Redis durability"](../../RUNBOOK.md#redis-durability).

## Ids

Every id is a UUIDv8 minted by the id-service through the gateway's internal load balancer (`ID_SERVICE_URL`), with a `x-caller: user-service` header. There is no local generator in `src/`, and dependency-cruiser keeps it that way. The call has one overall timeout and a circuit breaker, and is not retried here: the gateway already retries across replicas. When no id can be minted, the request answers `503` and writes nothing. A refresh mints its successor id only after the presented token proved rotatable, so an expired, revoked or replayed token is refused without calling the id-service.

## Configuration

Besides the platform variables (`NODE_ENV`, `PORT`, `DATABASE_URL`, `DB_*`, `REDIS_URL`, `LOG_LEVEL`, `TRUST_PROXY`, `APP_PUBLIC_URL`, `CORS_ORIGINS`, `SWAGGER_ENABLED`, `SMTP_URL`, `MAIL_FROM`, `THROTTLE_*`, `RETENTION_*`, `METRICS_TOKEN`):

| Variable | Default | |
| --- | --- | --- |
| `IDENTITY_BUCKET_KEY` | required | The key every existing user id was minted under. Permanent. |
| `IDENTITY_PIN_BOOTSTRAP` | `false` | `true` writes the key pin on an empty database. Off, the boot only compares. |
| `JWT_ES256_PRIVATE_KEYS` | required | `kid:pem[,kid:pem]`, P-256 only; `\n` escapes are accepted in the PEM. |
| `JWT_ES256_ACTIVE_KID` | required | The kid that signs. It must be in the list. |
| `JWT_ISSUER`, `JWT_AUDIENCE` | required | Stamped on every token and pinned by verifiers. |
| `JWT_ACCESS_TTL` | `5m` | How long a revoked-but-unexpired token stays usable. |
| `CSRF_SECRET` | required | Rotating it invalidates every CSRF cookie in circulation. |
| `REFRESH_TOKEN_TTL`, `EMAIL_VERIFICATION_TTL`, `PASSWORD_RESET_TTL`, `AUTH_REQUIRE_VERIFIED_EMAIL`, `ARGON2_*` | `7d`, `24h`, `1h`, `false`, argon2id defaults | |
| `ID_SERVICE_URL` | required | The gateway's internal listener, never a replica. |
| `ID_SERVICE_TIMEOUT_MS` | `2000` | Covers the gateway's retries, not one attempt. |
| `INTERNAL_API_TOKEN` | required | At least 32 characters. |
| `INTERNAL_API_TOKEN_PREVIOUS` | unset | Also accepted, while callers move to a new token. |
| `SESSION_EPOCH_RECONCILE_ENABLED` | `true` | |
| `SESSION_EPOCH_RECONCILE_INTERVAL_MS` | `5000` | |
| `RETENTION_AUTH_TOKEN_GRACE_DAYS` | `7` | |
| `RETENTION_REFRESH_TOKEN_GRACE_DAYS` | `30` | At least 30: a revoked token that comes back is the reuse signal. |

Key and token rotation: [RUNBOOK.md](../../RUNBOOK.md#rotate-the-es256-signing-key).

## Scripts

Run from the repo root (`pnpm <script>`), each reading `apps/user-service/.env`. They mint ids in-process on the scripts' node id, not through the id-service.

| Script | |
| --- | --- |
| `identity:verify` | Scan every user row for an id that does not route to its email's bucket. Exits non-zero on a finding. |
| `db:seed:perf-user` | The verified load-test account; `--clean` removes it. Run before the api's `db:seed:perf`. |
| `seed:users:bulk` | Synthetic users for the register-uniqueness benchmark; `--clean` removes them. |
| `db:metrics:users` | Size, cache-hit and vacuum readings for `users`. |

## Local

```bash
cp apps/user-service/.env.example apps/user-service/.env      # then fill IDENTITY_BUCKET_KEY and a key pair
docker compose --profile user-service up -d --build user-service   # user-postgres, a one-shot migrate, the service
curl -s http://127.0.0.1:3002/.well-known/jwks.json
pnpm --filter @jcool/user-service test                        # unit
pnpm --filter @jcool/user-service test:e2e                    # Postgres, Redis and Mailpit via Testcontainers
```
