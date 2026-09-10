import { Controller, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { PAYMENT_SESSION_THROTTLE, UserThrottlerGuard } from '@shared/infrastructure/throttler';
import { CurrentUser, type AuthenticatedUser } from '@shared/rbac';
import { CreatePaymentSessionUseCase } from '../application/use-cases';
import { CreatePaymentSessionResponseDto } from './dto/create-payment-session.response.dto';

/**
 * The global JwtAuthGuard protects the whole controller — no `@Public()`. `orders/:id/pay` lives here
 * rather than on OrderController because opening a payment is a Payment-context concern.
 */
@ApiTags('payments')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing, expired, or invalid access token' })
@Controller('orders')
export class PaymentController {
  constructor(private readonly createSession: CreatePaymentSessionUseCase) {}

  @Post(':id/pay')
  // Each attempt opens a session at the gateway, so this is throttled per authenticated user as
  // well as per IP — one account can't turn a retry loop into outbound load we pay for.
  @Throttle(PAYMENT_SESSION_THROTTLE)
  @UseGuards(UserThrottlerGuard)
  @ApiParam({ name: 'id', format: 'uuid', description: 'Order id to pay' })
  @ApiCreatedResponse({ type: CreatePaymentSessionResponseDto })
  @ApiNotFoundResponse({ description: 'Order not found (or not owned by the caller)' })
  @ApiConflictResponse({ description: 'Order is not PENDING, or already has an active payment' })
  async pay(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) orderId: string,
  ): Promise<CreatePaymentSessionResponseDto> {
    return CreatePaymentSessionResponseDto.from(await this.createSession.execute(orderId, user.userId));
  }
}
