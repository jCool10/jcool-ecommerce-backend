import { randomUUID } from 'node:crypto';
import { CLS_ID, type ClsService } from 'nestjs-cls';

/** CLS key holding the name of the background job running in this context. */
export const JOB_NAME_KEY = 'jobName';

/**
 * The correlation seam for work that has no request behind it.
 *
 * A timer or queue worker gets no requestId, so lines from one tick are indistinguishable from
 * lines from several ticks running side by side — exactly the question a retention or relay
 * incident asks. Opening a CLS scope per unit of background work gives each tick its own id, and
 * `jobName` rides alongside so a line names the driver that produced it.
 *
 * Deliberately NOT the trace id: {@link withSpan} already puts one on a tick. The trace follows work
 * across processes, this follows it across log lines; a tick usually wants both.
 */
export function runInJobContext<T>(cls: ClsService, jobName: string, fn: () => Promise<T>): Promise<T> {
  return cls.run(() => {
    // The same slot the middleware fills for a request, so the pino mixin needs no branch.
    cls.set(CLS_ID, randomUUID());
    cls.set(JOB_NAME_KEY, jobName);
    return fn();
  });
}

/** The background job owning the active context, or undefined inside a request (or outside CLS). */
export function getJobName(cls: ClsService): string | undefined {
  return cls.isActive() ? cls.get<string>(JOB_NAME_KEY) : undefined;
}
