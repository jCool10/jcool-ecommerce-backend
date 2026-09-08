import { randomUUID } from 'node:crypto';
import { CLS_ID, type ClsService } from 'nestjs-cls';

export const JOB_NAME_KEY = 'jobName';

/**
 * Correlation for work with no request behind it: without a per-tick id, lines from one tick are
 * indistinguishable from lines of several ticks running side by side. Deliberately NOT the trace id
 * ({@link withSpan} supplies that) — the trace follows work across processes, this across log lines.
 */
export function runInJobContext<T>(cls: ClsService, jobName: string, fn: () => Promise<T>): Promise<T> {
  return cls.run(() => {
    // The same slot the middleware fills for a request, so the pino mixin needs no branch.
    cls.set(CLS_ID, randomUUID());
    cls.set(JOB_NAME_KEY, jobName);
    return fn();
  });
}

export function getJobName(cls: ClsService): string | undefined {
  return cls.isActive() ? cls.get<string>(JOB_NAME_KEY) : undefined;
}
