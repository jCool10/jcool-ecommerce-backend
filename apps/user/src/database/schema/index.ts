// The five tables this service owns, collected for drizzle-kit and for DrizzleModule.forRoot().
// It has no sibling: user-service is one context, so this barrel and the module's own schema file
// happen to hold the same tables — the indirection is the drizzle-kit boundary, not a data model.
export * from '../../modules/user/infrastructure/schema/user.schema';
