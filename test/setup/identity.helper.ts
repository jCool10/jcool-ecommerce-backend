import { bucketForEmail } from '@shared/identity';
import { normalizeEmail } from '@shared/kernel/normalize-email';

// Duplicated as a literal in `vitest-e2e.config.mts`, which must satisfy env validation before any
// module of this repo loads.
export const E2E_IDENTITY_BUCKET_KEY = 'e2e-identity-bucket-key-not-a-real-secret-000';

export const WRONG_IDENTITY_BUCKET_KEY = 'e2e-identity-bucket-key-a-different-one-001';

export function bucketForTestEmail(email: string, key: string = E2E_IDENTITY_BUCKET_KEY): number {
  return bucketForEmail(normalizeEmail(email), key);
}
