// Barrel: User (auth) interface param/route decorators. `@CurrentUser` is not here — it reads the
// principal JwtStrategy attaches, which is shared RBAC vocabulary, so it lives in `@shared/rbac`.
export * from './refresh-token-cookie.decorator';
