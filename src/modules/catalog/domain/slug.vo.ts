import { ValueObject, DomainError, assertNonEmpty } from '../../../shared/kernel';

interface SlugProps {
  value: string;
}

/**
 * URL-safe identifier for catalog products/categories. The domain home for the
 * slug rule: trim + lowercase, then a single canonical shape check. Lives in
 * catalog only (YAGNI — no other context needs slugs).
 *
 * The interface DTO's `@Matches` stays the primary HTTP gate (returns 400); this
 * VO is the defense-in-depth backstop and the normalizer for any non-HTTP caller.
 * Pattern mirrors the DTO's `SLUG_PATTERN` (lowercase alphanumeric groups joined
 * by single hyphens).
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
