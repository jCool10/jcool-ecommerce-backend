import type { Provider } from '@nestjs/common';
import { makeCounterProvider } from '@willsoto/nestjs-prometheus';

export const ID_FENCE_REJECTIONS_TOTAL = 'id_fence_rejections_total';
export const ID_MINTED_TOTAL = 'id_minted_total';

export const MINT_METRIC_PROVIDERS: Provider[] = [
  makeCounterProvider({
    name: ID_FENCE_REJECTIONS_TOTAL,
    help: 'Mint requests refused with 503 LEASE_NOT_HELD because this replica held no usable lease.',
  }),
  makeCounterProvider({
    name: ID_MINTED_TOTAL,
    help: 'Ids minted, by the x-caller header the request carried.',
    labelNames: ['caller'],
  }),
];
