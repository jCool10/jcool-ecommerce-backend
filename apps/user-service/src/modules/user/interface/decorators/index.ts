// `@CurrentUser` is not here — it reads the principal the token guard attaches, which is shared RBAC
// vocabulary, so it lives in `@jcool/platform/rbac`.
export * from './refresh-token-cookie.decorator';
