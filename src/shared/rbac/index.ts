// Barrel: interface-level RBAC vocabulary (role enum + @Roles decorator + guard + @Public opt-out
// + the authenticated-principal shape every guarded controller reads). Siblings import by file.
export * from './role.enum';
export * from './roles.decorator';
export * from './roles.guard';
export * from './public.decorator';
export * from './current-user.decorator';
