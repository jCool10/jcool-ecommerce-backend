import type { EnvOverrides } from './test-app.factory';

// Duplicated as a literal in `vitest-e2e.config.mts`, which must satisfy env validation before any
// module of this repo loads.
export const E2E_IDENTITY_BUCKET_KEY = 'e2e-identity-bucket-key-not-a-real-secret-000';

/**
 * The api exactly as it ships before the cutover: its own users, sessions and HS256 tokens, and no
 * ES256 path. What the auth suites exercise for as long as the user module lives here; every other
 * suite runs as the api will after the cutover.
 */
export const LEGACY_AUTH_MODE: EnvOverrides = {
  AUTH_EPOCH_SOURCE: 'db',
  USER_DIRECTORY_SOURCE: 'local',
  AUTH_JWKS_URL: undefined,
};
