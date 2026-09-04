// Identity barrel: the pure UUIDv8 codec + the keyed routing bucket. Nothing here may pull Nest,
// ioredis or config — the generator and its DI wiring live outside this surface.
export * from './uuid-v8.codec';
export * from './email-bucket';
