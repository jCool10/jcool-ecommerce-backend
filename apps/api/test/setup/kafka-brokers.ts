import { inject } from 'vitest';

// Its own setup file because globalSetup imports worker-resources.ts, and inject() only exists in a
// worker. Set on the process rather than in createTestApp: specs that drive the client directly, and
// the CLIs they spawn, read it too.
process.env.KAFKA_BROKERS = inject('KAFKA_BROKERS');
// Here too, not only in createTestApp: the config module validates on import, and the worker it
// defaults to wants a key.
process.env.MESSAGING_SIGNING_KEY = inject('MESSAGING_SIGNING_KEY');
