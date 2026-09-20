import { bucketForEmail } from '@jcool/id-codec';
import { normalizeEmail } from '@jcool/kernel';
import { E2E_IDENTITY_BUCKET_KEY } from './e2e-constants';

export { E2E_IDENTITY_BUCKET_KEY };

export const WRONG_IDENTITY_BUCKET_KEY = 'e2e-identity-bucket-key-a-different-one-001';

export function bucketForTestEmail(email: string, key: string = E2E_IDENTITY_BUCKET_KEY): number {
  return bucketForEmail(normalizeEmail(email), key);
}
