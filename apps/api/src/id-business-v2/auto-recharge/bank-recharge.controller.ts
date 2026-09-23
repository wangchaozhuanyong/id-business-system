import { Body, Controller, Get, Header, Param, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, RequireRoles } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { BankRechargeAccountService } from './bank-recharge-account.service';
import { BankRechargeOrderService } from './bank-recharge-order.service';
import { BankRechargeQueryRepository } from './persistence/bank-recharge-query.repository';
import { BankRechargeFinanceService } from './bank-recharge-finance.service';

@Controller('id-business-v2/bank-recharge')
@RequireRoles('admin')
export class BankRechargeController {
  constructor(
    private readonly accounts: BankRechargeAccountService,
    private readonly orders: BankRechargeOrderService,
    private readonly queries: BankRechargeQueryRepository,
    private readonly finance: BankRechargeFinanceService
  ) {}

  @Get('accounts')
  @Header('Cache-Control', 'no-store')
  listAccounts() {
    return this.accounts.listAccounts();
  }

  @Post('accounts')
  createAccount(@Body() value: unknown, @CurrentUser() operator: AuthenticatedUser) {
    return this.accounts.createAccount(value, operator);
  }

  @Patch('accounts/:id')
  updateAccount(
    @Param('id') id: string,
    @Body() value: unknown,
    @CurrentUser() operator: AuthenticatedUser
  ) {
    return this.accounts.updateAccount(id, value, operator);
  }

  @Post('accounts/:id/totp-code')
  @Header('Cache-Control', 'no-store')
  totpCode(@Param('id') id: string, @CurrentUser() operator: AuthenticatedUser) {
    return this.accounts.totpCode(id, operator);
  }

  @Get('accounts/:id/identity')
  @Header('Cache-Control', 'no-store')
  accountIdentity(@Param('id') id: string, @CurrentUser() operator: AuthenticatedUser) {
    return this.accounts.accountIdentity(id, operator);
  }

  @Post('accounts/:id/login-credential')
  @Header('Cache-Control', 'no-store')
  loginCredential(@Param('id') id: string, @CurrentUser() operator: AuthenticatedUser) {
    return this.accounts.launchCredential(id, operator);
  }

  @Get('currencies')
  listCurrencies() {
    return this.accounts.listCurrencies();
  }

  @Post('currencies')
  createCurrency(@Body() value: unknown, @CurrentUser() operator: AuthenticatedUser) {
    return this.accounts.createCurrency(value, operator);
  }

  @Get('cards')
  listCards() {
    return this.accounts.listCards();
  }

  @Post('cards')
  createCard(@Body() value: unknown, @CurrentUser() operator: AuthenticatedUser) {
    return this.accounts.createCard(value, operator);
  }

  @Get('orders/options')
  orderOptions() {
    return this.queries.options();
  }

  @Get('renewal-warnings')
  renewalWarnings() {
    return this.queries.renewalWarnings();
  }

  @Get('orders')
  @Header('Cache-Control', 'no-store')
  listOrders(@Query() query: unknown) {
    return this.queries.list(query);
  }

  @Post('orders')
  createManualOrder(@Body() value: unknown, @CurrentUser() operator: AuthenticatedUser) {
    return this.orders.createManual(value, operator);
  }

  @Patch('orders/:id')
  updateOrder(
    @Param('id') id: string,
    @Body() value: unknown,
    @CurrentUser() operator: AuthenticatedUser
  ) {
    return this.orders.update(id, value, operator);
  }

  @Post('orders/:id/complete')
  completeOrder(
    @Param('id') id: string,
    @Body() value: unknown,
    @CurrentUser() operator: AuthenticatedUser
  ) {
    return this.finance.complete(id, value, operator);
  }

  @Post('orders/:id/refund')
  refundOrder(
    @Param('id') id: string,
    @Body() value: unknown,
    @CurrentUser() operator: AuthenticatedUser
  ) {
    return this.finance.refund(id, value, operator);
  }
}
