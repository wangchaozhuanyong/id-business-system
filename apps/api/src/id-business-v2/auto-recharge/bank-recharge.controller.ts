import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Put,
  Query
} from '@nestjs/common';
import { BankRechargeAccountDeliveryService } from './bank-recharge-account-delivery.service';
import { CurrentUser, RequireRoles } from '../../auth/auth.decorators';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { BankRechargeAccountService } from './bank-recharge-account.service';
import { RechargeCardRemovalService } from './recharge-card-removal.service';
import { BankRechargeCardService } from './bank-recharge-card.service';
import { BankRechargeOrderService } from './bank-recharge-order.service';
import { BankRechargeQueryRepository } from './persistence/bank-recharge-query.repository';
import { BankRechargeCorrectionService } from './bank-recharge-correction.service';
import { BankRechargeFinanceService } from './bank-recharge-finance.service';

@Controller('id-business-v2/bank-recharge')
@RequireRoles('admin')
export class BankRechargeController {
  constructor(
    private readonly accounts: BankRechargeAccountService,
    private readonly cards: BankRechargeCardService,
    private readonly orders: BankRechargeOrderService,
    private readonly queries: BankRechargeQueryRepository,
    private readonly finance: BankRechargeFinanceService,
    private readonly delivery: BankRechargeAccountDeliveryService,
    private readonly corrections: BankRechargeCorrectionService,
    private readonly cardRemoval: RechargeCardRemovalService
  ) {}

  @Get('accounts/:id/opening-card-deletion')
  @Header('Cache-Control', 'no-store')
  openingCardDeletion(@Param('id') id: string, @CurrentUser() operator: AuthenticatedUser) {
    return this.cardRemoval.preview(id, operator);
  }
  @Delete('accounts/:id/opening-card')
  deleteOpeningCard(
    @Param('id') id: string,
    @Body() value: unknown,
    @CurrentUser() operator: AuthenticatedUser
  ) {
    return this.cardRemoval.remove(id, value, operator);
  }

  @Get('account-copy-settings')
  @Header('Cache-Control', 'no-store')
  copySettings(@CurrentUser() operator: AuthenticatedUser) {
    return this.delivery.copySettings(operator);
  }

  @Put('account-copy-settings')
  updateCopySettings(@Body() input: unknown, @CurrentUser() operator: AuthenticatedUser) {
    return this.delivery.updateCopySettings(input, operator);
  }

  @Post('accounts/:id/copy')
  @Header('Cache-Control', 'no-store')
  copyAccount(@Param('id') id: string, @CurrentUser() operator: AuthenticatedUser) {
    return this.delivery.copyAccount(id, operator);
  }

  @Get('accounts')
  @Header('Cache-Control', 'no-store')
  listAccounts(
    @Query()
    query: {
      page?: string;
      pageSize?: string;
      keyword?: string;
      subscriptionState?: string;
    }
  ) {
    return this.accounts.listAccounts(query);
  }

  @Post('accounts')
  createAccount(@Body() value: unknown, @CurrentUser() operator: AuthenticatedUser) {
    return this.accounts.createAccount(value, operator);
  }

  @Post('accounts/import')
  importAccounts(@Body() value: unknown, @CurrentUser() operator: AuthenticatedUser) {
    return this.accounts.importAccounts(value, operator);
  }

  @Patch('accounts/:id')
  updateAccount(
    @Param('id') id: string,
    @Body() value: unknown,
    @CurrentUser() operator: AuthenticatedUser
  ) {
    return this.accounts.updateAccount(id, value, operator);
  }

  @Delete('accounts/:id')
  deleteAccount(@Param('id') id: string, @CurrentUser() operator: AuthenticatedUser) {
    return this.accounts.deleteAccount(id, operator);
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

  @Get('cards/management')
  @Header('Cache-Control', 'no-store')
  listManagedCards(
    @Query() query: { page?: string; pageSize?: string; keyword?: string; status?: string }
  ) {
    return this.cards.list(query);
  }

  @Get('cards/management/:id')
  @Header('Cache-Control', 'no-store')
  cardDetail(@Param('id') id: string, @CurrentUser() operator: AuthenticatedUser) {
    return this.cards.detail(id, operator);
  }

  @Get('cards/management/:id/orders')
  @Header('Cache-Control', 'no-store')
  cardOrders(@Param('id') id: string, @Query() query: { page?: string; pageSize?: string }) {
    return this.cards.orders(id, query);
  }

  @Post('cards/management')
  createManagedCard(@Body() value: unknown, @CurrentUser() operator: AuthenticatedUser) {
    return this.cards.create(value, operator);
  }

  @Post('cards/management/import')
  importManagedCards(@Body() value: unknown, @CurrentUser() operator: AuthenticatedUser) {
    return this.cards.importCards(value, operator);
  }

  @Post('cards/management/availability')
  @Header('Cache-Control', 'no-store')
  checkCardAvailability(@Body() value: unknown) {
    return this.cards.checkAvailability(value);
  }

  @Patch('cards/management/:id')
  updateManagedCard(
    @Param('id') id: string,
    @Body() value: unknown,
    @CurrentUser() operator: AuthenticatedUser
  ) {
    return this.cards.update(id, value, operator);
  }

  @Delete('cards/management/:id')
  deleteManagedCard(@Param('id') id: string, @CurrentUser() operator: AuthenticatedUser) {
    return this.cards.delete(id, operator);
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

  @Post('orders/:id/correct')
  correctOrder(
    @Param('id') id: string,
    @Body() value: unknown,
    @CurrentUser() operator: AuthenticatedUser
  ) {
    return this.corrections.correct(id, value, operator);
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
