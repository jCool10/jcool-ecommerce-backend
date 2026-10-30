import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Res,
  ServiceUnavailableException,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import {
  COMMAND_OUTCOME_STATUS,
  RESERVATIONS_PREFIX,
  TRY_OUTCOME_STATUS,
  type CommandOutcome,
  type StatusResponse,
} from '@jcool/internal-contracts';
import { ParseSnowflakeIdPipe } from '@jcool/platform/interface';
import { CallerTokenGuard, InternalCallers } from '@jcool/platform/internal-api';
import { Public } from '@jcool/platform/rbac';
import { ACCOUNT_THROTTLER, DEFAULT_THROTTLER } from '@jcool/platform/throttler';
import { INVENTORY_PARTICIPANT, type InventoryParticipant } from '../../application/public/inventory-participant.port';
import { ReservationTimeoutError } from '../../domain/errors/reservation-timeout.error';
import { StatusDto, TryReservationDto } from './dto';
import { LockBudgetExhaustedFilter, RETRY_AFTER_SEC } from './lock-budget-exhausted.filter';

/**
 * The checkout saga's side of stock. Every route is idempotent per order through the
 * `reservation_orders` fence, so a retry after a lost answer is always safe. Business outcomes are a
 * 2xx or a 409 carrying `outcome`; anything the participant throws is a 503 to retry, coded
 * `LOCK_BUDGET_EXHAUSTED` when only busy rows stood in the way.
 *
 * Unthrottled because every call comes from one private address. `@Public` only lifts the user-token
 * guard; the caller token replaces it.
 */
@ApiExcludeController()
@Public()
@SkipThrottle({ [DEFAULT_THROTTLER]: true, [ACCOUNT_THROTTLER]: true })
@UseGuards(CallerTokenGuard)
@UseFilters(LockBudgetExhaustedFilter)
@InternalCallers('api', 'order-service')
@Controller(RESERVATIONS_PREFIX)
export class ReservationsController {
  constructor(@Inject(INVENTORY_PARTICIPANT) private readonly participant: InventoryParticipant) {}

  @Post('status')
  @HttpCode(HttpStatus.OK)
  async status(@Body() { orderIds }: StatusDto, @Res({ passthrough: true }) res: Response): Promise<StatusResponse> {
    const statuses = await this.orRetry(res, () => this.participant.statusOf(orderIds));
    return { statuses: Object.fromEntries(statuses) };
  }

  // `@Res()` without passthrough: Nest would otherwise reset the status to the route's default.
  @Post(':orderId/try')
  async tryReserve(
    @Param('orderId', ParseSnowflakeIdPipe) orderId: string,
    @Body() { lines, holdUntil }: TryReservationDto,
    @Res() res: Response,
  ): Promise<void> {
    const outcome = await this.orRetry(res, () =>
      this.participant.tryReserve({
        orderId,
        lines: lines.map(({ variantId, quantity }) => ({ variantId, quantity })),
        holdUntil: new Date(holdUntil),
      }),
    );
    res.status(TRY_OUTCOME_STATUS[outcome]).json({ outcome });
  }

  @Post(':orderId/commit')
  commit(@Param('orderId', ParseSnowflakeIdPipe) orderId: string, @Res() res: Response): Promise<void> {
    return this.answerCommand(res, () => this.participant.commit(orderId));
  }

  @Post(':orderId/release')
  release(@Param('orderId', ParseSnowflakeIdPipe) orderId: string, @Res() res: Response): Promise<void> {
    return this.answerCommand(res, () => this.participant.release(orderId));
  }

  @Post(':orderId/restock')
  restock(@Param('orderId', ParseSnowflakeIdPipe) orderId: string, @Res() res: Response): Promise<void> {
    return this.answerCommand(res, () => this.participant.restock(orderId));
  }

  private async answerCommand(res: Response, run: () => Promise<CommandOutcome>): Promise<void> {
    const outcome = await this.orRetry(res, run);
    res.status(COMMAND_OUTCOME_STATUS[outcome]).json({ outcome });
  }

  private async orRetry<T>(res: Response, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof ReservationTimeoutError) throw error;
      res.setHeader('Retry-After', RETRY_AFTER_SEC);
      throw new ServiceUnavailableException(undefined, { cause: error });
    }
  }
}
