import { ValueObject, DomainError } from '../../../shared/kernel';
import { normalizeEmail } from './normalize-email';

interface EmailProps {
  value: string;
}

/**
 * A user's email as a domain value: the single place that both canonicalizes
 * (trim + lowercase, via `normalizeEmail`) and validates shape. Register and
 * login construct `Email.of(...)` so the same normalization feeds the
 * case-sensitive unique index — no more scattered `normalizeEmail` calls.
 *
 * The register/login DTO's `@IsEmail` remains the primary HTTP gate (400); this
 * minimal check is the domain backstop, deliberately loose (no RFC pedantry).
 */
export class Email extends ValueObject<EmailProps> {
  private static readonly PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

  private constructor(props: EmailProps) {
    super(props);
  }

  static of(raw: string): Email {
    const value = normalizeEmail(raw);
    if (!Email.PATTERN.test(value)) {
      throw new DomainError('Email is not a valid address');
    }
    return new Email({ value });
  }

  get value(): string {
    return this.props.value;
  }
}
