// Barrel: correlation (CLS) + structured logging (pino) building blocks + the shared route
// resolver. Telemetry lives here (and in interface/infrastructure), never in domain/
// application — see ADR-0013. The metrics pillar deliberately stays OUT of this barrel: it
// pulls prom-client, and application code imports only the pure `metrics/metrics.port` seam.
export * from './correlation/cls.setup';
export * from './logging/logger.module';
export * from './logging/redact-paths';
export * from './logging/db-query-counter';
export * from './logging/canonical-log.interceptor';
export * from './http-route.util';
