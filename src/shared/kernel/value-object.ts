/** Base for immutable value objects compared by structure, not identity: props are frozen on construction and `equals` does a shallow per-key comparison (nested-VO props would override `equals` to recurse). */
export abstract class ValueObject<TProps extends object> {
  protected readonly props: TProps;

  protected constructor(props: TProps) {
    this.props = Object.freeze({ ...props });
  }

  equals(other?: ValueObject<TProps>): boolean {
    if (other === null || other === undefined) return false;
    if (other.constructor !== this.constructor) return false;
    const a = this.props as Record<string, unknown>;
    const b = other.props as Record<string, unknown>;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => a[key] === b[key]);
  }
}
