import { ValueObject, DomainError, assertNonEmpty } from '@shared/kernel';

interface SlugProps {
  value: string;
}

/**
 * Mirrors the DTO's `SLUG_PATTERN`: the DTO's `@Matches` is the primary HTTP gate (400), this VO is
 * the backstop and normalizer for non-HTTP callers.
 */
export class Slug extends ValueObject<SlugProps> {
  private static readonly PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

  private constructor(props: SlugProps) {
    super(props);
  }

  static of(raw: string): Slug {
    assertNonEmpty(raw, 'Slug');
    const value = raw.trim().toLowerCase();
    if (!Slug.PATTERN.test(value)) {
      throw new DomainError('Slug must be lowercase alphanumeric with single hyphens (e.g. "wireless-headphones")');
    }
    return new Slug({ value });
  }

  get value(): string {
    return this.props.value;
  }
}
