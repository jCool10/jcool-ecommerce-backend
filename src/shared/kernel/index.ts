// Shared kernel barrel: pure DDD building blocks reused by ≥2 bounded contexts, zero
// framework/DB imports (importable from any layer) and no context-specific business rules.
export * from './domain-error';
export * from './duration-to-ms';
export * from './guard';
export * from './value-object';
export * from './entity';
export * from './aggregate-root';
export * from './domain-event';
export * from './result';
export * from './money.vo';
