import { DomainError } from './domain-error';

export function assertNonEmpty(value: string | null | undefined, label: string): void {
  if (value === null || value === undefined || value.trim().length === 0) {
    throw new DomainError(`${label} must not be empty`);
  }
}

// Safe range only: past 2^53 a number is no longer an exact count, so sums and products drift.
export function assertInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new DomainError(`${label} must be a safe integer`);
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
