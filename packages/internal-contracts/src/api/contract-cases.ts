import { isDeepStrictEqual } from 'node:util';
import { ContractMismatch } from '../common/contract-mismatch';
import { type CartLineBody, MAX_SKU_VIEW_BATCH, type SkuViewBody } from './types';

/** What a request outside the contract's batch bounds answers: a 400, never a partial read. */
export const BAD_BATCH = 'BAD_BATCH';
export type BadBatch = typeof BAD_BATCH;

export interface CatalogSkuSeed {
  /** In CURRENCY; null leaves the SKU without a price. */
  priceMinor: number | null;
  productStatus?: 'ACTIVE' | 'DRAFT' | 'ARCHIVED';
  variantArchived?: boolean;
}

export interface SeededSku {
  skuId: string;
  productName: string;
}

/** One way of reaching the reads: the api's in-process ports, the api over HTTP, or a stub of it. */
export interface ApiReadContractDriver {
  newId(): string;
  /** A product with one variant, the SKU. */
  seedSku(sku: CatalogSkuSeed): Promise<SeededSku>;
  /** A fresh user whose cart holds these lines, added in this order. */
  seedCart(lines: CartLineBody[]): Promise<string>;
  cartLines(userId: string): Promise<CartLineBody[]>;
  skuViews(skuIds: string[]): Promise<SkuViewBody[] | BadBatch>;
}

interface ExpectedView {
  unitPriceMinor: number | null;
  isActive: boolean;
}

/** SKUs are named; the runner seeds each and gives a name it never seeded a fresh, unknown id. */
export type ApiReadContractCase = {
  name: string;
  skus: Record<string, CatalogSkuSeed>;
  /** A bad batch has no request to refuse in-process, so only an HTTP runner takes it. */
  httpOnly?: boolean;
} & (
  | { op: 'cart'; cart?: [sku: string, quantity: number][]; expect: [sku: string, quantity: number][] }
  | { op: 'views'; read: string[]; expect: Record<string, ExpectedView> }
  | { op: 'badBatch'; size: number }
);

export const CURRENCY = 'VND';

const priced = (priceMinor: number, rest: Omit<CatalogSkuSeed, 'priceMinor'> = {}): CatalogSkuSeed => ({
  priceMinor,
  ...rest,
});

export const API_READ_CONTRACT_CASES: ApiReadContractCase[] = [
  {
    name: 'a user with no cart reads no lines, not a 404',
    skus: {},
    op: 'cart',
    expect: [],
  },
  {
    name: 'cart lines come back in the order they were added',
    skus: { a: priced(10_000), b: priced(20_000), c: priced(30_000) },
    op: 'cart',
    cart: [
      ['c', 1],
      ['a', 2],
      ['b', 3],
    ],
    expect: [
      ['c', 1],
      ['a', 2],
      ['b', 3],
    ],
  },
  {
    name: 'an id the catalog does not know is left out',
    skus: { live: priced(100_000) },
    op: 'views',
    read: ['live', 'unknown'],
    expect: { live: { unitPriceMinor: 100_000, isActive: true } },
  },
  {
    name: 'an archived product reads inactive and keeps its price',
    skus: { sku: priced(50_000, { productStatus: 'ARCHIVED' }) },
    op: 'views',
    read: ['sku'],
    expect: { sku: { unitPriceMinor: 50_000, isActive: false } },
  },
  {
    name: 'an archived variant reads inactive and keeps its price',
    skus: { sku: priced(50_000, { variantArchived: true }) },
    op: 'views',
    read: ['sku'],
    expect: { sku: { unitPriceMinor: 50_000, isActive: false } },
  },
  {
    name: 'a draft product reads inactive',
    skus: { sku: priced(50_000, { productStatus: 'DRAFT' }) },
    op: 'views',
    read: ['sku'],
    expect: { sku: { unitPriceMinor: 50_000, isActive: false } },
  },
  {
    name: 'an unpriced SKU reads a null price and stays active',
    skus: { sku: { priceMinor: null } },
    op: 'views',
    read: ['sku'],
    expect: { sku: { unitPriceMinor: null, isActive: true } },
  },
  {
    // The unknown id goes first: a reader keyed by position would slide every later view onto it.
    name: 'a mixed batch keys every view to its own skuId',
    skus: {
      live: priced(100_000),
      archived: priced(50_000, { productStatus: 'ARCHIVED' }),
      unpriced: { priceMinor: null },
      retired: priced(7_000, { variantArchived: true }),
    },
    op: 'views',
    read: ['gone', 'live', 'archived', 'unpriced', 'retired'],
    expect: {
      live: { unitPriceMinor: 100_000, isActive: true },
      archived: { unitPriceMinor: 50_000, isActive: false },
      unpriced: { unitPriceMinor: null, isActive: true },
      retired: { unitPriceMinor: 7_000, isActive: false },
    },
  },
  { name: 'a read of no ids is refused', skus: {}, httpOnly: true, op: 'badBatch', size: 0 },
  {
    name: 'a read of more ids than one batch is refused',
    skus: {},
    httpOnly: true,
    op: 'badBatch',
    size: MAX_SKU_VIEW_BATCH + 1,
  },
];

export async function runApiReadContractCase(
  driver: ApiReadContractDriver,
  testCase: ApiReadContractCase,
): Promise<void> {
  const seeded = new Map<string, SeededSku>();
  for (const [name, seed] of Object.entries(testCase.skus)) {
    seeded.set(name, await driver.seedSku(seed));
  }
  const unknown = new Map<string, string>();
  const idOf = (name: string): string => {
    const known = seeded.get(name)?.skuId ?? unknown.get(name);
    if (known !== undefined) return known;
    const id = driver.newId();
    unknown.set(name, id);
    return id;
  };
  const check = (expected: unknown, actual: unknown) => {
    if (!isDeepStrictEqual(actual, expected)) throw new ContractMismatch(1, testCase.op, expected, actual);
  };

  switch (testCase.op) {
    case 'cart': {
      const toLines = (lines: [string, number][]) => lines.map(([name, quantity]) => ({ skuId: idOf(name), quantity }));
      const userId = testCase.cart ? await driver.seedCart(toLines(testCase.cart)) : driver.newId();
      check(toLines(testCase.expect), await driver.cartLines(userId));
      return;
    }
    case 'views': {
      const views = await driver.skuViews(testCase.read.map(idOf));
      if (views === BAD_BATCH) return check(testCase.expect, views);
      const nameOf = new Map(testCase.read.map((name) => [idOf(name), name]));
      // Keyed by name and compared whole, so a missing, extra or repeated view all fail alike.
      const actual = Object.fromEntries(views.map((view) => [nameOf.get(view.skuId) ?? view.skuId, view]));
      const expected = Object.fromEntries(
        Object.entries(testCase.expect).map(([name, view]) => [
          name,
          { skuId: idOf(name), productName: seeded.get(name)?.productName, currency: CURRENCY, ...view },
        ]),
      );
      check(Object.keys(expected).length, views.length);
      check(expected, actual);
      return;
    }
    case 'badBatch':
      check(BAD_BATCH, await driver.skuViews(Array.from({ length: testCase.size }, () => driver.newId())));
  }
}
