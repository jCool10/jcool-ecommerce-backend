import { ClsServiceManager } from 'nestjs-cls';
import { describe, expect, it } from 'vitest';
import { getJobName, runInJobContext } from './job-context';

// The real service, not a fake: what is asserted here is AsyncLocalStorage behaviour, which a fake
// would simply be written to have.
const cls = ClsServiceManager.getClsService();

describe('runInJobContext', () => {
  // The pino mixin reads this one slot for requests and jobs alike.
  it('gives a background job the same correlation slot a request gets', async () => {
    const seen = await runInJobContext(cls, 'retention:messaging:outbox', () =>
      Promise.resolve({ id: cls.getId(), job: getJobName(cls) }),
    );

    expect(seen.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(seen.job).toBe('retention:messaging:outbox');
  });

  // The retention scheduler starts its sweeps with Promise.all, so their scopes genuinely overlap.
  it('gives concurrent jobs separate ids that survive an await', async () => {
    const identify = (name: string) =>
      runInJobContext(cls, name, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return { id: cls.getId(), job: getJobName(cls) };
      });

    const [a, b] = await Promise.all([identify('retention:messaging:inbox'), identify('retention:order:idempotency')]);

    expect(a.id).not.toBe(b.id);
    expect(a.job).toBe('retention:messaging:inbox');
    expect(b.job).toBe('retention:order:idempotency');
  });

  // `cls.get` throws outside a context, and the pino mixin calls this on boot lines too.
  it('answers for a caller that is in no context at all', () => {
    expect(getJobName(cls)).toBeUndefined();
  });
});
