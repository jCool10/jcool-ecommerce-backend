import { vi } from 'vitest';
import type { PaymentGatewayPort } from '../application/ports/payment-gateway.port';
import type { PaymentOrderRepositoryPort } from '../application/ports/payment-order-repository.port';
import type { PaymentRepositoryPort } from '../application/ports/payment-repository.port';

/**
 * Whole-port doubles for Payment's outbound seams. They live here rather than in
 * `@jcool/testing` because they name this context's ports, and a shared package may not import a context.
 *
 * Every method is present so the spec passes a real port instead of casting a one-method literal,
 * a cast that keeps compiling once the use case starts calling a second method, then fails at
 * runtime with "not a function" inside whichever test happens to reach it first.
 */
export function fakePaymentRepository(overrides: Partial<PaymentRepositoryPort> = {}): PaymentRepositoryPort {
  return {
    create: vi.fn(),
    findByOrderId: vi.fn(),
    findByProviderSessionId: vi.fn(),
    updateStatus: vi.fn(),
    findActiveByOrderIdForUpdate: vi.fn(),
    findStaleTcc: vi.fn(),
    bumpUpdatedAt: vi.fn(),
    incrementKeyGen: vi.fn(),
    ...overrides,
  };
}

export function fakePaymentGateway(overrides: Partial<PaymentGatewayPort> = {}): PaymentGatewayPort {
  return {
    provider: 'stripe',
    createSession: vi.fn(),
    verifyAndParseEvent: vi.fn(),
    getPaymentStatus: vi.fn(),
    retrieveSession: vi.fn(),
    expireSession: vi.fn(),
    retrieveAuthorization: vi.fn(),
    captureIntent: vi.fn(),
    voidIntent: vi.fn(),
    ...overrides,
  };
}

export function fakePaymentOrderRepository(
  overrides: Partial<PaymentOrderRepositoryPort> = {},
): PaymentOrderRepositoryPort {
  return {
    insertOpen: vi.fn(),
    insertFenced: vi.fn(),
    findForUpdate: vi.fn(),
    find: vi.fn(),
    update: vi.fn(),
    findParticipantStatuses: vi.fn(),
    ...overrides,
  };
}
