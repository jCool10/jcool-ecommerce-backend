import { Body, Controller, Headers, HttpCode, HttpStatus, Post, UseFilters } from '@nestjs/common';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import type { Counter } from 'prom-client';
import { NodeLease } from '@jcool/id-generator';
import { callerLabel } from './caller-label';
import { LeaseNotHeldFilter } from './lease-not-held.filter';
import { ID_MINTED_TOTAL } from './mint.metrics';
import { MintRequest, type MintResponse } from './mint.request';

// No service token: the service is reachable only on the private network (see README).
@Controller('v1/ids')
@UseFilters(LeaseNotHeldFilter)
export class MintController {
  constructor(
    private readonly lease: NodeLease,
    @InjectMetric(ID_MINTED_TOTAL) private readonly minted: Counter<'caller'>,
  ) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  mint(@Body() { bucket, count }: MintRequest, @Headers('x-caller') caller: string | undefined): MintResponse {
    const ids = Array.from({ length: count }, () => this.lease.generate(bucket));
    this.minted.inc({ caller: callerLabel(caller) }, count);
    return { ids };
  }
}
