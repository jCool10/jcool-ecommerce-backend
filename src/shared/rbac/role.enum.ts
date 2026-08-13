// RBAC vocabulary shared by every bounded context; const tuple + derived union so values
// serve as both runtime data (guards, seed) and a compile-time type, mirroring the `role` pgEnum.
export const ROLES = ['ADMIN', 'CUSTOMER'] as const;

export type Role = (typeof ROLES)[number];

export const Role = {
  Admin: 'ADMIN',
  Customer: 'CUSTOMER',
} as const satisfies Record<string, Role>;
