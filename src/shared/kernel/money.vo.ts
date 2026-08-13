import { ValueObject } from './value-object';
import { assertInteger, assertNonEmpty } from './guard';
import { DomainError } from './domain-error';

interface MoneyProps {
  amountMinor: number;
  currency: string;
}

/** Money as an integer count of the currency's smallest unit (VND đồng, USD cents) — never a float, so arithmetic stays exact; immutable, with cross-currency operations throwing `DomainError` rather than coercing, and no locale formatting (that belongs in the interface layer). */
export class Money extends ValueObject<MoneyProps> {
  private constructor(props: MoneyProps) {
    super(props);
  }

  static of(amountMinor: number, currency: string): Money {
    assertInteger(amountMinor, 'Money.amountMinor');
    return new Money({ amountMinor, currency: Money.normalizeCurrency(currency) });
  }

  static zero(currency: string): Money {
    return Money.of(0, currency);
  }

  // Canonical upper-case ISO-4217 code so equality is case-insensitive ('vnd' === 'VND').
  private static normalizeCurrency(currency: string): string {
    assertNonEmpty(currency, 'Money.currency');
    const code = currency.trim().toUpperCase();
    if (code.length !== 3) {
      throw new DomainError('Money.currency must be a 3-letter ISO-4217 code');
    }
    return code;
  }

  get amountMinor(): number {
    return this.props.amountMinor;
  }

  get currency(): string {
    return this.props.currency;
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.amountMinor + other.amountMinor, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.of(this.amountMinor - other.amountMinor, this.currency);
  }

  multiply(qtyInt: number): Money {
    assertInteger(qtyInt, 'Money.multiply factor');
    return Money.of(this.amountMinor * qtyInt, this.currency);
  }

  /** -1 / 0 / 1 like a comparator; throws on currency mismatch. */
  compare(other: Money): number {
    this.assertSameCurrency(other);
    if (this.amountMinor < other.amountMinor) return -1;
    if (this.amountMinor > other.amountMinor) return 1;
    return 0;
  }

  isZero(): boolean {
    return this.amountMinor === 0;
  }

  isNegative(): boolean {
    return this.amountMinor < 0;
  }

  equals(other?: Money): boolean {
    return super.equals(other);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new DomainError(`Money currency mismatch: ${this.currency} vs ${other.currency}`);
    }
  }
}
