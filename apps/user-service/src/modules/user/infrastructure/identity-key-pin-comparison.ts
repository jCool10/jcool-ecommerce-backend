import { LAYOUT_VERSION, identityKeyFingerprint } from '@jcool/id-codec';

/** What a database was built under, as its `identity_key_pin` row records it. */
export interface IdentityPin {
  fingerprint: string;
  layoutVersion: number;
}

export const runningIdentityPin = (bucketKey: string): IdentityPin => ({
  fingerprint: identityKeyFingerprint(bucketKey),
  layoutVersion: LAYOUT_VERSION,
});

/** Null when the running build may use the pinned database, otherwise the reason it may not. */
export function identityPinMismatch(pinned: IdentityPin, running: IdentityPin): string | null {
  if (pinned.fingerprint !== running.fingerprint) {
    return (
      `IDENTITY_BUCKET_KEY does not match the key this database was built with ` +
      `(pinned ${pinned.fingerprint}, current ${running.fingerprint}). The key is permanent: booting ` +
      `under a different one routes every new id to a shard that will not hold its rows. ` +
      `Restore the original key, or reset the database if it holds nothing worth keeping.`
    );
  }
  if (pinned.layoutVersion !== running.layoutVersion) {
    return (
      `The id layout does not match the one this database was built with (pinned ` +
      `${pinned.layoutVersion}, current ${running.layoutVersion}). The epoch and the field widths are ` +
      `permanent: every stored id decodes into different fields under another layout (a new epoch ` +
      `moves every timestamp; a width change can move the bucket too). Restore the original build, ` +
      `or reset the database if it holds nothing worth keeping.`
    );
  }
  return null;
}
