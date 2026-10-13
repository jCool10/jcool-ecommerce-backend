import { Inject, Injectable, type OnApplicationShutdown, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client, Connection } from '@temporalio/client';
import { requireIntConfig } from '@jcool/platform/config';
import { deadlineBoundedRetryInterceptor } from './deadline-bounded-grpc-retry';

export const TEMPORAL_SETTINGS = Symbol('TEMPORAL_SETTINGS');
export const TEMPORAL_CLIENT = Symbol('TEMPORAL_CLIENT');

export interface TemporalSettings {
  address: string;
  namespace: string;
  taskQueue: string;
  workerEnabled: boolean;
  workerShutdownGraceMs: number;
  activityConcurrency: number;
  workflowBundlePath: string;
  /** Production never bundles at boot: a missing prebuilt bundle is a broken image. */
  workflowBundleRequired: boolean;
}

export function temporalSettingsFrom(config: ConfigService): TemporalSettings {
  return {
    address: config.getOrThrow<string>('temporal.address'),
    namespace: config.getOrThrow<string>('temporal.namespace'),
    taskQueue: config.getOrThrow<string>('temporal.taskQueue'),
    workerEnabled: config.get<boolean>('temporal.workerEnabled') === true,
    workerShutdownGraceMs: requireIntConfig(config, 'temporal.workerShutdownGraceMs', 0),
    activityConcurrency: requireIntConfig(config, 'saga.activityConcurrency', 1),
    workflowBundlePath: config.getOrThrow<string>('temporal.workflowBundlePath'),
    workflowBundleRequired: config.get<string>('app.env') === 'production',
  };
}

/** Closes the client's channel; the worker owns its own native connection. */
@Injectable()
export class TemporalClientCloser implements OnApplicationShutdown {
  constructor(@Inject(TEMPORAL_CLIENT) private readonly client: Client) {}

  async onApplicationShutdown(): Promise<void> {
    await this.client.connection.close();
  }
}

export const temporalProviders: Provider[] = [
  { provide: TEMPORAL_SETTINGS, inject: [ConfigService], useFactory: temporalSettingsFrom },
  {
    provide: TEMPORAL_CLIENT,
    inject: [TEMPORAL_SETTINGS],
    // Lazy, so the app boots while Temporal is down and checkout answers 503 instead of crashlooping.
    useFactory: ({ address, namespace }: TemporalSettings) =>
      new Client({
        connection: Connection.lazy({ address, interceptors: [deadlineBoundedRetryInterceptor()] }),
        namespace,
      }),
  },
  TemporalClientCloser,
];
