// Mirrors the `role` pgEnum; the const tuple carries both the runtime values (guards, seed) and the
// compile-time union below.
export const ROLES = ['ADMIN', 'CUSTOMER'] as const;

export type Role = (typeof ROLES)[number];

// Constrained against the tuple rather than the `Role` alias: naming the alias here would be a
// self-reference (the value and the type share a name), which reads as the const's only use and
// makes scope analysis treat the export as dead. Same constraint, no ambiguity.
export const Role = {
  Admin: 'ADMIN',
  Customer: 'CUSTOMER',
} as const satisfies Record<string, (typeof ROLES)[number]>;
