import { Controller, Get, Header, Param, Query } from '@nestjs/common';
import { CurrentUser, RequireRoles } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { SharedBankCardRepository } from './persistence/shared-bank-card.repository';

@Controller('id-business-v2/bank-card-pool')
@RequireRoles('admin')
export class SharedBankCardController {
  constructor(private readonly cards: SharedBankCardRepository) {}

  @Get('options')
  @Header('Cache-Control', 'no-store')
  options(@Query('plan') plan: string) {
    return this.cards.options(plan);
  }

  @Get(':id/payment-details')
  @Header('Cache-Control', 'no-store')
  details(
    @Param('id') id: string,
    @Query('plan') plan: string,
    @CurrentUser() operator: AuthenticatedUser
  ) {
    return this.cards.paymentDetails(id, plan, operator);
  }
}
