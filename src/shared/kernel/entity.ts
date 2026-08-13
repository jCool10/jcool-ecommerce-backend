/** Base for entities compared by identity — same concrete type and same id, regardless of attribute drift — in contrast to `ValueObject`, compared by structure. */
export abstract class Entity<TId> {
  readonly id: TId;

  protected constructor(id: TId) {
    this.id = id;
  }

  equals(other?: Entity<TId>): boolean {
    if (other === null || other === undefined) return false;
    if (other.constructor !== this.constructor) return false;
    return this.id === other.id;
  }
}
