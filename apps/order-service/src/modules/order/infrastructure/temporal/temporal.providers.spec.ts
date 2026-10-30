import type { FactoryProvider } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Connection } from '@temporalio/client';
import { TEMPORAL_CONNECTION, temporalProviders } from './temporal.providers';

describe('temporalProviders', () => {
  const connect = (): Connection => {
    const provider = temporalProviders.find(
      (candidate): candidate is FactoryProvider =>
        typeof candidate === 'object' && 'provide' in candidate && candidate.provide === TEMPORAL_CONNECTION,
    );
    const config = { getOrThrow: () => ({ temporal: { address: 'temporal:7233' } }) } as unknown as ConfigService;
    return provider!.useFactory(config) as Connection;
  };

  it('looks the address up again within seconds, so a Temporal redeployed on a new IP is found', async () => {
    const connection = connect();

    expect(connection.options.channelArgs['grpc.dns_min_time_between_resolutions_ms']).toBeLessThanOrEqual(2_000);
    await connection.close();
  });
});
