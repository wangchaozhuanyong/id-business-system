ALTER TABLE `id_business_v2_balance_ledger`
MODIFY COLUMN `entry_type` ENUM(
  'gift_card_credit',
  'gift_card_redeemed',
  'gift_card_withdrawal',
  'order_consumption',
  'order_consumption_reversal',
  'order_upgrade_balance_return',
  'order_upgrade_balance_return_reversal',
  'opening_balance',
  'manual_adjustment',
  'account_loss'
) NOT NULL;

ALTER TABLE `id_business_v2_finance_journals`
MODIFY COLUMN `journal_type` ENUM(
  'supplier_deposit',
  'supplier_refund',
  'supplier_adjustment',
  'gift_card_purchase',
  'gift_card_redemption_loss',
  'gift_card_withdrawal_pending',
  'gift_card_refund_received',
  'gift_card_refund_write_off',
  'account_purchase',
  'order_completed',
  'order_refund',
  'order_cancel',
  'order_recovery',
  'order_upgrade_balance_return',
  'account_loss',
  'expense',
  'opening_balance',
  'fx_gain_loss',
  'manual_adjustment',
  'historical_backfill',
  'reversal'
) NOT NULL;
