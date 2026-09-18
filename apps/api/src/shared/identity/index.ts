// Nothing here may pull Nest, ioredis or config — DI wiring sits outside, in `identity.module.ts`.
// Codec and generator are imported from @jcool/id-codec and @jcool/id-generator directly.
export * from './identity.service';
