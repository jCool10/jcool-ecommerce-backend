import { isNonEmptyString, isRecord } from '../common/body-guards';

export const CATALOG_SKU_SNAPSHOT_EVENT = 'catalog.product.sku-snapshot';

/** The shop sells in one currency; a snapshot in another would be priced in the wrong unit. */
export const CATALOG_SNAPSHOT_CURRENCY = 'VND';

/** A version past this would win every later comparison and freeze the consumer's rows. */
export const MAX_CATALOG_SNAPSHOT_VERSION = 2_147_483_647;

/** The int4 ceiling of the catalog's `prices.amount_minor`. */
export const MAX_CATALOG_SNAPSHOT_PRICE_MINOR = 2_147_483_647;

export interface CatalogSkuSnapshotSku {
  skuId: string;
  /** Integer minor units from 1; null while the SKU has no price. */
  unitPriceMinor: number | null;
  /** Always CATALOG_SNAPSHOT_CURRENCY. */
  currency: string;
  /** False once the product is not ACTIVE or the variant is archived; the price stays. */
  isActive: boolean;
}

/**
 * Every SKU of one product as the catalog sells it, at the product's version after the write that
 * produced it. A consumer keeps a row only while no higher version of its product has arrived.
 */
export interface CatalogSkuSnapshotPayload {
  productId: string;
  version: number;
  productName: string;
  skus: CatalogSkuSnapshotSku[];
}

const isIntegerIn = (value: unknown, min: number, max: number): boolean =>
  Number.isInteger(value) && (value as number) >= min && (value as number) <= max;

function skuDefect(sku: unknown, at: string, seen: Set<string>): string | undefined {
  if (!isRecord(sku)) return `${at} is not an object`;
  const { skuId, unitPriceMinor, currency, isActive } = sku;
  if (!isNonEmptyString(skuId)) return `${at}.skuId is not a non-empty string`;
  if (seen.has(skuId)) return `${at}.skuId repeats an earlier SKU`;
  seen.add(skuId);
  if (unitPriceMinor !== null && !isIntegerIn(unitPriceMinor, 1, MAX_CATALOG_SNAPSHOT_PRICE_MINOR)) {
    return `${at}.unitPriceMinor is not null or an integer in 1..${MAX_CATALOG_SNAPSHOT_PRICE_MINOR}`;
  }
  if (currency !== CATALOG_SNAPSHOT_CURRENCY) return `${at}.currency is not ${CATALOG_SNAPSHOT_CURRENCY}`;
  if (typeof isActive !== 'boolean') return `${at}.isActive is not a boolean`;
  return undefined;
}

/** Which bound a payload breaks, or undefined when it has none. Names fields, never quotes values. */
export function catalogSkuSnapshotDefect(payload: unknown): string | undefined {
  if (!isRecord(payload)) return 'payload is not an object';
  const { productId, version, productName, skus } = payload;
  if (!isNonEmptyString(productId)) return 'productId is not a non-empty string';
  if (!isIntegerIn(version, 0, MAX_CATALOG_SNAPSHOT_VERSION)) {
    return `version is not an integer in 0..${MAX_CATALOG_SNAPSHOT_VERSION}`;
  }
  if (!isNonEmptyString(productName)) return 'productName is not a non-empty string';
  if (productName.includes('\u0000')) return 'productName holds a NUL byte';
  if (!Array.isArray(skus)) return 'skus is not a list';
  const seen = new Set<string>();
  for (const [index, sku] of skus.entries()) {
    const defect = skuDefect(sku, `skus[${index}]`, seen);
    if (defect) return defect;
  }
  return undefined;
}

/** Shape and bounds only; whether the ids are routable is the consumer's call. */
export function isCatalogSkuSnapshotPayload(payload: unknown): payload is CatalogSkuSnapshotPayload {
  return catalogSkuSnapshotDefect(payload) === undefined;
}

/** Throws rather than let the producer publish what every consumer would dead-letter. */
export function catalogSkuSnapshotPayload(facts: CatalogSkuSnapshotPayload): CatalogSkuSnapshotPayload {
  const payload: CatalogSkuSnapshotPayload = {
    productId: facts.productId,
    version: facts.version,
    productName: facts.productName,
    skus: facts.skus.map(({ skuId, unitPriceMinor, currency, isActive }) => ({
      skuId,
      unitPriceMinor,
      currency,
      isActive,
    })),
  };
  const defect = catalogSkuSnapshotDefect(payload);
  if (defect) throw new RangeError(`refusing a ${CATALOG_SKU_SNAPSHOT_EVENT} of product ${facts.productId}: ${defect}`);
  return payload;
}
