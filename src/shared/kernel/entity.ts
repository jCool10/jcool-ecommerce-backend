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
