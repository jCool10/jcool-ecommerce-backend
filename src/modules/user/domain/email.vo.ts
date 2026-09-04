import { ValueObject, DomainError, normalizeEmail } from '@shared/kernel';

interface EmailProps {
  value: string;
}

/** A user's email as a domain value — the single place that canonicalizes (trim + lowercase via `normalizeEmail`) and shape-validates; the DTO's `@IsEmail` stays the primary HTTP gate (400), this is the deliberately loose domain backstop. */
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
