import { ClsServiceManager } from 'nestjs-cls';
import { describe, expect, it } from 'vitest';
import { getJobName, JOB_NAME_KEY, runInJobContext } from './job-context';

// The real service, not a fake: what is asserted here is AsyncLocalStorage behaviour, and a fake
// would have exactly the behaviour it was written to have.
const cls = ClsServiceManager.getClsService();

describe('runInJobContext', () => {
  it('gives a background job the same correlation slot a request gets', async () => {
    const seen = await runInJobContext(cls, 'retention:messaging:outbox', () =>
      Promise.resolve({ id: cls.getId(), job: getJobName(cls) }),
    );

    // The pino mixin reads this one slot for both, so a timer's line answers the same query as a
    // request's.
    expect(seen.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(seen.job).toBe('retention:messaging:outbox');
  });

  it('keeps the context across an await, where a plain variable would already be wrong', async () => {
    await runInJobContext(cls, 'outbox-relay', async () => {
      const before = cls.getId();
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(cls.getId()).toBe(before);
      expect(cls.get<string>(JOB_NAME_KEY)).toBe('outbox-relay');
    });
  });

  it('gives concurrent jobs separate ids, so one tick is not read as seven', async () => {
    const identify = (name: string) =>
      runInJobContext(cls, name, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return { id: cls.getId(), job: getJobName(cls) };
      });

    // The retention scheduler starts its sweeps with Promise.all, so their scopes genuinely overlap.
    const [a, b] = await Promise.all([identify('retention:messaging:inbox'), identify('retention:order:idempotency')]);

    expect(a.id).not.toBe(b.id);
    expect(a.job).toBe('retention:messaging:inbox');
    expect(b.job).toBe('retention:order:idempotency');
  });

  it('leaves nothing behind once the job finishes', async () => {
    await runInJobContext(cls, 'payment.reconcile', () => Promise.resolve());

    expect(cls.isActive()).toBe(false);
    expect(getJobName(cls)).toBeUndefined();
  });

  it('propagates a failure instead of swallowing it inside the scope', async () => {
    await expect(runInJobContext(cls, 'boom', () => Promise.reject(new Error('pool exhausted')))).rejects.toThrow(
      'pool exhausted',
    );
    expect(cls.isActive()).toBe(false);
  });

  // `cls.get` throws outside a context, so the guard is what lets the pino mixin call this on boot
  // lines, before any request or job exists.
  it('answers for a caller that is in no context at all', () => {
    expect(getJobName(cls)).toBeUndefined();
  });
});
