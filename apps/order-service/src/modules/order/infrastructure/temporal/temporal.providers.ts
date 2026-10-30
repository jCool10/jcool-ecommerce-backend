import { Inject, Injectable, type OnApplicationShutdown, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client, Connection } from '@temporalio/client';
import type { CheckoutSagaConfig } from '../../../../config/checkout-saga.config';
import { makeDeadlineBoundedRetryInterceptor } from './deadline-bounded-grpc-retry.interceptor';

export const TEMPORAL_CONNECTION = Symbol('TEMPORAL_CONNECTION');
export const TEMPORAL_CLIENT = Symbol('TEMPORAL_CLIENT');

/** Closes the client connection; the worker owns its own native one. */
@Injectable()
export class TemporalConnectionCloser implements OnApplicationShutdown {
  constructor(@Inject(TEMPORAL_CONNECTION) private readonly connection: Connection) {}

  onApplicationShutdown(): Promise<void> {
    return this.connection.close();
  }
}

export const temporalProviders: Provider[] = [
  {
    provide: TEMPORAL_CONNECTION,
    inject: [ConfigService],
    // Lazy, so the app boots and serves without Temporal; a call fails within its own deadline instead.
    useFactory: (config: ConfigService): Connection =>
      Connection.lazy({
        address: config.getOrThrow<CheckoutSagaConfig>('checkoutSaga').temporal.address,
        interceptors: [makeDeadlineBoundedRetryInterceptor()],
      }),
  },
  {
    provide: TEMPORAL_CLIENT,
    inject: [TEMPORAL_CONNECTION, ConfigService],
    useFactory: (connection: Connection, config: ConfigService): Client =>
      new Client({ connection, namespace: config.getOrThrow<CheckoutSagaConfig>('checkoutSaga').temporal.namespace }),
  },
  TemporalConnectionCloser,
];
