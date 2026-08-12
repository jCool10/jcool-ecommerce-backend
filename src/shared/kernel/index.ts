// Shared kernel barrel: pure DDD building blocks reused by ≥2 bounded contexts.
// Zero framework/DB imports — importable from any layer. No context-specific
// business rules live here.
export * from './domain-error';
export * from './guard';
export * from './value-object';
export * from './entity';
export * from './aggregate-root';
export * from './domain-event';
export * from './result';
export * from './money.vo';
