/** Also the `CheckoutStep` search attribute value, so renaming one breaks visibility queries. */
export const CheckoutSagaStep = {
  RESERVING: 'RESERVING',
  AWAITING_AUTH: 'AWAITING_AUTH',
  COMMITTING_STOCK: 'COMMITTING_STOCK',
  CAPTURING: 'CAPTURING',
  COMPLETED: 'COMPLETED',
  COMPENSATING: 'COMPENSATING',
  COMPENSATED: 'COMPENSATED',
} as const;

export type CheckoutSagaStep = (typeof CheckoutSagaStep)[keyof typeof CheckoutSagaStep];

export const CHECKOUT_SAGA_STEPS: readonly CheckoutSagaStep[] = Object.values(CheckoutSagaStep);

export const TERMINAL_SAGA_STEPS: readonly CheckoutSagaStep[] = [
  CheckoutSagaStep.COMPLETED,
  CheckoutSagaStep.COMPENSATED,
];

export function isTerminalSagaStep(step: CheckoutSagaStep): boolean {
  return TERMINAL_SAGA_STEPS.includes(step);
}

export const Compensation = {
  RELEASE_STOCK: 'RELEASE_STOCK',
  RESTOCK: 'RESTOCK',
  CANCEL_PAYMENT: 'CANCEL_PAYMENT',
} as const;

export type Compensation = (typeof Compensation)[keyof typeof Compensation];

export const COMPENSATIONS: readonly Compensation[] = Object.values(Compensation);
