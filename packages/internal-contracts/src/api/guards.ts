import { isNonEmptyString, isRecord } from '../common/body-guards';
import type { CartLineBody, CartLinesResponse, SkuViewBody, SkuViewsResponse } from './types';

const isPositiveInteger = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0;
const isAmount = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;

function isCartLine(line: unknown): line is CartLineBody {
  return isRecord(line) && isNonEmptyString(line.skuId) && isPositiveInteger(line.quantity);
}

function isSkuView(view: unknown): view is SkuViewBody {
  return (
    isRecord(view) &&
    isNonEmptyString(view.skuId) &&
    typeof view.productName === 'string' &&
    (view.unitPriceMinor === null || isAmount(view.unitPriceMinor)) &&
    isNonEmptyString(view.currency) &&
    typeof view.isActive === 'boolean'
  );
}

export function isCartLinesResponse(body: unknown): body is CartLinesResponse {
  return isRecord(body) && Array.isArray(body.lines) && body.lines.every(isCartLine);
}

export function isSkuViewsResponse(body: unknown): body is SkuViewsResponse {
  return isRecord(body) && Array.isArray(body.views) && body.views.every(isSkuView);
}

/** The lines, cut down to the contract's fields, or undefined for anything but a 200 of that shape. */
export function cartLinesOf(status: number, body: unknown): CartLineBody[] | undefined {
  if (status !== 200 || !isCartLinesResponse(body)) return undefined;
  return body.lines.map(({ skuId, quantity }) => ({ skuId, quantity }));
}

export function skuViewsOf(status: number, body: unknown): SkuViewBody[] | undefined {
  if (status !== 200 || !isSkuViewsResponse(body)) return undefined;
  return body.views.map(({ skuId, productName, unitPriceMinor, currency, isActive }) => ({
    skuId,
    productName,
    unitPriceMinor,
    currency,
    isActive,
  }));
}
