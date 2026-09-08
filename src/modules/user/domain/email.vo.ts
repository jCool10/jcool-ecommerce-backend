import { ValueObject, DomainError, type NormalizedEmail, normalizeEmail } from '@shared/kernel';

interface EmailProps {
  value: NormalizedEmail;
}

/** Deliberately loose domain backstop: the DTO's `@IsEmail` stays the primary HTTP gate (400). */
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

  get value(): NormalizedEmail {
    return this.props.value;
  }
}
