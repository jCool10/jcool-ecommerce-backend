import { EventEmitter } from 'node:events';
import { Controller, Get } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import { ClsServiceManager } from 'nestjs-cls';
import { lastValueFrom, of, throwError, type Observable } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { fakeConfigService } from '@jcool/testing/fake-config.service';
import { fakePinoLogger } from '@jcool/testing/fake-pino-logger';
import { REQUEST_START_KEY } from '../correlation/cls.setup';
import { CanonicalLogInterceptor } from './canonical-log.interceptor';
import { incrementDbQueryCount } from './db-query-counter';

@Controller('products')
class ProductsController {
  @Get(':idOrSlug')
  findOne(this: void): void {}
}

@Controller('health')
class HealthController {
  @Get('live')
  live(this: void): void {}
}

const cls = ClsServiceManager.getClsService();

function run(env: string, controller: new () => object, handler: () => void, handle: () => Observable<unknown>) {
  const info = vi.fn();
  const interceptor = new CanonicalLogInterceptor(
    fakePinoLogger({ info }),
    cls,
    new Reflector(),
    fakeConfigService({ 'app.env': env }),
  );
  // Express sets content-length while writing the body, after the interceptor chain has unwound.
  let bodySent = false;
  const response = Object.assign(new EventEmitter(), {
    statusCode: 200,
    getHeader: (name: string) => (bodySent && name === 'content-length' ? '431' : undefined),
  });
  const context = new ExecutionContextHost([{ method: 'GET', path: '/concrete' }, response], controller, handler);

  const done = cls.run(async () => {
    cls.set(REQUEST_START_KEY, process.hrtime.bigint());
    for (let query = 0; query < 3; query++) incrementDbQueryCount(cls);
    await lastValueFrom(interceptor.intercept(context, { handle }), { defaultValue: undefined });
  });

  return {
    info,
    done,
    finish: (): void => {
      bodySent = true;
      response.emit('finish');
      response.emit('close');
    },
    drop: (): void => {
      response.emit('close');
    },
  };
}

const findOne = [ProductsController, ProductsController.prototype.findOne] as const;

describe('CanonicalLogInterceptor', () => {
  it('writes one line with the route template, status, duration and query count', async () => {
    const { info, done } = run('production', ...findOne, () => of({ id: 'abc' }));
    await done;

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      {
        method: 'GET',
        route: '/products/:idOrSlug',
        statusCode: 200,
        durationMs: expect.any(Number) as number,
        'db.queries': 3,
      },
      'request completed',
    );
  });

  // HttpExceptionFilter writes the line for a failed request; a second one would double-count it.
  it('writes no line when the handler throws', async () => {
    const { info, done } = run('production', ...findOne, () => throwError(() => new Error('boom')));

    await expect(done).rejects.toThrow('boom');
    expect(info).not.toHaveBeenCalled();
  });

  it('writes no line for a health probe', async () => {
    const { info, done } = run('production', HealthController, HealthController.prototype.live, () => of({}));
    await done;

    expect(info).not.toHaveBeenCalled();
  });

  it('writes the dev line once, when the response finishes or the connection drops', async () => {
    const finished = run('development', ...findOne, () => of({ id: 'abc' }));
    const dropped = run('development', ...findOne, () => of({ id: 'abc' }));
    await Promise.all([finished.done, dropped.done]);
    expect(finished.info).not.toHaveBeenCalled();

    finished.finish();
    dropped.drop();

    expect(finished.info).toHaveBeenCalledTimes(1);
    expect(dropped.info).toHaveBeenCalledTimes(1);
    expect(finished.info.mock.calls[0][0]).toContain(' ms - 431');
    expect(dropped.info.mock.calls[0][0]).toContain(' ms - -');
  });
});
