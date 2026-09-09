/**
 * Reconcile bucket, `media_assets` and `product_images` against each other:
 *   npm run storage:verify -- --prefix media/ --limit 5000
 *   npm run storage:verify:prod   (compiled twin, for a container without devDependencies)
 *
 * Three ways the stores can disagree, in increasing order of seriousness:
 *
 *   orphan object — bytes no row points at: a PUT that landed after its row was swept, or anything
 *   written to the bucket outside the app. NOT a crashed sweep — that deletes the object first and
 *   the row second, so it leaves a SWEEPING row whose object is gone, which is invisible here (the
 *   key is still in `knownKeys`, and only ATTACHED rows are HEAD-ed). Nor is it this scan's own
 *   snapshot window: candidates are re-read against the database before being reported.
 *
 *   missing object — an ATTACHED row whose object is gone: a product is rendering a broken image
 *   right now.
 *
 *   dangling link — a `product_images` row whose `media_assets` row is gone. There is no FK between
 *   them (separate contexts), and the read path hides it: an id that resolves to no URL is dropped
 *   from the response rather than rendered broken, so the product silently loses an image. Checked
 *   here because this is the only place that looks at both tables.
 *
 * Read-only by design: what to do about each of the three differs and none is safe to guess. Exits 1
 * when anything is found, so a scheduled run fails loudly. Lives under `src/` because `scripts/` is
 * excluded from the build and `tsx` is a devDependency, so a `scripts/` entrypoint cannot run in the
 * image.
 */
import 'dotenv/config';
import { HeadObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { eq, inArray, isNull } from 'drizzle-orm';
import configuration from '@shared/config/configuration';
import { mediaAssets, productImages } from '@shared/infrastructure/database/schema';

const DEFAULT_PREFIX = 'media/';
const DEFAULT_LIMIT = 10_000;
// HEAD is one round trip per row; a handful in flight keeps a large catalog from taking minutes
// without turning the check itself into a load test.
const HEAD_CONCURRENCY = 8;
// Caps one re-check statement: it binds a parameter per candidate, and a bucket listing can hand
// over more candidates than Postgres accepts in a single statement.
const RECHECK_CHUNK = 1000;

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const prefix = argValue('--prefix') ?? DEFAULT_PREFIX;
  const limit = Number(argValue('--limit') ?? DEFAULT_LIMIT);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`--limit must be a positive integer, got "${argValue('--limit')}"`);
  }

  const { database, storage } = configuration();
  if (!database.url) throw new Error('DATABASE_URL is not set');
  if (!storage.endpoint || !storage.bucket || !storage.accessKeyId || !storage.secretAccessKey) {
    throw new Error(
      'STORAGE_ENDPOINT, STORAGE_BUCKET, STORAGE_ACCESS_KEY_ID and STORAGE_SECRET_ACCESS_KEY are required',
    );
  }

  const client = new S3Client({
    endpoint: storage.endpoint,
    region: storage.region,
    forcePathStyle: true,
    credentials: { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey },
  });
  const pool = new Pool({ connectionString: database.url, max: 1 });
  const db = drizzle(pool);

  try {
    const rows = await db
      .select({ id: mediaAssets.id, storageKey: mediaAssets.storageKey, status: mediaAssets.status })
      .from(mediaAssets);
    const knownKeys = new Set(rows.map((row) => row.storageKey));

    // Bucket → database. Paged: ListObjectsV2 caps at 1000 keys per response regardless of MaxKeys.
    let orphanObjects: string[] = [];
    let scanned = 0;
    let continuationToken: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({ Bucket: storage.bucket, Prefix: prefix, ContinuationToken: continuationToken }),
      );
      for (const object of page.Contents ?? []) {
        if (!object.Key) continue;
        scanned += 1;
        if (!knownKeys.has(object.Key)) orphanObjects.push(object.Key);
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken && scanned < limit);

    if (orphanObjects.length > 0) {
      // The row snapshot predates the listing, and an upload inserts its row before it PUTs, so a key
      // that appeared mid-scan is absent from `knownKeys` while being a healthy PENDING asset. Re-read
      // just the candidates before calling any of them an orphan.
      const nowKnown = new Set<string>();
      for (let offset = 0; offset < orphanObjects.length; offset += RECHECK_CHUNK) {
        const chunk = orphanObjects.slice(offset, offset + RECHECK_CHUNK);
        const rechecked = await db
          .select({ storageKey: mediaAssets.storageKey })
          .from(mediaAssets)
          .where(inArray(mediaAssets.storageKey, chunk));
        for (const row of rechecked) nowKnown.add(row.storageKey);
      }
      orphanObjects = orphanObjects.filter((key) => !nowKnown.has(key));
    }

    // Database → bucket, for the state where a missing object is user-visible. A PENDING row with
    // no object is the normal case (the upload was never made), not a discrepancy.
    const attached = rows.filter((row) => row.status === 'ATTACHED');
    const missingObjects: string[] = [];
    for (let i = 0; i < attached.length; i += HEAD_CONCURRENCY) {
      const batch = attached.slice(i, i + HEAD_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (row) => {
          try {
            await client.send(new HeadObjectCommand({ Bucket: storage.bucket, Key: row.storageKey }));
            return null;
          } catch (error) {
            if (isNotFound(error)) return `${row.id} -> ${row.storageKey}`;
            throw error;
          }
        }),
      );
      missingObjects.push(...results.filter((entry): entry is string => entry !== null));
    }

    // Catalog → Media. One join rather than a HEAD per row: the answer is entirely in Postgres.
    const danglingLinks = await db
      .select({ imageId: productImages.id, productId: productImages.productId, assetId: productImages.assetId })
      .from(productImages)
      .leftJoin(mediaAssets, eq(productImages.assetId, mediaAssets.id))
      .where(isNull(mediaAssets.id));

    console.log(`\n--- storage reconciliation (bucket ${storage.bucket}, prefix "${prefix}") ---`);
    console.log(`rows: ${rows.length}   objects scanned: ${scanned}   attached rows checked: ${attached.length}`);

    console.log(`\norphan objects (no row points at them): ${orphanObjects.length}`);
    for (const key of orphanObjects) console.log(`  ${key}`);

    console.log(`\nmissing objects (ATTACHED row, object gone): ${missingObjects.length}`);
    for (const entry of missingObjects) console.log(`  ${entry}`);

    console.log(`\ndangling links (product_images row, no media_assets row): ${danglingLinks.length}`);
    for (const link of danglingLinks) {
      console.log(`  image ${link.imageId} on product ${link.productId} -> asset ${link.assetId}`);
    }

    if (scanned >= limit) {
      console.log(`\nstopped at --limit ${limit}; re-run with a higher limit to scan the rest`);
    }
    if (orphanObjects.length > 0 || missingObjects.length > 0 || danglingLinks.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    client.destroy();
    await pool.end();
  }
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return candidate.name === 'NotFound' || candidate.$metadata?.httpStatusCode === 404;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
