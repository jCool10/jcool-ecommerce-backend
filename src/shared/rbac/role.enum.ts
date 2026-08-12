// RBAC vocabulary shared by every bounded context (User owns the role, Catalog
// guards admin routes). Const tuple + derived union so the values work as both
// runtime data (guards, seed) and a compile-time type. Mirrors the `role` pgEnum.
export const ROLES = ['ADMIN', 'CUSTOMER'] as const;

export type Role = (typeof ROLES)[number];

export const Role = {
  Admin: 'ADMIN',
  Customer: 'CUSTOMER',
} as const satisfies Record<string, Role>;
