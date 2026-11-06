import type { FactoryProvider } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { type Client, Connection } from '@temporalio/client';
import { OpenTelemetryWorkflowClientInterceptor } from '@temporalio/interceptors-opentelemetry-v2';
import { TEMPORAL_CLIENT, TEMPORAL_CONNECTION, temporalProviders } from './temporal.providers';

describe('temporalProviders', () => {
  const config = {
    getOrThrow: () => ({ temporal: { address: 'temporal:7233', namespace: 'jcool' } }),
  } as unknown as ConfigService;
  const factoryOf = (token: symbol): FactoryProvider =>
    temporalProviders.find(
      (candidate): candidate is FactoryProvider =>
        typeof candidate === 'object' && 'provide' in candidate && candidate.provide === token,
    )!;

  it('looks the address up again within seconds, so a Temporal redeployed on a new IP is found', async () => {
    const connection = factoryOf(TEMPORAL_CONNECTION).useFactory(config) as Connection;

    expect(connection.options.channelArgs['grpc.dns_min_time_between_resolutions_ms']).toBeLessThanOrEqual(2_000);
    await connection.close();
  });

  it("sends the caller's trace with every workflow call, so the run continues the request's trace", async () => {
    const connection = Connection.lazy({ address: 'temporal:7233' });
    const client = factoryOf(TEMPORAL_CLIENT).useFactory(connection, config) as Client;

    expect(client.options.interceptors.workflow).toEqual([expect.any(OpenTelemetryWorkflowClientInterceptor)]);
    await connection.close();
  });
});
