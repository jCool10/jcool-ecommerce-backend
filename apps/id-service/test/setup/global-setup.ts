import { EtcdContainer } from '@testcontainers/etcd';
import { ETCD_IMAGE } from './keyspaces';

// One etcd for every spec; each spec works under a key prefix of its own.
export default async function setup({
  provide,
}: {
  provide: (key: 'ETCD_URL', value: string) => void;
}): Promise<() => Promise<void>> {
  const etcd = await new EtcdContainer(ETCD_IMAGE).start();
  provide('ETCD_URL', etcd.getClientEndpoint());
  return async () => {
    await etcd.stop();
  };
}
