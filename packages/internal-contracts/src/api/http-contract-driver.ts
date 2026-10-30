import { BAD_BATCH, type ApiReadContractDriver } from './contract-cases';
import { cartLinesOf, skuViewsOf } from './guards';
import { apiReadRoutes } from './routes';

export interface ApiReadHttpContractDriverOptions extends Pick<
  ApiReadContractDriver,
  'newId' | 'seedSku' | 'seedCart'
> {
  baseUrl: string;
  token: string;
}

/** Drives the reads exactly as the order-service does, failing on any answer the contract does not name. */
export function apiReadHttpContractDriver({
  baseUrl,
  token,
  ...arrange
}: ApiReadHttpContractDriverOptions): ApiReadContractDriver {
  const send = async (path: string, body?: unknown) => {
    const response = await fetch(new URL(path, baseUrl), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json().catch(() => null)) as unknown };
  };
  const unexpected = (path: string, answer: { status: number; body: unknown }) =>
    new Error(`${path} answered ${answer.status} ${JSON.stringify(answer.body)}`);

  return {
    ...arrange,
    async cartLines(userId) {
      const path = apiReadRoutes.cartLines(userId);
      const answer = await send(path);
      const lines = cartLinesOf(answer.status, answer.body);
      if (!lines) throw unexpected(path, answer);
      return lines;
    },
    async skuViews(skuIds) {
      const answer = await send(apiReadRoutes.skuViews, { skuIds });
      if (answer.status === 400) return BAD_BATCH;
      const views = skuViewsOf(answer.status, answer.body);
      if (!views) throw unexpected(apiReadRoutes.skuViews, answer);
      return views;
    },
  };
}
