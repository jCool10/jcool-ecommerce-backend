import {
  type Resource,
  detectResources,
  envDetector,
  hostDetector,
  processDetector,
  resourceFromAttributes,
} from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

/**
 * The detection NodeSDK runs by default, done once so the SDK (with `autoDetectResources: false`) and
 * the workflow span sink export under the same resource. Imports nothing a preload must load late.
 */
export function telemetryResource(serviceName: string): Resource {
  return resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }).merge(
    detectResources({ detectors: [envDetector, processDetector, hostDetector] }),
  );
}
