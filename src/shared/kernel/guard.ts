import { DomainError } from './domain-error';

/** Primitive invariant guards shared by value objects and aggregates; each throws `DomainError` (never a bare Error) so every business-rule breach maps to the same interface-layer response. */

export function assertNonEmpty(value: string | null | undefined, label: string): void {
  if (value === null || value === undefined || value.trim().length === 0) {
    throw new DomainError(`${label} must not be empty`);
  }
}

export function assertInteger(value: number, label: string): void {
  if (!Number.isInteger(value)) {
    throw new DomainError(`${label} must be an integer`);
  }
}

export function assertPositive(value: number, label: string): void {
  if (!(value > 0)) {
    throw new DomainError(`${label} must be positive`);
  }
}

export function assertMaxLen(value: string, max: number, label: string): void {
  if (value.length > max) {
    throw new DomainError(`${label} must be at most ${max} characters`);
  }
}
