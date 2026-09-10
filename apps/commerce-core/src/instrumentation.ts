// Preload via `node --import ./dist/apps/commerce-core/src/instrumentation.js` before the app, so
// auto-instrumentation can patch pg/ioredis/http as they load.
import { startTelemetry } from '@shared/observability/tracing/start-telemetry';

startTelemetry('jcool-api');
