import { Global, Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Etcd3 } from 'etcd3';
import type { EtcdConfig } from '../config/configuration';
import { createEtcdClient, ETCD_CLIENT } from './etcd-client';

@Global()
@Module({
  providers: [
    {
      provide: ETCD_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Etcd3 => createEtcdClient(config.getOrThrow<EtcdConfig>('etcd').endpoints),
    },
  ],
  exports: [ETCD_CLIENT],
})
export class EtcdModule implements OnApplicationShutdown {
  constructor(@Inject(ETCD_CLIENT) private readonly client: Etcd3) {}

  // A global module's hooks run after LeaseModule's, so the keeper has released its node by now.
  onApplicationShutdown(): void {
    this.client.close();
  }
}
